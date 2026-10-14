import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { db, sqlite, calendar, connectedAccount, task, taskBlock, taskConnection, user } from '@kairo/db'
import { decryptJson, encryptJson } from './credentials'
import { connectionCanWrite, pushTask, saveTodoistConnection, syncTodoistConnection } from './sync'

for (const file of readdirSync('../../packages/db/migrations')
  .filter((name) => name.endsWith('.sql'))
  .sort())
  sqlite.exec(readFileSync(`../../packages/db/migrations/${file}`, 'utf8').replaceAll('--> statement-breakpoint', ''))
db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' }).run()
db.insert(connectedAccount).values({ id: 'google', ownerUserId: 'owner', provider: 'google' }).run()
db.insert(calendar)
  .values({ id: 'cal', connectedAccountId: 'google', googleCalendarId: 'primary', name: 'Calendar' })
  .run()
db.insert(taskConnection)
  .values({ id: 'todoist', ownerUserId: 'owner', encryptedCredentials: encryptJson({ token: 'old-personal-token' }) })
  .run()
db.insert(task)
  .values({ id: 'task', connectionId: 'todoist', todoistId: 'remote-task', content: 'Existing task' })
  .run()
db.insert(taskBlock)
  .values({
    id: 'block',
    taskId: 'task',
    calendarId: 'cal',
    startAt: new Date('2026-09-28T10:00:00Z'),
    endAt: new Date('2026-09-28T11:00:00Z'),
  })
  .run()

test('OAuth reuses the task connection and rotates credentials without losing blocks', async () => {
  const connection = await saveTodoistConnection('owner', 'todoist-user', {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 1,
    scope: 'data:read',
  })
  assert.equal(connection.id, 'todoist')
  assert.equal(connection.scope, 'data:read')
  assert.equal(connectionCanWrite(connection), false)
  assert.equal(db.select().from(task).get()?.id, 'task')
  assert.equal(db.select().from(taskBlock).get()?.id, 'block')

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith('/oauth/access_token')) {
      assert.equal((init?.body as URLSearchParams).get('refresh_token'), 'refresh-1')
      return Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })
    }
    assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, 'Bearer access-2')
    return Response.json({ sync_token: 'next', full_sync: false, items: [] })
  }) as typeof fetch
  try {
    await syncTodoistConnection(connection.id)
  } finally {
    globalThis.fetch = originalFetch
  }
  const stored = db.select().from(taskConnection).where(eq(taskConnection.id, 'todoist')).get()!
  const credentials = decryptJson<{ refreshToken: string }>(stored.encryptedCredentials!)
  assert.equal(credentials.refreshToken, 'refresh-2')
  assert.equal(JSON.parse(stored.syncToken!).token, 'next')
  assert.equal(db.select().from(taskBlock).get()?.taskId, 'task')

  const upgraded = await saveTodoistConnection('owner', 'todoist-user', {
    access_token: 'access-3',
    refresh_token: 'refresh-3',
    expires_in: 3600,
  })
  assert.equal(upgraded.scope, 'data:read_write')
  assert.equal(connectionCanWrite(upgraded), true)
  db.update(taskConnection)
    .set({ encryptedCredentials: stored.encryptedCredentials })
    .where(eq(taskConnection.id, 'todoist'))
    .run()
  await assert.rejects(() =>
    saveTodoistConnection('owner', 'another-user', {
      access_token: 'different',
      refresh_token: 'different-refresh',
      expires_in: 3600,
    }),
  )
  assert.equal(db.select().from(taskConnection).get()?.providerSubject, 'todoist-user')

  db.update(taskConnection)
    .set({
      encryptedCredentials: encryptJson({
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresAt: Date.now() - 1000,
      }),
    })
    .where(eq(taskConnection.id, 'todoist'))
    .run()
  globalThis.fetch = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as typeof fetch
  try {
    await assert.rejects(() => syncTodoistConnection(connection.id))
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(db.select().from(taskConnection).where(eq(taskConnection.id, 'todoist')).get()?.status, 'reconnect')
  assert.equal(db.select().from(taskBlock).get()?.id, 'block')
  globalThis.fetch = (async () => {
    throw new Error('A reconnect-required token must not be retried')
  }) as typeof fetch
  try {
    await assert.rejects(() => syncTodoistConnection(connection.id), /Reconnect Todoist/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a pending task patch is pushed to Todoist and then cleared', async () => {
  db.update(taskConnection)
    .set({
      status: 'ready',
      scope: 'data:read_write',
      encryptedCredentials: encryptJson({ accessToken: 'live', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }),
    })
    .where(eq(taskConnection.id, 'todoist'))
    .run()
  db.update(task)
    .set({ pendingPatch: JSON.stringify({ title: 'Renamed', completed: true }) })
    .where(eq(task.id, 'task'))
    .run()
  const originalFetch = globalThis.fetch
  let commands: { type: string; args: unknown }[] = []
  globalThis.fetch = (async (_input, init) => {
    commands = JSON.parse((init?.body as URLSearchParams).get('commands')!)
    return Response.json({
      sync_status: Object.fromEntries(commands.map((command) => [(command as unknown as { uuid: string }).uuid, 'ok'])),
    })
  }) as typeof fetch
  try {
    await pushTask('task')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(
    commands.map((command) => [command.type, command.args]),
    [
      ['item_update', { id: 'remote-task', content: 'Renamed' }],
      ['item_close', { id: 'remote-task' }],
    ],
  )
  assert.equal(db.select().from(task).where(eq(task.id, 'task')).get()?.pendingPatch, null)
})
