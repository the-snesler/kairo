import { differenceInCalendarDays, format, parseISO, startOfDay } from 'date-fns'
import type { TaskDue, TaskSummary } from './types'

export type TaskGroupId = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none'
export interface TaskGroup {
  id: TaskGroupId
  label: string
  tasks: TaskSummary[]
}

export const TASK_GROUPS: { id: TaskGroupId; label: string }[] = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'week', label: 'This week' },
  { id: 'later', label: 'Later' },
  { id: 'none', label: 'No date' },
]

/** Local Date for a due value: all-day dates are local midnight, timed values the instant itself. */
export function dueToDate(due: TaskDue): Date {
  return 'date' in due ? parseISO(due.date) : new Date(due.dateTime)
}

export function isTimed(due: TaskDue | null): due is { dateTime: string } {
  return !!due && 'dateTime' in due
}

export function taskGroupId(task: TaskSummary, now: Date): TaskGroupId {
  if (!task.due) return 'none'
  const days = differenceInCalendarDays(dueToDate(task.due), now)
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days < 7) return 'week'
  return 'later'
}

// Day first (for multi-day groups), then timed by time, then all-day, then priority desc, then title.
export function compareTasks(a: TaskSummary, b: TaskSummary): number {
  if (a.due && b.due) {
    const da = dueToDate(a.due),
      db = dueToDate(b.due)
    const day = startOfDay(da).getTime() - startOfDay(db).getTime()
    if (day) return day
    const ta = isTimed(a.due),
      tb = isTimed(b.due)
    if (ta !== tb) return ta ? -1 : 1
    if (ta && da.getTime() !== db.getTime()) return da.getTime() - db.getTime()
  }
  return b.priority - a.priority || a.title.localeCompare(b.title)
}

/** Open tasks grouped by due date relative to `now`; empty groups omitted. */
export function groupTasks(tasks: TaskSummary[], now: Date): TaskGroup[] {
  const buckets = new Map<TaskGroupId, TaskSummary[]>()
  for (const task of tasks) {
    if (task.completed) continue
    const id = taskGroupId(task, now)
    buckets.set(id, [...(buckets.get(id) ?? []), task])
  }
  return TASK_GROUPS.flatMap(({ id, label }) => {
    const list = buckets.get(id)
    return list?.length ? [{ id, label, tasks: list.sort(compareTasks) }] : []
  })
}

export function formatTaskTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
}

/** Compact due label for a sidebar row; empty when the group heading already says the day. */
export function dueLabel(task: TaskSummary, group: TaskGroupId, now: Date): string {
  if (!task.due) return ''
  const date = dueToDate(task.due)
  const time = isTimed(task.due) ? formatTaskTime(date) : ''
  if (group === 'today' || group === 'tomorrow') return time
  const day =
    group === 'week'
      ? format(date, 'EEE')
      : format(date, date.getFullYear() === now.getFullYear() ? 'MMM d' : 'MMM d, yyyy')
  return time ? `${day} ${time}` : day
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60),
    m = Math.round(minutes % 60)
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}
