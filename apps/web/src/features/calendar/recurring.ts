import { summarizeRecurrence } from '@kairo/integrations/recurrence'
import { format } from 'date-fns'
import { formatTimeRange, parseEventDate, sameDay } from './date'
import type { CalendarEvent, CalendarOption, RecurringEventPatch, RecurringScope } from './types'

// Google's event color ids, using the hex its colors API reports (what synced events render with). The server
// snaps whatever we send to the nearest id, so these round-trip exactly.
export const EVENT_COLORS: [string, string][] = [
  ['Tomato', '#dc2127'],
  ['Flamingo', '#ff887c'],
  ['Tangerine', '#ffb878'],
  ['Banana', '#fbd75b'],
  ['Sage', '#7ae7bf'],
  ['Basil', '#51b749'],
  ['Peacock', '#46d6db'],
  ['Blueberry', '#5484ed'],
  ['Lavender', '#a4bdfc'],
  ['Grape', '#dbadff'],
  ['Graphite', '#e1e1e1'],
]

export const SCOPES: [RecurringScope, string][] = [
  ['this', 'This event'],
  ['following', 'This and following events'],
  ['all', 'All events'],
]

const time = (event: CalendarEvent, field: 'start' | 'end') => parseEventDate(event[field], event.allDay).getTime()
const lines = (value: string[] | undefined) => (value?.length ? value : null)
const sameLines = (a: string[] | null, b: string[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((line, i) => line === b[i]))

/** Fields of `changed` that differ from `original`, in the shape saveRecurringEvent expects. */
export function diffRecurring(original: CalendarEvent, changed: CalendarEvent): RecurringEventPatch {
  const patch: RecurringEventPatch = {}
  const allDay = !!original.allDay !== !!changed.allDay
  if (allDay) patch.allDay = !!changed.allDay
  if (allDay || time(original, 'start') !== time(changed, 'start') || time(original, 'end') !== time(changed, 'end')) {
    patch.start = changed.start
    patch.end = changed.end
  }
  if (original.title !== changed.title) patch.title = changed.title
  if ((original.description ?? '') !== (changed.description ?? '')) patch.description = changed.description ?? ''
  if ((original.location ?? '') !== (changed.location ?? '')) patch.location = changed.location ?? ''
  if (original.calendarId !== changed.calendarId) patch.calendarId = changed.calendarId
  if ((original.eventColor ?? '').toLowerCase() !== (changed.eventColor ?? '').toLowerCase())
    patch.eventColor = changed.eventColor
  if (!sameLines(lines(original.recurrence), lines(changed.recurrence))) patch.recurrence = lines(changed.recurrence)
  return patch
}

export const isEmptyPatch = (patch: RecurringEventPatch) => Object.keys(patch).length === 0

/** Scopes the server accepts for `patch`: a single occurrence can't change the rule or move calendars. */
export function allowedScopes(patch: RecurringEventPatch): RecurringScope[] {
  if ('calendarId' in patch) return ['all']
  if ('recurrence' in patch) return ['following', 'all']
  return ['this', 'following', 'all']
}

export const defaultScope = (allowed: RecurringScope[]): RecurringScope => (allowed.includes('this') ? 'this' : 'all')

export interface ChangeRow {
  label: string
  from: string
  to: string
}

const colorName = (hex: string | undefined, calendar: CalendarOption | undefined) =>
  hex
    ? (EVENT_COLORS.find(([, value]) => value === hex.toLowerCase())?.[0] ?? 'Custom color')
    : `Calendar color${calendar ? ` (${calendar.name})` : ''}`
const repeatText = (event: CalendarEvent) => {
  const { label, hint } = summarizeRecurrence(event.recurrence, parseEventDate(event.start, event.allDay))
  return hint ? `${label} ${hint}` : label
}
const timeText = (event: CalendarEvent) =>
  event.allDay ? 'All day' : formatTimeRange(parseEventDate(event.start), parseEventDate(event.end)).replace(/ /g, '')
const dateText = (event: CalendarEvent) => format(parseEventDate(event.start, event.allDay), 'EEE MMM d, yyyy')

/** Human-readable before/after rows for the fields `patch` changes. */
export function describeChanges(
  original: CalendarEvent,
  changed: CalendarEvent,
  patch: RecurringEventPatch,
  calendars: CalendarOption[] = [],
): ChangeRow[] {
  const rows: ChangeRow[] = []
  const add = (label: string, from: string, to: string) => from !== to && rows.push({ label, from, to })
  if ('start' in patch || 'allDay' in patch) {
    add('Time', timeText(original), timeText(changed))
    if (!sameDay(parseEventDate(original.start, original.allDay), parseEventDate(changed.start, changed.allDay)))
      add('Date', dateText(original), dateText(changed))
  }
  if ('title' in patch) add('Title', original.title, changed.title)
  if ('location' in patch) add('Location', original.location || 'None', changed.location || 'None')
  if ('description' in patch) add('Description', original.description || 'None', changed.description || 'None')
  const calendar = (id?: string) => calendars.find((item) => item.id === id)
  if ('calendarId' in patch)
    add('Calendar', calendar(original.calendarId)?.name ?? 'Unknown', calendar(changed.calendarId)?.name ?? 'Unknown')
  if ('eventColor' in patch)
    add(
      'Color',
      colorName(original.eventColor, calendar(original.calendarId)),
      colorName(changed.eventColor, calendar(changed.calendarId)),
    )
  if ('recurrence' in patch) add('Repeat', repeatText(original), repeatText(changed))
  return rows
}
