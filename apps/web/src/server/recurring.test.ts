import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { and, eq } from 'drizzle-orm'
import { accountAccess, calendar, connectedAccount, db, googleEvent, sqlite, user } from '@kairo/db'
import { normalizeGoogleEvent } from '@kairo/core'
import type { GoogleEvent } from '@kairo/integrations'
import { encryptJson } from './credentials'
import { deleteRecurringEventForUser, getAdjacentOccurrenceForUser, saveRecurringEventForUser } from './recurring'

for (const file of readdirSync('../../packages/db/migrations')
  .filter((name) => name.endsWith('.sql'))
  .sort())
  sqlite.exec(readFileSync(`../../packages/db/migrations/${file}`, 'utf8').replaceAll('--> statement-breakpoint', ''))
db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' }).run()
db.insert(connectedAccount)
  .values({
    id: 'google',
    ownerUserId: 'owner',
    provider: 'google',
    encryptedCredentials: encryptJson({
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600_000,
    }),
  })
  .run()
db.insert(accountAccess).values({ userId: 'owner', connectedAccountId: 'google' }).run()
db.insert(calendar)
  .values([
    { id: 'cal', connectedAccountId: 'google', googleCalendarId: 'primary', name: 'Main', accessRole: 'owner' },
    { id: 'ro', connectedAccountId: 'google', googleCalendarId: 'shared', name: 'Shared', accessRole: 'reader' },
  ])
  .run()

const tz = 'America/Los_Angeles'
const at = (dateTime: string) => ({ dateTime, timeZone: tz })
const master: GoogleEvent = {
  id: 'm',
  etag: '"m1"',
  summary: 'Standup',
  start: at('2026-10-02T13:20:00-07:00'),
  end: at('2026-10-02T14:20:00-07:00'),
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'],
}
const occurrence = (date: string): GoogleEvent => ({
  id: `m_${date.replaceAll('-', '')}`,
  etag: `"${date}"`,
  summary: 'Standup',
  recurringEventId: 'm',
  originalStartTime: at(`${date}T13:20:00-07:00`),
  start: at(`${date}T13:20:00-07:00`),
  end: at(`${date}T14:20:00-07:00`),
})
const later: GoogleEvent = { ...occurrence('2026-10-30'), summary: 'Edited later' }
db.insert(googleEvent)
  .values([{ ...normalizeGoogleEvent('cal', master), color: '#123456' }, normalizeGoogleEvent('cal', later)])
  .run()

type Call = { method: string; path: string; body?: Record<string, unknown>; ifMatch?: string }
async function withGoogle(handler: (call: Call) => Response, run: () => Promise<unknown>) {
  const calls: Call[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace('/calendar/v3', '') + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      ifMatch: headers['If-Match'],
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
  return calls
}

test('this and following splits the series in Google and in the local cache', async () => {
  const instance = occurrence('2026-10-16')
  const calls = await withGoogle(
    (call) => {
      if (call.method === 'GET' && call.path === '/calendars/primary/events/m_20261016') return Response.json(instance)
      if (call.method === 'GET' && call.path === '/calendars/primary/events/m') return Response.json(master)
      if (call.method === 'GET' && call.path.startsWith('/calendars/primary/events/m/instances?'))
        return Response.json({ items: [occurrence('2026-10-02')] })
      if (call.method === 'PATCH') return Response.json({ ...master, ...call.body, etag: '"m2"' })
      if (call.method === 'DELETE') return new Response(null, { status: 204 })
      if (call.method === 'POST') return Response.json({ ...call.body, id: 'n', etag: '"n1"' })
      return new Response('unexpected', { status: 500 })
    },
    () =>
      saveRecurringEventForUser('owner', {
        id: 'instance:cal:m_20261016',
        scope: 'following',
        patch: { title: 'New standup' },
      }),
  )
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      'GET /calendars/primary/events/m_20261016',
      'GET /calendars/primary/events/m',
      `GET /calendars/primary/events/m/instances?maxResults=1&timeMax=${encodeURIComponent('2026-10-16T20:20:00.000Z')}`,
      'PATCH /calendars/primary/events/m',
      'DELETE /calendars/primary/events/m_20261030',
      'POST /calendars/primary/events',
    ],
  )
  assert.equal(calls[3].ifMatch, '"m1"')
  assert.deepEqual(calls[3].body?.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261016T201959Z'])
  assert.deepEqual(calls[5].body?.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=FR'])
  assert.equal(calls[5].body?.summary, 'New standup')

  const rows = db.select().from(googleEvent).all()
  assert.deepEqual(rows.map((row) => row.googleEventId).sort(), ['m', 'n'])
  assert.equal(rows.find((row) => row.googleEventId === 'n')?.color, '#123456')
  assert.match(rows.find((row) => row.googleEventId === 'm')!.rawJson!, /UNTIL=20261016T201959Z/)
})

test('deleting following with no live earlier occurrence deletes the whole series', async () => {
  const calls = await withGoogle(
    (call) => {
      if (call.method === 'GET' && call.path.includes('/instances?')) return Response.json({ items: [] })
      if (call.method === 'GET' && call.path.endsWith('/m_20261009')) return Response.json(occurrence('2026-10-09'))
      if (call.method === 'GET') return Response.json(master)
      return new Response('precondition', { status: 412 })
    },
    () =>
      assert.rejects(
        () => deleteRecurringEventForUser('owner', { id: 'instance:cal:m_20261009', scope: 'following' }),
        /changed in Google Calendar/,
      ),
  )
  assert.equal(calls.at(-1)?.method, 'DELETE')
  assert.equal(calls.at(-1)?.path, '/calendars/primary/events/m')
})

test('a changed series surfaces a refresh error, and read-only calendars are rejected', async () => {
  await withGoogle(
    (call) => {
      if (call.method === 'GET' && call.path.endsWith('/m_20261009')) return Response.json(occurrence('2026-10-09'))
      if (call.method === 'GET') return Response.json(master)
      return new Response('precondition', { status: 412 })
    },
    () =>
      assert.rejects(
        () => deleteRecurringEventForUser('owner', { id: 'instance:cal:m_20261009', scope: 'all' }),
        /changed in Google Calendar/,
      ),
  )
  await withGoogle(
    (call) => Response.json(call.path.endsWith('/m') ? master : occurrence('2026-10-09')),
    () =>
      assert.rejects(
        () => deleteRecurringEventForUser('owner', { id: 'instance:ro:m_20261009', scope: 'this' }),
        /read only/,
      ),
  )
  assert.equal(
    db
      .select()
      .from(googleEvent)
      .where(and(eq(googleEvent.calendarId, 'cal'), eq(googleEvent.googleEventId, 'm')))
      .all().length,
    1,
  )
})

test('adjacent occurrences skip cancelled ones and use snapshot ids', async () => {
  const instances = [
    occurrence('2026-10-02'),
    occurrence('2026-10-09'),
    { ...occurrence('2026-10-16'), status: 'cancelled' },
    occurrence('2026-10-23'),
  ]
  let prev: unknown, next: unknown
  const calls = await withGoogle(
    (call) =>
      call.path.includes('/instances') ? Response.json({ items: instances }) : Response.json(occurrence('2026-10-09')),
    async () => {
      next = await getAdjacentOccurrenceForUser('owner', { id: 'instance:cal:m_20261009', direction: 'next' })
      prev = await getAdjacentOccurrenceForUser('owner', { id: 'instance:cal:m_20261009', direction: 'prev' })
    },
  )
  assert.ok(calls[1].path.startsWith('/calendars/primary/events/m/instances?'))
  assert.deepEqual(next, {
    id: 'instance:cal:m_20261023',
    start: '2026-10-23T13:20:00-07:00',
    end: '2026-10-23T14:20:00-07:00',
    allDay: false,
  })
  assert.equal((prev as { id: string }).id, 'instance:cal:m_20261002')
})
