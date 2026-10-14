import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
  accountAccess,
  calendar,
  connectedAccount,
  db,
  sqlite,
  syncJob,
  task,
  taskBlock,
  taskConnection,
  user,
  userCalendarSetting,
} from '@kairo/db'
import { syncTaskBlocks } from '@kairo/core'
import { taskMirrorCalendarId } from './sync'

for (const file of readdirSync('../../packages/db/migrations')
  .filter((name) => name.endsWith('.sql'))
  .sort())
  sqlite.exec(readFileSync(`../../packages/db/migrations/${file}`, 'utf8').replaceAll('--> statement-breakpoint', ''))
db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' }).run()
db.insert(connectedAccount).values({ id: 'google', ownerUserId: 'owner', provider: 'google' }).run()
db.insert(accountAccess).values({ userId: 'owner', connectedAccountId: 'google' }).run()
db.insert(calendar)
  .values([
    { id: 'default', connectedAccountId: 'google', googleCalendarId: 'primary', name: 'Default', accessRole: 'owner' },
    { id: 'tasks', connectedAccountId: 'google', googleCalendarId: 'tasks', name: 'Tasks', accessRole: 'writer' },
    { id: 'reader', connectedAccountId: 'google', googleCalendarId: 'reader', name: 'Read only', accessRole: 'reader' },
  ])
  .run()
db.insert(userCalendarSetting).values({ userId: 'owner', calendarId: 'default', isDefault: true, isMaybe: true }).run()

test('task calendar defaults to Default, supports an independent override, and moves existing mirrors', async () => {
  assert.equal(db.select().from(userCalendarSetting).get()?.isTasks, false)
  assert.equal(await taskMirrorCalendarId('owner'), 'default')
  assert.equal(await taskMirrorCalendarId('no-access'), null)
  db.insert(taskConnection).values({ id: 'todoist', ownerUserId: 'owner' }).run()
  db.insert(task)
    .values({
      id: 'task',
      connectionId: 'todoist',
      todoistId: 'remote',
      content: 'Work',
      dueDateTime: new Date('2026-10-13T10:00:00Z'),
    })
    .run()
  const [oldId] = await syncTaskBlocks(db, { connectionId: 'todoist' }, await taskMirrorCalendarId('owner'))
  db.update(taskBlock)
    .set({ googleEventId: 'existing-mirror', syncState: 'ready' })
    .where(eq(taskBlock.id, oldId))
    .run()

  db.insert(userCalendarSetting).values({ userId: 'owner', calendarId: 'tasks', isTasks: true }).run()
  assert.equal(await taskMirrorCalendarId('owner'), 'tasks')
  assert.equal(
    db.select().from(userCalendarSetting).where(eq(userCalendarSetting.calendarId, 'default')).get()?.isMaybe,
    true,
  )
  const jobs = await syncTaskBlocks(db, { connectionId: 'todoist' }, await taskMirrorCalendarId('owner'))
  assert.equal(jobs.length, 2)
  assert.equal(db.select().from(taskBlock).where(eq(taskBlock.id, oldId)).get()?.syncState, 'deleting')
  const live = db
    .select()
    .from(taskBlock)
    .all()
    .filter((block) => block.syncState !== 'deleting')
  assert.equal(live.length, 1)
  assert.equal(live[0].calendarId, 'tasks')
  assert.ok(
    jobs.every((id) =>
      db
        .select()
        .from(syncJob)
        .where(eq(syncJob.jobKey, `task-block:${id}`))
        .get(),
    ),
  )
  assert.deepEqual(await syncTaskBlocks(db, { connectionId: 'todoist' }, 'tasks'), [])

  // A lost write permission falls back safely to Default.
  db.update(calendar).set({ accessRole: 'reader' }).where(eq(calendar.id, 'tasks')).run()
  assert.equal(await taskMirrorCalendarId('owner'), 'default')
  db.update(calendar).set({ accessRole: 'writer' }).where(eq(calendar.id, 'tasks')).run()
  db.update(userCalendarSetting).set({ isTasks: false }).where(eq(userCalendarSetting.calendarId, 'tasks')).run()
  assert.equal(await taskMirrorCalendarId('owner'), 'default')
  db.update(userCalendarSetting).set({ isDefault: false }).run()
  assert.equal(await taskMirrorCalendarId('owner'), 'default') // first writable calendar
})
