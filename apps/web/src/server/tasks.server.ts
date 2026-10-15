import '@tanstack/react-start/server-only'
import { and, eq } from 'drizzle-orm'
import { db, syncJob, task, taskConnection } from '@kairo/db'
import { enqueueJob, mergePendingPatch, syncTaskBlocks } from '@kairo/core'
import type { TaskCreate, TaskPatch } from '@kairo/integrations'
import { requireUser } from './auth'
import { connectionCanWrite, createProviderTask, processJobs, taskMirrorCalendarId } from './sync'

// Applies the patch locally (optimistic), records it as pending, and enqueues a provider push.
// durationMinutes is Kairo-only (null clears the user override).
export async function updateTaskImpl(
  data: TaskPatch & { id: string; durationMinutes?: number | null },
): Promise<{ ok: true }> {
  const user = await requireUser()
  const [row] = await db
    .select({ item: task, connection: taskConnection })
    .from(task)
    .innerJoin(taskConnection, eq(task.connectionId, taskConnection.id))
    .where(and(eq(task.id, data.id), eq(taskConnection.ownerUserId, user.id)))
  if (!row || row.item.deleted) throw new Response('Task unavailable', { status: 404 })
  const { connection } = row
  const now = new Date()
  // Decided inside one transaction so the pending patch we merge into is the current one.
  const { patch, enqueue } = db.transaction((tx) => {
    const item = tx.select().from(task).where(eq(task.id, data.id)).get()!
    const pending: TaskPatch = item.pendingPatch ? JSON.parse(item.pendingPatch) : {}
    const job = tx
      .select({ leaseUntil: syncJob.leaseUntil })
      .from(syncJob)
      .where(eq(syncJob.jobKey, `task-push:${item.id}`))
      .get()
    const inFlight = !!job?.leaseUntil && job.leaseUntil > now
    const localDue = item.dueDateTime
      ? { dateTime: item.dueDateTime.toISOString() }
      : item.dueDate
        ? { date: item.dueDate.slice(0, 10) }
        : null
    const due = data.due && 'dateTime' in data.due ? { dateTime: new Date(data.due.dateTime).toISOString() } : data.due
    const undo = data.completed === false && item.completed
    // Undoing a completion that hasn't been sent just cancels it; a sent one is reverted (recurring: by restoring the due).
    const cancel = undo && pending.completed === true && !inFlight
    const patch: TaskPatch = {}
    if (data.title !== undefined && data.title !== item.content) patch.title = data.title
    if (
      due !== undefined &&
      (JSON.stringify(due) !== JSON.stringify(localDue) || (undo && !cancel && item.dueRecurring))
    )
      patch.due = due
    if (data.completed !== undefined && data.completed !== item.completed && !(undo && !cancel && item.dueRecurring))
      patch.completed = data.completed
    const sends = Object.keys(patch).some((key) => !(cancel && key === 'completed'))
    if (sends && !connectionCanWrite(connection)) throw new Error('Reconnect Todoist to edit tasks')
    if (patch.due !== undefined && item.dueRecurring) {
      if (patch.due === null)
        throw new Error('Recurring Todoist tasks cannot lose their date; edit the recurrence in Todoist')
      if ('dateTime' in patch.due !== !!item.dueDateTime)
        throw new Error(
          `Recurring Todoist tasks can only move to another ${item.dueDateTime ? 'time' : 'day'}; change the recurrence in Todoist`,
        )
    }
    const local: Partial<typeof task.$inferInsert> = { updatedAt: now }
    if (patch.title !== undefined) local.content = patch.title
    if (patch.due !== undefined)
      Object.assign(local, {
        dueDate: patch.due && 'date' in patch.due ? patch.due.date : null,
        dueDateTime: patch.due && 'dateTime' in patch.due ? new Date(patch.due.dateTime) : null,
        ...(item.dueRecurring ? {} : { dueString: null }),
      })
    if (data.completed !== undefined && data.completed !== item.completed)
      Object.assign(local, { completed: data.completed, completedAt: data.completed ? now : null })
    if (data.durationMinutes !== undefined) local.durationOverrideMinutes = data.durationMinutes
    const merged = mergePendingPatch(pending, patch, inFlight)
    tx.update(task)
      .set({ ...local, pendingPatch: Object.keys(merged).length ? JSON.stringify(merged) : null })
      .where(eq(task.id, item.id))
      .run()
    return { patch, enqueue: sends }
  })
  const item = row.item
  if (enqueue) await enqueueJob(db, 'task-push', item.id)
  await syncTaskBlocks(
    db,
    { taskIds: [item.id] },
    await taskMirrorCalendarId(user.id),
    patch.title !== undefined ? [item.id] : [],
  )
  void processJobs().catch((error) => console.error('Task sync failed', error))
  return { ok: true }
}

export async function createTaskImpl(data: TaskCreate): Promise<{ id: string | null }> {
  const user = await requireUser()
  const id = await createProviderTask(user.id, data)
  void processJobs().catch((error) => console.error('Task sync failed', error))
  return { id }
}
