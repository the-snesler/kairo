import { addDays, eventIntersectsDay, minuteOfDay, parseEventDate, startOfDay } from './date'
import type { CalendarEvent } from './types'

export interface TimedSegment {
  event: CalendarEvent
  top: number
  height: number
  left: number
  width: number
  column: number
  columns: number
}

export function timedSegments(events: CalendarEvent[], day: Date, hourHeight: number): TimedSegment[] {
  const start = startOfDay(day)
  const end = addDays(start, 1)
  const segments = events.flatMap(event => {
    if (event.allDay) return []
    const eventStart = parseEventDate(event.start)
    const eventEnd = parseEventDate(event.end)
    if (!eventIntersectsDay(eventStart, eventEnd, start)) return []
    const segmentStart = eventStart < start ? start : eventStart
    const segmentEnd = eventEnd > end ? end : eventEnd
    return [{ event, top: minuteOfDay(segmentStart) / 60 * hourHeight,
      height: Math.max(20, (segmentEnd.getTime() - segmentStart.getTime()) / 3_600_000 * hourHeight),
      left: 0, width: 100, column: 0, columns: 1 }]
  }).sort((a, b) => a.top - b.top || b.height - a.height)

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
    for (const segment of group) {
      segment.columns = columns
      segment.left = segment.column * 100 / columns
      segment.width = 100 / columns
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
