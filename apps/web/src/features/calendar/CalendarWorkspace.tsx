import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { toast } from 'sonner'
import IconChevronLeft from '~icons/tabler/chevron-left'
import IconChevronRight from '~icons/tabler/chevron-right'
import IconChevronDown from '~icons/tabler/chevron-down'
import IconPlus from '~icons/tabler/plus'
import IconX from '~icons/tabler/x'
import IconCheck from '~icons/tabler/check'
import {
  addDays,
  dayKey,
  eventIntersectsDay,
  formatShortTime,
  formatTime,
  formatTimeRange,
  HOUR_HEIGHT,
  parseEventDate,
  sameDay,
  startOfDay,
  startOfWeek,
} from './date'
import { inTopBar, normalizeTaskEvent, timedSegments } from './layout'
import { onExternalDrag } from './dnd/external'
import {
  createRange,
  MIN_DURATION_MINUTES,
  moveEvent,
  pointerMinutes,
  resizeEnd,
  resolveTarget,
  sameDue,
  taskDueForTarget,
  wallClock,
} from './dnd/geometry'
import type { DropTarget, DropZone, ZoneHit } from './dnd/geometry'
import { useCalendarDrag } from './dnd/useCalendarDrag'
import type { DragSession } from './dnd/useCalendarDrag'
import { EventPopover } from './EventPopover'
import { followSavedEvent, type EditorState } from './editor'
import type { EventDraft } from './EventPopover'
import { diffRecurring, isEmptyPatch } from './recurring'
import { RecurringScopeDialog } from './RecurringScopeDialog'
import type {
  CalendarEvent,
  CalendarView,
  CalendarWorkspaceProps as BaseWorkspaceProps,
  EventDecision,
  NewTask,
  RecurringEventPatch,
  RecurringScope,
} from './types'
import type { InspectorAnchor } from '../inspector/fields'
import { formatDuration } from '../tasks/grouping'
import { DEFAULT_TASK_MINUTES } from '../tasks/types'
import type { TaskSummary } from '../tasks/types'
import './calendar.css'

export type { CalendarEvent, CalendarOption, CalendarView, EventDecision } from './types'

export interface OccurrenceRef {
  id: string
  start: string
  end: string
  allDay: boolean
}

export interface CalendarWorkspaceProps extends BaseWorkspaceProps {
  /** Saves an edit to an occurrence of a repeating event (`event` is the occurrence as it was before the edit). */
  onRecurringEventChange?: (
    event: CalendarEvent,
    patch: RecurringEventPatch,
    scope: RecurringScope,
  ) => void | Promise<void>
  onRecurringEventDelete?: (event: CalendarEvent, scope: RecurringScope) => void | Promise<void>
  /** The occurrence before or after `event` in its series, if any. */
  onFindOccurrence?: (event: CalendarEvent, direction: 'prev' | 'next') => Promise<OccurrenceRef | null>
}

const STRIP_DAYS = 35
const STRIP_REBASE_DAYS = 14
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const colorPattern = /^#[0-9a-f]{6}$/i
// Keep in sync with .cal-event-title / .cal-event-time line heights and the card's vertical chrome in calendar.css.
const TITLE_LINE_HEIGHT = 14
const TIMED_CARD_CHROME = 22
const TASK_COLOR = '#f22420' // DEFAULT_TASK_COLOR in @kairo/integrations
const EXTERNAL_GHOST_HEIGHT = 22

function safeColor(value: string | undefined, fallback = '#7894a8') {
  return value && colorPattern.test(value) ? value : fallback
}

function eventStyle(event: CalendarEvent, past: boolean): CSSProperties {
  const calendar =
    event.kind === 'task' ? safeColor(event.task?.color ?? undefined, TASK_COLOR) : safeColor(event.calendarColor)
  const eventColor = safeColor(event.eventColor, calendar)
  return {
    '--calendar-color': calendar,
    '--event-color': eventColor,
    '--event-body':
      event.kind === 'external' && event.decision !== 'yes' && event.decision !== 'maybe'
        ? 'transparent'
        : event.kind === 'task'
          ? `color-mix(in srgb, ${eventColor} ${past ? '10%' : '18%'}, var(--cal-surface))`
          : `color-mix(in srgb, ${eventColor} ${past ? '23%' : '45%'}, var(--cal-surface))`,
  } as CSSProperties
}

function isDashed(event: CalendarEvent) {
  return event.kind === 'external'
}

function canEdit(event: CalendarEvent) {
  // Occurrences of a series are editable through scoped saves; recurring events without a series ref are not.
  return (
    event.editable !== false &&
    event.kind !== 'external' &&
    event.kind !== 'task' &&
    (!event.recurring || !!event.series)
  )
}

/** An occurrence edit held back until the user picks which occurrences it applies to. */
interface PendingEdit {
  original: CalendarEvent
  changed: CalendarEvent
}

interface ScopePrompt {
  mode: 'edit' | 'delete'
  /** The occurrence to delete (delete mode). */
  event?: CalendarEvent
  busy?: boolean
  error?: string
  /** Where to reopen the editor on "Continue editing". */
  anchor?: InspectorAnchor
  /** Runs once the pending edit is saved or discarded. */
  then?: () => void
}

/** Anchor in the middle of the viewport, for when an event's card isn't on screen. */
const centerAnchor = (): InspectorAnchor => ({
  getBoundingClientRect: () => new DOMRect(window.innerWidth / 2 - 160, window.innerHeight / 4, 0, 0),
})

function eventMinutes(event: CalendarEvent) {
  if (event.kind === 'task' && event.task) return event.task.durationMinutes
  return Math.round(
    (parseEventDate(event.end, event.allDay).getTime() - parseEventDate(event.start, event.allDay).getTime()) / 60_000,
  )
}

/** Calendar card for a task that is not (yet) on the calendar, e.g. dragged in from the sidebar. */
function taskEvent(task: TaskSummary): CalendarEvent {
  const placeholder = dayKey(new Date())
  return normalizeTaskEvent({
    id: `task-${task.id}`,
    title: task.title,
    kind: 'task',
    taskId: task.id,
    task,
    start: placeholder,
    end: placeholder,
    allDay: true,
  })
}

// Stand-in id for the event being created, so it previews on the calendar while the popover is open.
const DRAFT_ID = 'draft'

type DragData =
  | {
      type: 'move'
      item: CalendarEvent
      originDay: string
      zones: readonly DropZone[]
      grabMinutes: number
      durationMinutes: number
      compact: boolean
      titleLines: number
      timeLabel?: string
    }
  | {
      type: 'resize'
      item: CalendarEvent
      day: string
      startMinutes: number
      wrapper: HTMLElement
      column: HTMLElement
      bottomGap: number
      height: string
    }
  | {
      /** Dragging out a new event's time range in an empty part of a timed column. */
      type: 'create'
      day: Date
      anchorMinutes: number
      column: HTMLElement
    }

/** The task a task draft creates. All-day tasks fall on their first day; timed ones keep their length (up to a day). */
function draftTask(draft: EventDraft): NewTask {
  const description = draft.description?.trim()
  const base = { title: draft.title.trim(), ...(description ? { description } : {}) }
  if (draft.allDay) return { ...base, due: { date: draft.start.slice(0, 10) } }
  return {
    ...base,
    due: { dateTime: new Date(draft.start).toISOString() },
    durationMinutes: Math.min(Math.max(eventMinutes({ ...draft, id: DRAFT_ID }), 5), 24 * 60),
  }
}

/** Calendar card for a draft; task drafts render like the task they will become. */
function draftEvent(draft: EventDraft): CalendarEvent {
  const title = draft.title.trim() || '(No title)'
  if (draft.kind !== 'task') return { ...draft, id: DRAFT_ID, title, editable: false }
  const { due, durationMinutes = DEFAULT_TASK_MINUTES } = draftTask(draft)
  return normalizeTaskEvent({
    ...draft,
    id: DRAFT_ID,
    title,
    editable: false,
    task: {
      id: DRAFT_ID,
      title,
      priority: 1,
      due,
      recurring: false,
      durationMinutes,
      durationSource: 'user',
      completed: false,
    },
  })
}

/** Whether the snapshot now carries an optimistically created item: tasks by id, events by title and time. */
function landed(item: CalendarEvent, sourceEvents: CalendarEvent[]) {
  return sourceEvents.some((event) =>
    item.taskId
      ? event.taskId === item.taskId
      : event.title === item.title &&
        parseEventDate(event.start, event.allDay).getTime() === parseEventDate(item.start, item.allDay).getTime() &&
        parseEventDate(event.end, event.allDay).getTime() === parseEventDate(item.end, item.allDay).getTime(),
  )
}

function EventCard({
  event,
  compact,
  titleLines = 0,
  narrow,
  past,
  draggable,
  dragging,
  edited,
  timeLabel,
  onOpen,
  onPointerDown,
  onToggleComplete,
}: {
  event: CalendarEvent
  compact?: boolean
  /** Title lines that fit above the time row; 0 lays title and time out on a single line. */
  titleLines?: number
  /** Shares its row with overlapping events: a one-line card gives the time's space to the title. */
  narrow?: boolean
  past: boolean
  draggable?: boolean
  /** The original card while a drag of it is in progress. */
  dragging?: boolean
  /** Shows unsaved changes waiting for a recurring-scope choice. */
  edited?: boolean
  /** Replaces the computed time text. */
  timeLabel?: string
  onOpen?: (element: HTMLElement, event: CalendarEvent) => void
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>, item: CalendarEvent, resize: boolean) => void
  onToggleComplete?: (event: CalendarEvent) => void
}) {
  const start = parseEventDate(event.start, event.allDay)
  const end = parseEventDate(event.end, event.allDay)
  const inline = compact || titleLines < 1
  const task = event.kind === 'task'
  const committed = event.kind === 'external' && (event.decision === 'yes' || event.decision === 'maybe')
  const tentative = event.kind === 'external' && event.decision === 'maybe'
  const completed = !!event.task?.completed
  const time = timeLabel ?? (inTopBar(event) ? '' : inline ? formatShortTime(start) : formatTimeRange(start, end))
  const showTime = !!time && !(narrow && inline && timeLabel === undefined)
  return (
    <div
      className={`cal-event ${compact ? 'cal-event-compact' : ''} ${inline ? 'cal-event-inline' : ''} ${isDashed(event) ? 'cal-event-dashed' : ''} ${committed ? 'cal-event-committed' : ''} ${tentative ? 'cal-event-tentative' : ''} ${event.declined ? 'cal-event-declined' : ''} ${task ? 'cal-event-task' : ''} ${completed ? 'cal-event-completed' : ''} ${event.task?.pending ? 'cal-event-pending' : ''} ${past ? 'cal-event-past' : ''} ${draggable ? 'cal-event-draggable' : ''} ${dragging ? 'cal-event-dragging' : ''}`}
      style={
        {
          ...eventStyle(event, past),
          '--title-lines': Math.max(titleLines, 1),
        } as CSSProperties
      }
      data-event-id={event.id}
      role="button"
      tabIndex={0}
      aria-label={`${task ? 'Task: ' : ''}${event.title}${time ? `, ${time}` : ''}${edited ? ', unsaved changes' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onOpen?.(e.currentTarget, event)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen?.(e.currentTarget, event)
        }
      }}
      onPointerDown={(e) => onPointerDown?.(e, event, false)}
    >
      <span className="cal-event-title">
        {task && (
          <button
            type="button"
            className="cal-task-check"
            aria-label={completed ? 'Mark task incomplete' : 'Complete task'}
            aria-pressed={completed}
            disabled={!onToggleComplete}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onToggleComplete?.(event)
            }}
          >
            {completed && <IconCheck aria-hidden="true" />}
          </button>
        )}
        {edited && <span className="cal-event-dot" aria-hidden="true" />}
        {event.title}
      </span>
      {showTime && <span className="cal-event-time">{time}</span>}
      {!compact && draggable && onPointerDown && (
        <span
          className="cal-event-resize"
          role="presentation"
          onPointerDown={(e) => {
            e.stopPropagation()
            onPointerDown(e, event, true)
          }}
        />
      )}
    </div>
  )
}

export function CalendarWorkspace(props: CalendarWorkspaceProps) {
  const [internalView, setInternalView] = useState<CalendarView>(props.initialView ?? 'week')
  const [internalDate, setInternalDate] = useState(() => startOfDay(props.initialDate ?? new Date()))
  const [internalDeclined, setInternalDeclined] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [overrides, setOverrides] = useState<Record<string, CalendarEvent>>({})
  const [created, setCreated] = useState<CalendarEvent[]>([])
  const [deleted, setDeleted] = useState<string[]>([])
  const [taskOverrides, setTaskOverrides] = useState<Record<string, CalendarEvent>>({})
  const [dropError, setDropError] = useState('')
  const [pending, setPendingState] = useState<PendingEdit | null>(null)
  const pendingRef = useRef<PendingEdit | null>(null)
  const [prompt, setPrompt] = useState<ScopePrompt | null>(null)
  const [awaiting, setAwaiting] = useState<{ id: string; anchor: InspectorAnchor } | null>(null)
  // Bumped whenever the editor opens something, so a slower prev/next lookup doesn't take over afterwards.
  const navToken = useRef(0)
  const [stripStart, setStripStart] = useState(() =>
    addDays(startOfWeek(props.date ?? props.initialDate ?? new Date()), -14),
  )
  const [columnWidth, setColumnWidth] = useState(160)
  const scroller = useRef<HTMLDivElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const hourLabels = useRef<HTMLDivElement>(null)
  const dateRef = useRef(dayKey(props.date ?? props.initialDate ?? new Date()))
  const root = useRef<HTMLElement>(null)
  const stripStartRef = useRef(stripStart)
  const view = props.view ?? internalView
  const date = props.date ?? internalDate
  const showDeclined = props.showDeclined ?? internalDeclined
  const today = startOfDay(new Date())
  const sourceEvents = useMemo(() => props.events.map(normalizeTaskEvent), [props.events])
  const visibleEvents = useMemo(() => {
    const scheduled = new Set(sourceEvents.map((event) => event.taskId))
    // Optimistic task moves also cover tasks that were not on the calendar yet (dropped from the sidebar).
    const unscheduled = Object.values(taskOverrides).filter((event) => !scheduled.has(event.taskId))
    const draft: CalendarEvent[] = editor?.draft ? [draftEvent(editor.draft)] : []
    const pendingCreates = created.filter((item) => !landed(item, sourceEvents))
    return [...sourceEvents, ...pendingCreates, ...unscheduled, ...draft]
      .filter((event) => !deleted.includes(event.id))
      .map((event) => {
        const current =
          (pending?.original.id === event.id ? pending.changed : undefined) ??
          (event.kind === 'task' && event.taskId ? taskOverrides[event.taskId] : undefined) ??
          overrides[event.id] ??
          event
        const calendar = props.calendars?.find((item) => item.id === current.calendarId)
        return calendar && current.decision && current.decision !== 'undecided'
          ? { ...current, calendarColor: calendar.color }
          : current
      })
      .filter((event) => showDeclined || (!event.declined && event.status !== 'declined' && event.decision !== 'no'))
  }, [sourceEvents, props.calendars, created, deleted, overrides, taskOverrides, showDeclined, editor?.draft, pending])

  useEffect(() => {
    stripStartRef.current = stripStart
  }, [stripStart])

  useEffect(() => {
    setOverrides((current) => {
      const next = { ...current }
      for (const event of props.editorEvents ?? sourceEvents)
        if (
          next[event.id] &&
          parseEventDate(next[event.id].start, next[event.id].allDay).getTime() ===
            parseEventDate(event.start, event.allDay).getTime() &&
          parseEventDate(next[event.id].end, next[event.id].allDay).getTime() ===
            parseEventDate(event.end, event.allDay).getTime() &&
          next[event.id].title === event.title &&
          !!next[event.id].allDay === !!event.allDay &&
          (next[event.id].description ?? '') === (event.description ?? '') &&
          (next[event.id].location ?? '') === (event.location ?? '') &&
          next[event.id].decision === event.decision &&
          next[event.id].calendarId === event.calendarId &&
          next[event.id].eventColor === event.eventColor
        )
          delete next[event.id]
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
    setTaskOverrides((current) => {
      const next = { ...current }
      for (const event of sourceEvents) {
        const pending = event.taskId ? next[event.taskId] : undefined
        if (
          pending &&
          event.kind === 'task' &&
          sameDue(pending.task?.due, event.task?.due) &&
          pending.task?.durationMinutes === event.task?.durationMinutes
        )
          delete next[event.taskId!]
      }
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }, [sourceEvents, props.editorEvents])

  useEffect(() => {
    setCreated((current) => {
      const next = current.filter((item) => !landed(item, sourceEvents))
      return next.length === current.length ? current : next
    })
  }, [sourceEvents, created])

  useEffect(() => {
    setDeleted((current) => current.filter((id) => props.events.some((event) => event.id === id)))
  }, [props.events])

  const setDate = useCallback(
    (next: Date) => {
      const normalized = startOfDay(next)
      dateRef.current = dayKey(normalized)
      if (props.date === undefined) setInternalDate(normalized)
      props.onDateChange?.(normalized)
    },
    [props.date, props.onDateChange],
  )

  const setView = (next: CalendarView) => {
    if (props.view === undefined) setInternalView(next)
    props.onViewChange?.(next)
    setMenuOpen(false)
  }

  const reportDays = useCallback(
    (first: Date, count: number) => {
      const days = Array.from({ length: count }, (_, i) => addDays(first, i))
      props.onVisibleDaysChange?.(days)
      props.onVisibleRangeChange?.(first, addDays(first, count))
    },
    [props.onVisibleDaysChange, props.onVisibleRangeChange],
  )

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node || view === 'month') return
    const resize = () =>
      setColumnWidth(Math.max(view === 'day' ? node.clientWidth : node.clientWidth / 7, view === 'day' ? 320 : 128))
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(node)
    return () => observer.disconnect()
  }, [view])

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node || view === 'month') return
    const first = view === 'day' ? startOfDay(date) : startOfWeek(date)
    const origin = addDays(first, -14)
    stripStartRef.current = origin
    setStripStart(origin)
    node.scrollLeft = 14 * columnWidth
    if (!node.scrollTop) node.scrollTop = HOUR_HEIGHT * 6
    if (hourLabels.current) hourLabels.current.style.transform = `translateY(-${node.scrollTop}px)`
    reportDays(first, view === 'day' ? 1 : 7)
    // A date supplied by the shell is ignored when it matches the current left day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, columnWidth])

  useEffect(() => {
    if (view === 'month') reportDays(startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1)), 42)
    // Month range changes are reported by navigation and controlled date effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  useEffect(() => {
    if (props.date && dayKey(props.date) !== dateRef.current) {
      dateRef.current = dayKey(props.date)
      if (view === 'month') reportDays(startOfWeek(new Date(props.date.getFullYear(), props.date.getMonth(), 1)), 42)
      else {
        const first = view === 'week' ? startOfWeek(props.date) : startOfDay(props.date)
        stripStartRef.current = addDays(first, -14)
        setStripStart(stripStartRef.current)
        if (scroller.current) scroller.current.scrollLeft = 14 * columnWidth
        reportDays(first, view === 'week' ? 7 : 1)
      }
    }
  }, [props.date, view, columnWidth, reportDays])

  const onScroll = () => {
    const node = scroller.current
    if (!node || view === 'month') return
    if (hourLabels.current) hourLabels.current.style.transform = `translateY(-${node.scrollTop}px)`
    const leftIndex = Math.round(node.scrollLeft / columnWidth)
    const first = addDays(stripStartRef.current, leftIndex)
    if (leftIndex < 3 || leftIndex > 25) {
      const shiftDays = leftIndex < 3 ? -STRIP_REBASE_DAYS : STRIP_REBASE_DAYS
      stripStartRef.current = addDays(stripStartRef.current, shiftDays)
      flushSync(() => setStripStart(stripStartRef.current))
      node.scrollLeft -= shiftDays * columnWidth
    }
    if (dayKey(first) !== dateRef.current)
      startTransition(() => {
        setDate(first)
        reportDays(first, view === 'week' ? 7 : 1)
      })
  }

  const navigate = (direction: number) => {
    const next =
      view === 'month'
        ? new Date(date.getFullYear(), date.getMonth() + direction, 1)
        : addDays(date, direction * (view === 'week' ? 7 : 1))
    setDate(next)
    if (view === 'month') reportDays(startOfWeek(new Date(next.getFullYear(), next.getMonth(), 1)), 42)
    else {
      const first = view === 'week' ? startOfWeek(next) : next
      stripStartRef.current = addDays(first, -14)
      setStripStart(stripStartRef.current)
      if (scroller.current) scroller.current.scrollLeft = 14 * columnWidth
      reportDays(first, view === 'week' ? 7 : 1)
    }
  }

  const jumpTo = (target: Date) => {
    const day = startOfDay(target)
    setDate(day)
    if (view === 'month') reportDays(startOfWeek(new Date(day.getFullYear(), day.getMonth(), 1)), 42)
    else {
      const first = view === 'week' ? startOfWeek(day) : day
      stripStartRef.current = addDays(first, -14)
      setStripStart(stripStartRef.current)
      if (scroller.current) scroller.current.scrollLeft = 14 * columnWidth
      reportDays(first, view === 'week' ? 7 : 1)
    }
  }

  const jumpToday = () => jumpTo(today)

  const setPending = (next: PendingEdit | null) => {
    pendingRef.current = next
    setPendingState(next)
  }
  const hasPendingChanges = () => {
    const current = pendingRef.current
    return !!current && !isEmptyPatch(diffRecurring(current.original, current.changed))
  }
  /** Runs `next` now, or after the user saves or discards the pending occurrence edit. */
  const afterPending = (next: () => void, anchor?: InspectorAnchor) => {
    if (hasPendingChanges()) {
      setEditor(null)
      setPrompt({ mode: 'edit', anchor, then: next })
      return
    }
    setPending(null)
    next()
  }
  const cardAnchor = (id: string) =>
    root.current?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(id)}"]`) ?? null

  const openEditor = (element: HTMLElement, event: CalendarEvent | null, draft: EventDraft | null = null) => {
    if (event?.id === DRAFT_ID || prompt) return
    if (pendingRef.current && event?.id !== pendingRef.current.original.id)
      return afterPending(() => openEditor(element, event, draft), editor?.anchor)
    navToken.current++
    setAwaiting(null)
    if (event?.kind === 'task') {
      if (event.taskId) props.onTaskOpen?.(event.taskId, element)
      return
    }
    if (event || draft)
      setEditor({ sessionId: crypto.randomUUID(), eventId: event?.id ?? null, draft, anchor: element })
  }

  const canCreate = !!props.onEventCreate || !!props.onTaskCreate

  const createAt = (element: HTMLElement, day: Date, minutes: number, allDay = false, duration = 60) => {
    const start = allDay ? day : wallClock(dayKey(day), minutes)
    const end = allDay ? addDays(day, 1) : wallClock(dayKey(day), minutes + duration)
    const calendar = props.calendars?.[0]
    if (prompt) return
    if (pendingRef.current) return afterPending(() => createAt(element, day, minutes, allDay, duration), editor?.anchor)
    navToken.current++
    setAwaiting(null)
    const draft: EventDraft = {
      title: '',
      start: allDay ? dayKey(start) : start.toISOString(),
      end: allDay ? dayKey(end) : end.toISOString(),
      kind: props.onEventCreate ? 'google' : 'task',
      allDay,
      calendarId: calendar?.id,
      calendarColor: calendar?.color,
    }
    // Timed drafts anchor to the clicked hour slot rather than the whole day column.
    const anchor: InspectorAnchor = allDay
      ? element
      : {
          contextElement: element,
          getBoundingClientRect: () => {
            const box = element.getBoundingClientRect()
            return new DOMRect(
              box.left,
              box.top + (minutes / 60) * HOUR_HEIGHT,
              box.width,
              (Math.min(duration, 24 * 60 - minutes) / 60) * HOUR_HEIGHT,
            )
          },
        }
    setEditor({ sessionId: crypto.randomUUID(), eventId: null, draft, anchor })
  }

  // Creates appear at once: the optimistic card replaces the draft in the same render, the save runs in the
  // background, and a toast reports how it went.
  const createOptimistic = (
    optimistic: CalendarEvent,
    save: () => Promise<string | null | void> | void,
    label: 'Event' | 'Task',
  ) => {
    setCreated((current) => [...current, optimistic])
    setEditor(null)
    void (async () => {
      try {
        const id = await save()
        // Tasks are matched by id once known; otherwise the snapshot loaded by `save` already has the item.
        setCreated((current) =>
          id
            ? current.map((item) => (item.id === optimistic.id ? { ...item, taskId: id } : item))
            : current.filter((item) => item.id !== optimistic.id),
        )
        toast.success(`${label} created`, { description: optimistic.title })
      } catch (cause) {
        setCreated((current) => current.filter((item) => item.id !== optimistic.id))
        toast.error(`Could not create ${label.toLowerCase()}`, {
          description: cause instanceof Error ? cause.message : String(cause),
        })
      }
    })()
  }

  const createEvent = async (draft: EventDraft) => {
    const sessionId = editor?.sessionId
    const id = await props.onEventCreate!(draft)
    if (sessionId)
      setEditor((current) =>
        followSavedEvent(current, sessionId, { ...draft, id, recurring: !!draft.recurrence?.length }),
      )
  }

  const createTask = async (draft: EventDraft) => {
    const input = draftTask(draft)
    createOptimistic(
      { ...draftEvent(draft), id: `pending-${crypto.randomUUID()}` },
      () => props.onTaskCreate?.(input),
      'Task',
    )
  }

  const deleteEvent = async (event: CalendarEvent) => {
    setDeleted((current) => [...current, event.id])
    try {
      await props.onEventDelete?.(event)
    } catch (cause) {
      setDeleted((current) => current.filter((id) => id !== event.id))
      throw cause
    }
  }

  const decide = async (event: CalendarEvent, decision: EventDecision) => {
    const calendar = props.calendars?.find((item) =>
      decision === 'yes' ? item.isDefault : decision === 'maybe' ? item.isMaybe : false,
    )
    setOverrides((current) => ({
      ...current,
      [event.id]: { ...event, decision, calendarId: calendar?.id, eventColor: calendar?.color },
    }))
    try {
      await props.onDecisionChange?.(event, decision)
    } catch (cause) {
      setOverrides((current) => {
        const next = { ...current }
        delete next[event.id]
        return next
      })
      throw cause
    }
  }

  // Hidden/declined cards can leave the grid while their editor remains open.
  const storedEditingEvent = editor?.eventId
    ? (props.editorEvents ?? sourceEvents).find((event) => event.id === editor.eventId)
    : undefined
  const editingEvent = editor?.eventId
    ? (visibleEvents.find((event) => event.id === editor.eventId) ??
      (storedEditingEvent && (overrides[editor.eventId] ?? storedEditingEvent)) ??
      editor.fallback ??
      null)
    : null
  useEffect(() => {
    if (!editor?.eventId || editor.saving) return
    if (storedEditingEvent && editor.fallback)
      setEditor((current) => (current?.sessionId === editor.sessionId ? { ...current, fallback: undefined } : current))
    else if (!editingEvent) setEditor(null)
  }, [editor, storedEditingEvent, editingEvent])

  // After jumping to another occurrence, open it once it has loaded and rendered.
  useEffect(() => {
    if (!awaiting || !visibleEvents.some((event) => event.id === awaiting.id)) return
    const frame = requestAnimationFrame(() => {
      const fallback = !(awaiting.anchor instanceof Element) || awaiting.anchor.isConnected ? awaiting.anchor : null
      setEditor({
        sessionId: crypto.randomUUID(),
        eventId: awaiting.id,
        draft: null,
        anchor: cardAnchor(awaiting.id) ?? fallback ?? centerAnchor(),
      })
      setAwaiting(null)
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting, visibleEvents])
  // Give up on an occurrence that never shows up (e.g. hidden as declined) instead of opening it much later.
  useEffect(() => {
    if (!awaiting) return
    const timer = setTimeout(() => setAwaiting((current) => (current === awaiting ? null : current)), 10_000)
    return () => clearTimeout(timer)
  }, [awaiting])

  const canEditEvent = (event: CalendarEvent) =>
    canEdit(event) && (event.series ? !!props.onRecurringEventChange : !!props.onEventChange)
  const canDrag = (event: CalendarEvent) =>
    event.kind === 'task' ? event.editable !== false && !!event.taskId && !!props.onTaskChange : canEditEvent(event)

  const reportError = (cause: unknown, fallback: string) =>
    setDropError(cause instanceof Error ? cause.message : fallback)

  /** Optimistically applies a task change, then rolls back if the parent rejects it. */
  const commitTask = async (item: CalendarEvent, patch: { due?: TaskSummary['due']; durationMinutes?: number }) => {
    const task = item.task
    if (!task || !item.taskId) return
    const taskId = item.taskId
    const optimistic = normalizeTaskEvent({ ...item, task: { ...task, ...patch } })
    setTaskOverrides((current) => ({ ...current, [taskId]: optimistic }))
    setDropError('')
    try {
      await props.onTaskChange?.(taskId, patch)
    } catch (cause) {
      setTaskOverrides((current) => {
        if (current[taskId] !== optimistic) return current
        const next = { ...current }
        delete next[taskId]
        return next
      })
      reportError(cause, 'Could not update task.')
    }
  }

  // Saves run one at a time per event (each needs the etag the previous one produced); edits made meanwhile coalesce.
  const eventSaves = useRef(new Map<string, CalendarEvent | null>())
  const commitEvent = async (changed: CalendarEvent) => {
    setOverrides((current) => ({ ...current, [changed.id]: changed }))
    setDropError('')
    const saves = eventSaves.current
    const running = saves.has(changed.id)
    saves.set(changed.id, changed)
    const sessionId = editor?.eventId === changed.id ? editor.sessionId : undefined
    if (sessionId)
      setEditor((current) =>
        current?.sessionId === sessionId ? { ...current, fallback: changed, saving: true } : current,
      )
    if (running) return
    let savedId = changed.id
    let lastSaved: CalendarEvent | undefined
    for (let next = changed; ;) {
      try {
        const id = await props.onEventChange?.({ ...next, id: savedId })
        savedId = id || savedId
        lastSaved = { ...next, id: savedId }
      } catch (cause) {
        const failed = next
        setOverrides((current) => {
          if (current[failed.id] !== failed) return current
          const rest = { ...current }
          delete rest[failed.id]
          return rest
        })
        reportError(cause, 'Could not save event.')
      }
      const queued = saves.get(changed.id)
      if (!queued || queued === next) break
      next = queued
    }
    saves.delete(changed.id)
    if (sessionId)
      setEditor((current) => {
        if (current?.sessionId !== sessionId) return current
        return lastSaved
          ? followSavedEvent(current, sessionId, lastSaved)
          : { ...current, saving: false, fallback: undefined }
      })
  }

  /** Holds an occurrence edit locally; it's saved once a scope is chosen. */
  const stageEdit = (base: CalendarEvent, changed: CalendarEvent) => {
    const current = pendingRef.current
    setPending({ original: current?.original.id === changed.id ? current.original : base, changed })
  }
  const stageDrop = (item: CalendarEvent, changed: CalendarEvent) => {
    const current = pendingRef.current
    if (prompt || (current && current.original.id !== item.id)) return
    setEditor(null)
    stageEdit(item, changed)
    if (hasPendingChanges()) setPrompt({ mode: 'edit', anchor: cardAnchor(item.id) ?? undefined })
    else setPending(null)
  }

  const closeEditor = () => {
    const current = pendingRef.current
    if (current && editor?.eventId === current.original.id) {
      if (hasPendingChanges()) setPrompt({ mode: 'edit', anchor: editor.anchor })
      else setPending(null)
    }
    setEditor(null)
  }

  const reopenPending = (anchor?: InspectorAnchor) => {
    const current = pendingRef.current
    if (!current) return
    const element = cardAnchor(current.original.id)
    const fallback = anchor && (!(anchor instanceof Element) || anchor.isConnected) ? anchor : centerAnchor()
    setEditor({
      sessionId: crypto.randomUUID(),
      eventId: current.original.id,
      draft: null,
      anchor: element ?? fallback,
    })
  }

  const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback)

  const confirmScope = async (scope: RecurringScope) => {
    const current = prompt
    if (!current || current.busy) return
    if (current.mode === 'delete') {
      const event = current.event!
      setPrompt({ ...current, busy: true, error: '' })
      try {
        await props.onRecurringEventDelete?.(event, scope)
        if (scope === 'this') setDeleted((ids) => [...ids, event.id])
        setPrompt(null)
      } catch (cause) {
        setPrompt({ ...current, busy: false, error: message(cause, 'Could not delete event.') })
      }
      return
    }
    const edit = pendingRef.current
    if (!edit) return setPrompt(null)
    const patch = diffRecurring(edit.original, edit.changed)
    if (scope === 'this') {
      // A single occurrence changes in place: show it right away and let the snapshot catch up.
      const optimistic = edit.changed
      setOverrides((overrides) => ({ ...overrides, [edit.original.id]: optimistic }))
      setPending(null)
      setPrompt(null)
      current.then?.()
      try {
        await props.onRecurringEventChange?.(edit.original, patch, scope)
      } catch (cause) {
        setOverrides((overrides) => {
          if (overrides[edit.original.id] !== optimistic) return overrides
          const rest = { ...overrides }
          delete rest[edit.original.id]
          return rest
        })
        if (!pendingRef.current) {
          setPending(edit)
          setPrompt({ mode: 'edit', anchor: current.anchor, error: message(cause, 'Could not save event.') })
        } else reportError(cause, 'Could not save event.')
      }
      return
    }
    setPrompt({ ...current, busy: true, error: '' })
    try {
      await props.onRecurringEventChange?.(edit.original, patch, scope)
      setPending(null)
      setPrompt(null)
      current.then?.()
    } catch (cause) {
      setPrompt({ ...current, busy: false, error: message(cause, 'Could not save event.') })
    }
  }

  const deleteOccurrence = (event: CalendarEvent) => {
    const original = pendingRef.current?.original.id === event.id ? pendingRef.current.original : event
    setPending(null)
    setEditor(null)
    setPrompt({ mode: 'delete', event: original })
  }

  const navigateOccurrence = (event: CalendarEvent, direction: 'prev' | 'next') => {
    const find = props.onFindOccurrence
    if (!find) return
    const anchor = editor?.anchor ?? centerAnchor()
    afterPending(() => {
      setDropError('')
      const token = ++navToken.current
      find(event, direction)
        .then((found) => {
          if (token !== navToken.current) return
          if (!found) return reportError(null, `No ${direction === 'prev' ? 'earlier' : 'later'} occurrence.`)
          jumpTo(parseEventDate(found.start, found.allDay))
          setAwaiting({ id: found.id, anchor })
        })
        .catch((cause) => reportError(cause, 'Could not find that occurrence.'))
    }, anchor)
  }

  const hitTest = (x: number, y: number): ZoneHit | null => {
    const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-zone]')
    if (!zone || !root.current?.contains(zone) || !zone.dataset.day) return null
    return { zone: zone.dataset.dropZone as DropZone, day: zone.dataset.day, top: zone.getBoundingClientRect().top }
  }

  const drag = useCalendarDrag<DragData>({
    cursor: (session) => (session.data.type === 'move' ? 'move' : 'resize'),
    resolve: ({ data, x, y }) => {
      if (data.type === 'create') {
        const top = data.column.getBoundingClientRect().top
        return {
          zone: 'timed',
          day: dayKey(data.day),
          ...createRange(data.anchorMinutes, pointerMinutes(y, top, HOUR_HEIGHT)),
        }
      }
      if (data.type === 'resize') {
        const rect = data.column.getBoundingClientRect()
        return {
          zone: 'timed',
          day: data.day,
          minutes: data.startMinutes,
          endMinutes: resizeEnd(y, rect.top, HOUR_HEIGHT, data.startMinutes),
        }
      }
      return resolveTarget(hitTest(x, y), y, {
        hourHeight: HOUR_HEIGHT,
        grabMinutes: data.grabMinutes,
        durationMinutes: data.durationMinutes,
        zones: data.zones,
      })
    },
    onFrame: ({ data, y }) => {
      if (data.type !== 'resize') return
      // The card's bottom edge follows the pointer; the snapped end is shown by the preview.
      const top = data.wrapper.getBoundingClientRect().top
      const columnBottom = data.column.getBoundingClientRect().bottom
      data.wrapper.style.height = `${Math.max((MIN_DURATION_MINUTES / 60) * HOUR_HEIGHT, Math.min(columnBottom, y + data.bottomGap) - top)}px`
    },
    onFinish: ({ data }) => {
      if (data.type === 'resize') data.wrapper.style.height = data.height
    },
    onDrop: ({ data }, target) => {
      if (!target || target.invalid) return
      if (data.type === 'create') {
        if (target.minutes !== undefined && target.endMinutes !== undefined)
          createAt(data.column, data.day, target.minutes, false, target.endMinutes - target.minutes)
        return
      }
      const { item } = data
      if (data.type === 'resize') {
        // Measure from the item's true start: the resized segment may begin at midnight of a later day.
        const end = wallClock(data.day, target.endMinutes!)
        if (item.kind === 'task') {
          const durationMinutes = Math.round((end.getTime() - parseEventDate(item.start).getTime()) / 60_000)
          if (durationMinutes !== item.task?.durationMinutes) void commitTask(item, { durationMinutes })
          return
        }
        if (end.getTime() !== parseEventDate(item.end).getTime()) {
          const changed = { ...item, end: end.toISOString() }
          if (item.series) stageDrop(item, changed)
          else void commitEvent(changed)
        }
        return
      }
      if (item.kind === 'task') {
        const current = item.task?.due ?? null
        const due = taskDueForTarget(current, target)
        if (!sameDue(current, due)) void commitTask(item, { due })
        return
      }
      const moved = moveEvent(item, target, data.originDay)
      if (parseEventDate(moved.start, moved.allDay).getTime() !== parseEventDate(item.start, item.allDay).getTime()) {
        if (item.series) stageDrop(item, { ...item, ...moved })
        else void commitEvent({ ...item, ...moved })
      }
    },
    scrollArea: ({ data }) => {
      const element = scroller.current
      if (!element || view === 'month') return null
      const rect = element.getBoundingClientRect()
      const allDayRow = element.querySelector('.cal-allday-row')?.getBoundingClientRect()
      return { element, rect, gridTop: allDayRow?.bottom ?? rect.top, horizontal: data.type === 'move' }
    },
  })

  const startDrag = (e: ReactPointerEvent<HTMLElement>, event: CalendarEvent, resize: boolean) => {
    if (e.button !== 0 || !canDrag(event)) return
    e.stopPropagation()
    const target = e.currentTarget
    const zone = target.closest<HTMLElement>('[data-drop-zone]')
    const day = zone?.dataset.day
    if (!zone || !day) return
    if (resize) {
      const wrapper = target.closest<HTMLElement>('.cal-event-position')
      if (!wrapper || zone.dataset.dropZone !== 'timed') return
      const box = wrapper.getBoundingClientRect()
      const startMinutes = Math.round(((box.top - zone.getBoundingClientRect().top) / HOUR_HEIGHT) * 60)
      drag.begin(
        {
          type: 'resize',
          item: event,
          day,
          startMinutes,
          wrapper,
          column: zone,
          bottomGap: box.bottom - e.clientY,
          height: wrapper.style.height,
        },
        e.nativeEvent,
        { grabX: 0, grabY: 0, width: box.width, height: box.height },
      )
      return
    }
    const card = target.closest<HTMLElement>('.cal-event') ?? target
    const box = card.getBoundingClientRect()
    const compact = zone.dataset.dropZone !== 'timed'
    const timedZones: readonly DropZone[] = ['timed', 'month']
    const dayZones: readonly DropZone[] = ['allday', 'month']
    drag.begin(
      {
        type: 'move',
        item: event,
        originDay: day,
        zones: event.kind === 'task' ? ['timed', 'allday', 'month'] : inTopBar(event) ? dayZones : timedZones,
        grabMinutes: ((e.clientY - box.top) / HOUR_HEIGHT) * 60,
        durationMinutes: eventMinutes(event),
        compact,
        titleLines: compact ? 0 : Math.floor((box.height - TIMED_CARD_CHROME) / TITLE_LINE_HEIGHT),
      },
      e.nativeEvent,
      { grabX: e.clientX - box.left, grabY: e.clientY - box.top, width: box.width, height: box.height },
    )
  }

  const startCreate = (e: ReactPointerEvent<HTMLElement>, day: Date) => {
    // Touch drags scroll the grid; cards handle their own presses.
    if (e.button !== 0 || e.pointerType === 'touch' || !canCreate || prompt) return
    if (e.target instanceof Element && e.target.closest('.cal-event')) return
    const column = e.currentTarget
    drag.begin(
      {
        type: 'create',
        day,
        anchorMinutes: pointerMinutes(e.clientY, column.getBoundingClientRect().top, HOUR_HEIGHT),
        column,
      },
      e.nativeEvent,
      { grabX: 0, grabY: 0, width: 0, height: 0 },
    )
  }

  // Drags started outside the workspace (the task sidebar) render and drop here.
  const beginDrag = drag.begin
  useEffect(
    () =>
      onExternalDrag((payload, pointer, origin) => {
        const item = taskEvent(payload.task)
        const width = Math.min(Math.max(origin.width, 120), Math.max(columnWidth - 8, 120))
        const grabX = origin.width ? ((pointer.clientX - origin.left) / origin.width) * width : 0
        const grabY = Math.min(Math.max(pointer.clientY - origin.top, 0), EXTERNAL_GHOST_HEIGHT)
        beginDrag(
          {
            type: 'move',
            item,
            originDay: item.task?.due ? dayKey(parseEventDate(item.start, item.allDay)) : dayKey(new Date()),
            zones: ['timed', 'allday', 'month'],
            grabMinutes: (grabY / HOUR_HEIGHT) * 60,
            durationMinutes: payload.task.durationMinutes,
            compact: true,
            titleLines: 0,
            timeLabel: formatDuration(payload.task.durationMinutes),
          },
          pointer,
          { grabX, grabY, width, height: EXTERNAL_GHOST_HEIGHT },
        )
      }),
    [beginDrag, columnWidth],
  )

  const dragView = drag.view
  const dropTarget: DropTarget | null = dragView?.target ?? null
  const draggedItem = dragView?.data.type === 'move' ? dragView.data.item : null
  const isDragged = (event: CalendarEvent) =>
    !!draggedItem && (draggedItem.kind === 'task' ? event.taskId === draggedItem.taskId : event.id === draggedItem.id)
  const zoneClass = (zone: DropZone, day: Date) =>
    dropTarget?.zone === zone && dropTarget.day === dayKey(day)
      ? dropTarget.invalid
        ? 'cal-drop-invalid'
        : zone === 'timed'
          ? ''
          : 'cal-drop-target'
      : ''

  const toggleComplete = (event: CalendarEvent) => {
    if (!event.taskId) return
    setDropError('')
    Promise.resolve(props.onTaskChange?.(event.taskId, { completed: !event.task?.completed })).catch((cause) =>
      reportError(cause, 'Could not update task.'),
    )
  }

  const cardProps = (event: CalendarEvent) => ({
    draggable: canDrag(event),
    dragging: isDragged(event),
    edited: pending?.original.id === event.id,
    onPointerDown: startDrag,
    onOpen: openEditor,
    onToggleComplete: event.kind === 'task' && props.onTaskChange ? toggleComplete : undefined,
  })

  const days = useMemo(() => Array.from({ length: STRIP_DAYS }, (_, i) => addDays(stripStart, i)), [stripStart])
  const eventsByDay = useMemo(() => {
    const indexed = new Map(days.map((day) => [dayKey(day), [] as CalendarEvent[]]))
    for (const event of visibleEvents) {
      const start = parseEventDate(event.start, event.allDay)
      const end = parseEventDate(event.end, event.allDay)
      for (
        let day = startOfDay(start < days[0] ? days[0] : start);
        day <= days[days.length - 1] && day < end;
        day = addDays(day, 1)
      )
        indexed.get(dayKey(day))?.push(event)
    }
    for (const events of indexed.values()) events.sort((a, b) => Number(b.kind === 'task') - Number(a.kind === 'task'))
    return indexed
  }, [days, visibleEvents])
  const allDayCount = Math.max(1, ...days.map((day) => eventsByDay.get(dayKey(day))!.filter(inTopBar).length))
  const monthFirst = new Date(date.getFullYear(), date.getMonth(), 1)
  const monthStart = startOfWeek(monthFirst)
  const monthDays = Array.from({ length: 42 }, (_, i) => addDays(monthStart, i))
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date)

  return (
    <section
      ref={root}
      className="cal-workspace"
      aria-label="Calendar"
      style={{ '--hour-height': `${HOUR_HEIGHT}px` } as CSSProperties}
    >
      {props.showToolbar !== false && (
        <header className="cal-toolbar">
          <div className="cal-heading">
            <h1>{monthLabel}</h1>
            <span className="cal-zone">{props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          </div>
          <div className="cal-controls">
            <div className="cal-view-menu-wrap">
              <button
                className="cal-button"
                type="button"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(!menuOpen)}
              >
                {view[0].toUpperCase() + view.slice(1)} <IconChevronDown aria-hidden="true" />
              </button>
              {menuOpen && (
                <div className="cal-view-menu" role="menu">
                  {(['day', 'week', 'month'] as const).map((option) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={view === option}
                      key={option}
                      onClick={() => setView(option)}
                    >
                      {option[0].toUpperCase() + option.slice(1)}
                      {view === option && <span>✓</span>}
                    </button>
                  ))}
                  <hr />
                  <label>
                    <input
                      type="checkbox"
                      checked={showDeclined}
                      onChange={(e) => {
                        if (props.showDeclined === undefined) setInternalDeclined(e.target.checked)
                        props.onShowDeclinedChange?.(e.target.checked)
                      }}
                    />{' '}
                    Show declined
                  </label>
                </div>
              )}
            </div>
            <button type="button" className="cal-button" onClick={jumpToday}>
              Today
            </button>
            <button type="button" className="cal-icon-button" aria-label="Previous" onClick={() => navigate(-1)}>
              <IconChevronLeft />
            </button>
            <button type="button" className="cal-icon-button" aria-label="Next" onClick={() => navigate(1)}>
              <IconChevronRight />
            </button>
            {props.toolbarActions}
          </div>
        </header>
      )}
      {view === 'month' ? (
        <div className="cal-month">
          <div className="cal-month-head">
            {WEEKDAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="cal-month-grid">
            {monthDays.map((day) => {
              const items = visibleEvents
                .filter((event) =>
                  eventIntersectsDay(
                    parseEventDate(event.start, event.allDay),
                    parseEventDate(event.end, event.allDay),
                    day,
                  ),
                )
                .sort((a, b) => Number(b.kind === 'task') - Number(a.kind === 'task'))
              return (
                <div
                  key={dayKey(day)}
                  className={`cal-month-day ${day.getMonth() !== date.getMonth() ? 'cal-outside' : ''} ${zoneClass('month', day)}`}
                  data-drop-zone="month"
                  data-day={dayKey(day)}
                  onDoubleClick={(e) => createAt(e.currentTarget, day, 9 * 60, true)}
                >
                  <button
                    type="button"
                    className={`cal-month-date ${sameDay(day, today) ? 'cal-today' : ''}`}
                    onClick={() => {
                      setDate(day)
                      setView('day')
                    }}
                  >
                    {day.getDate()}
                  </button>
                  <div className="cal-month-events">
                    {items.slice(0, 4).map((event) => (
                      <EventCard
                        key={event.id}
                        compact
                        event={event}
                        past={parseEventDate(event.end, event.allDay) < new Date()}
                        {...cardProps(event)}
                      />
                    ))}
                    {items.length > 4 && <span className="cal-more">+{items.length - 4} more</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div
          className="cal-timeline-shell"
          style={
            {
              '--all-day-height': `min(${Math.max(58, allDayCount * 23 + 6)}px, max(58px, 35vh))`,
            } as CSSProperties
          }
        >
          <div className="cal-gutter-head">
            <span>All-day</span>
          </div>
          <div className="cal-scroll" ref={scroller} onScroll={onScroll}>
            <div className="cal-strip" style={{ width: columnWidth * STRIP_DAYS }}>
              <div className="cal-strip-head">
                {days.map((day) => (
                  <div
                    className={`cal-day-head ${sameDay(day, today) ? 'cal-current-day' : ''}`}
                    key={dayKey(day)}
                    style={{ width: columnWidth }}
                  >
                    <span>{WEEKDAYS[day.getDay()]}</span>
                    <strong>{day.getDate()}</strong>
                  </div>
                ))}
              </div>
              <div className="cal-allday-row">
                {days.map((day) => {
                  return (
                    <div
                      key={dayKey(day)}
                      className={`cal-allday-cell ${zoneClass('allday', day)}`}
                      data-drop-zone="allday"
                      data-day={dayKey(day)}
                      style={{ width: columnWidth }}
                      onDoubleClick={(e) => createAt(e.currentTarget, day, 0, true)}
                    >
                      {eventsByDay
                        .get(dayKey(day))!
                        .filter(inTopBar)
                        .map((event) => (
                          <EventCard
                            key={event.id}
                            compact
                            event={event}
                            past={parseEventDate(event.end, event.allDay) < new Date()}
                            {...cardProps(event)}
                          />
                        ))}
                    </div>
                  )
                })}
              </div>
              <div className="cal-time-grid" ref={timeline} style={{ height: HOUR_HEIGHT * 24 }}>
                {days.map((day) => {
                  const preview =
                    dropTarget?.zone === 'timed' &&
                    dropTarget.day === dayKey(day) &&
                    !dropTarget.invalid &&
                    dropTarget.minutes !== undefined &&
                    dropTarget.endMinutes !== undefined
                      ? dropTarget
                      : null
                  return (
                    <div
                      className={`cal-time-day ${sameDay(day, today) ? 'cal-current-day' : ''} ${zoneClass('timed', day)}`}
                      key={dayKey(day)}
                      data-drop-zone="timed"
                      data-day={dayKey(day)}
                      style={{ width: columnWidth }}
                      onPointerDown={(e) => startCreate(e, day)}
                      onDoubleClick={(e) => {
                        const box = e.currentTarget.getBoundingClientRect()
                        const minutes = Math.max(
                          0,
                          Math.min(23 * 60, Math.round(((e.clientY - box.top) / HOUR_HEIGHT) * 4) * 15),
                        )
                        createAt(e.currentTarget, day, minutes)
                      }}
                    >
                      {timedSegments(eventsByDay.get(dayKey(day))!, day, HOUR_HEIGHT).map((segment) => (
                        <div
                          key={`${segment.event.id}-${dayKey(day)}`}
                          className="cal-event-position"
                          style={{
                            top: segment.top,
                            height: segment.height,
                            left: `${segment.left}%`,
                            width: `${segment.width}%`,
                            zIndex: 3 + segment.column,
                          }}
                        >
                          <EventCard
                            event={segment.event}
                            narrow={segment.width < 100}
                            titleLines={Math.floor((segment.height - TIMED_CARD_CHROME) / TITLE_LINE_HEIGHT)}
                            past={parseEventDate(segment.event.end) < new Date()}
                            {...cardProps(segment.event)}
                          />
                        </div>
                      ))}
                      {preview && (
                        <div
                          className="cal-drop-preview"
                          aria-hidden="true"
                          style={{
                            top: (preview.minutes! / 60) * HOUR_HEIGHT,
                            height: ((preview.endMinutes! - preview.minutes!) / 60) * HOUR_HEIGHT,
                          }}
                        >
                          <span>
                            {formatTimeRange(
                              wallClock(preview.day, preview.minutes!),
                              wallClock(preview.day, preview.endMinutes!),
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  )
                })}
                {days.some((day) => sameDay(day, today)) && (
                  <div
                    className="cal-now-line"
                    style={{
                      left: `${days.findIndex((day) => sameDay(day, today)) * columnWidth}px`,
                      top: new Date().getHours() * HOUR_HEIGHT + (new Date().getMinutes() / 60) * HOUR_HEIGHT,
                      width: columnWidth,
                    }}
                  />
                )}
              </div>
            </div>
          </div>
          <div className="cal-hour-labels-clip">
            <div className="cal-hour-labels" ref={hourLabels}>
              {HOURS.map((hour) => (
                <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>
                  {hour === 0 ? '' : formatTime(new Date(2024, 0, 1, hour))}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <button
        className="cal-mobile-add"
        type="button"
        aria-label="New event"
        onClick={(e) => createAt(e.currentTarget, date, 9 * 60)}
      >
        <IconPlus />
      </button>
      {dragView?.data.type === 'move' &&
        createPortal(
          <div
            ref={drag.ghostRef}
            className={`cal-drag-ghost ${dropTarget?.invalid ? 'cal-drag-ghost-invalid' : ''}`}
            style={{ width: dragView.width, height: dragView.height }}
            aria-hidden="true"
          >
            <EventCard
              event={dragView.data.item}
              compact={dragView.data.compact}
              titleLines={dragView.data.titleLines}
              timeLabel={
                dropTarget?.zone === 'timed' &&
                !dropTarget.invalid &&
                dropTarget.minutes !== undefined &&
                dropTarget.endMinutes !== undefined
                  ? dragView.data.compact || dragView.data.titleLines < 1
                    ? formatShortTime(wallClock(dropTarget.day, dropTarget.minutes))
                    : formatTimeRange(
                        wallClock(dropTarget.day, dropTarget.minutes),
                        wallClock(dropTarget.day, dropTarget.endMinutes),
                      )
                  : dragView.data.timeLabel
              }
              past={false}
            />
          </div>,
          document.body,
        )}
      {dropError && (
        <div className="cal-drop-error" role="alert">
          {dropError}
          <button type="button" aria-label="Dismiss error" onClick={() => setDropError('')}>
            <IconX />
          </button>
        </div>
      )}
      {editor && (editingEvent || editor.draft) && (
        <EventPopover
          key={editor.sessionId}
          event={editingEvent}
          draft={editingEvent ? null : editor.draft}
          anchor={editor.anchor}
          calendars={props.calendars ?? []}
          editable={!!editingEvent && canEditEvent(editingEvent)}
          onClose={closeEditor}
          onChange={(changed) => {
            if (changed.series) return stageEdit(editingEvent!, changed)
            // A single event whose repeat rule changes becomes a series with new occurrence ids once saved; further
            // edits must go through those, so close the editor rather than saving against the old single event.
            if (editingEvent && 'recurrence' in diffRecurring(editingEvent, changed)) setEditor(null)
            void commitEvent(changed)
          }}
          onDraftChange={(draft) => setEditor((current) => current && { ...current, draft })}
          onCreate={props.onEventCreate ? createEvent : undefined}
          onCreateTask={props.onTaskCreate ? createTask : undefined}
          onDelete={props.onEventDelete ? deleteEvent : undefined}
          onDeleteOccurrence={props.onRecurringEventDelete ? deleteOccurrence : undefined}
          onNavigateOccurrence={props.onFindOccurrence ? navigateOccurrence : undefined}
          onDecide={props.onDecisionChange ? decide : undefined}
        />
      )}
      {prompt?.mode === 'delete' && prompt.event && (
        <RecurringScopeDialog
          mode="delete"
          original={prompt.event}
          busy={prompt.busy}
          error={prompt.error}
          onConfirm={(scope) => void confirmScope(scope)}
          onCancel={() => setPrompt(null)}
        />
      )}
      {prompt?.mode === 'edit' && pending && (
        <RecurringScopeDialog
          mode="edit"
          original={pending.original}
          changed={pending.changed}
          calendars={props.calendars ?? []}
          busy={prompt.busy}
          error={prompt.error}
          onConfirm={(scope) => void confirmScope(scope)}
          onDiscard={() => {
            setPending(null)
            setPrompt(null)
            prompt.then?.()
          }}
          onContinue={() => {
            setPrompt(null)
            reopenPending(prompt.anchor)
          }}
        />
      )}
    </section>
  )
}

export default CalendarWorkspace
