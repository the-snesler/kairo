import assert from 'node:assert/strict'
import test from 'node:test'
import type { GoogleEvent } from './index.js'
import {
  planRecurringDelete,
  planRecurringEdit,
  shiftRule,
  untilAs,
  type SeriesOperation,
  type SeriesPlanInput,
} from './series.js'

const tz = 'America/Los_Angeles'
const at = (dateTime: string) => ({ dateTime, timeZone: tz })
// Weekly on Fridays 13:20–14:20 Pacific, from Fri Oct 2 2026.
const master: GoogleEvent = {
  id: 'm',
  etag: '"m1"',
  summary: 'Standup',
  location: 'Room 1',
  attendees: [{ email: 'a@example.test' }],
  start: at('2026-10-02T13:20:00-07:00'),
  end: at('2026-10-02T14:20:00-07:00'),
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'],
}
const occurrence = (date: string, offset = '-07:00', extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: `m_${date.replaceAll('-', '')}`,
  etag: `"${date}"`,
  recurringEventId: 'm',
  originalStartTime: at(`${date}T13:20:00${offset}`),
  start: at(`${date}T13:20:00${offset}`),
  end: at(`${date}T14:20:00${offset}`),
  summary: 'Standup',
  ...extra,
})
const moved = occurrence('2026-10-09', '-07:00', {
  summary: 'Moved',
  start: at('2026-10-10T10:00:00-07:00'),
  end: at('2026-10-10T11:00:00-07:00'),
})
const cancelled = occurrence('2026-10-23', '-07:00', { status: 'cancelled' })
const afterDst = occurrence('2026-11-06', '-08:00', { summary: 'Retro' })
const base = (instance: GoogleEvent, overrides: Partial<SeriesPlanInput> = {}): SeriesPlanInput => ({
  calendarId: 'cal',
  master,
  instance,
  exceptions: [moved, cancelled, afterDst],
  timeZone: tz,
  ...overrides,
})
const ops = (list: SeriesOperation[]) => list.map((item) => [item.op, 'eventId' in item ? item.eventId : null])

test('this event patches only the instance, with its etag and zone', () => {
  const instance = occurrence('2026-10-16')
  const plan = planRecurringEdit({
    ...base(instance),
    scope: 'this',
    patch: { title: 'Solo', start: '2026-10-16T21:00:00Z', end: '2026-10-16T22:30:00Z' },
  })
  assert.deepEqual(plan, [
    {
      op: 'patch',
      calendarId: 'cal',
      eventId: 'm_20261016',
      etag: '"2026-10-16"',
      body: {
        summary: 'Solo',
        start: at('2026-10-16T14:00:00-07:00'),
        end: at('2026-10-16T15:30:00-07:00'),
      },
    },
  ])
  assert.throws(() =>
    planRecurringEdit({ ...base(instance), scope: 'this', patch: { recurrence: ['RRULE:FREQ=DAILY'] } }),
  )
  assert.throws(() => planRecurringEdit({ ...base(instance), scope: 'this', patch: { calendarId: 'other' } }))
  assert.throws(() => planRecurringEdit({ ...base(instance), scope: 'this', patch: { allDay: true } }))
  assert.deepEqual(planRecurringEdit({ ...base(instance), scope: 'this', patch: { calendarId: 'cal' } }), [])
})

test('all events moved Fri→Mon re-derives BYDAY and overwrites edited occurrences across DST', () => {
  const plan = planRecurringEdit({
    ...base(occurrence('2026-10-16')),
    scope: 'all',
    patch: { start: '2026-10-19T09:00:00-07:00', end: '2026-10-19T10:00:00-07:00' },
  })
  assert.deepEqual(plan, [
    {
      op: 'patch',
      calendarId: 'cal',
      eventId: 'm',
      etag: '"m1"',
      body: {
        start: at('2026-10-05T09:00:00-07:00'),
        end: at('2026-10-05T10:00:00-07:00'),
        // The cancelled Fri Oct 23 occurrence stays cancelled on its new Monday slot.
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=America/Los_Angeles:20261026T090000'],
      },
    },
    {
      op: 'patch',
      calendarId: 'cal',
      eventId: moved.id,
      ignoreMissing: true,
      body: { start: at('2026-10-12T09:00:00-07:00'), end: at('2026-10-12T10:00:00-07:00') },
    },
    {
      op: 'patch',
      calendarId: 'cal',
      eventId: afterDst.id,
      ignoreMissing: true,
      body: { start: at('2026-11-09T09:00:00-08:00'), end: at('2026-11-09T10:00:00-08:00') },
    },
  ])
})

test('all events copies changed fields to exceptions and moves calendars first', () => {
  const plan = planRecurringEdit({
    ...base(occurrence('2026-10-16')),
    scope: 'all',
    patch: { title: 'Sync', calendarId: 'work', eventColor: '#d50000' },
  })
  assert.deepEqual(ops(plan), [
    ['move', 'm'],
    ['patch', 'm'],
    ['patch', moved.id],
    ['patch', afterDst.id],
  ])
  assert.deepEqual(plan[0], { op: 'move', calendarId: 'cal', eventId: 'm', destinationCalendarId: 'work' })
  assert.ok(plan.slice(1).every((item) => item.calendarId === 'work'))
  assert.deepEqual((plan[1] as { body: unknown }).body, { summary: 'Sync', colorId: '11' })
  assert.deepEqual((plan[2] as { body: unknown }).body, { summary: 'Sync', colorId: '11' })
})

test('all events with a new rule keeps EXDATE lines and adds the zone', () => {
  const withExdate = {
    ...master,
    start: { dateTime: '2026-10-02T13:20:00-07:00' },
    end: { dateTime: '2026-10-02T14:20:00-07:00' },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR', 'EXDATE;TZID=America/Los_Angeles:20261030T132000'],
  }
  const plan = planRecurringEdit({
    ...base(occurrence('2026-10-16'), { master: withExdate, exceptions: [] }),
    scope: 'all',
    patch: { recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', 'EXDATE:20990101T000000Z'] },
  })
  assert.deepEqual(plan, [
    {
      op: 'patch',
      calendarId: 'cal',
      eventId: 'm',
      etag: '"m1"',
      body: {
        recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', 'EXDATE;TZID=America/Los_Angeles:20261030T132000'],
        start: at('2026-10-02T13:20:00-07:00'),
        end: at('2026-10-02T14:20:00-07:00'),
      },
    },
  ])
  // Moving the series shifts its EXDATEs with it.
  const shifted = planRecurringEdit({
    ...base(occurrence('2026-10-16'), { master: withExdate, exceptions: [] }),
    scope: 'all',
    patch: { start: '2026-10-16T15:00:00-07:00', end: '2026-10-16T16:00:00-07:00' },
  })
  assert.deepEqual((shifted[0] as { body: { recurrence: string[] } }).body.recurrence, [
    'RRULE:FREQ=WEEKLY;BYDAY=FR',
    'EXDATE;TZID=America/Los_Angeles:20261030T150000',
  ])
})

test('series-wide edits of a one-off moved occurrence keep the series on its own slot', () => {
  // Only the end changed: the series keeps Fri 13:20 and takes the new 90-minute length.
  const resized = planRecurringEdit({
    ...base(moved),
    scope: 'all',
    patch: { start: '2026-10-10T10:00:00-07:00', end: '2026-10-10T11:30:00-07:00' },
  })
  assert.deepEqual((resized[0] as { body: unknown }).body, {
    start: at('2026-10-02T13:20:00-07:00'),
    end: at('2026-10-02T14:50:00-07:00'),
  })
  // Only the title changed: the new series starts on the occurrence's original Friday slot.
  const renamed = planRecurringEdit({ ...base(moved), scope: 'following', patch: { title: 'Renamed' } })
  const created = renamed.at(-1) as Extract<SeriesOperation, { op: 'create' }>
  assert.deepEqual(created.body.start, at('2026-10-09T13:20:00-07:00'))
  assert.deepEqual(created.body.end, at('2026-10-09T14:20:00-07:00'))
  assert.equal(created.body.recurrence?.[0], 'RRULE:FREQ=WEEKLY;BYDAY=FR')
})

test('stop repeating collapses the series onto this occurrence', () => {
  const plan = planRecurringEdit({
    ...base(occurrence('2026-10-16')),
    scope: 'all',
    patch: { recurrence: null, title: 'Once' },
  })
  assert.deepEqual(ops(plan), [
    ['delete', moved.id],
    ['delete', afterDst.id],
    ['patch', 'm'],
  ])
  assert.deepEqual((plan[2] as { body: unknown }).body, {
    summary: 'Once',
    start: at('2026-10-16T13:20:00-07:00'),
    end: at('2026-10-16T14:20:00-07:00'),
    recurrence: [],
  })
})

test('this and following on the first occurrence is all events', () => {
  const first = occurrence('2026-10-02')
  const patch = { title: 'Renamed' }
  assert.deepEqual(
    planRecurringEdit({ ...base(first), scope: 'following', patch }),
    planRecurringEdit({ ...base(first), scope: 'all', patch }),
  )
  assert.deepEqual(planRecurringDelete({ ...base(first), scope: 'following' }), [
    { op: 'delete', calendarId: 'cal', eventId: 'm', etag: '"m1"' },
  ])
})

test('this and following splits the series, reduces COUNT, re-derives BYDAY and keeps cancellations', () => {
  const counted = { ...master, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=10'] }
  const instance = occurrence('2026-10-16')
  const input = base(instance, { master: counted, priorOccurrences: 2 })
  const plan = planRecurringEdit({
    ...input,
    scope: 'following',
    patch: { title: 'New standup', start: '2026-10-19T09:00:00-07:00', end: '2026-10-19T09:30:00-07:00' },
  })
  assert.deepEqual(plan, [
    {
      op: 'patch',
      calendarId: 'cal',
      eventId: 'm',
      etag: '"m1"',
      body: {
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261016T201959Z'],
        start: at('2026-10-02T13:20:00-07:00'),
        end: at('2026-10-02T14:20:00-07:00'),
      },
    },
    { op: 'delete', calendarId: 'cal', eventId: afterDst.id, ignoreMissing: true },
    {
      op: 'create',
      calendarId: 'cal',
      body: {
        summary: 'New standup',
        location: 'Room 1',
        attendees: [{ email: 'a@example.test' }],
        start: at('2026-10-19T09:00:00-07:00'),
        end: at('2026-10-19T09:30:00-07:00'),
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8', 'EXDATE;TZID=America/Los_Angeles:20261026T090000'],
      },
    },
  ])
  assert.throws(() =>
    planRecurringEdit({ ...input, priorOccurrences: undefined, scope: 'following', patch: { title: 'x' } }),
  )

  const single = planRecurringEdit({ ...input, scope: 'following', patch: { recurrence: null, calendarId: 'work' } })
  const created = single.at(-1) as Extract<SeriesOperation, { op: 'create' }>
  assert.equal(created.calendarId, 'work')
  assert.equal(created.body.recurrence, undefined)
  assert.deepEqual(created.body.start, at('2026-10-16T13:20:00-07:00'))
})

test('deletes per scope', () => {
  const instance = occurrence('2026-10-16')
  assert.deepEqual(planRecurringDelete({ ...base(instance), scope: 'this' }), [
    { op: 'delete', calendarId: 'cal', eventId: instance.id, etag: instance.etag },
  ])
  assert.deepEqual(planRecurringDelete({ ...base(instance), scope: 'all' }), [
    { op: 'delete', calendarId: 'cal', eventId: 'm', etag: '"m1"' },
  ])
  assert.deepEqual(ops(planRecurringDelete({ ...base(instance), scope: 'following' })), [
    ['patch', 'm'],
    ['delete', afterDst.id],
  ])
})

test('all-day series split and shift by date', () => {
  const daily: GoogleEvent = {
    id: 'd',
    etag: '"d1"',
    summary: 'Holiday',
    start: { date: '2026-10-01' },
    end: { date: '2026-10-02' },
    recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1'],
  }
  const instance: GoogleEvent = {
    id: 'd_20261101',
    recurringEventId: 'd',
    originalStartTime: { date: '2026-11-01' },
    start: { date: '2026-11-01' },
    end: { date: '2026-11-02' },
  }
  const input: SeriesPlanInput = { calendarId: 'cal', master: daily, instance, exceptions: [], timeZone: tz }
  const plan = planRecurringEdit({ ...input, scope: 'following', patch: { start: '2026-11-03', end: '2026-11-05' } })
  assert.deepEqual(plan[0], {
    op: 'patch',
    calendarId: 'cal',
    eventId: 'd',
    etag: '"d1"',
    body: {
      recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20261031'],
      start: { date: '2026-10-01' },
      end: { date: '2026-10-02' },
    },
  })
  assert.deepEqual(plan[1], {
    op: 'create',
    calendarId: 'cal',
    body: {
      summary: 'Holiday',
      start: { date: '2026-11-03' },
      end: { date: '2026-11-05' },
      recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=3'],
    },
  })
  const timed = planRecurringEdit({
    ...input,
    scope: 'all',
    patch: { allDay: false, start: '2026-11-01T09:00:00-08:00', end: '2026-11-01T10:00:00-08:00' },
  })
  assert.deepEqual((timed[0] as { body: unknown }).body, {
    start: at('2026-10-01T09:00:00-07:00'),
    end: at('2026-10-01T10:00:00-07:00'),
  })
  assert.throws(() => planRecurringEdit({ ...input, scope: 'all', patch: { start: '2026-11-01T09:00:00Z' } }))
})

test('shiftRule re-derives day parts', () => {
  assert.deepEqual(shiftRule({ freq: 'WEEKLY', interval: 1, byDay: [{ day: 'FR' }] }, '2026-10-16', '2026-10-19'), {
    freq: 'WEEKLY',
    interval: 1,
    byDay: [{ day: 'MO' }],
  })
  assert.deepEqual(
    shiftRule({ freq: 'MONTHLY', interval: 1, byDay: [{ day: 'FR', nth: 3 }] }, '2026-10-16', '2026-10-22').byDay,
    [{ day: 'TH', nth: 4 }],
  )
  assert.deepEqual(
    shiftRule({ freq: 'MONTHLY', interval: 1, byDay: [{ day: 'FR', nth: -1 }] }, '2026-10-30', '2026-10-29').byDay,
    [{ day: 'TH', nth: -1 }],
  )
  const daily = { freq: 'DAILY' as const, interval: 1 }
  assert.deepEqual(shiftRule(daily, '2026-10-16', '2026-10-19'), daily)
})

test('UNTIL follows the series type when all-day is toggled', () => {
  const rule = { freq: 'WEEKLY' as const, interval: 1, until: '20261127T075959Z' }
  // 23:59:59 Pacific on Nov 26 is still Nov 26 in the series zone.
  assert.equal(untilAs(rule, true, tz).until, '20261126')
  assert.equal(untilAs({ ...rule, until: '20261126' }, false, tz).until, '20261127T075959Z')
  assert.equal(untilAs(rule, false, tz), rule)

  const limited = { ...master, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261127T075959Z'] }
  const plan = planRecurringEdit({
    ...base(occurrence('2026-10-16'), { master: limited, exceptions: [] }),
    scope: 'all',
    patch: { allDay: true, start: '2026-10-16', end: '2026-10-17' },
  })
  assert.deepEqual((plan[0] as { body: { recurrence: string[] } }).body.recurrence, [
    'RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261126',
  ])
  const split = planRecurringEdit({
    ...base(occurrence('2026-10-16'), { master: limited, exceptions: [] }),
    scope: 'following',
    patch: { allDay: true, start: '2026-10-16', end: '2026-10-17' },
  })
  assert.deepEqual((split.at(-1) as { body: { recurrence: string[] } }).body.recurrence, [
    'RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261126',
  ])
})

test('following with only cancelled occurrences before it acts on the whole series', () => {
  const input = { ...base(occurrence('2026-10-16')), hasEarlierOccurrences: false }
  const patch = { title: 'Renamed' }
  assert.deepEqual(
    planRecurringEdit({ ...input, scope: 'following', patch }),
    planRecurringEdit({ ...input, scope: 'all', patch }),
  )
  assert.deepEqual(planRecurringDelete({ ...input, scope: 'following' }), [
    { op: 'delete', calendarId: 'cal', eventId: 'm', etag: '"m1"' },
  ])
})
