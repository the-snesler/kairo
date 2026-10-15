// Pure RRULE helpers shared by the browser and the server. Keep this file dependency-free.

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export interface RecurrenceRule {
  freq: Frequency
  interval: number // >= 1
  byDay?: { day: Weekday; nth?: number }[] // nth (1..4 or -1) only meaningful for MONTHLY
  byMonthDay?: number[]
  byMonth?: number[]
  until?: string // RRULE form: 'YYYYMMDD' (all-day) or 'YYYYMMDDTHHMMSSZ'
  count?: number
  wkst?: Weekday
}
export interface ParsedRecurrence {
  rule: RecurrenceRule | null // null if the RRULE uses parts we don't model
  supported: boolean // false when rule is null, there are several RRULEs, or unknown RRULE parts exist
  extra: string[] // non-RRULE lines (EXDATE, RDATE, ...) preserved verbatim
  raw: string[]
}
export interface RecurrencePreset {
  key: string
  label: string
  hint?: string
  rule: RecurrenceRule | null
}

const DAYS: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const WEEK_ORDER: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR']
const DAY_NAMES: Record<Weekday, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const FREQS: Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
const UNITS: Record<Frequency, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }

const isWeekday = (value: string): value is Weekday => (DAYS as string[]).includes(value)
const intList = (value: string, min: number, max: number) => {
  const parts = value.split(',').map(Number)
  return parts.every((n) => Number.isInteger(n) && n !== 0 && n >= min && n <= max) ? parts : null
}

function parseRule(body: string): RecurrenceRule | null {
  const parts = new Map<string, string>()
  for (const part of body.split(';')) {
    if (!part) continue
    const eq = part.indexOf('=')
    if (eq < 1) return null
    const key = part.slice(0, eq).trim().toUpperCase()
    if (parts.has(key)) return null
    parts.set(key, part.slice(eq + 1).trim())
  }
  const freq = parts.get('FREQ')?.toUpperCase()
  if (!freq || !(FREQS as string[]).includes(freq)) return null
  const rule: RecurrenceRule = { freq: freq as Frequency, interval: 1 }
  for (const [key, value] of parts) {
    if (key === 'FREQ') continue
    if (key === 'INTERVAL') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) return null
      rule.interval = n
    } else if (key === 'BYDAY') {
      const byDay: NonNullable<RecurrenceRule['byDay']> = []
      for (const item of value.toUpperCase().split(',')) {
        const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(item)
        if (!match || !isWeekday(match[2])) return null
        const nth = match[1] === undefined ? undefined : Number(match[1])
        if (nth !== undefined && (nth === 0 || Math.abs(nth) > 53)) return null
        byDay.push(nth === undefined ? { day: match[2] } : { day: match[2], nth })
      }
      rule.byDay = byDay
    } else if (key === 'BYMONTHDAY') {
      const list = intList(value, -31, 31)
      if (!list) return null
      rule.byMonthDay = list
    } else if (key === 'BYMONTH') {
      const list = intList(value, 1, 12)
      if (!list) return null
      rule.byMonth = list
    } else if (key === 'UNTIL') {
      if (!/^\d{8}(T\d{6}Z?)?$/i.test(value)) return null
      rule.until = value.toUpperCase()
    } else if (key === 'COUNT') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) return null
      rule.count = n
    } else if (key === 'WKST') {
      const day = value.toUpperCase()
      if (!isWeekday(day)) return null
      rule.wkst = day
    } else return null
  }
  if (rule.until && rule.count) return null
  return rule
}

/** Parses Google's `recurrence` array. Returns null when there is no RRULE at all. */
export function parseRecurrence(lines: readonly string[] | null | undefined): ParsedRecurrence | null {
  if (!lines?.length) return null
  const rrules: string[] = []
  const extra: string[] = []
  for (const line of lines) {
    if (/^RRULE:/i.test(line.trim())) rrules.push(line.trim().slice(6))
    else extra.push(line)
  }
  if (!rrules.length) return null
  const rule = parseRule(rrules[0])
  const supported = rule !== null && rrules.length === 1 && !extra.some((line) => /^EXRULE[:;]/i.test(line.trim()))
  return { rule, supported, extra, raw: [...lines] }
}

const formatDay = ({ day, nth }: { day: Weekday; nth?: number }) => `${nth ?? ''}${day}`

export function formatRecurrence(rule: RecurrenceRule, extra: readonly string[] = []): string[] {
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.map(formatDay).join(',')}`)
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`)
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`)
  if (rule.until) parts.push(`UNTIL=${rule.until}`)
  else if (rule.count) parts.push(`COUNT=${rule.count}`)
  if (rule.wkst) parts.push(`WKST=${rule.wkst}`)
  return [`RRULE:${parts.join(';')}`, ...extra]
}

const ordinal = (n: number): string => {
  if (n === -1) return 'last'
  if (n < 0) return `${ordinal(-n)} to last`
  const mod = n % 100
  const suffix = mod >= 11 && mod <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${suffix}`
}

/** Which occurrence of its weekday `date` is within its month (local time). */
export function nthWeekday(date: Date): { day: Weekday; nth: number; last: boolean } {
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  return {
    day: DAYS[date.getDay()],
    nth: Math.ceil(date.getDate() / 7),
    last: date.getDate() + 7 > daysInMonth,
  }
}

export function presetsFor(start: Date): RecurrencePreset[] {
  const day = DAYS[start.getDay()]
  const date = start.getDate()
  const { nth } = nthWeekday(start)
  const monthlyNth = nth === 5 ? -1 : nth
  const on = `on ${DAY_NAMES[day]}`
  return [
    { key: 'none', label: 'Does not repeat', rule: null },
    { key: 'daily', label: 'Every day', rule: { freq: 'DAILY', interval: 1 } },
    {
      key: 'weekdays',
      label: 'Every weekday',
      hint: 'Mon–Fri',
      rule: { freq: 'WEEKLY', interval: 1, byDay: WEEKDAYS.map((d) => ({ day: d })) },
    },
    { key: 'weekly', label: 'Every week', hint: on, rule: { freq: 'WEEKLY', interval: 1, byDay: [{ day }] } },
    { key: 'biweekly', label: 'Every 2 weeks', hint: on, rule: { freq: 'WEEKLY', interval: 2, byDay: [{ day }] } },
    {
      key: 'monthly-day',
      label: 'Every month',
      hint: `on the ${ordinal(date)}`,
      rule: { freq: 'MONTHLY', interval: 1, byMonthDay: [date] },
    },
    {
      key: 'monthly-nth',
      label: 'Every month',
      hint: `on the ${ordinal(monthlyNth)} ${DAY_NAMES[day]}`,
      rule: { freq: 'MONTHLY', interval: 1, byDay: [{ day, nth: monthlyNth }] },
    },
    {
      key: 'yearly',
      label: 'Every year',
      hint: `on ${MONTHS[start.getMonth()]} ${date}`,
      rule: { freq: 'YEARLY', interval: 1 },
    },
  ]
}

/** Canonical comparison key for a rule, filling in the parts RRULE derives from DTSTART. Ignores until/count/wkst. */
function canonicalKey(rule: RecurrenceRule, start: Date) {
  let byDay = rule.byDay
  let byMonthDay = rule.byMonthDay
  let byMonth = rule.byMonth
  if (rule.freq === 'WEEKLY' && !byDay?.length) byDay = [{ day: DAYS[start.getDay()] }]
  if (rule.freq === 'MONTHLY' && !byDay?.length && !byMonthDay?.length) byMonthDay = [start.getDate()]
  if (rule.freq === 'YEARLY') {
    if (!byMonth?.length) byMonth = [start.getMonth() + 1]
    if (!byDay?.length && !byMonthDay?.length) byMonthDay = [start.getDate()]
  }
  const sorted = (list: string[] | undefined) => [...new Set(list ?? [])].sort().join(',')
  return [
    rule.freq,
    rule.interval,
    sorted(byDay?.map(formatDay)),
    sorted(byMonthDay?.map(String)),
    sorted(byMonth?.map(String)),
  ].join('|')
}

const findPreset = (rule: RecurrenceRule, start: Date) => {
  const key = canonicalKey(rule, start)
  return presetsFor(start).find((preset) => preset.rule && canonicalKey(preset.rule, start) === key)
}

/** Preset key matching the recurrence, 'none' without recurrence, null for custom rules. */
export function matchPreset(lines: readonly string[] | null | undefined, start: Date): string | null {
  const parsed = parseRecurrence(lines)
  if (!parsed) return 'none'
  if (!parsed.supported || !parsed.rule || parsed.rule.until || parsed.rule.count) return null
  return findPreset(parsed.rule, start)?.key ?? null
}

const listDays = (days: Weekday[]) => {
  const sorted = WEEK_ORDER.filter((d) => days.includes(d))
  return sorted.join() === WEEKDAYS.join() ? 'Mon–Fri' : sorted.map((d) => DAY_NAMES[d]).join(', ')
}
const monthDay = (n: number) => (n === -1 ? 'last day' : n < 0 ? `${ordinal(n)} day` : ordinal(n))

function describeDays(rule: RecurrenceRule): string | undefined {
  const parts: string[] = []
  const plain = rule.byDay?.filter((d) => d.nth === undefined).map((d) => d.day) ?? []
  const nth = rule.byDay?.filter((d) => d.nth !== undefined) ?? []
  const months = rule.byMonth?.map((m) => MONTHS[m - 1])
  if (rule.freq === 'YEARLY' && months?.length === 1 && rule.byMonthDay?.length === 1 && !rule.byDay?.length) {
    return rule.byMonthDay[0] > 0
      ? `on ${months[0]} ${rule.byMonthDay[0]}`
      : `on the ${monthDay(rule.byMonthDay[0])} of ${months[0]}`
  }
  if (nth.length) parts.push(`the ${nth.map((d) => `${ordinal(d.nth!)} ${DAY_NAMES[d.day]}`).join(', ')}`)
  if (rule.byMonthDay?.length) parts.push(`the ${rule.byMonthDay.map(monthDay).join(', ')}`)
  if (plain.length)
    parts.push(rule.freq === 'MONTHLY' || rule.freq === 'YEARLY' ? `every ${listDays(plain)}` : listDays(plain))
  let text = parts.length ? `on ${parts.join(', ')}` : ''
  if (months?.length) text = `${text}${text ? ' ' : ''}in ${months.join(', ')}`
  return text || undefined
}

function describeEnd(rule: RecurrenceRule, start: Date): string | undefined {
  if (rule.count) return rule.count === 1 ? 'once' : `${rule.count} times`
  if (!rule.until) return undefined
  let year: number, month: number, day: number
  if (rule.until.length === 8) {
    year = Number(rule.until.slice(0, 4))
    month = Number(rule.until.slice(4, 6)) - 1
    day = Number(rule.until.slice(6, 8))
  } else {
    const date = untilToDate(rule.until)
    year = date.getFullYear()
    month = date.getMonth()
    day = date.getDate()
  }
  return `until ${MONTHS[month]} ${day}${year === start.getFullYear() ? '' : `, ${year}`}`
}

export function summarizeRecurrence(
  lines: readonly string[] | null | undefined,
  start: Date,
): { label: string; hint?: string } {
  const parsed = parseRecurrence(lines)
  if (!parsed) return { label: 'Does not repeat' }
  const rule = parsed.rule
  if (!parsed.supported || !rule) return { label: 'Custom' }
  const preset = findPreset(rule, start)
  const unit = UNITS[rule.freq]
  const label = preset?.label ?? (rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`)
  const hint = preset ? preset.hint : describeDays(rule)
  const end = describeEnd(rule, start)
  const full = end ? (hint ? `${hint}, ${end}` : end) : hint
  return full ? { label, hint: full } : { label }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** UNTIL value that ends a series just before the occurrence starting at `originalStart`. */
export function untilBefore(originalStart: string, allDay: boolean): string {
  if (allDay) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(originalStart)
    if (!match) throw new Error(`Invalid all-day date: ${originalStart}`)
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1))
    return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
  }
  const time = new Date(originalStart).getTime()
  if (Number.isNaN(time)) throw new Error(`Invalid date-time: ${originalStart}`)
  return new Date(time - 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')
}

/**
 * Parses an UNTIL value. The date form ('YYYYMMDD') maps to the end of that day in UTC (23:59:59Z) so the
 * last day is included regardless of timezone; the date-time form is read as UTC (with or without the 'Z').
 */
export function untilToDate(until: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/i.exec(until)
  if (!match) throw new Error(`Invalid UNTIL: ${until}`)
  const [y, m, d] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  if (match[4] === undefined) return new Date(Date.UTC(y, m, d, 23, 59, 59))
  return new Date(Date.UTC(y, m, d, Number(match[4]), Number(match[5]), Number(match[6])))
}

/** Copy of `rule` with its ending replaced; null removes both UNTIL and COUNT. */
export function withEnd(rule: RecurrenceRule, end: { until?: string; count?: number } | null): RecurrenceRule {
  const { until: _until, count: _count, ...rest } = rule
  if (end?.until) return { ...rest, until: end.until }
  if (end?.count) return { ...rest, count: end.count }
  return rest
}
