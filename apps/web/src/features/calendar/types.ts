export type CalendarView = 'day' | 'week' | 'month'
export type EventDecision = 'undecided' | 'yes' | 'maybe' | 'no'

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  allDay?: boolean
  kind: 'google' | 'external' | 'projection' | 'task'
  // For kind 'task': the task this card represents. Timed when due has a time, otherwise all-day.
  taskId?: string
  task?: TaskSummary
  calendarId?: string
  calendarColor?: string
  eventColor?: string
  decision?: EventDecision
  status?: string
  declined?: boolean
  description?: string
  location?: string
  editable?: boolean
  recurring?: boolean
  // RRULE/EXDATE lines of the event's series (or of a single event being made recurring). Absent = does not repeat.
  recurrence?: string[]
  // Set on expanded occurrences of a Google series; identifies what a scoped edit applies to.
  series?: SeriesRef
}

export type RecurringScope = 'this' | 'following' | 'all'

export interface SeriesRef {
  /** google_event row id of the series master. */
  masterId: string
  /** Google id of this occurrence (e.g. `abc123_20261016T182000Z`). */
  instanceId: string
  /** The occurrence's slot in the series: ISO datetime, or YYYY-MM-DD for all-day. */
  originalStart: string
  /** IANA zone the series recurs in, when Google reports one. */
  timeZone?: string
}

/** Fields of a recurring occurrence the user changed; only these are written. `recurrence: null` stops repeating. */
export type RecurringEventPatch = Partial<
  Pick<CalendarEvent, 'title' | 'start' | 'end' | 'allDay' | 'calendarId' | 'eventColor' | 'description' | 'location'>
> & { recurrence?: string[] | null }

export interface CalendarOption {
  id: string
  name: string
  color: string
}

export interface CalendarWorkspaceProps {
  events: CalendarEvent[]
  calendars?: CalendarOption[]
  view?: CalendarView
  date?: Date
  initialView?: CalendarView
  initialDate?: Date
  showDeclined?: boolean
  showToolbar?: boolean
  toolbarActions?: ReactNode
  showWeekends?: boolean
  timeZone?: string
  onViewChange?: (view: CalendarView) => void
  onDateChange?: (date: Date) => void
  onVisibleDaysChange?: (days: Date[]) => void
  onVisibleRangeChange?: (start: Date, end: Date) => void
  onShowDeclinedChange?: (show: boolean) => void
  onEventChange?: (event: CalendarEvent) => void | Promise<void>
  onEventCreate?: (event: Omit<CalendarEvent, 'id'>) => void | Promise<void>
  onEventDelete?: (event: CalendarEvent) => void | Promise<void>
  onDecisionChange?: (event: CalendarEvent, decision: EventDecision, calendarId?: string) => void | Promise<void>
  tasks?: TaskSummary[]
  onTaskChange?: (taskId: string, patch: TaskPatch & { durationMinutes?: number | null }) => void | Promise<void>
  onTaskOpen?: (taskId: string, anchor: HTMLElement) => void
}
import type { ReactNode } from 'react'
import type { TaskPatch, TaskSummary } from '../tasks/types'
