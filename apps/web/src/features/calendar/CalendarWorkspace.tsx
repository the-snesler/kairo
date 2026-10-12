import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react'
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal, flushSync } from 'react-dom'
import IconChevronLeft from '~icons/tabler/chevron-left'
import IconChevronRight from '~icons/tabler/chevron-right'
import IconChevronDown from '~icons/tabler/chevron-down'
import IconPlus from '~icons/tabler/plus'
import IconX from '~icons/tabler/x'
import IconTrash from '~icons/tabler/trash'
import IconCheck from '~icons/tabler/check'
import { addDays, dayKey, eventIntersectsDay, formatDateTimeLocal, formatShortTime, formatTime, formatTimeRange, HOUR_HEIGHT, parseEventDate, sameDay, startOfDay, startOfWeek } from './date'
import { inTopBar, normalizeTaskEvent, timedSegments } from './layout'
import { onExternalDrag } from './dnd/external'
import { MIN_DURATION_MINUTES, moveEvent, resizeEnd, resolveTarget, sameDue, taskDueForTarget, wallClock } from './dnd/geometry'
import type { DropTarget, DropZone, ZoneHit } from './dnd/geometry'
import { useCalendarDrag } from './dnd/useCalendarDrag'
import type { DragSession } from './dnd/useCalendarDrag'
import type { CalendarEvent, CalendarView, CalendarWorkspaceProps, EventDecision } from './types'
import { formatDuration } from '../tasks/grouping'
import type { TaskSummary } from '../tasks/types'
import './calendar.css'

export type { CalendarEvent, CalendarOption, CalendarView, CalendarWorkspaceProps, EventDecision } from './types'

const STRIP_DAYS = 35
const STRIP_REBASE_DAYS = 14
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const colorPattern = /^#[0-9a-f]{6}$/i
// Keep in sync with .cal-event-title / .cal-event-time line heights and the card's vertical chrome in calendar.css.
const TITLE_LINE_HEIGHT = 14
const TIMED_CARD_CHROME = 22
const TASK_COLOR = '#a78bfa'
const EXTERNAL_GHOST_HEIGHT = 22

function safeColor(value: string | undefined, fallback = '#7894a8') {
  return value && colorPattern.test(value) ? value : fallback
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000)
}

function eventStyle(event: CalendarEvent, past: boolean): CSSProperties {
  const calendar = safeColor(event.calendarColor, event.kind === 'task' ? TASK_COLOR : undefined)
  const eventColor = safeColor(event.eventColor, calendar)
  return {
    "--calendar-color": calendar,
    "--event-color": eventColor,
    "--event-body":
      event.kind === "external"
        ? "transparent"
        : event.kind === "task"
          ? `color-mix(in srgb, ${eventColor} ${past ? "10%" : "18%"}, var(--cal-surface))`
          : `color-mix(in srgb, ${eventColor} ${past ? "23%" : "45%"}, var(--cal-surface))`,
  } as CSSProperties;
}

function isDashed(event: CalendarEvent) {
  return event.kind === 'external'
}

function canEdit(event: CalendarEvent) {
  return event.editable !== false && event.kind !== 'external' && event.kind !== 'task' && !event.recurring
}

function eventMinutes(event: CalendarEvent) {
  if (event.kind === 'task' && event.task) return event.task.durationMinutes
  return Math.round((parseEventDate(event.end, event.allDay).getTime() - parseEventDate(event.start, event.allDay).getTime()) / 60_000)
}

/** Calendar card for a task that is not (yet) on the calendar, e.g. dragged in from the sidebar. */
function taskEvent(task: TaskSummary): CalendarEvent {
  const placeholder = dayKey(new Date())
  return normalizeTaskEvent({ id: `task-${task.id}`, title: task.title, kind: 'task', taskId: task.id, task, start: placeholder, end: placeholder, allDay: true })
}


interface EditorState {
  event: CalendarEvent | null
  draft: Omit<CalendarEvent, 'id'> | null
}

type DragData =
  | { type: 'move', item: CalendarEvent, originDay: string, zones: readonly DropZone[], grabMinutes: number, durationMinutes: number, compact: boolean, titleLines: number, timeLabel?: string }
  | { type: 'resize', item: CalendarEvent, day: string, startMinutes: number, wrapper: HTMLElement, column: HTMLElement, bottomGap: number, height: string }

function EventCard({
  event,
  compact,
  titleLines = 0,
  past,
  draggable,
  dragging,
  timeLabel,
  onOpen,
  onPointerDown,
  onToggleComplete,
}: {
  event: CalendarEvent;
  compact?: boolean;
  /** Title lines that fit above the time row; 0 lays title and time out on a single line. */
  titleLines?: number;
  past: boolean;
  draggable?: boolean;
  /** The original card while a drag of it is in progress. */
  dragging?: boolean;
  /** Replaces the computed time text. */
  timeLabel?: string;
  onOpen?: (element: HTMLElement, event: CalendarEvent) => void;
  onPointerDown?: (
    event: ReactPointerEvent<HTMLElement>,
    item: CalendarEvent,
    resize: boolean,
  ) => void;
  onToggleComplete?: (event: CalendarEvent) => void;
}) {
  const start = parseEventDate(event.start, event.allDay);
  const end = parseEventDate(event.end, event.allDay);
  const inline = compact || titleLines < 1;
  const task = event.kind === "task";
  const completed = !!event.task?.completed;
  const time = timeLabel ?? (inTopBar(event)
    ? ""
    : inline
      ? formatShortTime(start)
      : formatTimeRange(start, end));
  return (
    <div
      className={`cal-event ${compact ? "cal-event-compact" : ""} ${inline ? "cal-event-inline" : ""} ${isDashed(event) ? "cal-event-dashed" : ""} ${event.declined ? "cal-event-declined" : ""} ${task ? "cal-event-task" : ""} ${completed ? "cal-event-completed" : ""} ${event.task?.pending ? "cal-event-pending" : ""} ${past ? "cal-event-past" : ""} ${draggable ? "cal-event-draggable" : ""} ${dragging ? "cal-event-dragging" : ""}`}
      style={
        {
          ...eventStyle(event, past),
          "--title-lines": Math.max(titleLines, 1),
        } as CSSProperties
      }
      role="button"
      tabIndex={0}
      aria-label={`${task ? "Task: " : ""}${event.title}${time ? `, ${time}` : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.(e.currentTarget, event);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen?.(e.currentTarget, event);
        }
      }}
      onPointerDown={(e) => onPointerDown?.(e, event, false)}
    >
      <span className="cal-event-title">
        {task && (
          <button
            type="button"
            className="cal-task-check"
            aria-label={completed ? "Mark task incomplete" : "Complete task"}
            aria-pressed={completed}
            disabled={!onToggleComplete}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleComplete?.(event);
            }}
          >
            {completed && <IconCheck aria-hidden="true" />}
          </button>
        )}
        {event.title}
      </span>
      {time && <span className="cal-event-time">{time}</span>}
      {!compact && draggable && onPointerDown && (
        <span
          className="cal-event-resize"
          role="presentation"
          onPointerDown={(e) => {
            e.stopPropagation();
            onPointerDown(e, event, true);
          }}
        />
      )}
    </div>
  );
}

export function CalendarWorkspace(props: CalendarWorkspaceProps) {
  const [internalView, setInternalView] = useState<CalendarView>(props.initialView ?? 'week')
  const [internalDate, setInternalDate] = useState(() => startOfDay(props.initialDate ?? new Date()))
  const [internalDeclined, setInternalDeclined] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [form, setForm] = useState({ title: '', start: '', end: '', allDay: false, calendarId: '', eventColor: '', description: '', location: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [overrides, setOverrides] = useState<Record<string, CalendarEvent>>({})
  const [created, setCreated] = useState<CalendarEvent[]>([])
  const [deleted, setDeleted] = useState<string[]>([])
  const [taskOverrides, setTaskOverrides] = useState<Record<string, CalendarEvent>>({})
  const [dropError, setDropError] = useState('')
  const [stripStart, setStripStart] = useState(() => addDays(startOfWeek(props.date ?? props.initialDate ?? new Date()), -14))
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
    const scheduled = new Set(sourceEvents.map(event => event.taskId))
    // Optimistic task moves also cover tasks that were not on the calendar yet (dropped from the sidebar).
    const unscheduled = Object.values(taskOverrides).filter(event => !scheduled.has(event.taskId))
    return [...sourceEvents, ...created, ...unscheduled].filter(event => !deleted.includes(event.id)).map(event => {
      const current = (event.kind === 'task' && event.taskId ? taskOverrides[event.taskId] : undefined) ?? overrides[event.id] ?? event
      const calendar = props.calendars?.find(item => item.id === current.calendarId)
      return calendar && current.decision && current.decision !== 'undecided' ? { ...current, calendarColor: calendar.color } : current
    }).filter(event => showDeclined || (!event.declined && event.status !== 'declined' && event.decision !== 'no'))
  }, [sourceEvents, props.calendars, created, deleted, overrides, taskOverrides, showDeclined])

  useEffect(() => { stripStartRef.current = stripStart }, [stripStart])

  useEffect(() => {
    setOverrides(current => {
      const next = { ...current }
      for (const event of sourceEvents) if (next[event.id] && parseEventDate(next[event.id].start, next[event.id].allDay).getTime() === parseEventDate(event.start, event.allDay).getTime() && parseEventDate(next[event.id].end, next[event.id].allDay).getTime() === parseEventDate(event.end, event.allDay).getTime() && next[event.id].title === event.title && next[event.id].decision === event.decision && next[event.id].calendarId === event.calendarId && next[event.id].eventColor === event.eventColor) delete next[event.id]
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
    setTaskOverrides(current => {
      const next = { ...current }
      for (const event of sourceEvents) {
        const pending = event.taskId ? next[event.taskId] : undefined
        if (pending && event.kind === 'task' && sameDue(pending.task?.due, event.task?.due) && pending.task?.durationMinutes === event.task?.durationMinutes) delete next[event.taskId!]
      }
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }, [sourceEvents])

  useEffect(() => {
    setCreated(current => current.filter(draft => !sourceEvents.some(event => event.title === draft.title && parseEventDate(event.start, event.allDay).getTime() === parseEventDate(draft.start, draft.allDay).getTime() && parseEventDate(event.end, event.allDay).getTime() === parseEventDate(draft.end, draft.allDay).getTime())))
    setDeleted(current => current.filter(id => props.events.some(event => event.id === id)))
  }, [props.events, sourceEvents])

  const setDate = useCallback((next: Date) => {
    const normalized = startOfDay(next)
    dateRef.current = dayKey(normalized)
    if (props.date === undefined) setInternalDate(normalized)
    props.onDateChange?.(normalized)
  }, [props.date, props.onDateChange])

  const setView = (next: CalendarView) => {
    if (props.view === undefined) setInternalView(next)
    props.onViewChange?.(next)
    setMenuOpen(false)
  }

  const reportDays = useCallback((first: Date, count: number) => {
    const days = Array.from({ length: count }, (_, i) => addDays(first, i))
    props.onVisibleDaysChange?.(days)
    props.onVisibleRangeChange?.(first, addDays(first, count))
  }, [props.onVisibleDaysChange, props.onVisibleRangeChange])

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node || view === 'month') return
    const resize = () => setColumnWidth(Math.max(view === 'day' ? node.clientWidth : node.clientWidth / 7, view === 'day' ? 320 : 128))
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
    if (dayKey(first) !== dateRef.current) startTransition(() => {
      setDate(first)
      reportDays(first, view === 'week' ? 7 : 1)
    })
  }

  const navigate = (direction: number) => {
    const next = view === 'month' ? new Date(date.getFullYear(), date.getMonth() + direction, 1) : addDays(date, direction * (view === 'week' ? 7 : 1))
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

  const jumpToday = () => {
    setDate(today)
    if (view === 'month') reportDays(startOfWeek(new Date(today.getFullYear(), today.getMonth(), 1)), 42)
    else {
      const first = view === 'week' ? startOfWeek(today) : today
      stripStartRef.current = addDays(first, -14)
      setStripStart(stripStartRef.current)
      if (scroller.current) scroller.current.scrollLeft = 14 * columnWidth
      reportDays(first, view === 'week' ? 7 : 1)
    }
  }

  const floating = useFloating({ open: !!editor, onOpenChange: open => { if (!open) setEditor(null) }, placement: 'right-start', strategy: 'fixed', middleware: [offset(12), flip({ fallbackPlacements: ['left-start', 'bottom-start'] }), shift({ padding: 12 })], whileElementsMounted: autoUpdate })
  const dismiss = useDismiss(floating.context)
  const role = useRole(floating.context, { role: 'dialog' })
  const { getFloatingProps } = useInteractions([dismiss, role])

  const openEditor = (element: HTMLElement, event: CalendarEvent | null, draft: Omit<CalendarEvent, 'id'> | null = null) => {
    if (event?.kind === 'task') {
      if (event.taskId) props.onTaskOpen?.(event.taskId, element)
      return
    }
    floating.refs.setReference(element)
    const data = event ?? draft
    if (!data) return
    setForm({ title: data.title, start: formatDateTimeLocal(parseEventDate(data.start, data.allDay)), end: formatDateTimeLocal(parseEventDate(data.end, data.allDay)), allDay: !!data.allDay, calendarId: data.calendarId ?? props.calendars?.[0]?.id ?? '', eventColor: data.eventColor ?? '', description: data.description ?? '', location: data.location ?? '' })
    setError('')
    setEditor({ event, draft })
  }

  const createAt = (element: HTMLElement, day: Date, minutes: number, allDay = false) => {
    const start = addMinutes(day, allDay ? 0 : minutes)
    const end = allDay ? addDays(day, 1) : addMinutes(start, 60)
    openEditor(element, null, { title: '', start: start.toISOString(), end: end.toISOString(), kind: 'google', allDay, calendarId: props.calendars?.[0]?.id, calendarColor: props.calendars?.[0]?.color })
  }

  const save = async () => {
    if (!editor || !form.title.trim()) return
    const start = new Date(form.start)
    const end = new Date(form.end)
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) { setError('End must be after start.'); return }
    const calendar = props.calendars?.find(item => item.id === form.calendarId)
    const patch = { title: form.title.trim(), start: form.allDay ? dayKey(start) : start.toISOString(), end: form.allDay ? dayKey(end) : end.toISOString(), allDay: form.allDay, calendarId: form.calendarId || undefined, calendarColor: calendar?.color, eventColor: form.eventColor || undefined, description: form.description, location: form.location }
    setBusy(true)
    setError('')
    try {
      if (editor.event) {
        const updated = { ...editor.event, ...patch }
        setOverrides(current => ({ ...current, [updated.id]: updated }))
        await props.onEventChange?.(updated)
      } else if (editor.draft) {
        const draft = { ...editor.draft, ...patch }
        const optimistic = { ...draft, id: `pending-${crypto.randomUUID()}` }
        setCreated(current => [...current, optimistic])
        try { await props.onEventCreate?.(draft) }
        catch (cause) { setCreated(current => current.filter(item => item.id !== optimistic.id)); throw cause }
      }
      setEditor(null)
    } catch (cause) {
      if (editor.event) setOverrides(current => { const next = { ...current }; delete next[editor.event!.id]; return next })
      setError(cause instanceof Error ? cause.message : 'Could not save event.')
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!editor?.event) return
    setBusy(true)
    const event = editor.event
    setDeleted(current => [...current, event.id])
    try { await props.onEventDelete?.(event); setEditor(null) }
    catch (cause) { setDeleted(current => current.filter(id => id !== event.id)); setError(cause instanceof Error ? cause.message : 'Could not delete event.') }
    finally { setBusy(false) }
  }

  const decide = async (decision: EventDecision) => {
    if (!editor?.event) return
    setBusy(true)
    const event = editor.event
    setOverrides(current => ({ ...current, [event.id]: { ...event, decision, calendarId: form.calendarId || event.calendarId } }))
    try { await props.onDecisionChange?.(event, decision, form.calendarId || undefined); setEditor(null) }
    catch (cause) { setOverrides(current => { const next = { ...current }; delete next[event.id]; return next }); setError(cause instanceof Error ? cause.message : 'Could not save decision.') }
    finally { setBusy(false) }
  }

  const canDrag = (event: CalendarEvent) => event.kind === 'task'
    ? event.editable !== false && !!event.taskId && !!props.onTaskChange
    : canEdit(event) && !!props.onEventChange

  const reportError = (cause: unknown, fallback: string) => setDropError(cause instanceof Error ? cause.message : fallback)

  /** Optimistically applies a task change, then rolls back if the parent rejects it. */
  const commitTask = async (item: CalendarEvent, patch: { due?: TaskSummary['due'], durationMinutes?: number }) => {
    const task = item.task
    if (!task || !item.taskId) return
    const taskId = item.taskId
    const optimistic = normalizeTaskEvent({ ...item, task: { ...task, ...patch } })
    setTaskOverrides(current => ({ ...current, [taskId]: optimistic }))
    setDropError('')
    try { await props.onTaskChange?.(taskId, patch) }
    catch (cause) {
      setTaskOverrides(current => { if (current[taskId] !== optimistic) return current; const next = { ...current }; delete next[taskId]; return next })
      reportError(cause, 'Could not update task.')
    }
  }

  const commitEvent = async (changed: CalendarEvent) => {
    setOverrides(current => ({ ...current, [changed.id]: changed }))
    setDropError('')
    try { await props.onEventChange?.(changed) }
    catch (cause) {
      setOverrides(current => { if (current[changed.id] !== changed) return current; const next = { ...current }; delete next[changed.id]; return next })
      reportError(cause, 'Could not move event.')
    }
  }

  const hitTest = (x: number, y: number): ZoneHit | null => {
    const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-zone]')
    if (!zone || !root.current?.contains(zone) || !zone.dataset.day) return null
    return { zone: zone.dataset.dropZone as DropZone, day: zone.dataset.day, top: zone.getBoundingClientRect().top }
  }

  const drag = useCalendarDrag<DragData>({
    cursor: session => session.data.type === 'resize' ? 'resize' : 'move',
    resolve: ({ data, x, y }) => {
      if (data.type === 'resize') {
        const rect = data.column.getBoundingClientRect()
        return { zone: 'timed', day: data.day, minutes: data.startMinutes, endMinutes: resizeEnd(y, rect.top, HOUR_HEIGHT, data.startMinutes) }
      }
      return resolveTarget(hitTest(x, y), y, { hourHeight: HOUR_HEIGHT, grabMinutes: data.grabMinutes, durationMinutes: data.durationMinutes, zones: data.zones })
    },
    onFrame: ({ data, y }) => {
      if (data.type !== 'resize') return
      // The card's bottom edge follows the pointer; the snapped end is shown by the preview.
      const top = data.wrapper.getBoundingClientRect().top
      const columnBottom = data.column.getBoundingClientRect().bottom
      data.wrapper.style.height = `${Math.max(MIN_DURATION_MINUTES / 60 * HOUR_HEIGHT, Math.min(columnBottom, y + data.bottomGap) - top)}px`
    },
    onFinish: ({ data }) => {
      if (data.type === 'resize') data.wrapper.style.height = data.height
    },
    onDrop: ({ data }, target) => {
      if (!target || target.invalid) return
      const { item } = data
      if (data.type === 'resize') {
        // Measure from the item's true start: the resized segment may begin at midnight of a later day.
        const end = wallClock(data.day, target.endMinutes!)
        if (item.kind === 'task') {
          const durationMinutes = Math.round((end.getTime() - parseEventDate(item.start).getTime()) / 60_000)
          if (durationMinutes !== item.task?.durationMinutes) void commitTask(item, { durationMinutes })
          return
        }
        if (end.getTime() !== parseEventDate(item.end).getTime()) void commitEvent({ ...item, end: end.toISOString() })
        return
      }
      if (item.kind === 'task') {
        const current = item.task?.due ?? null
        const due = taskDueForTarget(current, target)
        if (!sameDue(current, due)) void commitTask(item, { due })
        return
      }
      const moved = moveEvent(item, target, data.originDay)
      if (parseEventDate(moved.start, moved.allDay).getTime() !== parseEventDate(item.start, item.allDay).getTime()) void commitEvent({ ...item, ...moved })
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
      const startMinutes = Math.round((box.top - zone.getBoundingClientRect().top) / HOUR_HEIGHT * 60)
      drag.begin({ type: 'resize', item: event, day, startMinutes, wrapper, column: zone, bottomGap: box.bottom - e.clientY, height: wrapper.style.height }, e.nativeEvent, { grabX: 0, grabY: 0, width: box.width, height: box.height })
      return
    }
    const card = target.closest<HTMLElement>('.cal-event') ?? target
    const box = card.getBoundingClientRect()
    const compact = zone.dataset.dropZone !== 'timed'
    const timedZones: readonly DropZone[] = ['timed', 'month']
    const dayZones: readonly DropZone[] = ['allday', 'month']
    drag.begin({
      type: 'move', item: event, originDay: day,
      zones: event.kind === 'task' ? ['timed', 'allday', 'month'] : inTopBar(event) ? dayZones : timedZones,
      grabMinutes: (e.clientY - box.top) / HOUR_HEIGHT * 60,
      durationMinutes: eventMinutes(event), compact,
      titleLines: compact ? 0 : Math.floor((box.height - TIMED_CARD_CHROME) / TITLE_LINE_HEIGHT),
    }, e.nativeEvent, { grabX: e.clientX - box.left, grabY: e.clientY - box.top, width: box.width, height: box.height })
  }

  // Drags started outside the workspace (the task sidebar) render and drop here.
  const beginDrag = drag.begin
  useEffect(() => onExternalDrag((payload, pointer, origin) => {
    const item = taskEvent(payload.task)
    const width = Math.min(Math.max(origin.width, 120), Math.max(columnWidth - 8, 120))
    const grabX = origin.width ? (pointer.clientX - origin.left) / origin.width * width : 0
    const grabY = Math.min(Math.max(pointer.clientY - origin.top, 0), EXTERNAL_GHOST_HEIGHT)
    beginDrag({
      type: 'move', item, originDay: item.task?.due ? dayKey(parseEventDate(item.start, item.allDay)) : dayKey(new Date()),
      zones: ['timed', 'allday', 'month'], grabMinutes: grabY / HOUR_HEIGHT * 60,
      durationMinutes: payload.task.durationMinutes, compact: true, titleLines: 0,
      timeLabel: formatDuration(payload.task.durationMinutes),
    }, pointer, { grabX, grabY, width, height: EXTERNAL_GHOST_HEIGHT })
  }), [beginDrag, columnWidth])

  const dragView = drag.view
  const dropTarget: DropTarget | null = dragView?.target ?? null
  const draggedItem = dragView?.data.type === 'move' ? dragView.data.item : null
  const isDragged = (event: CalendarEvent) => !!draggedItem && (draggedItem.kind === 'task' ? event.taskId === draggedItem.taskId : event.id === draggedItem.id)
  const zoneClass = (zone: DropZone, day: Date) => dropTarget?.zone === zone && dropTarget.day === dayKey(day)
    ? dropTarget.invalid ? 'cal-drop-invalid' : zone === 'timed' ? '' : 'cal-drop-target'
    : ''

  const toggleComplete = (event: CalendarEvent) => {
    if (!event.taskId) return
    setDropError('')
    Promise.resolve(props.onTaskChange?.(event.taskId, { completed: !event.task?.completed })).catch(cause => reportError(cause, 'Could not update task.'))
  }

  const cardProps = (event: CalendarEvent) => ({
    draggable: canDrag(event),
    dragging: isDragged(event),
    onPointerDown: startDrag,
    onOpen: openEditor,
    onToggleComplete: event.kind === 'task' && props.onTaskChange ? toggleComplete : undefined,
  })

  const days = useMemo(() => Array.from({ length: STRIP_DAYS }, (_, i) => addDays(stripStart, i)), [stripStart])
  const eventsByDay = useMemo(() => {
    const indexed = new Map(days.map(day => [dayKey(day), [] as CalendarEvent[]]))
    for (const event of visibleEvents) {
      const start = parseEventDate(event.start, event.allDay)
      const end = parseEventDate(event.end, event.allDay)
      for (let day = startOfDay(start < days[0] ? days[0] : start); day <= days[days.length - 1] && day < end; day = addDays(day, 1))
        indexed.get(dayKey(day))?.push(event)
    }
    for (const events of indexed.values()) events.sort((a, b) => Number(b.kind === 'task') - Number(a.kind === 'task'))
    return indexed
  }, [days, visibleEvents])
  const allDayCount = Math.max(
    1,
    ...days.map((day) => eventsByDay.get(dayKey(day))!.filter(inTopBar).length),
  );
  const monthFirst = new Date(date.getFullYear(), date.getMonth(), 1)
  const monthStart = startOfWeek(monthFirst)
  const monthDays = Array.from({ length: 42 }, (_, i) => addDays(monthStart, i))
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date)

  return (
    <section
      ref={root}
      className="cal-workspace"
      aria-label="Calendar"
      style={{ "--hour-height": `${HOUR_HEIGHT}px` } as CSSProperties}
    >
      {props.showToolbar !== false && (
        <header className="cal-toolbar">
          <div className="cal-heading">
            <h1>{monthLabel}</h1>
            <span className="cal-zone">
              {props.timeZone ??
                Intl.DateTimeFormat().resolvedOptions().timeZone}
            </span>
          </div>
          <div className="cal-controls">
            <div className="cal-view-menu-wrap">
              <button
                className="cal-button"
                type="button"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(!menuOpen)}
              >
                {view[0].toUpperCase() + view.slice(1)}{" "}
                <IconChevronDown aria-hidden="true" />
              </button>
              {menuOpen && (
                <div className="cal-view-menu" role="menu">
                  {(["day", "week", "month"] as const).map((option) => (
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
                        if (props.showDeclined === undefined)
                          setInternalDeclined(e.target.checked);
                        props.onShowDeclinedChange?.(e.target.checked);
                      }}
                    />{" "}
                    Show declined
                  </label>
                </div>
              )}
            </div>
            <button type="button" className="cal-button" onClick={jumpToday}>
              Today
            </button>
            <button
              type="button"
              className="cal-icon-button"
              aria-label="Previous"
              onClick={() => navigate(-1)}
            >
              <IconChevronLeft />
            </button>
            <button
              type="button"
              className="cal-icon-button"
              aria-label="Next"
              onClick={() => navigate(1)}
            >
              <IconChevronRight />
            </button>
            {props.toolbarActions}
          </div>
        </header>
      )}
      {view === "month" ? (
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
                .sort(
                  (a, b) =>
                    Number(b.kind === "task") - Number(a.kind === "task"),
                );
              return (
                <div
                  key={dayKey(day)}
                  className={`cal-month-day ${day.getMonth() !== date.getMonth() ? "cal-outside" : ""} ${zoneClass("month", day)}`}
                  data-drop-zone="month"
                  data-day={dayKey(day)}
                  onDoubleClick={(e) =>
                    createAt(e.currentTarget, day, 9 * 60, true)
                  }
                >
                  <button
                    type="button"
                    className={`cal-month-date ${sameDay(day, today) ? "cal-today" : ""}`}
                    onClick={() => {
                      setDate(day);
                      setView("day");
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
                        past={
                          parseEventDate(event.end, event.allDay) < new Date()
                        }
                        {...cardProps(event)}
                      />
                    ))}
                    {items.length > 4 && (
                      <span className="cal-more">+{items.length - 4} more</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div
          className="cal-timeline-shell"
          style={
            {
              "--all-day-height": `min(${Math.max(58, allDayCount * 23 + 6)}px, max(58px, 35vh))`,
            } as CSSProperties
          }
        >
          <div className="cal-gutter-head">
            <span>All-day</span>
          </div>
          <div className="cal-scroll" ref={scroller} onScroll={onScroll}>
            <div
              className="cal-strip"
              style={{ width: columnWidth * STRIP_DAYS }}
            >
              <div className="cal-strip-head">
                {days.map((day) => (
                  <div
                    className={`cal-day-head ${sameDay(day, today) ? "cal-current-day" : ""}`}
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
                      className={`cal-allday-cell ${zoneClass("allday", day)}`}
                      data-drop-zone="allday"
                      data-day={dayKey(day)}
                      style={{ width: columnWidth }}
                      onDoubleClick={(e) =>
                        createAt(e.currentTarget, day, 0, true)
                      }
                    >
                      {eventsByDay
                        .get(dayKey(day))!
                        .filter(inTopBar)
                        .map((event) => (
                          <EventCard
                            key={event.id}
                            compact
                            event={event}
                            past={
                              parseEventDate(event.end, event.allDay) <
                              new Date()
                            }
                            {...cardProps(event)}
                          />
                        ))}
                    </div>
                  );
                })}
              </div>
              <div
                className="cal-time-grid"
                ref={timeline}
                style={{ height: HOUR_HEIGHT * 24 }}
              >
                {days.map((day) => {
                  const preview =
                    dropTarget?.zone === "timed" &&
                    dropTarget.day === dayKey(day) &&
                    !dropTarget.invalid &&
                    dropTarget.minutes !== undefined &&
                    dropTarget.endMinutes !== undefined
                      ? dropTarget
                      : null;
                  return (
                    <div
                      className={`cal-time-day ${sameDay(day, today) ? "cal-current-day" : ""} ${zoneClass("timed", day)}`}
                      key={dayKey(day)}
                      data-drop-zone="timed"
                      data-day={dayKey(day)}
                      style={{ width: columnWidth }}
                      onDoubleClick={(e) => {
                        const box = e.currentTarget.getBoundingClientRect();
                        const minutes = Math.max(
                          0,
                          Math.min(
                            23 * 60,
                            Math.round(
                              ((e.clientY - box.top) / HOUR_HEIGHT) * 4,
                            ) * 15,
                          ),
                        );
                        createAt(e.currentTarget, day, minutes);
                      }}
                    >
                      {timedSegments(
                        eventsByDay.get(dayKey(day))!,
                        day,
                        HOUR_HEIGHT,
                      ).map((segment) => (
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
                            titleLines={Math.floor(
                              (segment.height - TIMED_CARD_CHROME) /
                                TITLE_LINE_HEIGHT,
                            )}
                            past={
                              parseEventDate(segment.event.end) < new Date()
                            }
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
                            height:
                              ((preview.endMinutes! - preview.minutes!) / 60) *
                              HOUR_HEIGHT,
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
                  );
                })}
                {days.some((day) => sameDay(day, today)) && (
                  <div
                    className="cal-now-line"
                    style={{
                      left: `${days.findIndex((day) => sameDay(day, today)) * columnWidth}px`,
                      top:
                        new Date().getHours() * HOUR_HEIGHT +
                        (new Date().getMinutes() / 60) * HOUR_HEIGHT,
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
                  {hour === 0 ? "" : formatTime(new Date(2024, 0, 1, hour))}
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
      {dragView?.data.type === "move" &&
        createPortal(
          <div
            ref={drag.ghostRef}
            className={`cal-drag-ghost ${dropTarget?.invalid ? "cal-drag-ghost-invalid" : ""}`}
            style={{ width: dragView.width, height: dragView.height }}
            aria-hidden="true"
          >
            <EventCard
              event={dragView.data.item}
              compact={dragView.data.compact}
              titleLines={dragView.data.titleLines}
              timeLabel={
                dropTarget?.zone === "timed" && !dropTarget.invalid && dropTarget.minutes !== undefined && dropTarget.endMinutes !== undefined
                  ? dragView.data.compact || dragView.data.titleLines < 1
                    ? formatShortTime(wallClock(dropTarget.day, dropTarget.minutes))
                    : formatTimeRange(wallClock(dropTarget.day, dropTarget.minutes), wallClock(dropTarget.day, dropTarget.endMinutes))
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
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setDropError("")}
          >
            <IconX />
          </button>
        </div>
      )}
      {editor && (
        <FloatingPortal>
          <div
            ref={floating.refs.setFloating}
            style={floating.floatingStyles}
            {...getFloatingProps({
              "className": "cal-editor",
              "aria-label": editor.event ? "Edit event" : "New event",
            })}
          >
            <div className="cal-editor-head">
              <strong>
                {editor.event
                  ? editor.event.kind === "external"
                    ? "Maybe event"
                    : "Event"
                  : "New event"}
              </strong>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setEditor(null)}
              >
                <IconX />
              </button>
            </div>
            <div className="cal-editor-body">
              <label>
                Title
                <input
                  value={form.title}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      title: e.target.value,
                    }))
                  }
                  readOnly={editor.event?.kind === "external"}
                  autoFocus
                />
              </label>
              <div className="cal-editor-times">
                <label>
                  Starts
                  <input
                    type="datetime-local"
                    value={form.start}
                    onChange={(e) =>
                      setForm((current) => ({
                        ...current,
                        start: e.target.value,
                      }))
                    }
                    readOnly={editor.event?.kind === "external"}
                  />
                </label>
                <label>
                  Ends
                  <input
                    type="datetime-local"
                    value={form.end}
                    onChange={(e) =>
                      setForm((current) => ({
                        ...current,
                        end: e.target.value,
                      }))
                    }
                    readOnly={editor.event?.kind === "external"}
                  />
                </label>
              </div>
              {editor.event?.kind !== "external" && (
                <label className="cal-checkbox-label">
                  <input
                    type="checkbox"
                    checked={form.allDay}
                    onChange={(e) =>
                      setForm((current) => ({
                        ...current,
                        allDay: e.target.checked,
                      }))
                    }
                  />{" "}
                  All day
                </label>
              )}
              {props.calendars && props.calendars.length > 0 && (
                <label>
                  Calendar
                  <select
                    value={form.calendarId}
                    onChange={(e) =>
                      setForm((current) => ({
                        ...current,
                        calendarId: e.target.value,
                      }))
                    }
                  >
                    {props.calendars.map((calendar) => (
                      <option key={calendar.id} value={calendar.id}>
                        {calendar.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {editor.event?.kind !== "external" && (
                <>
                  <label>
                    Event color
                    <input
                      type="color"
                      value={safeColor(
                        form.eventColor,
                        safeColor(editor.event?.eventColor, "#7894a8"),
                      )}
                      onChange={(e) =>
                        setForm((current) => ({
                          ...current,
                          eventColor: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Location
                    <input
                      value={form.location}
                      onChange={(e) =>
                        setForm((current) => ({
                          ...current,
                          location: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Description
                    <textarea
                      rows={3}
                      value={form.description}
                      onChange={(e) =>
                        setForm((current) => ({
                          ...current,
                          description: e.target.value,
                        }))
                      }
                    />
                  </label>
                </>
              )}
              {editor.event?.recurring && (
                <p className="cal-editor-note">
                  Recurring events are read-only until instance and series
                  editing are available.
                </p>
              )}
              {error && (
                <p className="cal-editor-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="cal-editor-actions">
              {editor.event?.kind === "external" ? (
                <div className="cal-decisions">
                  {(["yes", "maybe", "no", "undecided"] as const).map(
                    (decision) => (
                      <button
                        type="button"
                        key={decision}
                        disabled={busy || !props.onDecisionChange}
                        className={
                          editor.event?.decision === decision
                            ? "cal-selected"
                            : ""
                        }
                        onClick={() => decide(decision)}
                      >
                        {decision[0].toUpperCase() + decision.slice(1)}
                      </button>
                    ),
                  )}
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="cal-save"
                    disabled={
                      busy ||
                      (!!editor.event && !canEdit(editor.event)) ||
                      !form.title.trim() ||
                      (!editor.event && !props.onEventCreate) ||
                      (!!editor.event && !props.onEventChange)
                    }
                    onClick={save}
                  >
                    {busy ? "Saving…" : "Save"}
                  </button>
                  {editor.event && (
                    <button
                      type="button"
                      className="cal-delete"
                      disabled={
                        busy || !props.onEventDelete || !canEdit(editor.event)
                      }
                      aria-label="Delete event"
                      onClick={remove}
                    >
                      <IconTrash />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </FloatingPortal>
      )}
    </section>
  );
}

export default CalendarWorkspace
