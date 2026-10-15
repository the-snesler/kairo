import { formatRecurrence, nthWeekday, parseRecurrence, untilToDate, withEnd } from '@kairo/integrations/recurrence'
import type { Frequency, RecurrenceRule, Weekday } from '@kairo/integrations/recurrence'
import { useState } from 'react'
import { DateField, Modal } from '../inspector/fields'
import { addDays } from './date'

const DAYS: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const WEEK: [Weekday, string][] = [
  ['MO', 'Mo'],
  ['TU', 'Tu'],
  ['WE', 'We'],
  ['TH', 'Th'],
  ['FR', 'Fr'],
  ['SA', 'Sa'],
  ['SU', 'Su'],
]
const UNITS: [Frequency, string][] = [
  ['DAILY', 'day'],
  ['WEEKLY', 'week'],
  ['MONTHLY', 'month'],
  ['YEARLY', 'year'],
]
const DAY_NAMES: Record<Weekday, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
}
const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th']

type MonthMode = 'day' | 'nth' | 'last'
type EndMode = 'never' | 'on' | 'after'

const pad = (n: number) => String(n).padStart(2, '0')
const clampCount = (value: number) => Math.max(1, Math.min(999, Math.round(value) || 1))

/** UNTIL covering all of `day`: a date for all-day series, otherwise the end of that local day in UTC. */
function untilFor(day: Date, allDay: boolean) {
  if (allDay) return `${day.getFullYear()}${pad(day.getMonth() + 1)}${pad(day.getDate())}`
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59)
  return end
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')
}

function untilDay(until: string) {
  if (until.length === 8)
    return new Date(Number(until.slice(0, 4)), Number(until.slice(4, 6)) - 1, Number(until.slice(6, 8)))
  const date = untilToDate(until)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export interface RecurrenceDialogProps {
  start: Date
  allDay: boolean
  /** Current recurrence lines; non-RRULE lines (EXDATE, ...) are kept. */
  lines: string[] | undefined
  onCancel: () => void
  onDone: (lines: string[]) => void
}

/** "Custom…" repeat editor: every n units, weekdays or monthly mode, and how the series ends. */
export function RecurrenceDialog({ start, allDay, lines, onCancel, onDone }: RecurrenceDialogProps) {
  const parsed = parseRecurrence(lines)
  const rule = parsed?.supported ? parsed.rule : null
  const today = DAYS[start.getDay()]
  const position = nthWeekday(start)
  const [freq, setFreq] = useState<Frequency>(rule?.freq ?? 'WEEKLY')
  const [every, setEvery] = useState(rule?.interval ?? 1)
  const [days, setDays] = useState<Weekday[]>(() => {
    const plain = rule?.freq === 'WEEKLY' ? rule.byDay?.filter((d) => d.nth === undefined).map((d) => d.day) : []
    return plain?.length ? plain : [today]
  })
  const [monthMode, setMonthMode] = useState<MonthMode>(() => {
    const nth = rule?.freq === 'MONTHLY' ? rule.byDay?.[0]?.nth : undefined
    return nth === undefined ? 'day' : position.last && (nth === -1 || position.nth === 5) ? 'last' : 'nth'
  })
  const [endMode, setEndMode] = useState<EndMode>(rule?.until ? 'on' : rule?.count ? 'after' : 'never')
  const [until, setUntil] = useState(() => (rule?.until ? untilDay(rule.until) : addDays(start, 28)))
  const [count, setCount] = useState(rule?.count ?? 4)

  const monthOptions: [MonthMode, string][] = [
    ['day', `on day ${start.getDate()}`],
    ...(position.nth < 5
      ? [['nth', `on the ${ORDINALS[position.nth]} ${DAY_NAMES[today]}`] as [MonthMode, string]]
      : []),
    ...(position.last ? [['last', `on the last ${DAY_NAMES[today]}`] as [MonthMode, string]] : []),
  ]

  const done = () => {
    let next: RecurrenceRule = { freq, interval: clampCount(every) }
    if (freq === 'WEEKLY') next.byDay = WEEK.filter(([day]) => days.includes(day)).map(([day]) => ({ day }))
    if (freq === 'MONTHLY')
      if (monthMode === 'day') next.byMonthDay = [start.getDate()]
      else next.byDay = [{ day: today, nth: monthMode === 'last' ? -1 : position.nth }]
    next = withEnd(
      next,
      endMode === 'on' ? { until: untilFor(until, allDay) } : endMode === 'after' ? { count: clampCount(count) } : null,
    )
    onDone(formatRecurrence(next, parsed?.extra ?? []))
  }

  return (
    <Modal
      aria-label="Repeat"
      className="rec-dialog"
      onDismiss={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !e.nativeEvent.defaultPrevented) {
          e.preventDefault()
          done()
        }
      }}
    >
      <h2 className="rec-title">Repeat</h2>
      <div className="rec-line">
        <span className="rec-label">Every</span>
        <input
          className="rec-input rec-number"
          type="number"
          min={1}
          max={999}
          aria-label="Interval"
          value={every}
          onChange={(e) => setEvery(Number(e.target.value))}
          onBlur={() => setEvery(clampCount(every))}
        />
        <select
          className="rec-input"
          aria-label="Unit"
          value={freq}
          onChange={(e) => setFreq(e.target.value as Frequency)}
        >
          {UNITS.map(([value, unit]) => (
            <option key={value} value={value}>
              {every === 1 ? unit : `${unit}s`}
            </option>
          ))}
        </select>
        {freq === 'MONTHLY' && (
          <select
            className="rec-input"
            aria-label="Day of month"
            value={monthMode}
            onChange={(e) => setMonthMode(e.target.value as MonthMode)}
          >
            {monthOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        )}
      </div>
      {freq === 'WEEKLY' && (
        <div className="rec-line">
          <span className="rec-label">On</span>
          <div className="rec-days" role="group" aria-label="Days of the week">
            {WEEK.map(([day, label]) => {
              const on = days.includes(day)
              return (
                <button
                  type="button"
                  key={day}
                  className={`rec-day${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  aria-label={DAY_NAMES[day]}
                  onClick={() =>
                    setDays((current) =>
                      on ? (current.length > 1 ? current.filter((d) => d !== day) : current) : [...current, day],
                    )
                  }
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <div className="rec-ends" role="radiogroup" aria-label="Ends">
        <span className="rec-label">Ends</span>
        <label className="rec-radio">
          <input type="radio" name="rec-end" checked={endMode === 'never'} onChange={() => setEndMode('never')} />
          <span>Never</span>
        </label>
        <label className="rec-radio">
          <input type="radio" name="rec-end" checked={endMode === 'on'} onChange={() => setEndMode('on')} />
          <span>On</span>
        </label>
        <div className={`rec-end-value${endMode === 'on' ? '' : ' is-inactive'}`} onMouseDown={() => setEndMode('on')}>
          <DateField
            className="rec-input"
            value={until}
            aria-label="End date"
            onCommit={(day) => {
              setUntil(day < start ? start : day)
              setEndMode('on')
            }}
          />
        </div>
        <label className="rec-radio">
          <input type="radio" name="rec-end" checked={endMode === 'after'} onChange={() => setEndMode('after')} />
          <span>After</span>
        </label>
        <div className={`rec-end-value${endMode === 'after' ? '' : ' is-inactive'}`}>
          <input
            className="rec-input rec-number"
            type="number"
            min={1}
            max={999}
            aria-label="Occurrences"
            value={count}
            onFocus={() => setEndMode('after')}
            onChange={(e) => setCount(Number(e.target.value))}
            onBlur={() => setCount(clampCount(count))}
          />
          <span className="rec-meta">{count === 1 ? 'time' : 'times'}</span>
        </div>
      </div>
      <div className="rec-actions">
        <button type="button" className="rec-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="rec-button is-primary" onClick={done}>
          Done
        </button>
      </div>
    </Modal>
  )
}
