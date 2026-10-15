// Pure planning for scoped edits/deletes of recurring Google Calendar events ("This event", "This and
// following", "All events"). The planner only decides which API calls to make; the caller executes them in order.
import { closestEventColorId, type GoogleEvent, type GoogleTime } from './index.js'
import {
  formatRecurrence,
  parseRecurrence,
  untilBefore,
  withEnd,
  type RecurrenceRule,
  type Weekday,
} from './recurrence.js'

export type RecurringScope = 'this' | 'following' | 'all'
export type GoogleEventBody = Partial<GoogleEvent> & Record<string, unknown>

/** Fields the user changed on an occurrence; `recurrence: null` stops repeating. Colors are #rrggbb. */
export interface SeriesPatch {
  title?: string
  start?: string
  end?: string
  allDay?: boolean
  calendarId?: string
  eventColor?: string
  description?: string
  location?: string
  recurrence?: string[] | null
}

/**
 * `calendarId` values are opaque to the planner: ops reference the series' calendar or the patch's target calendar.
 * `ignoreMissing` ops may 404/410 without failing the edit.
 */
export type SeriesOperation =
  | { op: 'patch'; calendarId: string; eventId: string; body: GoogleEventBody; etag?: string; ignoreMissing?: boolean }
  | { op: 'create'; calendarId: string; body: GoogleEventBody }
  | { op: 'delete'; calendarId: string; eventId: string; etag?: string; ignoreMissing?: boolean }
  | { op: 'move'; calendarId: string; eventId: string; destinationCalendarId: string }

export interface SeriesPlanInput {
  /** Calendar the series lives in. */
  calendarId: string
  master: GoogleEvent
  /** The occurrence being edited, as Google returns it (has recurringEventId and originalStartTime). */
  instance: GoogleEvent
  /** Every stored exception of the series (events whose recurringEventId is the master), cancelled ones included. */
  exceptions: GoogleEvent[]
  /** IANA zone the series recurs in. */
  timeZone: string
  /** Occurrences (cancelled included) before this one; required to split a COUNT-limited series. */
  priorOccurrences?: number
  /** Whether any non-cancelled occurrence comes before this one; false makes "following" act on the whole series. */
  hasEarlierOccurrences?: boolean
}

const DAY_MS = 86400_000
const DAYS: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const isDateOnly = (value: string) => DATE_ONLY.test(value)
const pad = (n: number, width = 2) => String(n).padStart(width, '0')

// ---- Time-zone arithmetic (Intl only, no dependencies) ----

type Slot = { date: string; time?: string } // wall clock in the series zone; no time = all-day

const formatters = new Map<string, Intl.DateTimeFormat>()
function wallParts(instant: number, tz: string) {
  let format = formatters.get(tz)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(tz, format)
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((p) => [p.type, p.value]))
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  }
}
const utcOf = (date: string, time = '00:00:00') => Date.parse(`${date}T${time}Z`)
const offsetAt = (instant: number, tz: string) => {
  const wall = wallParts(instant, tz)
  return utcOf(wall.date, wall.time) - Math.floor(instant / 1000) * 1000
}
function instantOf(slot: Slot, tz: string): number {
  const guess = utcOf(slot.date, slot.time)
  let result = guess - offsetAt(guess, tz)
  const corrected = guess - offsetAt(result, tz)
  if (corrected !== result) result = corrected
  return result
}
function parseInstant(value: string) {
  const time = Date.parse(value)
  if (Number.isNaN(time)) throw new Error(`Invalid date-time: ${value}`)
  return time
}
function slotOf(value: string, tz: string): Slot {
  if (isDateOnly(value)) return { date: value }
  return wallParts(parseInstant(value), tz)
}
const addDays = (date: string, days: number) => new Date(utcOf(date) + days * DAY_MS).toISOString().slice(0, 10)
const dayDiff = (a: string, b: string) => Math.round((utcOf(a) - utcOf(b)) / DAY_MS)
const weekdayOf = (date: string) => DAYS[new Date(utcOf(date)).getUTCDay()]
/** Comparable position of an originalStart value (date or date-time). */
const position = (value: string) => (isDateOnly(value) ? utcOf(value) : parseInstant(value))

function formatOffset(offsetMs: number) {
  const minutes = Math.round(offsetMs / 60_000)
  const sign = minutes < 0 ? '-' : '+'
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
}
function timedValue(instant: number, tz: string): GoogleTime {
  const wall = wallParts(instant, tz)
  return { dateTime: `${wall.date}T${wall.time}${formatOffset(offsetAt(instant, tz))}`, timeZone: tz }
}
function googleTime(slot: Slot, tz: string): GoogleTime {
  return slot.time === undefined ? { date: slot.date } : timedValue(instantOf(slot, tz), tz)
}
const timeValue = (time: GoogleTime | undefined) => time?.dateTime ?? time?.date
/** A Google time with the series zone attached (Google requires it on recurring events). */
function withZone(time: GoogleTime | undefined, tz: string): GoogleTime | undefined {
  if (!time || time.date) return time
  return { ...time, timeZone: time.timeZone ?? tz }
}

// ---- Patch interpretation ----

interface Timing {
  allDay: boolean
  start: string
  end: string
  startSlot: Slot
  /** Moves a slot value of the old series onto the new series time (same day delta, new time of day). */
  shiftFrom(base: string): (value: string) => Slot
  /** Google start/end for an occurrence starting at `slot` with the new duration. */
  times(slot: Slot): { start: GoogleTime; end: GoogleTime }
}

function makeTiming(allDay: boolean, start: string, end: string, tz: string): Timing {
  if (allDay !== isDateOnly(start) || allDay !== isDateOnly(end))
    throw new Error(allDay ? 'All-day events need YYYY-MM-DD dates' : 'Timed events need date-times')
  const duration = allDay ? dayDiff(end, start) : parseInstant(end) - parseInstant(start)
  if (duration <= 0) throw new Error('Event end must follow start')
  const startSlot = slotOf(start, tz)
  return {
    allDay,
    start,
    end,
    startSlot,
    shiftFrom(base) {
      const delta = dayDiff(startSlot.date, slotOf(base, tz).date)
      return (value) => {
        const date = addDays(slotOf(value, tz).date, delta)
        return allDay ? { date } : { date, time: startSlot.time }
      }
    },
    times(slot) {
      if (allDay) return { start: { date: slot.date }, end: { date: addDays(slot.date, duration) } }
      const at = instantOf(slot, tz)
      return { start: timedValue(at, tz), end: timedValue(at + duration, tz) }
    },
  }
}

/** The occurrence's start/end after the patch, or null when the patch doesn't change its time. */
function patchedTiming(input: SeriesPlanInput, patch: SeriesPatch): Timing | null {
  const current = { start: timeValue(input.instance.start), end: timeValue(input.instance.end) }
  if (!current.start || !current.end) throw new Error('Occurrence has no time')
  const currentAllDay = isDateOnly(current.start)
  const allDay = patch.allDay ?? currentAllDay
  if (allDay !== currentAllDay && (patch.start === undefined || patch.end === undefined))
    throw new Error('Changing all-day requires a new start and end')
  const start = patch.start ?? current.start
  const end = patch.end ?? current.end
  const same = (a: string, b: string) => (isDateOnly(a) || isDateOnly(b) ? a === b : position(a) === position(b))
  if (allDay === currentAllDay && same(start, current.start) && same(end, current.end)) return null
  return makeTiming(allDay, start, end, input.timeZone)
}

function currentTiming(input: SeriesPlanInput): Timing {
  const start = timeValue(input.instance.start)
  const end = timeValue(input.instance.end)
  if (!start || !end) throw new Error('Occurrence has no time')
  return makeTiming(isDateOnly(start), start, end, input.timeZone)
}

/**
 * Timing for a series-wide edit (all / following). When the edit keeps the occurrence's start, the series stays on
 * its own slot: an occurrence that was moved one-off must not drag the series to where it was moved just because
 * its end or title changed. `fallback` returns the series' own slot and duration when the time didn't change at all.
 */
function seriesTiming(input: SeriesPlanInput, patch: SeriesPatch, fallback: boolean): Timing | null {
  const timing = patchedTiming(input, patch)
  const original = originalStartOf(input.instance)
  const current = timeValue(input.instance.start)
  if (!original || !current) return timing
  const allDay = isDateOnly(original)
  if (timing && (timing.allDay !== allDay || position(timing.start) !== position(current))) return timing
  if (timing && position(original) === position(current)) return timing
  if (!timing && !fallback) return null
  let length: number
  if (timing)
    length = allDay ? dayDiff(timing.end, timing.start) : parseInstant(timing.end) - parseInstant(timing.start)
  else {
    const masterStart = timeValue(input.master.start)
    const masterEnd = timeValue(input.master.end)
    if (!masterStart || !masterEnd || isDateOnly(masterStart) !== allDay) return currentTiming(input)
    length = allDay ? dayDiff(masterEnd, masterStart) : parseInstant(masterEnd) - parseInstant(masterStart)
  }
  const end = allDay ? addDays(original, length) : new Date(parseInstant(original) + length).toISOString()
  return makeTiming(allDay, original, end, input.timeZone)
}

function fieldBody(patch: SeriesPatch): GoogleEventBody {
  const body: GoogleEventBody = {}
  if (patch.title !== undefined) body.summary = patch.title
  if (patch.description !== undefined) body.description = patch.description
  if (patch.location !== undefined) body.location = patch.location
  if (patch.eventColor) body.colorId = closestEventColorId(patch.eventColor)
  return body
}

const originalStartOf = (event: GoogleEvent) => timeValue(event.originalStartTime)
const isRRule = (line: string) => /^RRULE:/i.test(line.trim())

// ---- Rule and EXDATE rewriting ----

/** UNTIL in the form RRULE requires for the series type: a date for all-day, otherwise a UTC date-time. */
export function untilAs(rule: RecurrenceRule, allDay: boolean, tz: string): RecurrenceRule {
  const until = rule.until
  if (!until || (until.length === 8) === allDay) return rule
  const date = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`
  if (allDay) {
    const time = `${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}`
    const instant = /Z$/i.test(until) ? utcOf(date, time) : instantOf({ date, time }, tz)
    return { ...rule, until: wallParts(instant, tz).date.replaceAll('-', '') }
  }
  // A date UNTIL includes that whole day; keep it inclusive as the last second of the day in the series zone.
  const end = new Date(instantOf({ date, time: '23:59:59' }, tz)).toISOString()
  return { ...rule, until: end.replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '') }
}

/** Re-derives the day parts of `rule` when its occurrences move from `oldDate` to `newDate`. */
export function shiftRule(rule: RecurrenceRule, oldDate: string, newDate: string): RecurrenceRule {
  const delta = dayDiff(newDate, oldDate)
  if (!delta) return rule
  const next: RecurrenceRule = { ...rule }
  const oldDay = Number(oldDate.slice(8, 10))
  const newDay = Number(newDate.slice(8, 10))
  if (rule.freq === 'WEEKLY' && rule.byDay?.length && rule.byDay.every((d) => d.nth === undefined)) {
    // Every listed weekday moves by the same amount (MO,WE,FR moved a day later becomes TU,TH,SA).
    next.byDay = rule.byDay.map(({ day }) => ({ day: DAYS[(((DAYS.indexOf(day) + delta) % 7) + 7) % 7] }))
  }
  if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') {
    if (rule.byMonthDay?.length === 1 && rule.byMonthDay[0] === oldDay) next.byMonthDay = [newDay]
    if (rule.byDay?.length === 1 && rule.byDay[0].nth !== undefined && rule.byDay[0].day === weekdayOf(oldDate)) {
      const oldNth = Math.ceil(oldDay / 7)
      const lastOld = Number(addDays(oldDate, 7).slice(8, 10)) < oldDay
      const lastNew = Number(addDays(newDate, 7).slice(8, 10)) < newDay
      const { nth } = rule.byDay[0]
      if (nth === oldNth || (nth === -1 && lastOld))
        next.byDay = [{ day: weekdayOf(newDate), nth: nth === -1 && lastNew ? -1 : Math.ceil(newDay / 7) }]
    }
  }
  if (rule.freq === 'YEARLY' && rule.byMonth?.length === 1 && rule.byMonth[0] === Number(oldDate.slice(5, 7)))
    next.byMonth = [Number(newDate.slice(5, 7))]
  return next
}

/** Values of an EXDATE line as originalStart-style strings (YYYY-MM-DD or ISO), or null if unparseable. */
function exdateValues(line: string, tz: string): string[] | null {
  const match = /^EXDATE((?:;[^:]*)?):(.+)$/i.exec(line.trim())
  if (!match) return null
  const zone = /;TZID=([^;:]+)/i.exec(match[1])?.[1] ?? tz
  const values: string[] = []
  for (const raw of match[2].split(',')) {
    const value = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(raw.trim())
    if (!value) return null
    const date = `${value[1]}-${value[2]}-${value[3]}`
    if (value[4] === undefined) values.push(date)
    else {
      const time = `${value[4]}:${value[5]}:${value[6]}`
      values.push(
        new Date(value[7] ? utcOf(date, time) : instantOf({ date, time }, zone)).toISOString().replace('.000Z', 'Z'),
      )
    }
  }
  return values
}

function formatExdates(slots: Slot[], tz: string): string[] {
  if (!slots.length) return []
  const allDay = slots[0].time === undefined
  const values = slots.map((slot) =>
    allDay ? slot.date.replaceAll('-', '') : `${slot.date.replaceAll('-', '')}T${slot.time!.replaceAll(':', '')}`,
  )
  return [allDay ? `EXDATE;VALUE=DATE:${values.join(',')}` : `EXDATE;TZID=${tz}:${values.join(',')}`]
}

/** Shifts EXDATE lines onto the new series time; other lines are kept verbatim. */
function shiftExtras(extra: string[], shift: (value: string) => Slot, tz: string) {
  return extra.flatMap((line) => {
    const values = exdateValues(line, tz)
    return values ? formatExdates(values.map(shift), tz) : [line]
  })
}

// ---- Planning ----

function parsedRule(master: GoogleEvent) {
  const parsed = parseRecurrence(master.recurrence)
  if (!parsed) throw new Error('This event is not a recurring series')
  return parsed
}

function isFirstOccurrence(input: SeriesPlanInput) {
  if (input.priorOccurrences === 0 || input.hasEarlierOccurrences === false) return true
  const original = originalStartOf(input.instance)
  const masterStart = timeValue(input.master.start)
  return !!original && !!masterStart && position(original) === position(masterStart)
}

function requireOccurrence(input: SeriesPlanInput) {
  const original = originalStartOf(input.instance)
  if (!original || input.instance.recurringEventId !== input.master.id)
    throw new Error('This occurrence does not belong to the series')
  return original
}

function planThis(input: SeriesPlanInput, patch: SeriesPatch): SeriesOperation[] {
  if (patch.recurrence !== undefined) throw new Error('Change the repeat rule for following or all events instead')
  if (patch.calendarId !== undefined && patch.calendarId !== input.calendarId)
    throw new Error('Move following or all events to another calendar instead')
  const body = fieldBody(patch)
  const timing = patchedTiming(input, patch)
  if (timing) Object.assign(body, timing.times(timing.startSlot))
  if (!Object.keys(body).length) return []
  return [{ op: 'patch', calendarId: input.calendarId, eventId: input.instance.id, body, etag: input.instance.etag }]
}

function planAll(input: SeriesPlanInput, patch: SeriesPatch): SeriesOperation[] {
  const { master, timeZone: tz } = input
  const original = requireOccurrence(input)
  const parsed = parsedRule(master)
  const ops: SeriesOperation[] = []
  let calendarId = input.calendarId
  if (patch.calendarId !== undefined && patch.calendarId !== calendarId) {
    ops.push({ op: 'move', calendarId, eventId: master.id, destinationCalendarId: patch.calendarId })
    calendarId = patch.calendarId
  }
  const fields = fieldBody(patch)
  const live = input.exceptions.filter((event) => event.status !== 'cancelled')
  const newRules = patch.recurrence?.filter(isRRule)

  if (patch.recurrence === null || (patch.recurrence && !newRules?.length)) {
    // Stop repeating: the series collapses into a single event at this occurrence's (patched) time.
    const occurrence = patchedTiming(input, patch) ?? currentTiming(input)
    for (const event of live) ops.push({ op: 'delete', calendarId, eventId: event.id, ignoreMissing: true })
    ops.push({
      op: 'patch',
      calendarId,
      eventId: master.id,
      body: { ...fields, ...occurrence.times(occurrence.startSlot), recurrence: [] },
      etag: master.etag,
    })
    return ops
  }

  const timing = seriesTiming(input, patch, false)
  const body: GoogleEventBody = { ...fields }
  const masterStart = timeValue(master.start)
  if (!masterStart) throw new Error('Series has no start time')
  const shift = timing?.shiftFrom(original)
  let rules = parsed.raw.filter(isRRule)
  let extra = parsed.extra
  if (timing && shift) {
    const newStart = shift(masterStart)
    Object.assign(body, timing.times(newStart))
    extra = shiftExtras(extra, shift, tz)
    // Cancelled occurrences are keyed by their old slot, which no longer exists once the series moves; keep them
    // cancelled as EXDATEs on their new slot.
    const moved =
      timing.startSlot.date !== slotOf(original, tz).date || timing.startSlot.time !== slotOf(original, tz).time
    const cancelled = input.exceptions
      .filter((event) => event.status === 'cancelled')
      .map(originalStartOf)
      .filter((value): value is string => !!value)
    if (moved && cancelled.length) extra = [...extra, ...formatExdates(cancelled.map(shift), tz)]
    if (!newRules && parsed.rule)
      rules = formatRecurrence(
        untilAs(shiftRule(parsed.rule, slotOf(masterStart, tz).date, newStart.date), timing.allDay, tz),
      )
  }
  if (newRules) rules = newRules
  const recurrence = [...rules, ...extra]
  if (recurrence.join('\n') !== parsed.raw.join('\n')) {
    body.recurrence = recurrence
    body.start ??= withZone(master.start, tz)
    body.end ??= withZone(master.end, tz)
  }
  if (Object.keys(body).length) ops.push({ op: 'patch', calendarId, eventId: master.id, body, etag: master.etag })

  // "All events" overwrites occurrences that were edited one by one. Cancelled ones stay cancelled.
  for (const event of live) {
    const exceptionBody: GoogleEventBody = { ...fields }
    const exceptionOriginal = originalStartOf(event)
    if (timing && shift && exceptionOriginal) Object.assign(exceptionBody, timing.times(shift(exceptionOriginal)))
    if (Object.keys(exceptionBody).length)
      ops.push({ op: 'patch', calendarId, eventId: event.id, body: exceptionBody, ignoreMissing: true })
  }
  return ops
}

/** Ends the series just before `original` and removes the exceptions from there on. */
function truncate(input: SeriesPlanInput, original: string): SeriesOperation[] {
  const { master } = input
  const parsed = parsedRule(master)
  if (!parsed.rule || !parsed.supported) throw new Error("This event's repeat rule can't be split")
  const rule = withEnd(parsed.rule, { until: untilBefore(original, isDateOnly(original)) })
  const ops: SeriesOperation[] = [
    {
      op: 'patch',
      calendarId: input.calendarId,
      eventId: master.id,
      body: {
        recurrence: formatRecurrence(rule, parsed.extra),
        start: withZone(master.start, input.timeZone),
        end: withZone(master.end, input.timeZone),
      },
      etag: master.etag,
    },
  ]
  for (const event of exceptionsFrom(input, original))
    if (event.status !== 'cancelled')
      ops.push({ op: 'delete', calendarId: input.calendarId, eventId: event.id, ignoreMissing: true })
  return ops
}

function exceptionsFrom(input: SeriesPlanInput, original: string) {
  const split = position(original)
  return input.exceptions.filter((event) => {
    const value = originalStartOf(event)
    return !!value && position(value) >= split
  })
}

// Master fields that are safe to copy onto a new series created by a split.
const COPIED_FIELDS = [
  'summary',
  'description',
  'location',
  'colorId',
  'transparency',
  'visibility',
  'reminders',
  'attendees',
  'guestsCanInviteOthers',
  'guestsCanModify',
  'guestsCanSeeOtherGuests',
  'anyoneCanAddSelf',
  'source',
]

function planFollowing(input: SeriesPlanInput, patch: SeriesPatch): SeriesOperation[] {
  const original = requireOccurrence(input)
  if (isFirstOccurrence(input)) return planAll(input, patch)
  const { master, timeZone: tz } = input
  const parsed = parsedRule(master)
  const ops = truncate(input, original)

  const timing = seriesTiming(input, patch, true) ?? currentTiming(input)
  const shift = timing.shiftFrom(original)
  const body: GoogleEventBody = {}
  const source = master as unknown as Record<string, unknown>
  for (const key of COPIED_FIELDS) if (source[key] !== undefined) body[key] = source[key]
  Object.assign(body, fieldBody(patch), timing.times(timing.startSlot))

  // A null or RRULE-less recurrence creates a single event instead of a new series.
  const given = patch.recurrence?.filter(isRRule)
  if (patch.recurrence === undefined || given?.length) {
    let rules = given
    if (!rules?.length) {
      let rule = untilAs(shiftRule(parsed.rule!, slotOf(original, tz).date, timing.startSlot.date), timing.allDay, tz)
      if (rule.count) {
        if (input.priorOccurrences === undefined) throw new Error('Occurrence count unknown')
        rule = withEnd(rule, { count: Math.max(1, rule.count - input.priorOccurrences) })
      }
      rules = formatRecurrence(rule)
    }
    // Cancelled occurrences after the split stay cancelled in the new series.
    const split = position(original)
    const cancelled = [
      ...exceptionsFrom(input, original)
        .filter((event) => event.status === 'cancelled')
        .map((event) => originalStartOf(event)!),
      ...parsed.extra.flatMap((line) => exdateValues(line, tz) ?? []).filter((value) => position(value) >= split),
    ]
    body.recurrence = [...rules, ...formatExdates(cancelled.map(shift), tz)]
  }
  ops.push({ op: 'create', calendarId: patch.calendarId ?? input.calendarId, body })
  return ops
}

export function planRecurringEdit(input: SeriesPlanInput & { patch: SeriesPatch; scope: RecurringScope }) {
  const { patch, scope } = input
  if (scope === 'this') return planThis(input, patch)
  if (scope === 'all') return planAll(input, patch)
  return planFollowing(input, patch)
}

export function planRecurringDelete(input: SeriesPlanInput & { scope: RecurringScope }): SeriesOperation[] {
  const { master, instance, calendarId } = input
  const original = requireOccurrence(input)
  if (input.scope === 'this') return [{ op: 'delete', calendarId, eventId: instance.id, etag: instance.etag }]
  if (input.scope === 'all' || isFirstOccurrence(input))
    return [{ op: 'delete', calendarId, eventId: master.id, etag: master.etag }]
  return truncate(input, original)
}
