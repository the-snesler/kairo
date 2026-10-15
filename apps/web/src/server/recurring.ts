// Scoped edits of recurring Google events. Kept free of request/session imports so it can be tested directly;
// calendar.server.ts resolves the user and delegates here.
import { and, eq, or } from 'drizzle-orm'
import { db, accountAccess, calendar, googleEvent } from '@kairo/db'
import { normalizeGoogleEvent } from '@kairo/core'
import {
  GoogleApiError,
  parseRecurrence,
  planRecurringDelete,
  planRecurringEdit,
  type GoogleCalendarClient,
  type GoogleEvent,
  type RecurringScope,
  type SeriesOperation,
  type SeriesPatch,
} from '@kairo/integrations'
import { clientForCalendar } from './sync'

type CalendarRow = typeof calendar.$inferSelect
const DAY_MS = 86400_000
const CHANGED_IN_GOOGLE = 'This event changed in Google Calendar. Refresh and try again.'

const unavailable = () => new Response('Event unavailable', { status: 404 })
const isMissing = (error: unknown) => error instanceof GoogleApiError && (error.status === 404 || error.status === 410)
const isKairoOwned = (event: GoogleEvent) =>
  !!event.extendedProperties?.private?.kairoProjectionId || !!event.extendedProperties?.private?.kairoTaskBlockId
const timeValue = (time: GoogleEvent['start']) => time?.dateTime ?? time?.date
const position = (value: string) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value)
const writable = (cal: CalendarRow) => cal.accessRole === 'owner' || cal.accessRole === 'writer'

/** Splits the `instance:{calendarId}:{googleInstanceId}` ids the snapshot emits for expanded occurrences. */
export function parseInstanceId(id: string) {
  const match = /^instance:([^:]+):(.+)$/.exec(id)
  if (!match) throw unavailable()
  return { calendarId: match[1], instanceId: match[2] }
}

async function ownedCalendar(userId: string, calendarId: string) {
  const [row] = await db
    .select({ cal: calendar })
    .from(calendar)
    .innerJoin(accountAccess, eq(calendar.connectedAccountId, accountAccess.connectedAccountId))
    .where(and(eq(calendar.id, calendarId), eq(accountAccess.userId, userId)))
  if (!row) throw new Response('Calendar unavailable', { status: 404 })
  return row.cal
}

async function getOrUnavailable(client: GoogleCalendarClient, calendarId: string, eventId: string) {
  try {
    return await client.getEvent(calendarId, eventId)
  } catch (error) {
    if (isMissing(error)) throw unavailable()
    throw error
  }
}

function storedAsGoogle(row: typeof googleEvent.$inferSelect): GoogleEvent {
  const raw = row.rawJson ? (JSON.parse(row.rawJson) as GoogleEvent) : null
  if (raw?.id) return raw
  const original = row.originalStartTime
  return {
    id: row.googleEventId,
    status: row.status,
    recurringEventId: row.recurringEventId ?? undefined,
    originalStartTime: original ? (original.length === 10 ? { date: original } : { dateTime: original }) : undefined,
  }
}

async function loadSeries(userId: string, id: string, timeZone?: string) {
  const { calendarId, instanceId } = parseInstanceId(id)
  const cal = await ownedCalendar(userId, calendarId)
  const { client } = await clientForCalendar(cal.id, userId)
  const instance = await getOrUnavailable(client, cal.googleCalendarId, instanceId)
  if (!instance.recurringEventId || isKairoOwned(instance)) throw unavailable()
  const master = await getOrUnavailable(client, cal.googleCalendarId, instance.recurringEventId)
  if (isKairoOwned(master) || !master.recurrence?.length) throw unavailable()
  const rows = await db
    .select()
    .from(googleEvent)
    .where(and(eq(googleEvent.calendarId, cal.id), eq(googleEvent.recurringEventId, master.id)))
  return {
    cal,
    client,
    instance,
    master,
    exceptions: rows.map(storedAsGoogle),
    timeZone: master.start?.timeZone ?? timeZone ?? cal.timeZone ?? 'UTC',
  }
}
type SeriesContext = Awaited<ReturnType<typeof loadSeries>>

/** Occurrences (cancelled ones too, as COUNT counts them) before this one; only needed for COUNT rules. */
async function priorOccurrences(context: SeriesContext) {
  if (!parseRecurrence(context.master.recurrence)?.rule?.count) return undefined
  const original = timeValue(context.instance.originalStartTime)
  if (!original) return undefined
  const split = position(original)
  const instances = await context.client.listInstances(context.cal.googleCalendarId, context.master.id, {
    showDeleted: true,
    timeMax: new Date(split + DAY_MS),
  })
  return instances.filter((item) => {
    const value = timeValue(item.originalStartTime)
    return !!value && position(value) < split
  }).length
}

/** Whether a non-cancelled occurrence starts before this one; undefined when Google can't say. */
async function hasEarlierOccurrences(context: SeriesContext) {
  const original = timeValue(context.instance.originalStartTime)
  if (!original) return undefined
  try {
    const earlier = await context.client.listInstances(context.cal.googleCalendarId, context.master.id, {
      timeMax: new Date(position(original)),
      maxResults: 1,
    })
    return earlier.some((item) => item.status !== 'cancelled')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function execute(userId: string, context: SeriesContext, ops: SeriesOperation[], eventColor?: string) {
  const targets = new Map<string, Promise<{ client: GoogleCalendarClient; cal: CalendarRow }>>([
    [context.cal.id, Promise.resolve({ client: context.client, cal: context.cal })],
  ])
  const target = (calendarId: string) => {
    let found = targets.get(calendarId)
    if (!found) {
      found = (async () => {
        const cal = await ownedCalendar(userId, calendarId)
        if (!writable(cal)) throw new Error('Calendar is read only')
        return { client: (await clientForCalendar(cal.id, userId)).client, cal }
      })()
      targets.set(calendarId, found)
    }
    return found
  }
  const etags = new Map<string, string>()
  const etagFor = (op: { eventId: string; etag?: string }) => (op.etag ? (etags.get(op.eventId) ?? op.etag) : undefined)
  // `recolored`: the op set a colorId, so the user's chosen color applies (a split's truncated master keeps its own).
  const saved: { calendarId: string; event: GoogleEvent; recolored: boolean }[] = []
  const removed: { calendarId: string; googleEventId: string }[] = []
  const remember = (calendarId: string, event: GoogleEvent, recolored = false) => {
    if (event.etag) etags.set(event.id, event.etag)
    saved.push({ calendarId, event, recolored })
  }
  try {
    for (const op of ops) {
      const { client, cal } = await target(op.calendarId)
      try {
        if (op.op === 'move') {
          const destination = await target(op.destinationCalendarId)
          const moved = await client.moveEvent(cal.googleCalendarId, op.eventId, destination.cal.googleCalendarId)
          removed.push({ calendarId: cal.id, googleEventId: op.eventId })
          remember(destination.cal.id, moved)
        } else if (op.op === 'patch') {
          remember(
            cal.id,
            await client.updateEvent(cal.googleCalendarId, op.eventId, op.body, etagFor(op)),
            op.body.colorId !== undefined,
          )
        } else if (op.op === 'create') {
          remember(cal.id, await client.createEvent(cal.googleCalendarId, op.body), op.body.colorId !== undefined)
        } else {
          await client.deleteEvent(cal.googleCalendarId, op.eventId, etagFor(op))
          removed.push({ calendarId: cal.id, googleEventId: op.eventId })
        }
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 412) throw new Error(CHANGED_IN_GOOGLE)
        if (!(op.op === 'patch' || op.op === 'delete') || !op.ignoreMissing || !isMissing(error)) throw error
        removed.push({ calendarId: cal.id, googleEventId: op.eventId })
      }
    }
  } finally {
    // Record whatever reached Google, even if a later step failed.
    const masterColor = db
      .select({ color: googleEvent.color })
      .from(googleEvent)
      .where(and(eq(googleEvent.calendarId, context.cal.id), eq(googleEvent.googleEventId, context.master.id)))
      .get()?.color
    db.transaction((tx) => {
      for (const item of removed)
        tx.delete(googleEvent)
          .where(
            and(
              eq(googleEvent.calendarId, item.calendarId),
              or(
                eq(googleEvent.googleEventId, item.googleEventId),
                eq(googleEvent.recurringEventId, item.googleEventId),
              ),
            ),
          )
          .run()
      for (const { calendarId, event, recolored } of saved) {
        const existing = tx
          .select({ color: googleEvent.color })
          .from(googleEvent)
          .where(and(eq(googleEvent.calendarId, calendarId), eq(googleEvent.googleEventId, event.id)))
          .get()
        const value = {
          ...normalizeGoogleEvent(calendarId, event),
          color: (recolored && eventColor) || existing?.color || masterColor || null,
        }
        tx.insert(googleEvent)
          .values(value)
          .onConflictDoUpdate({ target: [googleEvent.calendarId, googleEvent.googleEventId], set: value })
          .run()
      }
    })
  }
}

export async function saveRecurringEventForUser(
  userId: string,
  data: { id: string; scope: RecurringScope; patch: SeriesPatch; timeZone?: string },
) {
  const context = await loadSeries(userId, data.id, data.timeZone)
  if (!writable(context.cal)) throw new Error('Calendar is read only')
  const ops = planRecurringEdit({
    calendarId: context.cal.id,
    master: context.master,
    instance: context.instance,
    exceptions: context.exceptions,
    timeZone: context.timeZone,
    priorOccurrences: data.scope === 'following' ? await priorOccurrences(context) : undefined,
    hasEarlierOccurrences: data.scope === 'following' ? await hasEarlierOccurrences(context) : undefined,
    patch: data.patch,
    scope: data.scope,
  })
  await execute(userId, context, ops, data.patch.eventColor)
  return { ok: true as const }
}

export async function deleteRecurringEventForUser(userId: string, data: { id: string; scope: RecurringScope }) {
  const context = await loadSeries(userId, data.id)
  if (!writable(context.cal)) throw new Error('Calendar is read only')
  const ops = planRecurringDelete({
    calendarId: context.cal.id,
    master: context.master,
    instance: context.instance,
    exceptions: context.exceptions,
    timeZone: context.timeZone,
    hasEarlierOccurrences: data.scope === 'following' ? await hasEarlierOccurrences(context) : undefined,
    scope: data.scope,
  })
  await execute(userId, context, ops)
  return { ok: true as const }
}

/** The neighbouring non-cancelled occurrence of the same series, or null at either end. */
export async function getAdjacentOccurrenceForUser(
  userId: string,
  data: { id: string; direction: 'prev' | 'next' },
): Promise<{ id: string; start: string; end: string; allDay: boolean } | null> {
  const { calendarId, instanceId } = parseInstanceId(data.id)
  const cal = await ownedCalendar(userId, calendarId)
  const { client } = await clientForCalendar(cal.id, userId)
  const instance = await getOrUnavailable(client, cal.googleCalendarId, instanceId)
  const start = timeValue(instance.start)
  if (!instance.recurringEventId || !start || isKairoOwned(instance)) throw unavailable()
  const from = position(start)
  const window = 400 * DAY_MS
  const items = await client.listInstances(
    cal.googleCalendarId,
    instance.recurringEventId,
    data.direction === 'next'
      ? { timeMin: new Date(from - DAY_MS), timeMax: new Date(from + window), maxResults: 50 }
      : { timeMin: new Date(from - window), timeMax: new Date(from + DAY_MS) },
  )
  const candidates = items
    .map((item) => ({ item, start: timeValue(item.start), end: timeValue(item.end) }))
    .filter(
      (entry): entry is { item: GoogleEvent; start: string; end: string } =>
        entry.item.id !== instance.id &&
        entry.item.status !== 'cancelled' &&
        !!entry.start &&
        !!entry.end &&
        (data.direction === 'next' ? position(entry.start) > from : position(entry.start) < from),
    )
    .sort((a, b) => position(a.start) - position(b.start))
  const found = data.direction === 'next' ? candidates[0] : candidates.at(-1)
  if (!found) return null
  return {
    id: `instance:${cal.id}:${found.item.id}`,
    start: found.start,
    end: found.end,
    allDay: !!found.item.start?.date,
  }
}
