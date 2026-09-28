import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '@kairo/db';
import { calendar, connectedAccount, eventDecision, eventProjection, externalEvent, googleEvent, icsSource, syncJob, task, taskConnection, user } from '@kairo/db/schema';
import { applyGoogleSnapshot, applyIcsSnapshot, applyTodoistSync, enqueueJob, leaseJobs, reconcileProjection } from './sync.js';
import type { GoogleCalendarClient } from '@kairo/integrations';

sqlite.exec(readFileSync('../db/migrations/0000_minor_norman_osborn.sql', 'utf8').replaceAll('--> statement-breakpoint', ''));
db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' }).run();
db.insert(connectedAccount).values({ id: 'account', ownerUserId: 'owner', provider: 'google' }).run();
db.insert(calendar).values({ id: 'cal', connectedAccountId: 'account', googleCalendarId: 'primary', name: 'Calendar' }).run();
db.insert(icsSource).values({ id: 'source', ownerUserId: 'owner', url: 'https://example.test/feed.ics', name: 'Feed' }).run();
db.insert(taskConnection).values({ id: 'todoist', ownerUserId: 'owner' }).run();

test('snapshots and cursors commit together; retries upsert instead of duplicating', async () => {
  const events = [{ id: 'google-1', summary: 'Event', start: { dateTime: '2026-09-24T10:00:00Z' }, end: { dateTime: '2026-09-24T11:00:00Z' } }];
  await applyGoogleSnapshot(db, 'cal', events, 'cursor-1', true);
  await applyGoogleSnapshot(db, 'cal', events, 'cursor-2', false);
  assert.equal(db.select().from(googleEvent).all().length, 1);
  assert.equal(db.select().from(calendar).where(eq(calendar.id, 'cal')).get()?.syncCursor, 'cursor-2');

  const horizon = { start: new Date('2026-09-01'), end: new Date('2026-10-01') };
  const occurrence = { uid: 'uid', recurrenceId: '', title: 'Invitation', description: null, location: null,
    start: '2026-09-24', end: '2026-09-25', allDay: true, cancelled: false, revision: 'r1' };
  await applyIcsSnapshot(db, 'source', [occurrence], {}, horizon);
  await applyIcsSnapshot(db, 'source', [occurrence], {}, horizon);
  assert.equal(db.select().from(externalEvent).all().length, 1);
  const eventId = db.select().from(externalEvent).get()!.id;
  db.insert(eventDecision).values({ id: 'decision', userId: 'owner', externalEventId: eventId, state: 'maybe', destinationCalendarId: 'cal' }).run();
  db.insert(eventProjection).values({ id: 'projection', decisionId: 'decision', syncState: 'ready' }).run();
  await applyIcsSnapshot(db, 'source', [], {}, horizon);
  assert.ok(db.select().from(externalEvent).get()?.withdrawnAt);
  assert.equal(db.select().from(eventProjection).get()?.conflictKind, 'source_withdrawn');
  await applyIcsSnapshot(db, 'source', [occurrence], {}, horizon);
  assert.equal(db.select().from(eventProjection).get()?.syncState, 'pending');
  assert.equal(db.select().from(syncJob).where(eq(syncJob.jobKey, 'projection:decision')).get()?.targetId, 'decision');

  await applyTodoistSync(db, 'todoist', { sync_token: 'token-1', full_sync: true,
    items: [{ id: 'todo-1', content: 'Work', due: { date: '2026-09-24' } }] });
  await applyTodoistSync(db, 'todoist', { sync_token: 'token-2', full_sync: false,
    items: [{ id: 'todo-1', content: 'Work updated', due: { date: '2026-09-24' } }] });
  assert.equal(db.select().from(task).all().length, 1);
  assert.equal(db.select().from(task).get()?.content, 'Work updated');
});

test('jobs are leased once and a repeated enqueue uses the same row', async () => {
  await enqueueJob(db, 'projection', 'decision');
  await enqueueJob(db, 'projection', 'decision');
  assert.equal(db.select().from(syncJob).all().length, 1);
  assert.equal((await leaseJobs(db)).length, 1);
  assert.equal((await leaseJobs(db)).length, 0);
});

test('a remote Google edit is preserved until explicit restore', async () => {
  db.update(eventProjection).set({ syncState: 'ready', conflictKind: null,
    destinationCalendarId: 'cal', googleEventId: 'google-1', lastAppliedEtag: 'old', lastAppliedSourceRevision: 'r1' })
    .where(eq(eventProjection.id, 'projection')).run();
  await applyGoogleSnapshot(db, 'cal', [{ id: 'google-1', etag: 'changed', summary: 'Edited in Google',
    start: { dateTime: '2026-09-24T10:00:00Z' }, end: { dateTime: '2026-09-24T11:00:00Z' } }], 'cursor-3', false);
  assert.equal(db.select().from(eventProjection).where(eq(eventProjection.id, 'projection')).get()?.conflictKind, 'remote_changed');
  assert.equal(db.select().from(googleEvent).where(eq(googleEvent.googleEventId, 'google-1')).get()?.projectionId, 'projection');
  let updates = 0;
  const client = {
    getEvent: async () => ({ id: 'google-1', etag: 'changed', summary: 'Edited in Google' }),
    updateEvent: async (_calendarId: string, _eventId: string, body: { summary?: string }, etag?: string) => {
      updates++; assert.equal(body.summary, 'Invitation'); assert.equal(etag, 'changed');
      return { id: 'google-1', etag: 'restored' };
    },
  } as unknown as GoogleCalendarClient;
  await reconcileProjection(db, 'decision', async () => client);
  assert.equal(updates, 0);
  await reconcileProjection(db, 'decision', async () => client, true);
  assert.equal(updates, 1);
  assert.equal(db.select().from(eventProjection).where(eq(eventProjection.id, 'projection')).get()?.lastAppliedEtag, 'restored');
});
