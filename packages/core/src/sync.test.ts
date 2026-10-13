import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '@kairo/db';
import { calendar, connectedAccount, eventDecision, eventProjection, externalEvent, googleEvent, icsSource, syncJob, task, taskBlock, taskConnection, taskEstimate, user } from '@kairo/db/schema';
import { applyGoogleSnapshot, applyIcsSnapshot, applyTaskSync, clearPendingFields, enqueueJob, finishJob, isJobRunning, leaseJobs, mergePendingPatch, planTaskBlock, pushPendingPatch, reconcileProjection, reconcileTaskBlock, syncTaskBlocks } from './sync.js';
import type { GoogleCalendarClient, NormalizedTask } from '@kairo/integrations';

for (const file of readdirSync('../db/migrations').filter(name => name.endsWith('.sql')).sort())
  sqlite.exec(readFileSync(`../db/migrations/${file}`, 'utf8').replaceAll('--> statement-breakpoint', ''));
const normalized = (externalId: string, overrides: Partial<NormalizedTask> = {}): NormalizedTask => ({ externalId, title: 'Work', description: null,
  projectId: null, projectName: null, projectColor: null, priority: 1, due: null, durationMinutes: null, completed: false, deleted: false, updatedAt: null, ...overrides });
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

  await applyTaskSync(db, 'todoist', { cursor: 'token-1', full: true, tasks: [normalized('todo-1', { due: { date: '2026-09-24' } })] });
  await applyTaskSync(db, 'todoist', { cursor: 'token-2', full: false, tasks: [normalized('todo-1', { title: 'Work updated', due: { date: '2026-09-24' } })] });
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

test('task sync keeps pending fields and the duration override, and fills project names', async () => {
  await applyTaskSync(db, 'todoist', { cursor: 'p-1', full: false, projects: [{ id: 'proj', name: 'Inbox', color: '#808080' }],
    tasks: [normalized('todo-2', { title: 'Write', projectId: 'proj', due: { dateTime: '2026-09-24T10:00:00.000Z' }, durationMinutes: 45 })] });
  const local = db.select().from(task).where(eq(task.todoistId, 'todo-2')).get()!;
  assert.equal(local.projectName, 'Inbox');
  assert.equal(local.projectColor, '#808080');
  const pendingPatch = JSON.stringify({ due: { dateTime: '2026-09-25T12:00:00.000Z' } });
  db.update(task).set({ pendingPatch, durationOverrideMinutes: 90, dueDateTime: new Date('2026-09-25T12:00:00Z') }).where(eq(task.id, local.id)).run();
  await applyTaskSync(db, 'todoist', { cursor: 'p-2', full: false,
    tasks: [normalized('todo-2', { title: 'Write more', projectId: 'proj', due: { dateTime: '2026-09-24T10:00:00.000Z' }, durationMinutes: 30 })] });
  const after = db.select().from(task).where(eq(task.id, local.id)).get()!;
  assert.equal(after.dueDateTime?.toISOString(), '2026-09-25T12:00:00.000Z');
  assert.equal(after.content, 'Write more');
  assert.equal(after.durationMinutes, 30);
  assert.equal(after.durationOverrideMinutes, 90);
  assert.equal(after.projectName, 'Inbox');
  await applyTaskSync(db, 'todoist', { cursor: 'p-3', full: false, projects: [{ id: 'proj', name: 'Renamed', color: '#4073ff' }], tasks: [] });
  assert.equal(db.select().from(task).where(eq(task.id, local.id)).get()?.projectName, 'Renamed');
  assert.equal(db.select().from(task).where(eq(task.id, local.id)).get()?.projectColor, '#4073ff');
});

test('an incremental sync names new tasks in unchanged projects', async () => {
  await applyTaskSync(db, 'todoist', { cursor: 'p-4', full: false, tasks: [normalized('todo-3', { title: 'New', projectId: 'proj' })] });
  assert.equal(db.select().from(task).where(eq(task.todoistId, 'todo-3')).get()?.projectName, 'Renamed');
  await applyTaskSync(db, 'todoist', { cursor: 'p-5', full: false, tasks: [normalized('todo-3', { title: 'New', projectId: 'unknown' })] });
  assert.equal(db.select().from(task).where(eq(task.todoistId, 'todo-3')).get()?.projectName, null);
});

test('pushed fields are cleared individually; newer edits stay pending', async () => {
  const local = db.select().from(task).where(eq(task.todoistId, 'todo-2')).get()!;
  const read = () => JSON.parse(db.select().from(task).where(eq(task.id, local.id)).get()!.pendingPatch ?? 'null');
  db.update(task).set({ pendingPatch: JSON.stringify({ completed: true, title: 'A' }) }).where(eq(task.id, local.id)).run();
  const pushed = await pushPendingPatch(db, local.id, async (_item, patch) => {
    assert.deepEqual(patch, { completed: true, title: 'A' });
    db.update(task).set({ pendingPatch: JSON.stringify({ completed: true, title: 'B', due: { date: '2026-09-30' } }) }).where(eq(task.id, local.id)).run();
  });
  assert.deepEqual(pushed, { status: 'pushed', remaining: { title: 'B', due: { date: '2026-09-30' } } });
  assert.deepEqual(read(), { title: 'B', due: { date: '2026-09-30' } });
  assert.deepEqual(clearPendingFields(db, local.id, { title: 'B', due: { date: '2026-09-30' } }), {});
  assert.equal(read(), null);

  db.update(task).set({ pendingPatch: JSON.stringify({ title: 'C' }) }).where(eq(task.id, local.id)).run();
  const rejected = await pushPendingPatch(db, local.id, async () => {
    db.update(task).set({ pendingPatch: JSON.stringify({ title: 'C', completed: false }) }).where(eq(task.id, local.id)).run();
    throw new Error('refused');
  }, () => true);
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(read(), { completed: false });
  db.update(task).set({ pendingPatch: null }).where(eq(task.id, local.id)).run();
});

test('undoing an unsent completion cancels it; a sent or in-flight one is reverted', () => {
  assert.deepEqual(mergePendingPatch({ completed: true, title: 'x' }, { completed: false }, false), { title: 'x' });
  assert.deepEqual(mergePendingPatch({ completed: true }, { completed: false }, true), { completed: false });
  assert.deepEqual(mergePendingPatch({}, { completed: false, due: { date: '2026-09-24' } }, false), { completed: false, due: { date: '2026-09-24' } });
  assert.deepEqual(mergePendingPatch({ completed: true }, { due: { date: '2026-09-24' } }, true), { completed: true, due: { date: '2026-09-24' } });
});

test('enqueueing a running job does not release its lease, and it runs again after finishing', async () => {
  db.delete(syncJob).run();
  await enqueueJob(db, 'task-push', 'rerun');
  const [job] = await leaseJobs(db);
  await new Promise(resolve => setTimeout(resolve, 2));
  await enqueueJob(db, 'task-push', 'rerun');
  assert.equal(await isJobRunning(db, 'task-push', 'rerun'), true);
  assert.equal((await leaseJobs(db)).length, 0);
  await finishJob(db, job);
  const [again] = await leaseJobs(db);
  assert.equal(again?.id, job.id);
  await finishJob(db, again);
  assert.equal(db.select().from(syncJob).all().length, 0);
  await enqueueJob(db, 'task-push', 'failing');
  const [failing] = await leaseJobs(db);
  await finishJob(db, failing, new Error('boom'));
  const stored = db.select().from(syncJob).get()!;
  assert.equal(stored.attempts, 1);
  assert.ok(stored.nextRunAt > new Date());
  db.delete(syncJob).run();
});

test('mirror blocks follow timed open tasks only', () => {
  const item = { id: 't', dueDateTime: new Date('2026-09-24T10:00:00Z'), completed: false, deleted: false, durationOverrideMinutes: null, durationMinutes: null };
  const block = (id: string, calendarId: string, minutes = 30, syncState = 'ready') => ({ id, calendarId, syncState,
    startAt: new Date('2026-09-24T10:00:00Z'), endAt: new Date(Date.parse('2026-09-24T10:00:00Z') + minutes * 60_000) });
  assert.deepEqual(planTaskBlock(item, null, [block('a', 'cal'), block('b', 'cal'), block('c', 'other')], 'cal').remove, ['b', 'c']);
  assert.equal(planTaskBlock(item, null, [block('a', 'cal')], 'cal').block?.changed, false);
  const estimated = planTaskBlock(item, 50, [block('a', 'cal')], 'cal').block!;
  assert.equal(estimated.changed, true);
  assert.equal(estimated.endAt.toISOString(), '2026-09-24T10:50:00.000Z');
  assert.equal(planTaskBlock({ ...item, durationOverrideMinutes: 15, durationMinutes: 60 }, 50, [], 'cal').block?.endAt.toISOString(), '2026-09-24T10:15:00.000Z');
  assert.deepEqual(planTaskBlock({ ...item, dueDateTime: null }, null, [block('a', 'cal'), block('d', 'cal', 30, 'deleting')], 'cal'), { block: null, remove: ['a'] });
  assert.deepEqual(planTaskBlock({ ...item, completed: true }, null, [block('a', 'cal')], 'cal').remove, ['a']);
  assert.equal(planTaskBlock(item, null, [], null).block, null);
});

test('mirror blocks are created, moved, and deleted through Google', async () => {
  const local = db.select().from(task).where(eq(task.todoistId, 'todo-2')).get()!;
  db.delete(syncJob).run();
  db.insert(taskEstimate).values({ taskId: local.id, minutes: 20, provider: 'test', model: 'test', inputHash: 'x' }).run();
  db.update(task).set({ durationMinutes: null, durationOverrideMinutes: null }).where(eq(task.id, local.id)).run();
  const [created] = await syncTaskBlocks(db, { connectionId: 'todoist' }, 'cal');
  const stored = db.select().from(taskBlock).where(eq(taskBlock.id, created)).get()!;
  assert.equal(stored.endAt.getTime() - stored.startAt.getTime(), 20 * 60_000);
  assert.deepEqual(await syncTaskBlocks(db, { connectionId: 'todoist' }, 'cal'), []);
  const calls: string[] = [];
  const client = {
    findByPrivateProperty: async () => undefined,
    createEvent: async (_cal: string, body: { summary?: string }) => { calls.push(`create:${body.summary}`); return { id: 'g-block', etag: 'e1' }; },
    updateEvent: async (_cal: string, id: string) => { calls.push(`update:${id}`); return { id, etag: 'e2' }; },
    deleteEvent: async (_cal: string, id: string) => { calls.push(`delete:${id}`); },
  } as unknown as GoogleCalendarClient;
  await reconcileTaskBlock(db, created, async () => client);
  assert.equal(db.select().from(taskBlock).where(eq(taskBlock.id, created)).get()?.googleEventId, 'g-block');
  db.update(task).set({ dueDateTime: new Date('2026-09-24T15:00:00Z') }).where(eq(task.id, local.id)).run();
  assert.deepEqual(await syncTaskBlocks(db, { taskIds: [local.id] }, 'cal'), [created]);
  await reconcileTaskBlock(db, created, async () => client);
  db.update(task).set({ dueDateTime: null, dueDate: '2026-09-24' }).where(eq(task.id, local.id)).run();
  await syncTaskBlocks(db, { taskIds: [local.id] }, 'cal');
  assert.equal(db.select().from(taskBlock).where(eq(taskBlock.id, created)).get()?.syncState, 'deleting');
  await reconcileTaskBlock(db, created, async () => client);
  assert.equal(db.select().from(taskBlock).where(eq(taskBlock.taskId, local.id)).all().length, 0);
  assert.deepEqual(calls, ['create:Write more', 'update:g-block', 'delete:g-block']);
});
