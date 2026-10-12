import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import IconCalendar from '~icons/tabler/calendar-month'
import IconChevronLeft from '~icons/tabler/chevron-left'
import IconChevronRight from '~icons/tabler/chevron-right'
import IconCircleDashed from '~icons/tabler/circle-dashed'
import IconPlus from '~icons/tabler/plus'
import IconRefresh from '~icons/tabler/refresh'
import IconSettings from '~icons/tabler/settings'
import IconSquareCheck from '~icons/tabler/square-check'
import type { CalendarOption } from '../calendar/types'
import './sidebar.css'

export interface SidebarTask {
  id: string
  title: string
  dueDate?: string | null
  priority?: number
  projectName?: string | null
}

export interface SidebarSource {
  id: string
  name: string
  color?: string | null
  status?: string
}

interface Props {
  selectedDate: Date
  visibleDays: Date[]
  calendars: CalendarOption[]
  visibleCalendarIds: Set<string>
  sources: SidebarSource[]
  tasks: SidebarTask[]
  syncBusy?: boolean
  onDateChange: (date: Date) => void
  onToggleCalendar: (id: string) => void
  onAddFeed: () => void
  onConnectGoogle: () => void
  onSync: () => void
  onSettings: () => void
  onTaskDropStart?: (task: SidebarTask) => void
}

export function Sidebar(props: Props) {
  const [month, setMonth] = useState(startOfMonth(props.selectedDate))
  useEffect(() => {
    const middle = props.visibleDays[Math.floor(props.visibleDays.length / 2)]
    if (middle) setMonth(startOfMonth(middle))
  }, [props.visibleDays])
  const days = useMemo(() => {
    const first = startOfWeek(startOfMonth(month), { weekStartsOn: 1 })
    const last = endOfWeek(endOfMonth(month), { weekStartsOn: 1 })
    const values: Date[] = []
    for (let day = first; day <= last; day = addDays(day, 1)) values.push(day)
    return values
  }, [month])
  const active = new Set(props.visibleDays.map((day) => format(day, 'yyyy-MM-dd')))
  const rangeStart = props.visibleDays[0] && format(props.visibleDays[0], 'yyyy-MM-dd')
  const rangeEnd = props.visibleDays.at(-1) && format(props.visibleDays.at(-1)!, 'yyyy-MM-dd')
  const today = new Date()

  return <aside className="kairo-sidebar">
    <div className="sidebar-brand"><span className="brand-mark"><IconCalendar /></span><span>Kairo</span><button className="icon-button sidebar-settings" aria-label="Settings" onClick={props.onSettings}><IconSettings /></button></div>
    <div className="sidebar-scroll">
      <div className="mini-calendar">
        <div className="mini-month-heading"><strong>{format(month, 'MMMM yyyy')}</strong><div><button aria-label="Previous month" onClick={() => setMonth(subMonths(month, 1))}><IconChevronLeft /></button><button aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><IconChevronRight /></button></div></div>
        <div className="mini-grid mini-weekdays">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((name, i) => <span key={i}>{name}</span>)}</div>
        <div className="mini-grid mini-days">{days.map((day) => {
          const key = format(day, 'yyyy-MM-dd')
          return <button key={key} className={`${active.has(key) ? 'in-range' : ''} ${key === rangeStart ? 'range-start' : ''} ${key === rangeEnd ? 'range-end' : ''} ${isSameDay(day, today) ? 'today' : ''} ${isSameMonth(day, month) ? '' : 'out-month'}`} onClick={() => props.onDateChange(day)} aria-label={format(day, 'EEEE, MMMM d, yyyy')} aria-current={isSameDay(day, today) ? 'date' : undefined}>{format(day, 'd')}</button>
        })}</div>
      </div>

      <section className="sidebar-section"><div className="sidebar-section-heading"><span>Calendars</span><button aria-label="Connect Google Calendar" title="Connect Google Calendar" onClick={props.onConnectGoogle}><IconPlus /></button></div>
        {props.calendars.length ? props.calendars.map((calendar) => <label className="calendar-toggle" key={calendar.id}><input type="checkbox" checked={props.visibleCalendarIds.has(calendar.id)} onChange={() => props.onToggleCalendar(calendar.id)} /><span className="calendar-check" style={{ '--swatch': calendar.color } as React.CSSProperties} /><span title={calendar.name}>{calendar.name}</span></label>) : <button className="sidebar-empty-action" onClick={props.onConnectGoogle}><IconPlus /> Connect Google Calendar</button>}
      </section>

      <section className="sidebar-section"><div className="sidebar-section-heading"><span>Maybe feeds</span><button aria-label="Add ICS feed" title="Add ICS feed" onClick={props.onAddFeed}><IconPlus /></button></div>
        {props.sources.length ? props.sources.map((source) => <div className="source-row" key={source.id}><IconCircleDashed style={{ color: source.color || '#8fc6ec' }} /><span title={source.name}>{source.name}</span>{source.status === 'error' && <span className="source-error" title="Sync error">!</span>}</div>) : <button className="sidebar-empty-action" onClick={props.onAddFeed}><IconPlus /> Add an ICS feed</button>}
      </section>

      <section className="sidebar-section tasks-section"><div className="sidebar-section-heading"><span>Tasks</span><IconSquareCheck className="section-heading-icon" /></div>
        {props.tasks.length ? props.tasks.map((task) => <div className="sidebar-task" key={task.id} draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-kairo-task', task.id); event.dataTransfer.effectAllowed = 'copy'; props.onTaskDropStart?.(task) }}><span className="task-circle" /><span className="task-text"><strong>{task.title}</strong><small>{task.projectName || 'Todoist'}{task.dueDate ? ` · Due ${format(new Date(task.dueDate), 'MMM d')}` : ''}</small></span></div>) : <p className="sidebar-hint">Your open Todoist tasks will appear here. Drag a task onto the calendar to reserve time for it.</p>}
      </section>
    </div>
    <div className="sidebar-footer"><button onClick={props.onSync} disabled={props.syncBusy}><IconRefresh className={props.syncBusy ? 'spin' : ''} /> {props.syncBusy ? 'Syncing…' : 'Sync now'}</button></div>
  </aside>
}
