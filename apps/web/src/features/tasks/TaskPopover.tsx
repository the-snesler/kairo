import { FloatingPortal } from '@floating-ui/react'
import { parseISO } from 'date-fns'
import { useEffect, useRef, useState } from 'react'
import IconArrowRight from '~icons/tabler/arrow-right'
import IconCalendar from '~icons/tabler/calendar-event'
import IconCheck from '~icons/tabler/check'
import IconClock from '~icons/tabler/clock'
import IconExternalLink from '~icons/tabler/external-link'
import IconFlag from '~icons/tabler/flag-filled'
import IconHash from '~icons/tabler/hash'
import IconHourglass from '~icons/tabler/hourglass'
import IconLock from '~icons/tabler/lock'
import IconRepeat from '~icons/tabler/repeat'
import IconX from '~icons/tabler/x'
import { dayKey, minuteOfDay } from '../calendar/date'
import { sameDue } from '../calendar/dnd/geometry'
import { DateField, DurationField, EndTimeField, Row, TextField, TimeField, useInspector } from '../inspector/fields'
import type { InspectorAnchor } from '../inspector/fields'
import type { DurationSource, TaskDue, TaskPatch, TaskSummary } from './types'

export type TaskChange = TaskPatch & { durationMinutes?: number | null }

export interface TaskPopoverProps {
  task: TaskSummary
  anchor: InspectorAnchor
  onClose: () => void
  onChange: (patch: TaskChange) => Promise<void>
  canEdit: boolean
}

const SOURCE_LABEL: Record<DurationSource, string> = { user: 'Set by you', ai: 'AI estimate', provider: 'From Todoist', default: 'Default' }
// Todoist API priority 4 is the UI's p1 (urgent).
const PRIORITY_COLOR: Record<number, string> = { 4: '#ff7066', 3: '#ff9a14', 2: '#5297ff' }
const DEFAULT_TIME = 9 * 60

function dueParts(due: TaskDue | null) {
  if (!due) return { date: null, minutes: null }
  if ('date' in due) return { date: parseISO(due.date), minutes: null }
  const date = new Date(due.dateTime)
  return { date, minutes: minuteOfDay(date) }
}

function toDue(date: Date, minutes: number | null): TaskDue {
  return minutes === null ? { date: dayKey(date) } : { dateTime: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes).toISOString() }
}

export function TaskPopover({ task, anchor, onClose, onChange, canEdit }: TaskPopoverProps) {
  const inspector = useInspector(anchor, onClose)
  // Shown optimistically while a save is in flight; reset whenever the task itself changes.
  const [due, setDue] = useState(task.due)
  const [duration, setDuration] = useState(task.durationMinutes)
  const [completing, setCompleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dueKey = JSON.stringify(task.due)
  useEffect(() => { setDue(task.due) }, [dueKey])
  useEffect(() => { setDuration(task.durationMinutes) }, [task.durationMinutes])

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
  const changeDue = (next: TaskDue | null) => {
    if (inflight.current || sameDue(next, task.due)) return
    setDue(next)
    void save({ due: next }).then(ok => { if (!ok) setDue(task.due) })
  }
  const changeDuration = (minutes: number | null) => {
    if (inflight.current || minutes === task.durationMinutes && task.durationSource === 'user') return
    if (minutes !== null) setDuration(minutes)
    void save({ durationMinutes: minutes }).then(ok => { if (!ok) setDuration(task.durationMinutes) })
  }

  const { date, minutes } = dueParts(due)
  const estimated = task.durationSource !== 'user'
  const priority = task.priority > 1 ? 5 - task.priority : null
  return <FloatingPortal>
    <div ref={inspector.ref} style={inspector.style} {...inspector.getFloatingProps({ className: `inspector${busy ? ' is-busy' : ''}`, 'aria-label': 'Task', 'aria-busy': busy })}>
      <div className="insp-head">
        <span className="insp-kind">Task{!canEdit && <small><IconLock /> Read only</small>}</span>
        <button type="button" className="insp-icon-button" aria-label="Close" onClick={inspector.close}><IconX /></button>
      </div>

      <div className="insp-title-wrap">
        <button type="button" className={`insp-check${completing ? ' is-done' : ''}`} role="checkbox" aria-checked={completing} aria-label="Complete task" disabled={locked} onClick={complete}><IconCheck /></button>
        <TextField className={`insp-title${completing ? ' is-done' : ''}`} value={task.title} placeholder="Title" aria-label="Task title" readOnly={!canEdit} disabled={busy}
          onCommit={title => title.trim() && title.trim() !== task.title && void save({ title: title.trim() })} />
      </div>

      <div className="insp-section">
        {date && minutes !== null && <Row icon={<IconClock />}>
          <TimeField minutes={minutes} aria-label="Due time" disabled={locked} onCommit={next => changeDue(toDue(date, next))} />
          <IconArrowRight className="insp-arrow" />
          <EndTimeField startMinutes={minutes} duration={duration} aria-label="End time" disabled={locked} onCommit={length => changeDuration(length)} />
        </Row>}
        <Row icon={minutes === null ? <IconCalendar /> : undefined}>
          <DateField value={date} placeholder="No date" aria-label="Due date" disabled={locked} onCommit={day => changeDue(toDue(day, minutes))} />
        </Row>
        <Row>
          <div className="insp-chips">
            {date && <button type="button" className={`insp-chip${minutes === null ? ' is-on' : ''}`} aria-pressed={minutes === null} disabled={locked}
              onClick={() => changeDue(toDue(date, minutes === null ? DEFAULT_TIME : null))}>All-day</button>}
            {date && <button type="button" className="insp-chip" disabled={locked} onClick={() => changeDue(null)}>Clear date</button>}
            {task.recurring && <span className="insp-chip is-static"><IconRepeat /> Repeats</span>}
          </div>
        </Row>
      </div>

      <div className="insp-section">
        <Row icon={<IconHourglass />}>
          <DurationField minutes={duration} prefix={estimated ? '~' : ''} aria-label="Duration" disabled={locked} onCommit={length => changeDuration(length)} />
          <span className="insp-meta">{SOURCE_LABEL[task.durationSource]}</span>
          {!estimated && <button type="button" className="insp-chip" disabled={locked} onClick={() => changeDuration(null)}>Reset</button>}
        </Row>
      </div>

      {task.description && <div className="insp-section insp-description">
        <TextField multiline value={task.description} aria-label="Description" readOnly onCommit={() => {}} />
      </div>}

      {!canEdit && <p className="insp-note"><IconLock /> Reconnect Todoist to edit tasks</p>}
      {error && <p className="insp-error" role="alert">{error}</p>}

      <div className="insp-foot">
        <div className="insp-foot-meta">
          {task.projectName && <span title={task.projectName}><IconHash /><span className="insp-truncate">{task.projectName}</span></span>}
          {priority && <span style={{ color: PRIORITY_COLOR[task.priority], fontWeight: 650 }}><IconFlag /> P{priority}</span>}
          {task.pending && <span><em>Syncing…</em></span>}
        </div>
        {task.url && <a className="insp-link" href={task.url} target="_blank" rel="noreferrer">Open in Todoist <IconExternalLink /></a>}
      </div>
    </div>
  </FloatingPortal>
}
