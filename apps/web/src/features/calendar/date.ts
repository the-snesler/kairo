export const DAY_MS = 86_400_000
export const HOUR_HEIGHT = 50

export function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

export function addDays(value: Date, days: number): Date {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

export function startOfWeek(value: Date): Date {
  return addDays(startOfDay(value), -value.getDay())
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function parseEventDate(value: string, allDay?: boolean): Date {
  if (allDay && /^\d{4}-\d\d-\d\d$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day)
  }
  return new Date(value)
}

export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
}

function shortTimeParts(date: Date): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: date.getMinutes() ? '2-digit' : undefined,
  }).formatToParts(date)
}

/** Like formatTime, but drops ":00" on the hour ("4 PM"). */
export function formatShortTime(date: Date): string {
  return shortTimeParts(date)
    .map((part) => part.value)
    .join('')
}

/** Compact range such as "4–5:15 PM", omitting the first day period when both ends share it. */
export function formatTimeRange(start: Date, end: Date): string {
  const startParts = shortTimeParts(start)
  const endParts = shortTimeParts(end)
  const period = (parts: Intl.DateTimeFormatPart[]) => parts.find((part) => part.type === 'dayPeriod')?.value
  const trimmed =
    period(startParts) !== undefined && period(startParts) === period(endParts)
      ? startParts
          .filter((part) => part.type !== 'dayPeriod')
          .map((part) => part.value)
          .join('')
          .trim()
      : formatShortTime(start)
  return `${trimmed}–${formatShortTime(end)}`
}

export function formatDateTimeLocal(date: Date): string {
  return `${dayKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function eventIntersectsDay(start: Date, end: Date, day: Date): boolean {
  return start < addDays(day, 1) && end > day
}
