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
}

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
