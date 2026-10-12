import { addDays, DAY_MS, dayKey, eventIntersectsDay, minuteOfDay, parseEventDate, startOfDay } from './date'
import type { CalendarEvent } from './types'

// How far, as a fraction of a column, an event reaches under its right-hand neighbour.
const OVERHANG = 0.4

export interface TimedSegment {
  event: CalendarEvent
  top: number
  height: number
  left: number
  width: number
  column: number
  columns: number
}

/** Derives a task card's start/end from its single due date: all-day for a date, start + duration for a time. */
export function normalizeTaskEvent(event: CalendarEvent): CalendarEvent {
  const due = event.kind === 'task' ? event.task?.due : null
  if (!due || !event.task) return event
  if ('date' in due) return { ...event, start: due.date, end: dayKey(addDays(parseEventDate(due.date, true), 1)), allDay: true }
  const start = new Date(due.dateTime)
  return { ...event, start: start.toISOString(), end: new Date(start.getTime() + Math.max(event.task.durationMinutes, 1) * 60_000).toISOString(), allDay: false }
}

/** All-day events and timed events lasting a full day or more render in the top bar instead of the time grid. */
export function inTopBar(event: CalendarEvent): boolean {
  if (event.allDay) return true
  return parseEventDate(event.end).getTime() - parseEventDate(event.start).getTime() >= DAY_MS
}

export function timedSegments(events: CalendarEvent[], day: Date, hourHeight: number): TimedSegment[] {
  const start = startOfDay(day)
  const end = addDays(start, 1)
  const segments = events.flatMap(event => {
    if (inTopBar(event)) return []
    const eventStart = parseEventDate(event.start)
    const eventEnd = parseEventDate(event.end)
    if (!eventIntersectsDay(eventStart, eventEnd, start)) return []
    const segmentStart = eventStart < start ? start : eventStart
    const segmentEnd = eventEnd > end ? end : eventEnd
    return [{ event, top: minuteOfDay(segmentStart) / 60 * hourHeight,
      height: Math.max(20, (segmentEnd.getTime() - segmentStart.getTime()) / 3_600_000 * hourHeight),
      left: 0, width: 100, column: 0, columns: 1 }]
  }).sort((a, b) => a.top - b.top || b.height - a.height)

  const overlaps = (a: TimedSegment, b: TimedSegment) => a.top < b.top + b.height && b.top < a.top + a.height
  let group: TimedSegment[] = []
  const flush = () => {
    const lanes: number[] = []
    for (const segment of group) {
      let column = lanes.findIndex(bottom => bottom <= segment.top)
      if (column < 0) column = lanes.length
      lanes[column] = segment.top + segment.height
      segment.column = column
    }
    const columns = Math.max(lanes.length, 1)
    const columnWidth = 100 / columns
    for (const segment of group) {
      // Grow into columns to the right that are free for this event's duration, then overhang the next occupied one.
      let span = 1
      while (segment.column + span < columns && !group.some(other => other.column === segment.column + span && overlaps(other, segment))) span++
      segment.columns = columns
      segment.left = segment.column * columnWidth
      segment.width = (span + (segment.column + span < columns ? OVERHANG : 0)) * columnWidth
    }
    group = []
  }
  let groupBottom = -1
  for (const segment of segments) {
    if (segment.top >= groupBottom) flush()
    group.push(segment)
    groupBottom = Math.max(groupBottom, segment.top + segment.height)
  }
  flush()
  return segments
}
