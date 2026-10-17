import '@tanstack/react-start/server-only'
import { and, eq } from 'drizzle-orm'
import {
  db,
  accountAccess,
  calendar,
  eventDecision,
  eventProjection,
  externalEvent,
  googleEvent,
  icsSource,
  task,
  taskConnection,
  taskEstimate,
  userCalendarSetting,
} from '@kairo/db'
import {
  effectiveTaskDuration,
  enqueueJob,
  normalizeGoogleEvent,
  reconcileProjection,
  syncTaskBlocks,
} from '@kairo/core'
import { closestEventColorId, GOOGLE_EVENT_COLORS, GoogleApiError, type GoogleEvent } from '@kairo/integrations'
import type { CalendarEvent, RecurringEventPatch, RecurringScope } from '../features/calendar/types'
import type { TaskSummary } from '../features/tasks/types'
import { geminiConnected } from './ai-connection'
import { getAuthStatus, getSession, requireUser } from './auth'
import {
  clientForCalendar,
  connectionCanWrite,
  processJobs,
  syncAll,
  syncIcsSource,
  taskMirrorCalendarId,
  taskProviders,
} from './sync'
import { deleteRecurringEventForUser, getAdjacentOccurrenceForUser, saveRecurringEventForUser } from './recurring'

async function ownedCalendar(userId: string, calendarId: string) {
  const [row] = await db
    .select({ cal: calendar, access: accountAccess })
    .from(calendar)
    .innerJoin(accountAccess, eq(calendar.connectedAccountId, accountAccess.connectedAccountId))
    .where(and(eq(calendar.id, calendarId), eq(accountAccess.userId, userId)))
  if (!row) throw new Response('Calendar unavailable', { status: 404 })
  return row.cal
}

async function ownedExternal(userId: string, eventId: string) {
  const [row] = await db
    .select({ event: externalEvent })
    .from(externalEvent)
    .innerJoin(icsSource, eq(externalEvent.sourceId, icsSource.id))
    .where(and(eq(externalEvent.id, eventId), eq(icsSource.ownerUserId, userId)))
  if (!row) throw new Response('Event unavailable', { status: 404 })
  return row.event
}

const recurrenceOf = (rawJson: string | null): string[] | undefined => {
  const lines = (JSON.parse(rawJson || '{}') as GoogleEvent).recurrence
  return lines?.length ? lines : undefined
}

function intersects(start: string, end: string, rangeStart: Date, rangeEnd: Date) {
  return new Date(start) < rangeEnd && new Date(end) > rangeStart
}

export async function getViewerImpl() {
  const status = await getAuthStatus()
  const session = await getSession()
  return {
    needsSetup: status.needsSetup,
    user: session?.user ? { id: session.user.id, name: session.user.name, email: session.user.email } : null,
  }
}

export async function getCalendarSnapshotImpl(data: { start: string; end: string }) {
  const user = await requireUser()
  const start = new Date(data.start),
    end = new Date(data.end)
  if (!(start < end) || end.getTime() - start.getTime() > 124 * 86400_000) throw new Error('Invalid calendar range')
  const owned = await db
    .select({ cal: calendar, setting: userCalendarSetting })
    .from(calendar)
    .innerJoin(accountAccess, eq(calendar.connectedAccountId, accountAccess.connectedAccountId))
    .leftJoin(
      userCalendarSetting,
      and(eq(userCalendarSetting.calendarId, calendar.id), eq(userCalendarSetting.userId, user.id)),
    )
    .where(eq(accountAccess.userId, user.id))
  const calendars = owned.map(({ cal, setting }) => ({
    id: cal.id,
    name: cal.name,
    color: cal.color || '#8b8aa7',
    visible: setting?.visible ?? true,
    isDefault: setting?.isDefault ?? false,
    isMaybe: setting?.isMaybe ?? false,
    isTasks: setting?.isTasks ?? false,
    accessRole: cal.accessRole || 'reader',
    syncStatus: cal.syncStatus,
    lastError: cal.lastError,
  }))
  const calIds = new Set(calendars.map((item) => item.id))
  const allSources = await db.select().from(icsSource).where(eq(icsSource.ownerUserId, user.id))
  const externalSources = allSources.filter((source) => source.status !== 'removed')
  const sourceIds = new Set(externalSources.map((item) => item.id))
  const decisions = await db.select().from(eventDecision).where(eq(eventDecision.userId, user.id))
  const byExternal = new Map(decisions.map((item) => [item.externalEventId, item]))
  const sourcesById = new Map(allSources.map((item) => [item.id, item]))
  const storedExternal = await db.select().from(externalEvent)
  const projections = await db.select().from(eventProjection)
  const conflicts = projections
    .filter((projection) => projection.syncState === 'conflict')
    .flatMap((projection) => {
      const choice = decisions.find((decision) => decision.id === projection.decisionId)
      const source = choice && storedExternal.find((item) => item.id === choice.externalEventId)
      if (!choice || !source || !sourcesById.has(source.sourceId)) return []
      return [
        {
          id: projection.id,
          decisionId: choice.id,
          title: source.title,
          state: choice.state,
          kind: projection.conflictKind || 'unknown',
          sourceName: sourcesById.get(source.sourceId)?.name || 'ICS feed',
          calendarName:
            calendars.find((item) => item.id === projection.destinationCalendarId)?.name || 'Google Calendar',
          lastError: projection.lastError,
        },
      ]
    })
  const storedGoogle = await db.select().from(googleEvent)
  const connections = await db.select().from(taskConnection).where(eq(taskConnection.ownerUserId, user.id))
  const connectionIds = new Set(connections.map((item) => item.id))
  const storedTasks = await db.select().from(task)
  const tasks = storedTasks.filter((item) => connectionIds.has(item.connectionId) && !item.completed && !item.deleted)
  const events: CalendarEvent[] = []
  const recurringCalendars = new Set(
    storedGoogle
      .filter((item) => calIds.has(item.calendarId) && !!recurrenceOf(item.rawJson))
      .map((item) => item.calendarId),
  )
  const expandedCalendars = new Set<string>()
  for (const calendarId of recurringCalendars) {
    try {
      const { client, cal } = await clientForCalendar(calendarId, user.id)
      const instances = await client.listRangeEvents(cal.googleCalendarId, start, end)
      const local = calendars.find((item) => item.id === calendarId)!
      for (const item of instances) {
        if (
          !item.recurringEventId ||
          item.status === 'cancelled' ||
          item.extendedProperties?.private?.kairoProjectionId ||
          item.extendedProperties?.private?.kairoTaskBlockId
        )
          continue
        const allDay = !!item.start?.date
        const eventStart = item.start?.date || item.start?.dateTime
        const eventEnd = item.end?.date || item.end?.dateTime
        if (!eventStart || !eventEnd || !intersects(eventStart, eventEnd, start, end)) continue
        const parent = storedGoogle.find(
          (row) => row.calendarId === calendarId && row.googleEventId === item.recurringEventId,
        )
        const parentGoogle = parent && (JSON.parse(parent.rawJson || '{}') as GoogleEvent)
        const recurrence = parent && recurrenceOf(parent.rawJson)
        const originalStart = item.originalStartTime?.dateTime ?? item.originalStartTime?.date
        // Occurrences are editable only when their series master is stored locally.
        const series =
          parent && recurrence && originalStart
            ? {
                masterId: parent.id,
                instanceId: item.id,
                originalStart,
                timeZone: parentGoogle?.start?.timeZone ?? item.start?.timeZone,
              }
            : undefined
        events.push({
          id: `instance:${calendarId}:${item.id}`,
          kind: 'google',
          title: item.summary || '(Untitled)',
          start: eventStart,
          end: eventEnd,
          allDay,
          calendarId,
          calendarColor: local.color,
          eventColor: (item.colorId && GOOGLE_EVENT_COLORS[item.colorId]) || parent?.color || local.color,
          status: item.status,
          declined: item.attendees?.some((attendee) => attendee.self && attendee.responseStatus === 'declined'),
          description: item.description,
          location: item.location,
          editable: !!series && (local.accessRole === 'owner' || local.accessRole === 'writer'),
          recurring: true,
          recurrence: series && recurrence,
          series,
        })
      }
      expandedCalendars.add(calendarId)
    } catch (error) {
      console.error('Recurring Google range unavailable', error)
    }
  }
  for (const item of storedGoogle) {
    if (!calIds.has(item.calendarId) || item.status === 'cancelled' || item.projectionId || item.taskBlockId) continue
    const recurring = !!item.recurringEventId || !!item.originalStartTime || !!recurrenceOf(item.rawJson)
    if (expandedCalendars.has(item.calendarId) && recurring) continue
    const cal = calendars.find((candidate) => candidate.id === item.calendarId)!
    const eventStart = item.allDay ? item.startDate : item.startAt?.toISOString()
    const eventEnd = item.allDay ? item.endDate : item.endAt?.toISOString()
    if (!eventStart || !eventEnd || !intersects(eventStart, eventEnd, start, end)) continue
    events.push({
      id: item.id,
      kind: 'google',
      title: item.title || '(Untitled)',
      start: eventStart,
      end: eventEnd,
      allDay: item.allDay,
      calendarId: item.calendarId,
      calendarColor: cal.color,
      eventColor: (item.colorId && GOOGLE_EVENT_COLORS[item.colorId]) || item.color || cal.color,
      status: item.status,
      declined: item.responseStatus === 'declined',
      description: item.description || undefined,
      location: item.location || undefined,
      // Un-expanded series (range expansion failed) stay read-only.
      editable: !recurring && (cal.accessRole === 'owner' || cal.accessRole === 'writer'),
      recurring,
    })
  }
  for (const item of storedExternal) {
    if (!sourceIds.has(item.sourceId) || item.withdrawnAt || item.status === 'cancelled') continue
    const eventStart = item.allDay ? item.startDate : item.startAt?.toISOString()
    const eventEnd = item.allDay ? item.endDate : item.endAt?.toISOString()
    if (!eventStart || !eventEnd || !intersects(eventStart, eventEnd, start, end)) continue
    const choice = byExternal.get(item.id)
    const cal = choice?.destinationCalendarId
      ? calendars.find((candidate) => candidate.id === choice.destinationCalendarId)
      : null
    events.push({
      id: item.id,
      kind: 'external',
      title: item.title,
      start: eventStart,
      end: eventEnd,
      allDay: item.allDay,
      calendarId: cal?.id,
      calendarColor: cal?.color || sourcesById.get(item.sourceId)?.color || '#8fc6ec',
      eventColor: cal?.color,
      decision: choice?.state || 'undecided',
      declined: choice?.state === 'no',
      description: item.description || undefined,
      location: item.location || undefined,
      editable: false,
    })
  }
  const estimates = await db
    .select({ taskId: taskEstimate.taskId, minutes: taskEstimate.minutes })
    .from(taskEstimate)
    .innerJoin(task, eq(taskEstimate.taskId, task.id))
    .innerJoin(taskConnection, eq(task.connectionId, taskConnection.id))
    .where(eq(taskConnection.ownerUserId, user.id))
  const estimateBy = new Map(estimates.map((item) => [item.taskId, item.minutes]))
  const connectionsById = new Map(connections.map((item) => [item.id, item]))
  const summaries: TaskSummary[] = tasks.map((item) => {
    const duration = effectiveTaskDuration(item, estimateBy.get(item.id))
    const connection = connectionsById.get(item.connectionId)!
    return {
      id: item.id,
      title: item.content,
      description: item.description,
      projectName: item.projectName,
      color: item.projectColor,
      priority: item.priority,
      due: item.dueDateTime
        ? { dateTime: item.dueDateTime.toISOString() }
        : item.dueDate
          ? { date: item.dueDate.slice(0, 10) }
          : null,
      recurring: item.dueRecurring,
      durationMinutes: duration.minutes,
      durationSource: duration.source,
      completed: item.completed,
      url: taskProviders[connection.provider]?.taskUrl?.(item.todoistId) ?? null,
      pending: !!item.pendingPatch,
    }
  })
  const writable = new Map(connections.map((item) => [item.id, connectionCanWrite(item)]))
  summaries.forEach((summary, index) => {
    if (!summary.due) return
    const editable = writable.get(tasks[index].connectionId)!
    const due = summary.due
    const timed = 'dateTime' in due
    const eventStart = 'dateTime' in due ? due.dateTime : due.date
    const eventEnd = timed
      ? new Date(Date.parse(eventStart) + summary.durationMinutes * 60_000).toISOString()
      : new Date(Date.parse(`${eventStart}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10)
    if (intersects(eventStart, eventEnd, start, end))
      events.push({
        id: `task:${summary.id}`,
        kind: 'task',
        taskId: summary.id,
        task: summary,
        title: summary.title,
        start: eventStart,
        end: eventEnd,
        allDay: !timed,
        editable,
      })
  })
  return {
    calendars,
    taskCalendarId: await taskMirrorCalendarId(user.id),
    sources: externalSources.map((item) => ({
      id: item.id,
      name: item.name,
      color: item.color,
      status: item.status,
      lastError: item.lastError,
    })),
    tasks: summaries,
    events,
    conflicts,
    connections: {
      gemini: await geminiConnected(user.id),
      google: owned.length > 0,
      todoist: connections.some(
        (item) => !!item.providerSubject && !!item.encryptedCredentials && item.status !== 'reconnect',
      ),
      todoistNeedsReconnect: connections.some((item) => item.status === 'reconnect' || !item.providerSubject),
      todoistCanWrite: connections.some(
        (item) => !!item.providerSubject && !!item.encryptedCredentials && connectionCanWrite(item),
      ),
    },
    errors: [
      ...calendars.filter((item) => item.lastError).map((item) => `${item.name}: ${item.lastError}`),
      ...externalSources.filter((item) => item.lastError).map((item) => `${item.name}: ${item.lastError}`),
      ...connections.filter((item) => item.lastError).map((item) => `Todoist: ${item.lastError}`),
    ],
  }
}

export async function resolveProjectionConflictImpl(data: {
  id: string
  action: 'restore' | 'keep-google' | 'remove-decision'
}) {
  const user = await requireUser()
  const [row] = await db
    .select({ projection: eventProjection, decision: eventDecision, source: externalEvent, feed: icsSource })
    .from(eventProjection)
    .innerJoin(eventDecision, eq(eventProjection.decisionId, eventDecision.id))
    .innerJoin(externalEvent, eq(eventDecision.externalEventId, externalEvent.id))
    .innerJoin(icsSource, eq(externalEvent.sourceId, icsSource.id))
    .where(and(eq(eventProjection.id, data.id), eq(eventDecision.userId, user.id), eq(icsSource.ownerUserId, user.id)))
  if (!row) throw new Response('Conflict unavailable', { status: 404 })
  const { projection, decision, source } = row
  if (projection.syncState !== 'conflict') return { ok: true }
  if (data.action === 'restore') {
    if (source.withdrawnAt)
      throw new Error('This ICS event was withdrawn. Keep the Google edit or remove the decision instead.')
    await reconcileProjection(db, decision.id, async (id) => (await clientForCalendar(id, user.id)).client, true)
    return { ok: true }
  }
  let remote: GoogleEvent | undefined
  let projectionCalendar: typeof calendar.$inferSelect | undefined
  if (projection.destinationCalendarId && projection.googleEventId) {
    projectionCalendar = await ownedCalendar(user.id, projection.destinationCalendarId)
    const { client } = await clientForCalendar(projectionCalendar.id, user.id)
    try {
      remote = await client.getEvent(projectionCalendar.googleCalendarId, projection.googleEventId)
    } catch (error) {
      if (!(error instanceof GoogleApiError && error.status === 404)) throw error
    }
    if (remote && data.action === 'keep-google') {
      remote = await client.updateEvent(
        projectionCalendar.googleCalendarId,
        remote.id,
        { extendedProperties: { private: { kairoProjectionId: null as unknown as string } } },
        remote.etag,
      )
    } else if (remote && data.action === 'remove-decision') {
      await client.deleteEvent(projectionCalendar.googleCalendarId, remote.id, remote.etag)
      remote = undefined
    }
  }
  const state = data.action === 'keep-google' ? 'no' : 'undecided'
  const [cached] =
    projectionCalendar && projection.googleEventId
      ? await db
          .select()
          .from(googleEvent)
          .where(
            and(
              eq(googleEvent.calendarId, projectionCalendar.id),
              eq(googleEvent.googleEventId, projection.googleEventId),
            ),
          )
      : []
  db.transaction((tx) => {
    tx.update(eventDecision)
      .set({ state, destinationCalendarId: null, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(eventDecision.id, decision.id))
      .run()
    tx.update(eventProjection)
      .set({
        destinationCalendarId: null,
        googleEventId: null,
        lastAppliedSourceRevision: null,
        lastAppliedEtag: null,
        syncState: 'ready',
        conflictKind: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(eventProjection.id, projection.id))
      .run()
    if (projectionCalendar && projection.googleEventId) {
      tx.delete(googleEvent)
        .where(
          and(
            eq(googleEvent.calendarId, projectionCalendar.id),
            eq(googleEvent.googleEventId, projection.googleEventId),
          ),
        )
        .run()
      if (remote && data.action === 'keep-google') {
        const value = {
          ...normalizeGoogleEvent(projectionCalendar.id, remote),
          projectionId: null,
          color: cached?.color || null,
        }
        tx.insert(googleEvent)
          .values(value)
          .onConflictDoUpdate({ target: [googleEvent.calendarId, googleEvent.googleEventId], set: value })
          .run()
      }
    }
  })
  return { ok: true }
}

export async function syncNowImpl() {
  const user = await requireUser()
  return syncAll(user.id)
}

export async function addIcsFeedImpl(data: { url: string; name: string }) {
  const user = await requireUser()
  const url = new URL(data.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Feed URL must use HTTP or HTTPS')
  const [source] = await db
    .insert(icsSource)
    .values({ ownerUserId: user.id, url: data.url, name: data.name, color: '#8fc6ec' })
    .returning()
  await syncIcsSource(source.id)
  return { id: source.id }
}

export async function deleteIcsFeedImpl(data: { id: string }) {
  const user = await requireUser()
  await db
    .update(icsSource)
    .set({ status: 'removed', updatedAt: new Date() })
    .where(and(eq(icsSource.id, data.id), eq(icsSource.ownerUserId, user.id)))
  return { ok: true }
}

export async function setCalendarVisibilityImpl(data: { calendarId: string; visible: boolean }) {
  const user = await requireUser()
  await ownedCalendar(user.id, data.calendarId)
  await db
    .insert(userCalendarSetting)
    .values({ userId: user.id, calendarId: data.calendarId, visible: data.visible })
    .onConflictDoUpdate({
      target: [userCalendarSetting.userId, userCalendarSetting.calendarId],
      set: { visible: data.visible },
    })
  return { ok: true }
}

export async function setCalendarRoleImpl(data: {
  calendarId: string
  role: 'default' | 'maybe' | 'tasks'
  active: boolean
}) {
  const user = await requireUser()
  const cal = await ownedCalendar(user.id, data.calendarId)
  if (data.role === 'tasks' && data.active && cal.accessRole !== 'owner' && cal.accessRole !== 'writer')
    throw new Error('Choose a writable calendar for tasks')
  const field = { default: 'isDefault', maybe: 'isMaybe', tasks: 'isTasks' } as const
  const key = field[data.role]
  db.transaction((tx) => {
    if (data.active)
      tx.update(userCalendarSetting)
        .set({ [key]: false })
        .where(eq(userCalendarSetting.userId, user.id))
        .run()
    tx.insert(userCalendarSetting)
      .values({ userId: user.id, calendarId: data.calendarId, [key]: data.active })
      .onConflictDoUpdate({
        target: [userCalendarSetting.userId, userCalendarSetting.calendarId],
        set: { [key]: data.active },
      })
      .run()
  })
  if (data.role === 'tasks' || data.role === 'default') {
    const calendarId = await taskMirrorCalendarId(user.id)
    const connections = await db.select().from(taskConnection).where(eq(taskConnection.ownerUserId, user.id))
    for (const connection of connections) await syncTaskBlocks(db, { connectionId: connection.id }, calendarId)
    void processJobs().catch((error) => console.error('Task sync failed', error))
  }
  return { ok: true }
}

export async function decideExternalEventImpl(data: { eventId: string; state: 'undecided' | 'yes' | 'maybe' | 'no' }) {
  const user = await requireUser()
  await ownedExternal(user.id, data.eventId)
  let calendarId: string | undefined
  if (data.state === 'yes' || data.state === 'maybe') {
    const rows = await db
      .select()
      .from(userCalendarSetting)
      .where(
        and(
          eq(userCalendarSetting.userId, user.id),
          data.state === 'yes' ? eq(userCalendarSetting.isDefault, true) : eq(userCalendarSetting.isMaybe, true),
        ),
      )
    calendarId = rows[0]?.calendarId
    if (!calendarId) throw new Error(`Choose a ${data.state === 'maybe' ? 'Maybe' : 'default'} calendar first`)
  }
  const [choice] = await db
    .insert(eventDecision)
    .values({
      userId: user.id,
      externalEventId: data.eventId,
      state: data.state,
      destinationCalendarId: calendarId || null,
      decidedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [eventDecision.userId, eventDecision.externalEventId],
      set: {
        state: data.state,
        destinationCalendarId: calendarId || null,
        decidedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning()
  await enqueueJob(db, 'projection', choice.id)
  void processJobs().catch((error) => console.error('Projection sync failed', error))
  return { ok: true, decisionId: choice.id }
}

export async function saveGoogleEventImpl(data: {
  id?: string
  title: string
  start: string
  end: string
  allDay: boolean
  calendarId: string
  eventColor?: string
  description?: string
  location?: string
  recurrence?: string[] | null
  timeZone?: string
}) {
  const user = await requireUser()
  const cal = await ownedCalendar(user.id, data.calendarId)
  if (!['owner', 'writer'].includes(cal.accessRole || '')) throw new Error('Calendar is read only')
  if (new Date(data.end) <= new Date(data.start)) throw new Error('Event end must follow start')
  const { client } = await clientForCalendar(cal.id, user.id)
  const body: Partial<GoogleEvent> = {
    summary: data.title,
    description: data.description,
    location: data.location,
    start: data.allDay ? { date: data.start.slice(0, 10) } : { dateTime: data.start },
    end: data.allDay ? { date: data.end.slice(0, 10) } : { dateTime: data.end },
  }
  if (data.recurrence?.length) {
    // Google requires a zone on the start/end of recurring timed events.
    body.recurrence = data.recurrence
    const timeZone = data.timeZone || cal.timeZone || 'UTC'
    if (!data.allDay) {
      body.start = { dateTime: data.start, timeZone }
      body.end = { dateTime: data.end, timeZone }
    }
  }
  if (data.eventColor) body.colorId = closestEventColorId(data.eventColor)
  let remote
  let oldColor: string | null = null
  if (data.id) {
    const [row] = await db
      .select({ event: googleEvent, sourceCalendar: calendar })
      .from(googleEvent)
      .innerJoin(calendar, eq(googleEvent.calendarId, calendar.id))
      .innerJoin(accountAccess, eq(calendar.connectedAccountId, accountAccess.connectedAccountId))
      .where(and(eq(googleEvent.id, data.id), eq(accountAccess.userId, user.id)))
    const old = row?.event
    if (!old || old.projectionId || old.taskBlockId) throw new Response('Event unavailable', { status: 404 })
    if (old.recurringEventId || old.originalStartTime || recurrenceOf(old.rawJson))
      throw new Error('Edit recurring events with a scope (this, following or all events)')
    oldColor = old.color
    if (old.calendarId !== cal.id) {
      const { client: sourceClient } = await clientForCalendar(old.calendarId, user.id)
      const moved = await sourceClient.moveEvent(
        row.sourceCalendar.googleCalendarId,
        old.googleEventId,
        cal.googleCalendarId,
      )
      remote = await client.updateEvent(cal.googleCalendarId, moved.id, body, moved.etag)
      await db.delete(googleEvent).where(eq(googleEvent.id, old.id))
    } else remote = await client.updateEvent(cal.googleCalendarId, old.googleEventId, body, old.etag || undefined)
  } else remote = await client.createEvent(cal.googleCalendarId, body)
  const values = { ...normalizeGoogleEvent(cal.id, remote), color: data.eventColor || oldColor }
  const [saved] = await db
    .insert(googleEvent)
    .values(values)
    .onConflictDoUpdate({ target: [googleEvent.calendarId, googleEvent.googleEventId], set: values })
    .returning()
  return { id: saved.id }
}

export async function deleteGoogleEventImpl(data: { id: string }) {
  const user = await requireUser()
  const [row] = await db
    .select({ event: googleEvent, cal: calendar })
    .from(googleEvent)
    .innerJoin(calendar, eq(googleEvent.calendarId, calendar.id))
    .innerJoin(accountAccess, eq(calendar.connectedAccountId, accountAccess.connectedAccountId))
    .where(and(eq(googleEvent.id, data.id), eq(accountAccess.userId, user.id)))
  if (!row || row.event.projectionId || row.event.taskBlockId) throw new Response('Event unavailable', { status: 404 })
  if (!['owner', 'writer'].includes(row.cal.accessRole || '')) throw new Error('Calendar is read only')
  if (row.event.recurringEventId || row.event.originalStartTime || recurrenceOf(row.event.rawJson))
    throw new Error('Delete recurring events with a scope (this, following or all events)')
  const { client } = await clientForCalendar(row.cal.id, user.id)
  await client.deleteEvent(row.cal.googleCalendarId, row.event.googleEventId, row.event.etag || undefined)
  await db.delete(googleEvent).where(eq(googleEvent.id, row.event.id))
  return { ok: true }
}

export async function saveRecurringEventImpl(data: {
  id: string
  scope: RecurringScope
  patch: RecurringEventPatch
  timeZone?: string
}) {
  const user = await requireUser()
  return saveRecurringEventForUser(user.id, data)
}

export async function deleteRecurringEventImpl(data: { id: string; scope: RecurringScope }) {
  const user = await requireUser()
  return deleteRecurringEventForUser(user.id, data)
}

export async function getAdjacentOccurrenceImpl(data: { id: string; direction: 'prev' | 'next' }) {
  const user = await requireUser()
  return getAdjacentOccurrenceForUser(user.id, data)
}
