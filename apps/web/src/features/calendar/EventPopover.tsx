import {
  formatRecurrence,
  matchPreset,
  parseRecurrence,
  presetsFor,
  summarizeRecurrence,
} from '@kairo/integrations/recurrence'
import { differenceInCalendarDays } from 'date-fns'
import { FloatingPortal } from '@floating-ui/react'
import { useRef, useState } from 'react'
import IconArrowRight from '~icons/tabler/arrow-right'
import IconCalendar from '~icons/tabler/calendar-event'
import IconChevronDown from '~icons/tabler/chevron-down'
import IconChevronLeft from '~icons/tabler/chevron-left'
import IconChevronRight from '~icons/tabler/chevron-right'
import IconClock from '~icons/tabler/clock'
import IconLock from '~icons/tabler/lock'
import IconMapPin from '~icons/tabler/map-pin'
import IconPalette from '~icons/tabler/palette'
import IconRepeat from '~icons/tabler/repeat'
import IconRepeatOff from '~icons/tabler/repeat-off'
import IconTrash from '~icons/tabler/trash'
import IconX from '~icons/tabler/x'
import { Combo, DateField, EndTimeField, Row, TextField, TimeField, useInspector } from '../inspector/fields'
import type { ComboOption, InspectorAnchor } from '../inspector/fields'
import { formatDuration } from '../tasks/grouping'
import { addDays, dayKey, minuteOfDay, parseEventDate, startOfDay } from './date'
import { RecurrenceDialog } from './RecurrenceDialog'
import { EVENT_COLORS } from './recurring'
import type { CalendarEvent, CalendarOption, EventDecision } from './types'

export type EventDraft = Omit<CalendarEvent, 'id'>

export interface EventPopoverProps {
  /** The event as currently shown on the calendar, or null while creating `draft`. */
  event: CalendarEvent | null
  draft: EventDraft | null
  anchor: InspectorAnchor
  calendars: CalendarOption[]
  /** Whether `event` can be edited; edits are saved as they are made. */
  editable: boolean
  onClose: () => void
  onChange: (event: CalendarEvent) => void
  onDraftChange: (draft: EventDraft) => void
  onCreate?: (draft: EventDraft) => Promise<void>
  /** Creates a task from a draft whose kind is 'task'. */
  onCreateTask?: (draft: EventDraft) => Promise<void>
  onDelete?: (event: CalendarEvent) => Promise<void>
  /** Deleting an occurrence of a series asks for a scope instead of deleting right away. */
  onDeleteOccurrence?: (event: CalendarEvent) => void
  onNavigateOccurrence?: (event: CalendarEvent, direction: 'prev' | 'next') => void
  onDecide?: (event: CalendarEvent, decision: EventDecision) => Promise<void>
}

const DECISIONS: [EventDecision, string][] = [
  ['yes', 'Yes'],
  ['maybe', 'Maybe'],
  ['no', 'No'],
  ['undecided', 'Undecided'],
]

type DraftKind = 'google' | 'task'
const DRAFT_KINDS: ComboOption<DraftKind>[] = [
  { key: 'google', label: 'New event', value: 'google' },
  { key: 'task', label: 'New task', value: 'task' },
]

const atMinute = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes)
const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000)

export function EventPopover(props: EventPopoverProps) {
  const { event, draft, calendars } = props
  const value = (event ?? draft)!
  const external = event?.kind === 'external'
  // Task drafts become a task with a due date (and length, when timed) rather than a calendar event.
  const isTask = draft?.kind === 'task'
  const editable = draft ? !!(isTask ? props.onCreateTask : props.onCreate) : props.editable
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [customRepeat, setCustomRepeat] = useState(false)
  const inspector = useInspector(props.anchor, props.onClose)

  const start = parseEventDate(value.start, value.allDay)
  const end = parseEventDate(value.end, value.allDay)
  const duration = Math.round((end.getTime() - start.getTime()) / 60_000)
  const lastDay = value.allDay ? addDays(end, -1) : startOfDay(addMinutes(end, -1))
  const days = differenceInCalendarDays(lastDay, start) + 1
  // Remembers the times to restore when All-day is switched back off.
  const timed = useRef(value.allDay ? { minutes: 9 * 60, duration: 60 } : { minutes: minuteOfDay(start), duration })
  if (!value.allDay) timed.current = { minutes: minuteOfDay(start), duration }

  const update = (patch: Partial<CalendarEvent>) => {
    if (!editable) return
    setError('')
    if (event) props.onChange({ ...event, ...patch })
    else props.onDraftChange({ ...value, ...patch })
  }
  const moveStart = (next: Date) => update({ start: next.toISOString(), end: addMinutes(next, duration).toISOString() })
  const setStartDate = (day: Date) =>
    value.allDay
      ? update({ start: dayKey(day), end: dayKey(addDays(day, days)) })
      : moveStart(atMinute(day, minuteOfDay(start)))
  const setEndDate = (day: Date) => {
    if (value.allDay)
      return update(
        day < start ? { start: dayKey(day), end: dayKey(addDays(day, 1)) } : { end: dayKey(addDays(day, 1)) },
      )
    const next = atMinute(day, minuteOfDay(end))
    if (next <= start) return setError('End must be after start.')
    update({ end: next.toISOString() })
  }
  const toggleAllDay = () => {
    if (value.allDay) {
      const next = atMinute(start, timed.current.minutes)
      update({
        allDay: false,
        start: next.toISOString(),
        end: addMinutes(next, Math.min(timed.current.duration, 24 * 60)).toISOString(),
      })
    } else update({ allDay: true, start: dayKey(start), end: dayKey(addDays(lastDay, 1)) })
  }

  const run = async (action: () => Promise<void>, fallback: string, closeAfter = false) => {
    setBusy(true)
    setError('')
    try {
      await action()
      if (closeAfter) props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback)
    } finally {
      setBusy(false)
    }
  }
  const create = () => {
    const action = isTask ? props.onCreateTask : props.onCreate
    if (draft && action && draft.title.trim() && !busy)
      void run(
        () => action({ ...draft, title: draft.title.trim() }),
        isTask ? 'Could not create task.' : 'Could not create event.',
        isTask,
      )
  }
  const setDraftKind = (kind: DraftKind) => {
    if (!draft || kind === draft.kind) return
    setError('')
    // Tasks don't repeat from here; a dropped rule isn't brought back when switching back to an event.
    props.onDraftChange({ ...draft, kind, ...(kind === 'task' ? { recurrence: undefined } : {}) })
  }

  const locked = !editable || busy
  const calendar = calendars.find((item) => item.id === value.calendarId)
  const color = value.eventColor ?? calendar?.color
  const preset = EVENT_COLORS.find(([, hex]) => hex === color?.toLowerCase())
  const colorName =
    preset?.[0] ?? (color?.toLowerCase() === calendar?.color.toLowerCase() ? 'Calendar color' : 'Custom color')
  const calendarOptions = calendars.map((item) => ({ key: item.id, label: item.name, swatch: item.color, value: item }))
  const colorOptions = EVENT_COLORS.map(([name, hex]) => ({ key: hex, label: name, swatch: hex, value: hex }))
  const kind = draft ? (isTask ? 'New task' : 'New event') : external ? 'Maybe event' : 'Event'
  const span = !isTask && days > 1

  const repeat = summarizeRecurrence(value.recurrence, start)
  const repeatKey = matchPreset(value.recurrence, start) ?? 'current'
  const extra = parseRecurrence(value.recurrence)?.extra ?? []
  const repeatOptions: ComboOption<string[] | 'custom'>[] = [
    ...presetsFor(start).map((preset) => ({
      key: preset.key,
      label: preset.label,
      hint: preset.hint,
      value: preset.rule ? formatRecurrence(preset.rule, extra) : [],
    })),
    ...(repeatKey === 'current' ? [{ key: 'current', ...repeat, value: value.recurrence ?? [] }] : []),
    { key: 'custom', label: 'Custom…', value: 'custom' as const },
  ]
  const showRepeat = !external && !isTask && (editable || !!value.recurrence?.length || !!value.recurring)

  return (
    <FloatingPortal>
      <div
        ref={inspector.ref}
        style={inspector.style}
        {...inspector.getFloatingProps({
          className: `inspector${busy ? ' is-busy' : ''}`,
          'aria-label': kind,
          'aria-busy': busy,
        })}
      >
        <div className="insp-head">
          <span className="insp-kind">
            {draft && props.onCreate && props.onCreateTask ? (
              <span className="insp-kind-picker">
                <Combo
                  className="insp-kind-select"
                  display={kind}
                  aria-label="Create"
                  options={DRAFT_KINDS}
                  selectedKey={isTask ? 'task' : 'google'}
                  disabled={busy}
                  onCommit={setDraftKind}
                />
                <IconChevronDown aria-hidden="true" />
              </span>
            ) : (
              kind
            )}
            {event && !editable && !external && (
              <small>
                <IconLock /> Read only
              </small>
            )}
          </span>
          {event && !external && (props.onDelete || (event.series && props.onDeleteOccurrence)) && (
            <button
              type="button"
              className="insp-icon-button is-danger"
              aria-label="Delete event"
              title="Delete event"
              disabled={locked}
              onClick={() =>
                event.series && props.onDeleteOccurrence
                  ? props.onDeleteOccurrence(event)
                  : void run(() => props.onDelete!(event), 'Could not delete event.', true)
              }
            >
              <IconTrash />
            </button>
          )}
          <button type="button" className="insp-icon-button" aria-label="Close" onClick={inspector.close}>
            <IconX />
          </button>
        </div>

        <div className="insp-title-wrap">
          {draft ? (
            <input
              className="insp-title"
              value={draft.title}
              placeholder="Title"
              aria-label="Title"
              autoFocus
              disabled={busy}
              onChange={(e) => props.onDraftChange({ ...draft, title: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  create()
                }
              }}
            />
          ) : (
            <TextField
              className="insp-title"
              value={value.title}
              placeholder="Title"
              aria-label="Title"
              readOnly={locked}
              onCommit={(title) => title.trim() && update({ title: title.trim() })}
            />
          )}
        </div>

        <div className="insp-section">
          {value.allDay ? (
            <Row icon={<IconCalendar />}>
              <DateField
                value={start}
                aria-label={isTask ? 'Date' : 'Start date'}
                disabled={locked}
                onCommit={setStartDate}
              />
              {!isTask && (
                <>
                  <IconArrowRight className="insp-arrow" />
                  <DateField value={lastDay} aria-label="End date" disabled={locked} onCommit={setEndDate} />
                  {days > 1 && <span className="insp-meta">{days} days</span>}
                </>
              )}
            </Row>
          ) : (
            <>
              <Row icon={<IconClock />}>
                <TimeField
                  minutes={minuteOfDay(start)}
                  aria-label="Start time"
                  disabled={locked}
                  onCommit={(minutes) => moveStart(atMinute(start, minutes))}
                />
                <IconArrowRight className="insp-arrow" />
                <EndTimeField
                  startMinutes={minuteOfDay(start)}
                  duration={duration}
                  aria-label="End time"
                  disabled={locked}
                  onCommit={(length) => update({ end: addMinutes(start, length).toISOString() })}
                />
                <span className="insp-meta">{formatDuration(duration)}</span>
              </Row>
              <Row>
                <DateField
                  value={start}
                  aria-label={span ? 'Start date' : 'Date'}
                  disabled={locked}
                  onCommit={setStartDate}
                />
                {span && (
                  <>
                    <IconArrowRight className="insp-arrow" />
                    <DateField value={lastDay} aria-label="End date" disabled={locked} onCommit={setEndDate} />
                  </>
                )}
              </Row>
            </>
          )}
          <Row>
            <div className="insp-chips">
              <button
                type="button"
                className={`insp-chip${value.allDay ? ' is-on' : ''}`}
                aria-pressed={!!value.allDay}
                disabled={locked}
                onClick={toggleAllDay}
              >
                All-day
              </button>
            </div>
          </Row>
          {showRepeat && (
            <Row icon={value.recurrence?.length || value.recurring ? <IconRepeat /> : <IconRepeatOff />}>
              <Combo
                display={
                  !value.recurrence?.length && value.recurring
                    ? 'Repeats'
                    : repeat.hint
                      ? `${repeat.label} ${repeat.hint}`
                      : repeat.label
                }
                aria-label="Repeat"
                options={repeatOptions}
                selectedKey={repeatKey}
                disabled={locked}
                onCommit={(choice) =>
                  choice === 'custom'
                    ? setCustomRepeat(true)
                    : update({ recurrence: choice.length ? choice : undefined })
                }
              />
              {event?.series && props.onNavigateOccurrence && (
                <span className="insp-occurrence-nav">
                  <button
                    type="button"
                    className="insp-icon-button"
                    aria-label="Previous occurrence"
                    title="Previous occurrence"
                    disabled={busy}
                    onClick={() => props.onNavigateOccurrence!(event, 'prev')}
                  >
                    <IconChevronLeft />
                  </button>
                  <button
                    type="button"
                    className="insp-icon-button"
                    aria-label="Next occurrence"
                    title="Next occurrence"
                    disabled={busy}
                    onClick={() => props.onNavigateOccurrence!(event, 'next')}
                  >
                    <IconChevronRight />
                  </button>
                </span>
              )}
            </Row>
          )}
        </div>

        {!isTask && (!locked || value.location) && (
          <div className="insp-section">
            <Row icon={<IconMapPin />}>
              <TextField
                value={value.location ?? ''}
                placeholder="Location"
                aria-label="Location"
                readOnly={locked}
                onCommit={(location) => update({ location })}
              />
            </Row>
          </div>
        )}

        {(!locked || value.description) && (
          <div className="insp-section insp-description">
            <TextField
              multiline
              value={value.description ?? ''}
              placeholder="Description"
              aria-label="Description"
              readOnly={locked}
              onCommit={(description) => update({ description })}
            />
          </div>
        )}

        {!external && !isTask && calendars.length > 0 && (
          <div className="insp-section">
            <Row icon={<span className="insp-swatch" style={{ background: calendar?.color ?? value.calendarColor }} />}>
              <Combo
                display={calendar?.name ?? 'Calendar'}
                aria-label="Calendar"
                options={calendarOptions}
                selectedKey={calendar?.id}
                disabled={locked}
                onCommit={(item) => update({ calendarId: item.id, calendarColor: item.color })}
              />
            </Row>
            <Row icon={<IconPalette style={{ color }} />}>
              <Combo
                display={colorName}
                aria-label="Event color"
                options={colorOptions}
                selectedKey={preset?.[1]}
                disabled={locked}
                onCommit={(eventColor) => update({ eventColor })}
              />
            </Row>
          </div>
        )}

        {error && (
          <p className="insp-error" role="alert">
            {error}
          </p>
        )}

        {draft && (
          <div className="insp-foot">
            <span className="insp-foot-meta">{busy ? 'Creating…' : 'Press Enter to create'}</span>
            <button
              type="button"
              className="insp-primary"
              disabled={busy || !draft.title.trim() || !editable}
              onClick={create}
            >
              Create
            </button>
          </div>
        )}
        {event && external && (
          <div className="insp-foot">
            <div className="insp-segmented" role="group" aria-label="Attending?">
              {DECISIONS.map(([decision, label]) => (
                <button
                  type="button"
                  key={decision}
                  className={event.decision === decision ? 'is-selected' : ''}
                  aria-pressed={event.decision === decision}
                  disabled={busy || !props.onDecide}
                  onClick={() => void run(() => props.onDecide!(event, decision), 'Could not save decision.')}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {customRepeat && (
        <RecurrenceDialog
          start={start}
          allDay={!!value.allDay}
          lines={value.recurrence}
          onCancel={() => setCustomRepeat(false)}
          onDone={(recurrence) => {
            setCustomRepeat(false)
            update({ recurrence })
          }}
        />
      )}
    </FloatingPortal>
  )
}
