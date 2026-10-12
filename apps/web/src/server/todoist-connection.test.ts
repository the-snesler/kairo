import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { db, sqlite, calendar, connectedAccount, task, taskBlock, taskConnection, user } from '@kairo/db'
import { decryptJson, encryptJson } from './credentials'
import { saveTodoistConnection, syncTodoistConnection } from './sync'

sqlite.exec(readFileSync('../../packages/db/migrations/0000_minor_norman_osborn.sql', 'utf8').replaceAll('--> statement-breakpoint', ''))
db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' }).run()
db.insert(connectedAccount).values({ id: 'google', ownerUserId: 'owner', provider: 'google' }).run()
db.insert(calendar).values({ id: 'cal', connectedAccountId: 'google', googleCalendarId: 'primary', name: 'Calendar' }).run()
db.insert(taskConnection).values({ id: 'todoist', ownerUserId: 'owner', encryptedCredentials: encryptJson({ token: 'old-personal-token' }) }).run()
db.insert(task).values({ id: 'task', connectionId: 'todoist', todoistId: 'remote-task', content: 'Existing task' }).run()
db.insert(taskBlock).values({ id: 'block', taskId: 'task', calendarId: 'cal', startAt: new Date('2026-09-28T10:00:00Z'), endAt: new Date('2026-09-28T11:00:00Z') }).run()

test('OAuth reuses the task connection and rotates credentials without losing blocks', async () => {
  const connection = await saveTodoistConnection('owner', 'todoist-user', {
    access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 1, scope: 'data:read' })
  assert.equal(connection.id, 'todoist')
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
  try { await syncTodoistConnection(connection.id) } finally { globalThis.fetch = originalFetch }
  const stored = db.select().from(taskConnection).where(eq(taskConnection.id, 'todoist')).get()!
  const credentials = decryptJson<{ refreshToken: string }>(stored.encryptedCredentials!)
  assert.equal(credentials.refreshToken, 'refresh-2')
  assert.equal(stored.syncToken, 'next')
  assert.equal(db.select().from(taskBlock).get()?.taskId, 'task')

  await assert.rejects(() => saveTodoistConnection('owner', 'another-user', {
    access_token: 'different', refresh_token: 'different-refresh', expires_in: 3600 }))
  assert.equal(db.select().from(taskConnection).get()?.providerSubject, 'todoist-user')

  db.update(taskConnection).set({ encryptedCredentials: encryptJson({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: Date.now() - 1000 }) })
    .where(eq(taskConnection.id, 'todoist')).run()
  globalThis.fetch = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as typeof fetch
  try { await assert.rejects(() => syncTodoistConnection(connection.id)) } finally { globalThis.fetch = originalFetch }
  assert.equal(db.select().from(taskConnection).where(eq(taskConnection.id, 'todoist')).get()?.status, 'reconnect')
  assert.equal(db.select().from(taskBlock).get()?.id, 'block')
  globalThis.fetch = (async () => { throw new Error('A reconnect-required token must not be retried') }) as typeof fetch
  try { await assert.rejects(() => syncTodoistConnection(connection.id), /Reconnect Todoist/) }
  finally { globalThis.fetch = originalFetch }
})
