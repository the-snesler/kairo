import { addDays, isValid, parse, startOfDay } from 'date-fns'

export const DAY_MINUTES = 24 * 60

const circular = (a: number, b: number) => { const d = Math.abs(a - b) % DAY_MINUTES; return Math.min(d, DAY_MINUTES - d) }

/**
 * Minute of day for typed times like "3", "3p", "330pm", "15:30", "noon".
 * A bare 1–12 hour has no period, so it resolves to whichever of AM/PM is closer to `reference`.
 */
export function parseTime(text: string, reference = 12 * 60): number | null {
  const value = text.trim().toLowerCase().replace(/\s+|\./g, '')
  if (value === 'noon') return 12 * 60
  if (value === 'midnight') return 0
  const match = /^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/.exec(value)
  if (!match) return null
  const hour = Number(match[1]), minute = match[2] ? Number(match[2]) : 0
  if (minute > 59) return null
  const period = match[3]?.[0]
  if (period) return hour >= 1 && hour <= 12 ? (hour % 12 + (period === 'p' ? 12 : 0)) * 60 + minute : null
  if (hour > 23) return null
  // "0", "13"–"23" and zero-padded hours ("09") are unambiguous 24-hour times.
  if (hour === 0 || hour > 12 || match[1].startsWith('0')) return hour * 60 + minute
  const am = (hour % 12) * 60 + minute
  return circular(am, reference) <= circular(am + 720, reference) ? am : am + 720
}

/** Minutes for typed durations like "45", "45m", "1h", "1.5h", "1h30", "1:30". Bare numbers are minutes. */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, '')
  const clock = /^(\d+):(\d{2})$/.exec(value)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])
  const match = /^(?:(\d+(?:\.\d+)?)h[a-z]*)?(?:(\d+)(?:m[a-z]*)?)?$/.exec(value)
  if (!match || (!match[1] && !match[2])) return null
  return Math.round(Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0))
}

const DATE_FORMATS = ['yyyy-MM-dd', 'M/d/yyyy', 'M/d/yy', 'M/d', 'MMM d yyyy', 'MMM d', 'MMMM d yyyy', 'MMMM d', 'd MMM', 'd MMMM', 'EEE MMM d yyyy', 'EEE MMM d', 'EEEE MMMM d', 'EEE', 'EEEE']
const WEEKDAY_ONLY = new Set(['EEE', 'EEEE'])

/** Local midnight for typed dates like "oct 20", "10/20", "tomorrow" or "fri" (the next Friday). */
export function parseDate(text: string, today = new Date()): Date | null {
  const value = text.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ')
  const base = startOfDay(today)
  if (value === 'today' || value === 'tod') return base
  if (value === 'tomorrow' || value === 'tom') return addDays(base, 1)
  if (value === 'yesterday') return addDays(base, -1)
  for (const format of DATE_FORMATS) {
    const date = parse(value, format, base)
    if (!isValid(date) || date.getFullYear() < 1970) continue
    if (WEEKDAY_ONLY.has(format)) return addDays(base, (date.getDay() - base.getDay() + 7) % 7 || 7)
    return startOfDay(date)
  }
  return null
}
