import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react'
import { flushSync } from 'react-dom'
import IconChevronLeft from '~icons/tabler/chevron-left'
import IconChevronRight from '~icons/tabler/chevron-right'
import IconChevronDown from '~icons/tabler/chevron-down'
import IconPlus from '~icons/tabler/plus'
import IconX from '~icons/tabler/x'
import IconTrash from '~icons/tabler/trash'
import IconGripVertical from '~icons/tabler/grip-vertical'
import { addDays, dayKey, eventIntersectsDay, formatDateTimeLocal, formatTime, HOUR_HEIGHT, parseEventDate, sameDay, startOfDay, startOfWeek } from './date'
import { timedSegments } from './layout'
import type { CalendarEvent, CalendarView, CalendarWorkspaceProps, EventDecision } from './types'
import './calendar.css'

export type { CalendarEvent, CalendarOption, CalendarView, CalendarWorkspaceProps, EventDecision } from './types'

const STRIP_DAYS = 35
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const colorPattern = /^#[0-9a-f]{6}$/i

function safeColor(value: string | undefined, fallback = '#7894a8') {
  return value && colorPattern.test(value) ? value : fallback
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000)
}

function eventStyle(event: CalendarEvent, past: boolean): CSSProperties {
  const calendar = safeColor(event.calendarColor)
  const eventColor = safeColor(event.eventColor, calendar)
  return {
    '--calendar-color': calendar,
    '--event-color': eventColor,
    '--event-body': event.kind === 'external' || event.kind === 'taskDue' ? 'transparent' : `color-mix(in srgb, ${eventColor} ${past ? '23%' : '60%'}, var(--cal-surface))`,
  } as CSSProperties
}

function isDashed(event: CalendarEvent) {
  return event.kind === 'external'
}

function canEdit(event: CalendarEvent) {
  return event.editable !== false && event.kind !== 'external' && event.kind !== 'taskDue' && !event.recurring
}

interface EditorState {
  event: CalendarEvent | null
  draft: Omit<CalendarEvent, 'id'> | null
}

function EventCard({ event, compact, past, onOpen, onPointerDown }: {
  event: CalendarEvent
  compact?: boolean
  past: boolean
  onOpen: (element: HTMLElement, event: CalendarEvent) => void
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>, item: CalendarEvent, resize: boolean) => void
}) {
  const start = parseEventDate(event.start, event.allDay)
  const end = parseEventDate(event.end, event.allDay)
  const time = event.allDay ? '' : `${formatTime(start)}${compact ? '' : ` – ${formatTime(end)}`}`
  return <div
    className={`cal-event ${compact ? 'cal-event-compact' : ''} ${isDashed(event) ? 'cal-event-dashed' : ''} ${event.declined ? 'cal-event-declined' : ''} ${event.kind === 'taskBlock' ? 'cal-event-task' : ''} ${event.kind === 'taskDue' ? 'cal-event-due' : ''} ${past ? 'cal-event-past' : ''}`}
    style={eventStyle(event, past)}
    role={event.kind === 'taskDue' ? 'note' : 'button'} tabIndex={event.kind === 'taskDue' ? undefined : 0}
    aria-label={`${event.title}${time ? `, ${time}` : ''}`}
    onClick={e => { e.stopPropagation(); if (event.kind !== 'taskDue') onOpen(e.currentTarget, event) }}
    onDoubleClick={e => e.stopPropagation()}
    onKeyDown={e => { if (event.kind !== 'taskDue' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(e.currentTarget, event) } }}
    onPointerDown={e => onPointerDown?.(e, event, false)}
  >
    <span className="cal-event-title">{event.kind === 'taskBlock' && <IconGripVertical aria-hidden="true" />}{event.title}<span className="cal-event-time">{time}</span></span>
    {!compact && canEdit(event) && onPointerDown && <span className="cal-event-resize" role="presentation" onPointerDown={e => { e.stopPropagation(); onPointerDown(e, event, true) }} />}
  </div>
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
  const [dropTarget, setDropTarget] = useState<{ key: string, minutes?: number } | null>(null)
  const [dropError, setDropError] = useState('')
  const [stripStart, setStripStart] = useState(() => addDays(startOfWeek(props.date ?? props.initialDate ?? new Date()), -14))
  const [columnWidth, setColumnWidth] = useState(160)
  const scroller = useRef<HTMLDivElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const dateRef = useRef(dayKey(props.date ?? props.initialDate ?? new Date()))
  const dragRef = useRef<{ event: CalendarEvent, x: number, y: number, resize: boolean, moved: boolean, changed?: CalendarEvent } | null>(null)
  const stripStartRef = useRef(stripStart)
  const suppressClickRef = useRef(false)
  const view = props.view ?? internalView
  const date = props.date ?? internalDate
  const showDeclined = props.showDeclined ?? internalDeclined
  const today = startOfDay(new Date())
  const visibleEvents = useMemo(() => [...props.events, ...created].filter(event => !deleted.includes(event.id)).map(event => {
    const current = overrides[event.id] ?? event
    const calendar = props.calendars?.find(item => item.id === current.calendarId)
    return calendar && current.decision && current.decision !== 'undecided' ? { ...current, calendarColor: calendar.color } : current
  }).filter(event => showDeclined || (!event.declined && event.status !== 'declined' && event.decision !== 'no')), [props.events, props.calendars, created, deleted, overrides, showDeclined])

  useEffect(() => { stripStartRef.current = stripStart }, [stripStart])

  useEffect(() => {
    setOverrides(current => {
      const next = { ...current }
      for (const event of props.events) if (next[event.id] && parseEventDate(next[event.id].start, next[event.id].allDay).getTime() === parseEventDate(event.start, event.allDay).getTime() && parseEventDate(next[event.id].end, next[event.id].allDay).getTime() === parseEventDate(event.end, event.allDay).getTime() && next[event.id].title === event.title && next[event.id].decision === event.decision && next[event.id].calendarId === event.calendarId && next[event.id].eventColor === event.eventColor) delete next[event.id]
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }, [props.events])

  useEffect(() => {
    setCreated(current => current.filter(draft => !props.events.some(event => event.title === draft.title && parseEventDate(event.start, event.allDay).getTime() === parseEventDate(draft.start, draft.allDay).getTime() && parseEventDate(event.end, event.allDay).getTime() === parseEventDate(draft.end, draft.allDay).getTime())))
    setDeleted(current => current.filter(id => props.events.some(event => event.id === id)))
  }, [props.events])

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
    const leftIndex = Math.round(node.scrollLeft / columnWidth)
    const first = addDays(stripStartRef.current, leftIndex)
    if (dayKey(first) !== dateRef.current) {
      setDate(first)
      reportDays(first, view === 'week' ? 7 : 1)
    }
    if (leftIndex < 7 || leftIndex > 21) {
      const shiftDays = leftIndex < 7 ? -7 : 7
      stripStartRef.current = addDays(stripStartRef.current, shiftDays)
      flushSync(() => setStripStart(stripStartRef.current))
      node.scrollLeft -= shiftDays * columnWidth
    }
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
    if (event?.kind === 'taskDue') return
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

  const taskDragOver = (e: ReactDragEvent<HTMLElement>, key: string, minutes?: number) => {
    if (!props.onTaskDrop || !Array.from(e.dataTransfer.types).includes('application/x-kairo-task')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropTarget(current => current?.key === key && current.minutes === minutes ? current : { key, minutes })
  }

  const taskDragLeave = (e: ReactDragEvent<HTMLElement>) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setDropTarget(null)
  }

  const taskDrop = async (e: ReactDragEvent<HTMLElement>, day: Date, minutes: number) => {
    const taskId = e.dataTransfer.getData('application/x-kairo-task')
    if (!taskId || !props.onTaskDrop) return
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const start = addMinutes(day, minutes)
    setDropError('')
    try { await props.onTaskDrop(taskId, start, addMinutes(start, 60)) }
    catch (cause) { setDropError(cause instanceof Error ? cause.message : 'Could not schedule task.') }
  }

  const dropMinute = (e: ReactDragEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(23 * 60, Math.round((e.clientY - box.top) / HOUR_HEIGHT * 4) * 15))
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

  const startDrag = (e: ReactPointerEvent<HTMLElement>, event: CalendarEvent, resize: boolean) => {
    if (!canEdit(event) || !props.onEventChange || e.button !== 0) return
    e.stopPropagation()
    dragRef.current = { event, x: e.clientX, y: e.clientY, resize, moved: false }
    const onMove = (pointer: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = pointer.clientX - drag.x
      const dy = pointer.clientY - drag.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
      drag.moved = true
      const days = drag.resize ? 0 : Math.round(dx / columnWidth)
      const minutes = drag.event.allDay ? 0 : Math.round(dy / HOUR_HEIGHT * 4) * 15
      const originalStart = parseEventDate(drag.event.start, drag.event.allDay)
      const originalEnd = parseEventDate(drag.event.end, drag.event.allDay)
      const start = drag.resize ? originalStart : addMinutes(addDays(originalStart, days), minutes)
      const end = drag.resize ? addMinutes(originalEnd, minutes) : addMinutes(addDays(originalEnd, days), minutes)
      if (end <= addMinutes(start, 15)) return
      drag.changed = { ...drag.event, start: drag.event.allDay ? dayKey(start) : start.toISOString(), end: drag.event.allDay ? dayKey(end) : end.toISOString() }
      setOverrides(current => ({ ...current, [drag.event.id]: drag.changed! }))
    }
    const onEnd = async () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      const drag = dragRef.current
      dragRef.current = null
      if (!drag?.moved || !drag.changed) return
      suppressClickRef.current = true
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
      try { await props.onEventChange?.(drag.changed) }
      catch { setOverrides(current => { const next = { ...current }; delete next[drag.event.id]; return next }) }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  const days = useMemo(() => Array.from({ length: STRIP_DAYS }, (_, i) => addDays(stripStart, i)), [stripStart])
  const monthFirst = new Date(date.getFullYear(), date.getMonth(), 1)
  const monthStart = startOfWeek(monthFirst)
  const monthDays = Array.from({ length: 42 }, (_, i) => addDays(monthStart, i))
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date)

  return <section className="cal-workspace" aria-label="Calendar">
    {props.showToolbar !== false && <header className="cal-toolbar">
      <div className="cal-heading"><h1>{monthLabel}</h1><span className="cal-zone">{props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div>
      <div className="cal-controls">
        <div className="cal-view-menu-wrap">
          <button className="cal-button" type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{view[0].toUpperCase() + view.slice(1)} <IconChevronDown aria-hidden="true" /></button>
          {menuOpen && <div className="cal-view-menu" role="menu">
            {(['day', 'week', 'month'] as const).map(option => <button type="button" role="menuitemradio" aria-checked={view === option} key={option} onClick={() => setView(option)}>{option[0].toUpperCase() + option.slice(1)}{view === option && <span>✓</span>}</button>)}
            <hr />
            <label><input type="checkbox" checked={showDeclined} onChange={e => { if (props.showDeclined === undefined) setInternalDeclined(e.target.checked); props.onShowDeclinedChange?.(e.target.checked) }} /> Show declined</label>
          </div>}
        </div>
        <button type="button" className="cal-button" onClick={jumpToday}>Today</button>
        <button type="button" className="cal-icon-button" aria-label="Previous" onClick={() => navigate(-1)}><IconChevronLeft /></button>
        <button type="button" className="cal-icon-button" aria-label="Next" onClick={() => navigate(1)}><IconChevronRight /></button>
      </div>
    </header>}
    {view === 'month' ? <div className="cal-month">
      <div className="cal-month-head">{WEEKDAYS.map(day => <span key={day}>{day}</span>)}</div>
      <div className="cal-month-grid">{monthDays.map(day => {
        const items = visibleEvents.filter(event => eventIntersectsDay(parseEventDate(event.start, event.allDay), parseEventDate(event.end, event.allDay), day)).sort((a, b) => Number(b.kind === 'taskDue') - Number(a.kind === 'taskDue'))
        const dropKey = `month-${dayKey(day)}`
        return <div key={dayKey(day)} className={`cal-month-day ${day.getMonth() !== date.getMonth() ? 'cal-outside' : ''} ${dropTarget?.key === dropKey ? 'cal-drop-target' : ''}`} onDoubleClick={e => createAt(e.currentTarget, day, 9 * 60, true)} onDragOver={e => taskDragOver(e, dropKey)} onDragLeave={taskDragLeave} onDrop={e => taskDrop(e, day, 9 * 60)}>
          <button type="button" className={`cal-month-date ${sameDay(day, today) ? 'cal-today' : ''}`} onClick={() => { setDate(day); setView('day') }}>{day.getDate()}</button>
          <div className="cal-month-events">{items.slice(0, 4).map(event => <EventCard key={event.id} compact event={event} past={parseEventDate(event.end, event.allDay) < new Date()} onOpen={openEditor} />)}{items.length > 4 && <span className="cal-more">+{items.length - 4} more</span>}</div>
        </div>
      })}</div>
    </div> : <div className="cal-timeline-shell">
      <div className="cal-gutter-head"><span>All-day</span></div>
      <div className="cal-scroll" ref={scroller} onScroll={onScroll}>
        <div className="cal-strip" style={{ width: columnWidth * STRIP_DAYS }}>
          <div className="cal-strip-head">{days.map(day => <div className={`cal-day-head ${sameDay(day, today) ? 'cal-current-day' : ''}`} key={dayKey(day)} style={{ width: columnWidth }}><span>{WEEKDAYS[day.getDay()]}</span><strong>{day.getDate()}</strong></div>)}</div>
          <div className="cal-allday-row">{days.map(day => {
            const dropKey = `all-${dayKey(day)}`
            return <div key={dayKey(day)} className={`cal-allday-cell ${dropTarget?.key === dropKey ? 'cal-drop-target' : ''}`} style={{ width: columnWidth }} onDoubleClick={e => createAt(e.currentTarget, day, 0, true)} onDragOver={e => taskDragOver(e, dropKey)} onDragLeave={taskDragLeave} onDrop={e => taskDrop(e, day, 9 * 60)}>{visibleEvents.filter(event => event.allDay && eventIntersectsDay(parseEventDate(event.start, true), parseEventDate(event.end, true), day)).sort((a, b) => Number(b.kind === 'taskDue') - Number(a.kind === 'taskDue')).slice(0, 2).map(event => <EventCard key={event.id} compact event={event} past={parseEventDate(event.end, true) < new Date()} onOpen={(element, item) => { if (!suppressClickRef.current) openEditor(element, item) }} onPointerDown={startDrag} />)}</div>
          })}</div>
          <div className="cal-time-grid" ref={timeline} style={{ height: HOUR_HEIGHT * 24 }}>
            {days.map(day => {
              const dropKey = `time-${dayKey(day)}`
              return <div className={`cal-time-day ${sameDay(day, today) ? 'cal-current-day' : ''} ${dropTarget?.key === dropKey ? 'cal-drop-target' : ''}`} key={dayKey(day)} style={{ width: columnWidth, '--drop-top': `${(dropTarget?.key === dropKey ? dropTarget.minutes ?? 0 : 0) / 60 * HOUR_HEIGHT}px` } as CSSProperties} onDoubleClick={e => { const box = e.currentTarget.getBoundingClientRect(); const minutes = Math.max(0, Math.min(23 * 60, Math.round((e.clientY - box.top) / HOUR_HEIGHT * 4) * 15)); createAt(e.currentTarget, day, minutes) }} onDragOver={e => taskDragOver(e, dropKey, dropMinute(e))} onDragLeave={taskDragLeave} onDrop={e => taskDrop(e, day, dropMinute(e))}>
              {timedSegments(visibleEvents, day, HOUR_HEIGHT).map(segment => <div key={`${segment.event.id}-${dayKey(day)}`} className="cal-event-position" style={{ top: segment.top, height: segment.height, left: `${segment.left}%`, width: `${segment.width}%` }}>
                <EventCard event={segment.event} past={parseEventDate(segment.event.end) < new Date()} onOpen={(element, event) => { if (!suppressClickRef.current) openEditor(element, event) }} onPointerDown={startDrag} />
              </div>)}
            </div>})}
            {days.some(day => sameDay(day, today)) && <div className="cal-now-line" style={{ left: `${days.findIndex(day => sameDay(day, today)) * columnWidth}px`, top: new Date().getHours() * HOUR_HEIGHT + new Date().getMinutes() / 60 * HOUR_HEIGHT, width: columnWidth }} />}
          </div>
        </div>
      </div>
      <div className="cal-hour-labels">{HOURS.map(hour => <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>{hour === 0 ? '' : formatTime(new Date(2024, 0, 1, hour))}</span>)}</div>
    </div>}
    <button className="cal-mobile-add" type="button" aria-label="New event" onClick={e => createAt(e.currentTarget, date, 9 * 60)}><IconPlus /></button>
    {dropError && <div className="cal-drop-error" role="alert">{dropError}<button type="button" aria-label="Dismiss error" onClick={() => setDropError('')}><IconX /></button></div>}
    {editor && <FloatingPortal><div ref={floating.refs.setFloating} style={floating.floatingStyles} {...getFloatingProps({ className: 'cal-editor', 'aria-label': editor.event ? 'Edit event' : 'New event' })}>
      <div className="cal-editor-head"><strong>{editor.event ? editor.event.kind === 'external' ? 'Maybe event' : 'Event' : 'New event'}</strong><button type="button" aria-label="Close" onClick={() => setEditor(null)}><IconX /></button></div>
      <div className="cal-editor-body">
        <label>Title<input value={form.title} onChange={e => setForm(current => ({ ...current, title: e.target.value }))} readOnly={editor.event?.kind === 'external'} autoFocus /></label>
        <div className="cal-editor-times"><label>Starts<input type="datetime-local" value={form.start} onChange={e => setForm(current => ({ ...current, start: e.target.value }))} readOnly={editor.event?.kind === 'external'} /></label><label>Ends<input type="datetime-local" value={form.end} onChange={e => setForm(current => ({ ...current, end: e.target.value }))} readOnly={editor.event?.kind === 'external'} /></label></div>
        {editor.event?.kind !== 'external' && <label className="cal-checkbox-label"><input type="checkbox" checked={form.allDay} onChange={e => setForm(current => ({ ...current, allDay: e.target.checked }))} /> All day</label>}
        {props.calendars && props.calendars.length > 0 && <label>Calendar<select value={form.calendarId} onChange={e => setForm(current => ({ ...current, calendarId: e.target.value }))}>{props.calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>}
        {editor.event?.kind !== 'external' && <><label>Event color<input type="color" value={safeColor(form.eventColor, safeColor(editor.event?.eventColor, '#7894a8'))} onChange={e => setForm(current => ({ ...current, eventColor: e.target.value }))} /></label><label>Location<input value={form.location} onChange={e => setForm(current => ({ ...current, location: e.target.value }))} /></label><label>Description<textarea rows={3} value={form.description} onChange={e => setForm(current => ({ ...current, description: e.target.value }))} /></label></>}
        {editor.event?.recurring && <p className="cal-editor-note">Recurring events are read-only until instance and series editing are available.</p>}
        {error && <p className="cal-editor-error" role="alert">{error}</p>}
      </div>
      <div className="cal-editor-actions">{editor.event?.kind === 'external' ? <div className="cal-decisions">{(['yes', 'maybe', 'no', 'undecided'] as const).map(decision => <button type="button" key={decision} disabled={busy || !props.onDecisionChange} className={editor.event?.decision === decision ? 'cal-selected' : ''} onClick={() => decide(decision)}>{decision[0].toUpperCase() + decision.slice(1)}</button>)}</div> : <><button type="button" className="cal-save" disabled={busy || !!editor.event && !canEdit(editor.event) || !form.title.trim() || (!editor.event && !props.onEventCreate) || (!!editor.event && !props.onEventChange)} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>{editor.event && <button type="button" className="cal-delete" disabled={busy || !props.onEventDelete || !canEdit(editor.event)} aria-label="Delete event" onClick={remove}><IconTrash /></button>}</>}</div>
    </div></FloatingPortal>}
  </section>
}

export default CalendarWorkspace
