// Pure drag-and-drop geometry for the calendar: no DOM access, so it can be unit tested in node.
import { addDays, DAY_MS, dayKey, minuteOfDay, parseEventDate } from '../date'
import type { TaskDue } from '../../tasks/types'

export const SNAP_MINUTES = 15
export const MIN_DURATION_MINUTES = 15
export const DAY_MINUTES = 24 * 60

export type DropZone = 'timed' | 'allday' | 'month'

/** Where a drag would land. `minutes`/`endMinutes` are wall-clock minutes into `day` (timed zone only). */
export interface DropTarget {
  zone: DropZone
  day: string
  minutes?: number
  endMinutes?: number
  /** Hovering a zone the item may not move into. */
  invalid?: boolean
}

/** The drop zone under the pointer: its kind, day and top edge in client coordinates (already reflects scroll). */
export interface ZoneHit {
  zone: DropZone
  day: string
  top: number
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function snap(minutes: number, step = SNAP_MINUTES) {
  return Math.round(minutes / step) * step
}

/** Minutes into the day at a client Y coordinate inside a timed column whose top edge is at `zoneTop`. */
export function pointerMinutes(clientY: number, zoneTop: number, hourHeight: number) {
  return ((clientY - zoneTop) / hourHeight) * 60
}

/** Snapped start minute for an item of `durationMinutes` grabbed `grabMinutes` below its top edge, kept inside the day. */
export function timedStart(
  clientY: number,
  zoneTop: number,
  hourHeight: number,
  grabMinutes: number,
  durationMinutes: number,
  step = SNAP_MINUTES,
) {
  const fit = Math.min(Math.max(durationMinutes, step), DAY_MINUTES)
  const latest = Math.floor((DAY_MINUTES - fit) / step) * step
  return clamp(snap(pointerMinutes(clientY, zoneTop, hourHeight) - grabMinutes, step), 0, latest)
}

/** Snapped end minute while resizing an item that starts at `startMinutes`: at least the minimum duration, at most midnight. */
export function resizeEnd(
  clientY: number,
  zoneTop: number,
  hourHeight: number,
  startMinutes: number,
  step = SNAP_MINUTES,
  minDuration = MIN_DURATION_MINUTES,
) {
  return clamp(snap(pointerMinutes(clientY, zoneTop, hourHeight), step), startMinutes + minDuration, DAY_MINUTES)
}

export interface ResolveOptions {
  hourHeight: number
  grabMinutes: number
  durationMinutes: number
  zones: readonly DropZone[]
}

export function resolveTarget(hit: ZoneHit | null, clientY: number, options: ResolveOptions): DropTarget | null {
  if (!hit) return null
  if (!options.zones.includes(hit.zone)) return { zone: hit.zone, day: hit.day, invalid: true }
  if (hit.zone !== 'timed') return { zone: hit.zone, day: hit.day }
  const minutes = timedStart(clientY, hit.top, options.hourHeight, options.grabMinutes, options.durationMinutes)
  return {
    zone: 'timed',
    day: hit.day,
    minutes,
    endMinutes: Math.min(DAY_MINUTES, minutes + Math.max(options.durationMinutes, MIN_DURATION_MINUTES)),
  }
}

export function targetKey(target: DropTarget | null) {
  return target
    ? `${target.zone}|${target.day}|${target.minutes ?? ''}|${target.endMinutes ?? ''}|${target.invalid ? 1 : 0}`
    : ''
}

/** Local midnight of a YYYY-MM-DD key. */
export function dateFromKey(day: string) {
  return parseEventDate(day, true)
}

/** Local wall-clock time `minutes` into `day`; DST-safe because the Date constructor resolves wall-clock fields. */
export function wallClock(day: string, minutes: number) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date, 0, minutes)
}

export function daysBetween(from: string, to: string) {
  return Math.round((dateFromKey(to).getTime() - dateFromKey(from).getTime()) / DAY_MS)
}

/** Auto-scroll speed (px/frame) for a pointer near either edge of [min, max]; 0 outside the range or away from edges. */
export function edgeVelocity(position: number, min: number, max: number, edge = 48, maxSpeed = 18) {
  if (position < min || position > max) return 0
  const size = Math.min(edge, (max - min) / 3)
  if (size <= 0) return 0
  if (position < min + size) return -maxSpeed * Math.min(1, (min + size - position) / size)
  if (position > max - size) return maxSpeed * Math.min(1, (position - (max - size)) / size)
  return 0
}

export interface EventTimes {
  start: string
  end: string
  allDay?: boolean
}

/**
 * New start/end for a calendar event dropped on `target`. Timed drops keep the event's length;
 * day-level drops (all-day row, month cell) shift by whole days from `originDay`, preserving wall-clock times.
 */
export function moveEvent(event: EventTimes, target: DropTarget, originDay: string): EventTimes {
  const start = parseEventDate(event.start, event.allDay)
  const end = parseEventDate(event.end, event.allDay)
  if (target.zone === 'timed' && target.minutes !== undefined) {
    const nextStart = wallClock(target.day, target.minutes)
    return {
      start: nextStart.toISOString(),
      end: new Date(nextStart.getTime() + end.getTime() - start.getTime()).toISOString(),
      allDay: false,
    }
  }
  const delta = daysBetween(originDay, target.day)
  if (event.allDay) return { start: dayKey(addDays(start, delta)), end: dayKey(addDays(end, delta)), allDay: true }
  return { start: addDays(start, delta).toISOString(), end: addDays(end, delta).toISOString(), allDay: false }
}

/** Task due date for a drop. All-day row → date only; grid → date and time; month cell keeps any existing time of day. */
export function taskDueForTarget(due: TaskDue | null, target: DropTarget): TaskDue {
  if (target.zone === 'timed' && target.minutes !== undefined)
    return { dateTime: wallClock(target.day, target.minutes).toISOString() }
  if (target.zone === 'month' && due && 'dateTime' in due)
    return { dateTime: wallClock(target.day, minuteOfDay(new Date(due.dateTime))).toISOString() }
  return { date: target.day }
}

export function sameDue(a: TaskDue | null | undefined, b: TaskDue | null | undefined) {
  if (!a || !b) return !a && !b
  if ('date' in a) return 'date' in b && a.date === b.date
  return 'dateTime' in b && new Date(a.dateTime).getTime() === new Date(b.dateTime).getTime()
}
