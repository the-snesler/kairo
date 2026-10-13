import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { calendar, eventDecision, eventProjection, externalEvent, googleEvent, icsSource,
  syncJob, task, taskBlock, taskConnection, taskEstimate } from '@kairo/db/schema';
import { DEFAULT_TASK_COLOR, GoogleApiError, type GoogleCalendarClient, type GoogleEvent, type IcsOccurrence, type NormalizedTask, type TaskPatch, type TaskSyncResult } from '@kairo/integrations';

type Db = any;
const date = (value?: string) => value ? new Date(value) : null;

export function normalizeGoogleEvent(calendarId: string, event: GoogleEvent) {
  const allDay = !!event.start?.date;
  return { calendarId, googleEventId: event.id, recurringEventId: event.recurringEventId ?? null,
    originalStartTime: event.originalStartTime?.dateTime ?? event.originalStartTime?.date ?? null,
    etag: event.etag ?? null, eventType: event.eventType ?? 'default', title: event.summary ?? '',
    description: event.description ?? null, location: event.location ?? null,
    startAt: allDay ? null : date(event.start?.dateTime), endAt: allDay ? null : date(event.end?.dateTime),
    startDate: event.start?.date ?? null, endDate: event.end?.date ?? null,
    timeZone: event.start?.timeZone ?? null, allDay, status: event.status ?? 'confirmed',
    responseStatus: event.attendees?.find(a => a.self)?.responseStatus ?? null,
    colorId: event.colorId ?? null, projectionId: event.extendedProperties?.private?.kairoProjectionId ?? null,
    taskBlockId: event.extendedProperties?.private?.kairoTaskBlockId ?? null,
    rawJson: JSON.stringify(event), updatedAt: new Date() };
}

export async function applyGoogleSnapshot(db: Db, calendarId: string, events: GoogleEvent[], cursor: string, full: boolean) {
  db.transaction((tx: Db) => {
    const seen = new Set<string>();
    for (const item of events) {
      seen.add(item.id);
      const value = normalizeGoogleEvent(calendarId, item);
      const [projection] = value.projectionId
        ? tx.select().from(eventProjection).where(eq(eventProjection.id, value.projectionId)).all()
        : tx.select().from(eventProjection).where(and(eq(eventProjection.destinationCalendarId, calendarId),
          eq(eventProjection.googleEventId, item.id))).all();
      if (projection) value.projectionId = projection.id;
      tx.insert(googleEvent).values(value).onConflictDoUpdate({ target: [googleEvent.calendarId, googleEvent.googleEventId], set: value }).run();
      if (projection) {
        if (projection.googleEventId === item.id && projection.destinationCalendarId === calendarId &&
            projection.lastAppliedEtag && projection.lastAppliedEtag !== item.etag) {
          tx.update(eventProjection).set({ syncState: 'conflict', conflictKind: item.status === 'cancelled' ? 'remote_deleted' : 'remote_changed', updatedAt: new Date() })
            .where(eq(eventProjection.id, projection.id)).run();
        }
      }
    }
    if (full) {
      const existing = tx.select({ id: googleEvent.id, googleEventId: googleEvent.googleEventId, projectionId: googleEvent.projectionId })
        .from(googleEvent).where(eq(googleEvent.calendarId, calendarId)).all();
      for (const item of existing) if (!seen.has(item.googleEventId)) {
        tx.delete(googleEvent).where(eq(googleEvent.id, item.id)).run();
        const [projection] = tx.select().from(eventProjection).where(and(eq(eventProjection.destinationCalendarId, calendarId),
          eq(eventProjection.googleEventId, item.googleEventId))).all();
        const projectionId = item.projectionId ?? projection?.id;
        if (projectionId) tx.update(eventProjection).set({ syncState: 'conflict', conflictKind: 'remote_deleted', updatedAt: new Date() })
          .where(eq(eventProjection.id, projectionId)).run();
      }
    }
    tx.update(calendar).set({ syncCursor: cursor, syncStatus: 'ready', lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(eq(calendar.id, calendarId)).run();
  });
}

export async function applyIcsSnapshot(db: Db, sourceId: string, occurrences: IcsOccurrence[], cache: { etag?: string; lastModified?: string }, horizon: { start: Date; end: Date }) {
  db.transaction((tx: Db) => {
    const seen = new Set<string>(); const now = new Date();
    for (const item of occurrences) {
      seen.add(`${item.uid}\0${item.recurrenceId}`);
      const previous = tx.select().from(externalEvent).where(and(eq(externalEvent.sourceId, sourceId),
        eq(externalEvent.uid, item.uid), eq(externalEvent.recurrenceId, item.recurrenceId))).get();
      const values = { sourceId, uid: item.uid, recurrenceId: item.recurrenceId,
        title: item.title, description: item.description, location: item.location,
        startAt: item.allDay ? null : new Date(item.start), endAt: item.allDay ? null : new Date(item.end),
        startDate: item.allDay ? item.start : null, endDate: item.allDay ? item.end : null,
        allDay: item.allDay, status: item.cancelled ? 'cancelled' : 'confirmed', sourceRevision: item.revision,
        lastSeenAt: now, withdrawnAt: null };
      tx.insert(externalEvent).values(values).onConflictDoUpdate({ target: [externalEvent.sourceId, externalEvent.uid, externalEvent.recurrenceId], set: values }).run();
      if (previous && (previous.sourceRevision !== item.revision || previous.withdrawnAt)) {
        const choices = tx.select().from(eventDecision).where(eq(eventDecision.externalEventId, previous.id)).all();
        for (const choice of choices) if (choice.state === 'yes' || choice.state === 'maybe') {
          if (previous.withdrawnAt) tx.update(eventProjection).set({ syncState: 'pending', conflictKind: null, updatedAt: now })
            .where(and(eq(eventProjection.decisionId, choice.id), eq(eventProjection.conflictKind, 'source_withdrawn'))).run();
          tx.insert(syncJob).values({ jobKey: `projection:${choice.id}`, kind: 'projection', targetId: choice.id, nextRunAt: now })
            .onConflictDoUpdate({ target: syncJob.jobKey, set: { nextRunAt: now, leaseUntil: null, updatedAt: now } }).run();
        }
      }
    }
    // Only the expanded horizon was fetched. Preserve all decisions outside it.
    const previousInHorizon = tx.select().from(externalEvent).where(eq(externalEvent.sourceId, sourceId)).all();
    for (const item of previousInHorizon) if (
      (item.allDay ? !!item.startDate && item.startDate < horizon.end.toISOString().slice(0, 10) && !!item.endDate && item.endDate > horizon.start.toISOString().slice(0, 10)
        : !!item.startAt && item.startAt < horizon.end && !!item.endAt && item.endAt > horizon.start) &&
      !seen.has(`${item.uid}\0${item.recurrenceId}`)) {
      tx.update(externalEvent).set({ withdrawnAt: now }).where(eq(externalEvent.id, item.id)).run();
      const choices = tx.select().from(eventDecision).where(eq(eventDecision.externalEventId, item.id)).all();
      for (const choice of choices) if (choice.state === 'yes' || choice.state === 'maybe')
        tx.update(eventProjection).set({ syncState: 'conflict', conflictKind: 'source_withdrawn', updatedAt: now })
          .where(eq(eventProjection.decisionId, choice.id)).run();
    }
    tx.update(icsSource).set({ status: 'ready', etag: cache.etag, lastModified: cache.lastModified,
      lastSuccessfulFetchAt: now, lastError: null, updatedAt: now }).where(eq(icsSource.id, sourceId)).run();
  });
}

// Columns owned by each TaskPatch field: while the field is pending, provider syncs must not overwrite them.
const pendingColumns: Record<keyof TaskPatch, string[]> = { title: ['content'],
  due: ['dueDate', 'dueDateTime', 'dueTimeZone', 'dueString', 'dueRecurring'], completed: ['completed', 'completedAt'] };

export function normalizedTaskValues(item: NormalizedTask) {
  return { content: item.title, description: item.description, projectId: item.projectId, priority: item.priority,
    dueDate: item.due && 'date' in item.due ? item.due.date : null, dueDateTime: item.due && 'dateTime' in item.due ? new Date(item.due.dateTime) : null,
    dueTimeZone: item.due?.timeZone ?? null, dueString: item.due?.string ?? null, dueRecurring: !!item.due?.recurring,
    durationMinutes: item.durationMinutes, completed: item.completed, completedAt: item.completedAt ?? null, deleted: item.deleted,
    providerUpdatedAt: item.updatedAt };
}

// Provider-agnostic apply. Returns ids of tasks whose title or color changed or that are new (their mirrors need a refresh).
export async function applyTaskSync(db: Db, connectionId: string, result: TaskSyncResult): Promise<string[]> {
  return db.transaction((tx: Db) => {
    const now = new Date(); const touched: string[] = [];
    // Incremental syncs only carry changed projects; fall back to the name and color already stored for that project.
    const known = new Map<string, { name: string, color: string | null }>(tx.select({ projectId: task.projectId, projectName: task.projectName, projectColor: task.projectColor }).from(task)
      .where(and(eq(task.connectionId, connectionId), isNotNull(task.projectId), isNotNull(task.projectName))).all()
      .map((row: { projectId: string; projectName: string; projectColor: string | null }) => [row.projectId, { name: row.projectName, color: row.projectColor }]));
    for (const project of result.projects ?? []) known.set(project.id, { name: project.name, color: project.color });
    if (result.full) tx.update(task).set({ deleted: true, updatedAt: now }).where(eq(task.connectionId, connectionId)).run();
    for (const item of result.tasks) {
      const existing = tx.select().from(task).where(and(eq(task.connectionId, connectionId), eq(task.todoistId, item.externalId))).get();
      const values: Record<string, unknown> = { ...normalizedTaskValues(item), updatedAt: now,
        projectName: item.projectName ?? (item.projectId ? known.get(item.projectId)?.name ?? null : null),
        projectColor: item.projectColor ?? (item.projectId ? known.get(item.projectId)?.color ?? null : null) };
      if (item.completed && !item.completedAt) values.completedAt = existing?.completedAt ?? now;
      const pending = existing?.pendingPatch ? JSON.parse(existing.pendingPatch) as TaskPatch : {};
      for (const key of Object.keys(pending) as (keyof TaskPatch)[]) for (const column of pendingColumns[key] ?? []) delete values[column];
      if (existing) {
        tx.update(task).set(values).where(eq(task.id, existing.id)).run();
        if ((values.content !== undefined && values.content !== existing.content) || values.projectColor !== existing.projectColor) touched.push(existing.id);
      } else touched.push(tx.insert(task).values({ ...values, connectionId, todoistId: item.externalId }).returning().get().id);
    }
    for (const project of result.projects ?? []) {
      const inProject = and(eq(task.connectionId, connectionId), eq(task.projectId, project.id));
      for (const row of tx.select({ id: task.id, projectColor: task.projectColor }).from(task).where(inProject).all() as { id: string, projectColor: string | null }[])
        if (row.projectColor !== project.color && !touched.includes(row.id)) touched.push(row.id);
      tx.update(task).set({ projectName: project.name, projectColor: project.color }).where(inProject).run();
    }
    tx.update(taskConnection).set({ syncToken: result.cursor, status: 'ready', lastError: null,
      lastSyncedAt: now, updatedAt: now }).where(eq(taskConnection.id, connectionId)).run();
    return touched;
  });
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Removes sent fields from the pending patch, keeping any whose value changed (a newer edit) since they were sent.
export function clearPendingFields(db: Db, taskId: string, sent: TaskPatch): TaskPatch {
  return db.transaction((tx: Db) => {
    const row = tx.select({ pendingPatch: task.pendingPatch }).from(task).where(eq(task.id, taskId)).get();
    const pending: TaskPatch = row?.pendingPatch ? JSON.parse(row.pendingPatch) : {};
    for (const key of Object.keys(sent) as (keyof TaskPatch)[]) if (key in pending && sameValue(pending[key], sent[key])) delete pending[key];
    tx.update(task).set({ pendingPatch: Object.keys(pending).length ? JSON.stringify(pending) : null }).where(eq(task.id, taskId)).run();
    return pending;
  });
}

export type PushResult = { status: 'idle' } | { status: 'pushed'; remaining: TaskPatch } | { status: 'rejected'; error: unknown; sent: TaskPatch };

// Pushes the pending patch. Permanent failures drop only the fields that were sent.
export async function pushPendingPatch(db: Db, taskId: string, push: (item: typeof task.$inferSelect, patch: TaskPatch) => Promise<void>,
  isPermanent: (error: unknown) => boolean = () => false): Promise<PushResult> {
  const [item] = await db.select().from(task).where(eq(task.id, taskId));
  if (!item?.pendingPatch) return { status: 'idle' };
  const sent: TaskPatch = JSON.parse(item.pendingPatch);
  try { await push(item, sent); }
  catch (error) {
    if (!isPermanent(error)) throw error;
    clearPendingFields(db, taskId, sent);
    return { status: 'rejected', error, sent };
  }
  return { status: 'pushed', remaining: clearPendingFields(db, taskId, sent) };
}

// Merges a new edit into the pending patch. Undoing a completion that hasn't been sent just cancels it.
export function mergePendingPatch(pending: TaskPatch, next: TaskPatch, inFlight: boolean): TaskPatch {
  const merged = { ...pending, ...next };
  if (next.completed === false && pending.completed === true && !inFlight) delete merged.completed;
  return merged;
}

export const DEFAULT_TASK_MINUTES = 30;
export type DurationSource = 'user' | 'provider' | 'ai' | 'default';

export function effectiveTaskDuration(item: { durationOverrideMinutes: number | null; durationMinutes: number | null }, estimate?: number | null): { minutes: number; source: DurationSource } {
  if (item.durationOverrideMinutes != null) return { minutes: item.durationOverrideMinutes, source: 'user' };
  if (item.durationMinutes != null) return { minutes: item.durationMinutes, source: 'provider' };
  if (estimate != null) return { minutes: estimate, source: 'ai' };
  return { minutes: DEFAULT_TASK_MINUTES, source: 'default' };
}

type MirrorTask = { id: string; dueDateTime: Date | null; completed: boolean; deleted: boolean; durationOverrideMinutes: number | null; durationMinutes: number | null };
type MirrorBlock = { id: string; calendarId: string; startAt: Date; endAt: Date; syncState: string };

// A timed open task is mirrored by exactly one block on the mirror calendar; every other block goes away.
export function planTaskBlock(item: MirrorTask, estimate: number | null | undefined, blocks: MirrorBlock[], calendarId: string | null) {
  const live = blocks.filter(block => block.syncState !== 'deleting');
  const start = calendarId && item.dueDateTime && !item.completed && !item.deleted ? item.dueDateTime : null;
  if (!start) return { block: null, remove: live.map(block => block.id) };
  const end = new Date(start.getTime() + effectiveTaskDuration(item, estimate).minutes * 60_000);
  const keep = live.find(block => block.calendarId === calendarId);
  return { block: { id: keep?.id ?? null, calendarId: calendarId!, startAt: start, endAt: end,
    changed: !keep || keep.startAt.getTime() !== start.getTime() || keep.endAt.getTime() !== end.getTime() },
    remove: live.filter(block => block !== keep).map(block => block.id) };
}

// Brings task blocks in line with their tasks and enqueues Google reconciles. `touched` forces a refresh (e.g. title change).
export async function syncTaskBlocks(db: Db, scope: { connectionId: string } | { taskIds: string[] }, calendarId: string | null, touched: Iterable<string> = []) {
  const forced = new Set(touched);
  const byConnection = 'connectionId' in scope;
  if (!byConnection && !scope.taskIds.length) return [];
  const tasks = db.select().from(task).where(byConnection ? eq(task.connectionId, scope.connectionId) : inArray(task.id, scope.taskIds)).all();
  const ids: string[] = tasks.map((item: { id: string }) => item.id);
  const blocks = (byConnection ? db.select({ block: taskBlock }).from(taskBlock).innerJoin(task, eq(taskBlock.taskId, task.id)).where(eq(task.connectionId, scope.connectionId)).all().map((row: { block: MirrorBlock }) => row.block)
    : db.select().from(taskBlock).where(inArray(taskBlock.taskId, ids)).all()) as (MirrorBlock & { taskId: string })[];
  const estimates = (byConnection ? db.select({ estimate: taskEstimate }).from(taskEstimate).innerJoin(task, eq(taskEstimate.taskId, task.id)).where(eq(task.connectionId, scope.connectionId)).all().map((row: { estimate: unknown }) => row.estimate)
    : db.select().from(taskEstimate).where(inArray(taskEstimate.taskId, ids)).all()) as { taskId: string; minutes: number }[];
  const estimateBy = new Map(estimates.map(item => [item.taskId, item.minutes]));
  const blocksBy = new Map<string, MirrorBlock[]>();
  for (const block of blocks) blocksBy.set(block.taskId, [...blocksBy.get(block.taskId) ?? [], block]);
  const jobs: string[] = [];
  db.transaction((tx: Db) => {
    const now = new Date();
    for (const item of tasks) {
      const plan = planTaskBlock(item, estimateBy.get(item.id), blocksBy.get(item.id) ?? [], calendarId);
      for (const id of plan.remove) { tx.update(taskBlock).set({ syncState: 'deleting', updatedAt: now }).where(eq(taskBlock.id, id)).run(); jobs.push(id); }
      const next = plan.block;
      if (!next || (!next.changed && !forced.has(item.id))) continue;
      if (next.id) { tx.update(taskBlock).set({ startAt: next.startAt, endAt: next.endAt, syncState: 'pending', updatedAt: now }).where(eq(taskBlock.id, next.id)).run(); jobs.push(next.id); }
      else jobs.push(tx.insert(taskBlock).values({ taskId: item.id, calendarId: next.calendarId, startAt: next.startAt, endAt: next.endAt }).returning().get().id);
    }
  });
  for (const id of jobs) await enqueueJob(db, 'task-block', id);
  return jobs;
}

// A running job keeps its lease (no parallel run); the bumped updatedAt tells finishJob to run it again.
export async function enqueueJob(db: Db, kind: string, targetId: string, nextRunAt = new Date()) {
  const jobKey = `${kind}:${targetId}`, now = new Date();
  await db.insert(syncJob).values({ jobKey, kind, targetId, nextRunAt }).onConflictDoUpdate({ target: syncJob.jobKey,
    set: { nextRunAt, updatedAt: now, leaseUntil: sql`CASE WHEN ${syncJob.leaseUntil} > ${now.getTime()} THEN ${syncJob.leaseUntil} ELSE NULL END` } });
}

export async function isJobRunning(db: Db, kind: string, targetId: string, now = new Date()) {
  const [job] = await db.select({ leaseUntil: syncJob.leaseUntil }).from(syncJob).where(eq(syncJob.jobKey, `${kind}:${targetId}`));
  return !!job?.leaseUntil && job.leaseUntil > now;
}

export async function leaseJobs(db: Db, limit = 10, now = new Date()) {
  return db.transaction((tx: Db) => {
    const due = tx.select().from(syncJob).where(and(lte(syncJob.nextRunAt, now), or(isNull(syncJob.leaseUntil), lte(syncJob.leaseUntil, now))))
      .orderBy(syncJob.nextRunAt).limit(limit).all();
    const leased = [];
    for (const job of due) {
      const result = tx.update(syncJob).set({ leaseUntil: new Date(now.getTime() + 60_000), updatedAt: now })
        .where(and(eq(syncJob.id, job.id), or(isNull(syncJob.leaseUntil), lte(syncJob.leaseUntil, now)))).returning().all();
      if (result[0]) leased.push(result[0]);
    }
    return leased;
  });
}

type LeasedJob = { id: string; updatedAt: Date };

// A job re-enqueued while it ran (updatedAt moved past the lease) is released to run again instead of finished or backed off.
export async function finishJob(db: Db, job: LeasedJob, error?: unknown) {
  const [current] = await db.select().from(syncJob).where(eq(syncJob.id, job.id));
  if (!current) return;
  if (current.updatedAt.getTime() !== job.updatedAt.getTime()) {
    await db.update(syncJob).set({ leaseUntil: null }).where(eq(syncJob.id, job.id));
    return;
  }
  if (!error) { await db.delete(syncJob).where(and(eq(syncJob.id, job.id), eq(syncJob.updatedAt, job.updatedAt))); return; }
  const attempts = current.attempts + 1;
  const delay = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(10, attempts - 1));
  await db.update(syncJob).set({ attempts, leaseUntil: null, lastError: String(error),
    nextRunAt: new Date(Date.now() + delay), updatedAt: new Date() }).where(eq(syncJob.id, job.id));
}

export async function runDueJobs(db: Db, handlers: Record<string, (targetId: string) => Promise<void>>, limit = 10) {
  const jobs = await leaseJobs(db, limit);
  for (const job of jobs) {
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`Unknown sync job kind: ${job.kind}`);
      await handler(job.targetId);
      await finishJob(db, job);
    } catch (error) { await finishJob(db, job, error); }
  }
  return jobs.length;
}

export async function reconcileProjection(db: Db, decisionId: string,
  clientForCalendar: (calendarId: string) => Promise<GoogleCalendarClient>, force = false) {
  const [decision] = await db.select().from(eventDecision).where(eq(eventDecision.id, decisionId));
  if (!decision) return;
  const [source] = await db.select().from(externalEvent).where(eq(externalEvent.id, decision.externalEventId));
  if (!source) return;
  let [projection] = await db.select().from(eventProjection).where(eq(eventProjection.decisionId, decisionId));
  if (!projection) {
    await db.insert(eventProjection).values({ decisionId, syncState: 'pending' }).onConflictDoNothing();
    [projection] = await db.select().from(eventProjection).where(eq(eventProjection.decisionId, decisionId));
  }
  if (!projection || (projection.syncState === 'conflict' && !force)) return;
  if (source.withdrawnAt && (decision.state === 'yes' || decision.state === 'maybe') && !force) {
    await db.update(eventProjection).set({ syncState: 'conflict', conflictKind: 'source_withdrawn', updatedAt: new Date() })
      .where(eq(eventProjection.id, projection.id));
    return;
  }
  const desired = decision.state === 'yes' || decision.state === 'maybe' ? decision.destinationCalendarId : null;
  if ((decision.state === 'yes' || decision.state === 'maybe') && !desired) throw new Error('Decision has no destination calendar');
  const getRemote = async () => {
    if (!projection.googleEventId || !projection.destinationCalendarId) return undefined;
    const [cal] = await db.select().from(calendar).where(eq(calendar.id, projection.destinationCalendarId));
    if (!cal) return undefined;
    const client = await clientForCalendar(cal.id);
    try { return { cal, client, event: await client.getEvent(cal.googleCalendarId, projection.googleEventId) }; }
    catch (error) { if (error instanceof GoogleApiError && error.status === 404) return undefined; throw error; }
  };
  const remote = await getRemote();
  if (projection.googleEventId && !remote && desired && !force) {
    await db.update(eventProjection).set({ syncState: 'conflict', conflictKind: 'remote_deleted', updatedAt: new Date() })
      .where(eq(eventProjection.id, projection.id));
    return;
  }
  if (remote && projection.lastAppliedEtag && remote.event.etag !== projection.lastAppliedEtag && !force) {
    await db.update(eventProjection).set({ syncState: 'conflict', conflictKind: 'remote_changed', updatedAt: new Date() })
      .where(eq(eventProjection.id, projection.id));
    return;
  }
  if (!desired) {
    if (remote) await remote.client.deleteEvent(remote.cal.googleCalendarId, remote.event.id, remote.event.etag);
    await db.update(eventProjection).set({ googleEventId: null, destinationCalendarId: null, lastAppliedEtag: null,
      syncState: 'ready', conflictKind: null, lastError: null, updatedAt: new Date() }).where(eq(eventProjection.id, projection.id));
    return;
  }
  const [destination] = await db.select().from(calendar).where(eq(calendar.id, desired));
  if (!destination) throw new Error('Destination calendar no longer exists');
  const client = await clientForCalendar(destination.id);
  const start = source.allDay ? { date: source.startDate! } : { dateTime: source.startAt!.toISOString(), ...(source.timeZone ? { timeZone: source.timeZone } : {}) };
  const end = source.allDay ? { date: source.endDate! } : { dateTime: source.endAt!.toISOString(), ...(source.timeZone ? { timeZone: source.timeZone } : {}) };
  const body: Partial<GoogleEvent> = { summary: source.title, description: source.description ?? undefined,
    location: source.location ?? undefined, start, end,
    extendedProperties: { private: { kairoProjectionId: projection.id } } };
  if (remote && remote.cal.id !== desired) {
    if ((remote.event.eventType ?? 'default') !== 'default') {
      await db.update(eventProjection).set({ syncState: 'conflict', conflictKind: 'move_unsupported', updatedAt: new Date() })
        .where(eq(eventProjection.id, projection.id)); return;
    }
    const moved = await remote.client.moveEvent(remote.cal.googleCalendarId, remote.event.id, destination.googleCalendarId);
    const updated = await client.updateEvent(destination.googleCalendarId, moved.id, body, moved.etag);
    await saveProjectionMapping(db, projection.id, desired, updated, source.sourceRevision);
    return;
  }
  if (remote) {
    if (projection.lastAppliedSourceRevision === source.sourceRevision && !force) return;
    const updated = await client.updateEvent(destination.googleCalendarId, remote.event.id, body, remote.event.etag);
    await saveProjectionMapping(db, projection.id, desired, updated, source.sourceRevision);
    return;
  }
  // A previous insert may have succeeded before the local mapping was saved.
  const found = await client.findProjection(destination.googleCalendarId, projection.id);
  const created = found ?? await client.createEvent(destination.googleCalendarId, body);
  await saveProjectionMapping(db, projection.id, desired, created, source.sourceRevision);
}

async function saveProjectionMapping(db: Db, projectionId: string, destinationCalendarId: string, event: GoogleEvent, revision: string) {
  await db.update(eventProjection).set({ destinationCalendarId, googleEventId: event.id,
    lastAppliedSourceRevision: revision, lastAppliedEtag: event.etag ?? null, syncState: 'ready',
    conflictKind: null, lastError: null, updatedAt: new Date() }).where(eq(eventProjection.id, projectionId));
}

export async function reconcileTaskBlock(db: Db, blockId: string,
  clientForCalendar: (calendarId: string) => Promise<GoogleCalendarClient>) {
  const [block] = await db.select().from(taskBlock).where(eq(taskBlock.id, blockId));
  if (!block) return;
  const [cal] = await db.select().from(calendar).where(eq(calendar.id, block.calendarId));
  const [linkedTask] = await db.select().from(task).where(eq(task.id, block.taskId));
  const gone = (error: unknown) => error instanceof GoogleApiError && (error.status === 404 || error.status === 410);
  if (block.syncState === 'deleting' || !linkedTask) {
    if (cal) {
      const client = await clientForCalendar(cal.id);
      const eventId = block.googleEventId ?? (await client.findByPrivateProperty(cal.googleCalendarId, 'kairoTaskBlockId', block.id))?.id;
      if (eventId) {
        try { await client.deleteEvent(cal.googleCalendarId, eventId); } catch (error) { if (!gone(error)) throw error; }
        await db.delete(googleEvent).where(and(eq(googleEvent.calendarId, cal.id), eq(googleEvent.googleEventId, eventId)));
      }
    }
    await db.delete(taskBlock).where(eq(taskBlock.id, block.id));
    return;
  }
  if (!cal) return;
  const client = await clientForCalendar(cal.id);
  // The mirror is derived from the task, so Kairo's version always wins over remote edits.
  const body: Partial<GoogleEvent> = { summary: linkedTask.content, description: 'Task blocked by Kairo', status: 'confirmed', start: { dateTime: block.startAt.toISOString() },
    end: { dateTime: block.endAt.toISOString() }, extendedProperties: { private: { kairoTaskBlockId: block.id } } };
  try { body.colorId = await client.closestEventColorId(linkedTask.projectColor ?? DEFAULT_TASK_COLOR); }
  catch (error) { console.error('Google event palette unavailable', error); }
  const update = async (id: string) => { try { return await client.updateEvent(cal.googleCalendarId, id, body); } catch (error) { if (gone(error)) return undefined; throw error; } };
  let event = block.googleEventId ? await update(block.googleEventId) : undefined;
  if (!event) {
    const found = await client.findByPrivateProperty(cal.googleCalendarId, 'kairoTaskBlockId', block.id);
    event = (found && await update(found.id)) || await client.createEvent(cal.googleCalendarId, body);
  }
  await db.update(taskBlock).set({ googleEventId: event.id, lastAppliedEtag: event.etag ?? null, lastError: null, updatedAt: new Date() }).where(eq(taskBlock.id, block.id));
  await db.update(taskBlock).set({ syncState: 'ready' }).where(and(eq(taskBlock.id, block.id), ne(taskBlock.syncState, 'deleting')));
}
