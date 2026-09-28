import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { calendar, eventDecision, eventProjection, externalEvent, googleEvent, icsSource,
  syncJob, task, taskBlock, taskConnection } from '@kairo/db/schema';
import { GoogleApiError, type GoogleCalendarClient, type GoogleEvent, type IcsOccurrence, type TodoistSync } from '@kairo/integrations';

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

export async function applyTodoistSync(db: Db, connectionId: string, result: TodoistSync) {
  db.transaction((tx: Db) => {
    const now = new Date();
    if (result.full_sync) tx.update(task).set({ deleted: true, updatedAt: now }).where(eq(task.connectionId, connectionId)).run();
    for (const item of result.items ?? []) {
      const values = { connectionId, todoistId: item.id, content: item.content ?? '', description: item.description ?? null,
        projectId: item.project_id ?? null, priority: item.priority ?? 1, dueDate: item.due?.date ?? null,
        dueDateTime: date(item.due?.datetime), dueTimeZone: item.due?.timezone ?? null,
        durationMinutes: item.duration ? item.duration.amount * (item.duration.unit === 'day' ? 1440 : 1) : null,
        completed: !!item.checked, deleted: !!item.is_deleted, providerUpdatedAt: date(item.updated_at), updatedAt: now };
      tx.insert(task).values(values).onConflictDoUpdate({ target: [task.connectionId, task.todoistId], set: values }).run();
    }
    tx.update(taskConnection).set({ syncToken: result.sync_token, status: 'ready', lastError: null,
      lastSyncedAt: now, updatedAt: now }).where(eq(taskConnection.id, connectionId)).run();
  });
}

export async function enqueueJob(db: Db, kind: string, targetId: string, nextRunAt = new Date()) {
  const jobKey = `${kind}:${targetId}`;
  await db.insert(syncJob).values({ jobKey, kind, targetId, nextRunAt }).onConflictDoUpdate({ target: syncJob.jobKey,
    set: { nextRunAt, leaseUntil: null, updatedAt: new Date() } });
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

export async function finishJob(db: Db, id: string, error?: unknown) {
  if (!error) { await db.delete(syncJob).where(eq(syncJob.id, id)); return; }
  const [job] = await db.select().from(syncJob).where(eq(syncJob.id, id));
  if (!job) return;
  const attempts = job.attempts + 1;
  const delay = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(10, attempts - 1));
  await db.update(syncJob).set({ attempts, leaseUntil: null, lastError: String(error),
    nextRunAt: new Date(Date.now() + delay), updatedAt: new Date() }).where(eq(syncJob.id, id));
}

export async function runDueJobs(db: Db, handlers: Record<string, (targetId: string) => Promise<void>>, limit = 10) {
  const jobs = await leaseJobs(db, limit);
  for (const job of jobs) {
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`Unknown sync job kind: ${job.kind}`);
      await handler(job.targetId);
      await finishJob(db, job.id);
    } catch (error) { await finishJob(db, job.id, error); }
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
  if (!cal || !linkedTask) return;
  const client = await clientForCalendar(cal.id);
  const body: Partial<GoogleEvent> = { summary: linkedTask.content, start: { dateTime: block.startAt.toISOString() },
    end: { dateTime: block.endAt.toISOString() }, extendedProperties: { private: { kairoTaskBlockId: block.id } } };
  try {
    let event: GoogleEvent | undefined;
    if (block.googleEventId) {
      const current = await client.getEvent(cal.googleCalendarId, block.googleEventId);
      if (block.lastAppliedEtag && current.etag !== block.lastAppliedEtag) {
        await db.update(taskBlock).set({ syncState: 'conflict', lastError: 'Google event changed remotely' }).where(eq(taskBlock.id, block.id));
        return;
      }
      event = await client.updateEvent(cal.googleCalendarId, current.id, body, current.etag);
    } else {
      const found = await client.findByPrivateProperty(cal.googleCalendarId, 'kairoTaskBlockId', block.id);
      event = found ?? await client.createEvent(cal.googleCalendarId, body);
    }
    await db.update(taskBlock).set({ googleEventId: event.id, lastAppliedEtag: event.etag ?? null,
      syncState: 'ready', lastError: null, updatedAt: new Date() }).where(eq(taskBlock.id, block.id));
  } catch (error) {
    if (error instanceof GoogleApiError && (error.status === 404 || error.status === 412)) {
      await db.update(taskBlock).set({ syncState: 'conflict', lastError: String(error), updatedAt: new Date() }).where(eq(taskBlock.id, block.id));
      return;
    }
    throw error;
  }
}
