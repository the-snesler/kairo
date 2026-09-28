import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleCalendarClient, syncGoogleEvents } from './google/index.js';
import { parseIcs } from './ics/index.js';
import { syncTodoist } from './todoist/index.js';

test('Google sync follows pages and commits only the final cursor', async () => {
  const requests: URL[] = [];
  const client = new GoogleCalendarClient('test', async input => {
    const url = new URL(String(input)); requests.push(url);
    return Response.json(requests.length === 1 ? { items: [{ id: 'a' }], nextPageToken: 'next' } :
      { items: [{ id: 'b' }], nextSyncToken: 'cursor-2' });
  });
  let applied: unknown;
  const cursor = await syncGoogleEvents(client, 'primary', 'cursor-1', async (events, next, context) => { applied = { events, next, context }; });
  assert.equal(cursor, 'cursor-2');
  assert.deepEqual(applied, { events: [{ id: 'a' }, { id: 'b' }], next: 'cursor-2', context: { full: false, complete: true } });
  assert.equal(requests[1].searchParams.get('syncToken'), 'cursor-1');
  assert.equal(requests[1].searchParams.get('pageToken'), 'next');
});

test('Google 410 starts a fresh full sync', async () => {
  let count = 0;
  const client = new GoogleCalendarClient('test', async input => {
    count++;
    if (count === 1) return new Response('expired', { status: 410 });
    assert.equal(new URL(String(input)).searchParams.has('syncToken'), false);
    return Response.json({ items: [], nextSyncToken: 'fresh' });
  });
  const cursor = await syncGoogleEvents(client, 'primary', 'old', async (_events, _next, context) => assert.equal(context.full, true));
  assert.equal(cursor, 'fresh');
});

test('ICS expansion applies an exception and remains bounded by the display range', () => {
  const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART:20260920T100000Z\r\nDTEND:20260920T110000Z\r\nRRULE:FREQ=DAILY;COUNT=4\r\nSUMMARY:Original\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:series\r\nRECURRENCE-ID:20260922T100000Z\r\nDTSTART:20260922T120000Z\r\nDTEND:20260922T130000Z\r\nSUMMARY:Changed\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const events = parseIcs(body, new Date('2026-09-21T00:00:00Z'), new Date('2026-09-24T00:00:00Z'));
  assert.equal(events.length, 3);
  assert.equal(events.find(event => event.title === 'Changed')?.start, '2026-09-22T12:00:00.000Z');
});

test('Todoist uses the v1 form sync contract', async () => {
  const result = await syncTodoist('token', 'cursor', async (input, init) => {
    assert.equal(input, 'https://api.todoist.com/api/v1/sync');
    assert.equal(init?.method, 'POST');
    assert.equal((init?.body as URLSearchParams).get('sync_token'), 'cursor');
    assert.equal((init?.body as URLSearchParams).get('resource_types'), '["items"]');
    return Response.json({ sync_token: 'next', full_sync: false, items: [] });
  });
  assert.equal(result.sync_token, 'next');
});
