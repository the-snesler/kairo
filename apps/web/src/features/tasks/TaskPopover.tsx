import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react'
import { format } from 'date-fns'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import IconCalendar from '~icons/tabler/calendar-event'
import IconCheck from '~icons/tabler/check'
import IconClock from '~icons/tabler/clock'
import IconExternalLink from '~icons/tabler/external-link'
import IconFlag from '~icons/tabler/flag-filled'
import IconHourglass from '~icons/tabler/hourglass'
import IconRepeat from '~icons/tabler/repeat'
import IconX from '~icons/tabler/x'
import { sameDue } from '../calendar/dnd/geometry'
import { formatDuration } from './grouping'
import type { DurationSource, TaskDue, TaskPatch, TaskSummary } from './types'
import './task-popover.css'

export type TaskChange = TaskPatch & { durationMinutes?: number | null }

export interface TaskPopoverProps {
  task: TaskSummary
  anchor: HTMLElement
  onClose: () => void
  onChange: (patch: TaskChange) => Promise<void>
  canEdit: boolean
}

const PRESETS = [15, 30, 45, 60, 90, 120]
const SOURCE_LABEL: Record<DurationSource, string> = { user: 'Set by you', ai: 'AI estimate', provider: 'From Todoist', default: 'Default' }
// Todoist API priority 4 is the UI's p1 (urgent).
const PRIORITY_COLOR: Record<number, string> = { 4: '#ff7066', 3: '#ff9a14', 2: '#5297ff' }

function dueParts(due: TaskDue | null) {
  if (!due) return { date: '', time: '' }
  if ('date' in due) return { date: due.date, time: '' }
  const d = new Date(due.dateTime)
  return { date: format(d, 'yyyy-MM-dd'), time: format(d, 'HH:mm') }
}

function toDue(date: string, time: string): TaskDue {
  return time ? { dateTime: new Date(`${date}T${time}`).toISOString() } : { date }
}


export function TaskPopover({ task, anchor, onClose, onChange, canEdit }: TaskPopoverProps) {
  const floating = useFloating({ open: true, onOpenChange: open => { if (!open) onClose() }, elements: { reference: anchor }, placement: 'right-start', strategy: 'fixed', middleware: [offset(12), flip({ fallbackPlacements: ['left-start', 'bottom-start'] }), shift({ padding: 12 })], whileElementsMounted: autoUpdate })
  const dismiss = useDismiss(floating.context)
  const role = useRole(floating.context, { role: 'dialog' })
  const { getFloatingProps } = useInteractions([dismiss, role])

  const [title, setTitle] = useState(task.title)
  const [date, setDate] = useState(() => dueParts(task.due).date)
  const [time, setTime] = useState(() => dueParts(task.due).time)
  const [custom, setCustom] = useState('')
  const [completing, setCompleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setTitle(task.title) }, [task.title])
  const dueKey = JSON.stringify(task.due)
  useEffect(() => { const parts = dueParts(task.due); setDate(parts.date); setTime(parts.time) }, [dueKey])

  const locked = !canEdit || busy
  const inflight = useRef(false)
  const save = async (patch: TaskChange) => {
    if (!canEdit || inflight.current) return false
    inflight.current = true; setBusy(true); setError('')
    try { await onChange(patch); return true }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save the task.'); return false }
    finally { inflight.current = false; setBusy(false) }
  }

  const complete = async () => {
    setCompleting(true)
    if (await save({ completed: true })) onClose()
    else setCompleting(false)
  }
  const commitTitle = () => {
    const next = title.trim()
    if (inflight.current) return
    if (!next || next === task.title) return setTitle(task.title)
    void save({ title: next }).then(ok => { if (!ok) setTitle(task.title) })
  }
  const commitDue = (nextDate: string, nextTime: string) => {
    const due = nextDate ? toDue(nextDate, nextTime) : null
    if (inflight.current || sameDue(due, task.due)) return
    void save({ due }).then(ok => { if (!ok) { const parts = dueParts(task.due); setDate(parts.date); setTime(parts.time) } })
  }
  const commitCustom = () => {
    const minutes = Math.round(Number(custom))
    setCustom('')
    if (custom && minutes >= 5 && minutes <= 1440 && minutes !== task.durationMinutes) void save({ durationMinutes: minutes })
  }
  // Enter commits via blur; Escape reverts a dirty field (and only closes the popover when nothing is dirty).
  const keys = (revert: () => void, dirty: boolean) => (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    if (e.key === 'Enter') { e.preventDefault(); input.blur() }
    if (e.key === 'Escape' && dirty) { e.nativeEvent.stopPropagation(); revert(); requestAnimationFrame(() => input.blur()) }
  }

  const priority = task.priority > 1 ? 5 - task.priority : null
  return <FloatingPortal>
    <div ref={floating.refs.setFloating} style={floating.floatingStyles} {...getFloatingProps({ className: `task-popover${busy ? ' is-busy' : ''}`, 'aria-label': 'Task', 'aria-busy': busy })}>
      <div className="task-pop-head">
        <button type="button" className={`task-pop-check${completing ? ' is-done' : ''}`} role="checkbox" aria-checked={completing} aria-label="Complete task" disabled={locked} onClick={complete}><IconCheck /></button>
        <input className={`task-pop-title${completing ? ' is-done' : ''}`} value={title} aria-label="Task title" readOnly={!canEdit} disabled={busy} onChange={e => setTitle(e.target.value)} onBlur={commitTitle}
          onKeyDown={keys(() => setTitle(task.title), title !== task.title)} />
        <button type="button" className="task-pop-close" aria-label="Close" onClick={onClose}><IconX /></button>
      </div>

      <div className="task-pop-body">
        <div className="task-pop-row">
          <IconCalendar className="task-pop-icon" />
          <input type="date" aria-label="Due date" value={date} disabled={locked} onBlur={() => commitDue(date, time)}
            // Typed years fire change per digit (0002, 0020…); only commit plausible dates immediately.
            onChange={e => { const next = e.target.value; setDate(next); if (!next || +next.slice(0, 4) >= 1970) commitDue(next, next ? time : '') }} />
          {date && (time
            ? <span className="task-pop-time"><input type="time" aria-label="Due time" value={time} disabled={locked} onChange={e => setTime(e.target.value)} onBlur={() => commitDue(date, time)}
                onKeyDown={keys(() => setTime(dueParts(task.due).time), time !== dueParts(task.due).time)} />
              <button type="button" className="task-pop-icon-button" aria-label="Remove time" title="Remove time" disabled={locked} onClick={() => { setTime(''); commitDue(date, '') }}><IconX /></button></span>
            : <button type="button" className="task-pop-link" disabled={locked} onClick={() => { setTime('09:00'); commitDue(date, '09:00') }}><IconClock /> Add time</button>)}
          {task.due && <button type="button" className="task-pop-link task-pop-clear" disabled={locked} onClick={() => { setDate(''); setTime(''); commitDue('', '') }}>No date</button>}
        </div>
        {task.recurring && <p className="task-pop-note"><IconRepeat /> Repeats</p>}

        <div className="task-pop-row task-pop-duration">
          <IconHourglass className="task-pop-icon" />
          <div className="task-pop-chips">
            {PRESETS.map(minutes => <button type="button" key={minutes} className={task.durationMinutes === minutes ? 'is-selected' : ''} aria-pressed={task.durationMinutes === minutes} disabled={locked} onClick={() => minutes !== task.durationMinutes && save({ durationMinutes: minutes })}>{formatDuration(minutes)}</button>)}
            <input type="number" min={5} max={1440} step={5} inputMode="numeric" aria-label="Custom duration in minutes" placeholder={PRESETS.includes(task.durationMinutes) ? 'min' : String(task.durationMinutes)} value={custom} disabled={locked}
              onChange={e => setCustom(e.target.value)} onBlur={commitCustom} onKeyDown={keys(() => setCustom(''), !!custom)} />
          </div>
        </div>
        <p className="task-pop-source">
          {task.durationSource === 'user' ? formatDuration(task.durationMinutes) : `~${formatDuration(task.durationMinutes)}`} · {SOURCE_LABEL[task.durationSource]}
          {task.durationSource === 'user' && <button type="button" className="task-pop-link" disabled={locked} onClick={() => save({ durationMinutes: null })}>Reset</button>}
        </p>

        {!canEdit && <p className="task-pop-note">Reconnect Todoist to edit tasks</p>}
        {error && <p className="task-pop-error" role="alert">{error}</p>}
      </div>

      <div className="task-pop-foot">
        {task.projectName && <span className="task-pop-project" title={task.projectName}>{task.projectName}</span>}
        {priority && <span className="task-pop-priority" style={{ color: PRIORITY_COLOR[task.priority] }}><IconFlag /> P{priority}</span>}
        {task.pending && <span className="task-pop-pending">Syncing…</span>}
        {task.url && <a className="task-pop-open" href={task.url} target="_blank" rel="noreferrer">Open in Todoist <IconExternalLink /></a>}
      </div>
    </div>
  </FloatingPortal>
}
