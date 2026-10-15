import assert from 'node:assert/strict'
import test from 'node:test'
import { closestEventColorId, GoogleCalendarClient, syncGoogleEvents } from './google/index.js'
import { parseIcs } from './ics/index.js'
import {
  createTodoistProvider,
  exchangeTodoistCode,
  floatingToInstant,
  instantToFloating,
  refreshTodoistToken,
  syncTodoist,
  todoistAuthorizationUrl,
} from './todoist/index.js'
import { TaskPatchError } from './tasks.js'

test('Google sync follows pages and commits only the final cursor', async () => {
  const requests: URL[] = []
  const client = new GoogleCalendarClient('test', async (input) => {
    const url = new URL(String(input))
    requests.push(url)
    return Response.json(
      requests.length === 1
        ? { items: [{ id: 'a' }], nextPageToken: 'next' }
        : { items: [{ id: 'b' }], nextSyncToken: 'cursor-2' },
    )
  })
  let applied: unknown
  const cursor = await syncGoogleEvents(client, 'primary', 'cursor-1', async (events, next, context) => {
    applied = { events, next, context }
  })
  assert.equal(cursor, 'cursor-2')
  assert.deepEqual(applied, {
    events: [{ id: 'a' }, { id: 'b' }],
    next: 'cursor-2',
    context: { full: false, complete: true },
  })
  assert.equal(requests[1].searchParams.get('syncToken'), 'cursor-1')
  assert.equal(requests[1].searchParams.get('pageToken'), 'next')
})

test('Google 410 starts a fresh full sync', async () => {
  let count = 0
  const client = new GoogleCalendarClient('test', async (input) => {
    count++
    if (count === 1) return new Response('expired', { status: 410 })
    assert.equal(new URL(String(input)).searchParams.has('syncToken'), false)
    return Response.json({ items: [], nextSyncToken: 'fresh' })
  })
  const cursor = await syncGoogleEvents(client, 'primary', 'old', async (_events, _next, context) =>
    assert.equal(context.full, true),
  )
  assert.equal(cursor, 'fresh')
})

test('ICS expansion applies an exception and remains bounded by the display range', () => {
  const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART:20260920T100000Z\r\nDTEND:20260920T110000Z\r\nRRULE:FREQ=DAILY;COUNT=4\r\nSUMMARY:Original\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:series\r\nRECURRENCE-ID:20260922T100000Z\r\nDTSTART:20260922T120000Z\r\nDTEND:20260922T130000Z\r\nSUMMARY:Changed\r\nEND:VEVENT\r\nEND:VCALENDAR`
  const events = parseIcs(body, new Date('2026-09-21T00:00:00Z'), new Date('2026-09-24T00:00:00Z'))
  assert.equal(events.length, 3)
  assert.equal(events.find((event) => event.title === 'Changed')?.start, '2026-09-22T12:00:00.000Z')
})

test('Todoist uses the v1 form sync contract', async () => {
  const result = await syncTodoist('token', 'cursor', async (input, init) => {
    assert.equal(input, 'https://api.todoist.com/api/v1/sync')
    assert.equal(init?.method, 'POST')
    assert.equal((init?.body as URLSearchParams).get('sync_token'), 'cursor')
    assert.equal((init?.body as URLSearchParams).get('resource_types'), '["items"]')
    return Response.json({ sync_token: 'next', full_sync: false, items: [] })
  })
  assert.equal(result.sync_token, 'next')
})

test('Todoist OAuth requests read-write scope and exchanges a code', async () => {
  const credentials = {
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'http://localhost:3000/api/todoist/callback',
  }
  const url = new URL(todoistAuthorizationUrl(credentials, 'csrf-state'))
  assert.equal(url.origin, 'https://app.todoist.com')
  assert.equal(url.searchParams.get('scope'), 'data:read_write')
  assert.equal(url.searchParams.get('state'), 'csrf-state')
  const token = await exchangeTodoistCode(credentials, 'code', async (input, init) => {
    assert.equal(input, 'https://api.todoist.com/oauth/access_token')
    const body = init?.body as URLSearchParams
    assert.equal(body.get('code'), 'code')
    assert.equal(body.get('redirect_uri'), credentials.redirectUri)
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'data:read' })
  })
  assert.equal(token.refresh_token, 'refresh')
})

test('Todoist refresh requests a rotated token', async () => {
  const credentials = {
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'http://localhost:3000/api/todoist/callback',
  }
  const token = await refreshTodoistToken(credentials, 'old-refresh', async (_input, init) => {
    const body = init?.body as URLSearchParams
    assert.equal(body.get('grant_type'), 'refresh_token')
    assert.equal(body.get('refresh_token'), 'old-refresh')
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
  })
  assert.equal(token.refresh_token, 'new-refresh')
})

test('Todoist floating times convert through the user timezone', () => {
  assert.equal(
    floatingToInstant('2026-03-08T10:00:00.000000', 'America/Chicago').toISOString(),
    '2026-03-08T15:00:00.000Z',
  )
  assert.equal(floatingToInstant('2026-01-15T10:00:00', 'America/Chicago').toISOString(), '2026-01-15T16:00:00.000Z')
  assert.equal(instantToFloating('2026-07-01T15:30:00.000Z', 'America/Chicago'), '2026-07-01T10:30:00')
})

test('Todoist provider sync normalizes dues, projects, and keeps the timezone in its cursor', async () => {
  const bodies: URLSearchParams[] = []
  const provider = createTodoistProvider({
    fetch: async (_input, init) => {
      const body = init?.body as URLSearchParams
      bodies.push(body)
      return Response.json(
        body.get('sync_token') === '*'
          ? {
              sync_token: 's1',
              full_sync: true,
              user: { tz_info: { timezone: 'America/Chicago' } },
              projects: [
                { id: 'p', name: 'Home', color: 'berry_red' },
                { id: 'in', name: 'Inbox', color: 'charcoal', inbox_project: true },
              ],
              items: [
                {
                  id: 'a',
                  content: 'All day',
                  project_id: 'p',
                  due: { date: '2026-10-12', string: 'every day', is_recurring: true },
                },
                {
                  id: 'b',
                  content: 'Floating',
                  project_id: 'in',
                  due: { date: '2026-10-12T09:00:00.000000', timezone: null, string: 'Oct 12 9am' },
                },
                {
                  id: 'c',
                  content: 'Fixed',
                  due: { date: '2026-10-12T14:00:00.000000Z', timezone: 'Europe/Madrid' },
                  duration: { amount: 2, unit: 'day' },
                },
              ],
            }
          : {
              sync_token: 's2',
              full_sync: false,
              items: [{ id: 'd', content: 'Later', due: { date: '2026-10-13T09:00:00' } }],
            },
      )
    },
  })
  const first = await provider.sync('token', 'legacy-plain-token')
  assert.equal(bodies[0].get('sync_token'), '*')
  assert.equal(bodies[0].get('resource_types'), '["items","projects","user"]')
  assert.deepEqual(first.tasks[0].due, { date: '2026-10-12', timeZone: null, string: 'every day', recurring: true })
  assert.equal(first.tasks[0].projectName, 'Home')
  assert.equal(first.tasks[0].projectColor, '#b8256f')
  assert.equal(first.tasks[1].projectColor, null)
  assert.deepEqual(first.tasks[1].due, {
    dateTime: '2026-10-12T14:00:00.000Z',
    timeZone: null,
    string: 'Oct 12 9am',
    recurring: false,
  })
  assert.equal(
    first.tasks[2].due && 'dateTime' in first.tasks[2].due && first.tasks[2].due.dateTime,
    '2026-10-12T14:00:00.000Z',
  )
  assert.equal(first.tasks[2].durationMinutes, 2880)
  const second = await provider.sync('token', first.cursor)
  assert.equal(bodies[1].get('sync_token'), 's1')
  await provider.sync('token', JSON.stringify({ v: 2, token: 's1', tz: null }))
  assert.equal(bodies[2].get('sync_token'), '*')
  assert.equal(
    second.tasks[0].due && 'dateTime' in second.tasks[0].due && second.tasks[0].due.dateTime,
    '2026-10-13T14:00:00.000Z',
  )
})

test('Todoist provider update sends sync commands and preserves recurrence', async () => {
  const requests: { url: string; body?: URLSearchParams }[] = []
  let currentDue: Record<string, unknown> | null = {
    date: '2026-10-12T09:00:00',
    timezone: null,
    string: 'every weekday at 9am',
    lang: 'en',
    is_recurring: true,
  }
  const provider = createTodoistProvider({
    fetch: async (input, init) => {
      const url = String(input)
      requests.push({ url, body: init?.body as URLSearchParams })
      if (url.endsWith('/tasks/t1')) return Response.json({ id: 't1', due: currentDue })
      if (url.endsWith('/user')) return Response.json({ id: 'u', tz_info: { timezone: 'America/Chicago' } })
      const commands = JSON.parse((init?.body as URLSearchParams).get('commands')!) as { uuid: string }[]
      return Response.json({ sync_status: Object.fromEntries(commands.map((command) => [command.uuid, 'ok'])) })
    },
  })
  await provider.update('token', 't1', {
    title: 'Renamed',
    due: { dateTime: '2026-10-13T16:00:00.000Z' },
    completed: true,
  })
  const sync = requests.find((request) => request.url === 'https://api.todoist.com/api/v1/sync')!
  const commands = JSON.parse(sync.body!.get('commands')!)
  assert.deepEqual(
    commands.map((command: { type: string; args: unknown }) => [command.type, command.args]),
    [
      [
        'item_update',
        {
          id: 't1',
          content: 'Renamed',
          due: { date: '2026-10-13T11:00:00', string: 'every weekday at 9am', lang: 'en', is_recurring: true },
        },
      ],
      ['item_close', { id: 't1' }],
    ],
  )
  await assert.rejects(() => provider.update('token', 't1', { due: { date: '2026-10-14' } }), TaskPatchError)
  await assert.rejects(() => provider.update('token', 't1', { due: null }), TaskPatchError)

  currentDue = {
    date: '2026-10-12T07:00:00.000000Z',
    timezone: 'Europe/Madrid',
    string: 'Oct 12 9am',
    is_recurring: false,
  }
  requests.length = 0
  await provider.update('token', 't1', { due: { dateTime: '2026-10-13T16:00:00.000Z' } })
  assert.deepEqual(JSON.parse(requests.at(-1)!.body!.get('commands')!)[0].args, {
    id: 't1',
    due: { date: '2026-10-13T16:00:00Z', timezone: 'Europe/Madrid' },
  })
  requests.length = 0
  await provider.update('token', 't1', { due: null, completed: false })
  assert.deepEqual(
    JSON.parse(requests.at(-1)!.body!.get('commands')!).map((command: { type: string; args: unknown }) => [
      command.type,
      command.args,
    ]),
    [
      ['item_update', { id: 't1', due: null }],
      ['item_uncomplete', { id: 't1' }],
    ],
  )

  // Stored state + cursor timezone: one request, and a recurring "uncomplete" only restores the due.
  requests.length = 0
  await provider.update(
    'token',
    't1',
    { due: { dateTime: '2026-10-13T16:00:00.000Z' }, completed: false },
    {
      current: { timed: true, recurring: true, string: 'every day at 9am', timeZone: null },
      cursor: JSON.stringify({ v: 1, token: 's', tz: 'America/Chicago' }),
    },
  )
  assert.equal(requests.length, 1)
  assert.deepEqual(
    JSON.parse(requests[0].body!.get('commands')!).map((command: { type: string; args: unknown }) => [
      command.type,
      command.args,
    ]),
    [
      [
        'item_update',
        { id: 't1', due: { date: '2026-10-13T11:00:00', string: 'every day at 9am', is_recurring: true } },
      ],
    ],
  )
})

test('Todoist command errors surface as patch errors', async () => {
  const provider = createTodoistProvider({
    fetch: async (_input, init) => {
      const [command] = JSON.parse((init?.body as URLSearchParams).get('commands')!) as { uuid: string }[]
      return Response.json({
        sync_status: { [command.uuid]: { error: 'Item not found', error_code: 22, http_code: 404 } },
      })
    },
  })
  await assert.rejects(() => provider.update('token', 'missing', { title: 'x' }), TaskPatchError)
})

test('Google event colors match on hue, and greys go to Graphite', () => {
  assert.equal(closestEventColorId('#808080'), '8') // Todoist charcoal
  assert.equal(closestEventColorId('#b8b8b8'), '8') // Todoist grey
  assert.equal(closestEventColorId('#f22420'), '11') // Kairo's default task red → Tomato
  assert.equal(closestEventColorId('#4073ff'), '9') // Todoist blue → Blueberry
  assert.equal(closestEventColorId('#299438'), '10') // Todoist green → Basil
})

test('Todoist provider create adds an Inbox task and returns its id', async () => {
  const requests: URLSearchParams[] = []
  const provider = createTodoistProvider({
    fetch: async (_input, init) => {
      const body = init?.body as URLSearchParams
      requests.push(body)
      const [command] = JSON.parse(body.get('commands')!) as { uuid: string; temp_id: string }[]
      return Response.json({ sync_status: { [command.uuid]: 'ok' }, temp_id_mapping: { [command.temp_id]: 'new-1' } })
    },
  })
  const cursor = JSON.stringify({ v: 3, token: 's', tz: 'America/Chicago' })
  const id = await provider.create!(
    'token',
    { title: 'Write report', due: { dateTime: '2026-10-13T16:00:00.000Z' }, durationMinutes: 90 },
    { cursor },
  )
  assert.equal(id, 'new-1')
  const [command] = JSON.parse(requests[0].get('commands')!)
  assert.equal(command.type, 'item_add')
  assert.deepEqual(command.args, {
    content: 'Write report',
    due: { date: '2026-10-13T11:00:00' },
    duration: { amount: 90, unit: 'minute' },
  })

  await provider.create!('token', { title: 'Errand', due: { date: '2026-10-14' }, durationMinutes: 60 }, { cursor })
  assert.deepEqual(JSON.parse(requests[1].get('commands')!)[0].args, {
    content: 'Errand',
    due: { date: '2026-10-14' },
  })
})
