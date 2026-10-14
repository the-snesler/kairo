process.env.TZ = 'America/New_York'

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  daysBetween,
  edgeVelocity,
  moveEvent,
  resizeEnd,
  resolveTarget,
  sameDue,
  snap,
  taskDueForTarget,
  timedStart,
  wallClock,
} from './geometry'

const HOUR = 50 // px per hour, as in the calendar

test('snaps to 15 minutes', () => {
  assert.equal(snap(7), 0)
  assert.equal(snap(8), 15)
  assert.equal(snap(52), 45)
  assert.equal(snap(53), 60)
})

test('timed start follows the pointer minus the grab offset', () => {
  // Pointer at 10:00 (500px below the column top), grabbed 30 minutes into the card → starts 9:30.
  assert.equal(timedStart(600, 100, HOUR, 30, 60), 9 * 60 + 30)
  // Scroll is reflected in the zone top: the same pointer with the column scrolled 200px up lands 4 hours later.
  assert.equal(timedStart(600, -100, HOUR, 30, 60), 13 * 60 + 30)
})

test('timed start is clamped so the item fits in the day', () => {
  assert.equal(timedStart(-500, 0, HOUR, 0, 60), 0)
  assert.equal(timedStart(24 * HOUR + 300, 0, HOUR, 0, 60), 23 * 60)
  // A 50 minute item can start no later than 23:00 on the 15 minute grid (23:10 would not be on the grid).
  assert.equal(timedStart(24 * HOUR, 0, HOUR, 0, 50), 23 * 60)
  // Items longer than a day pin to midnight.
  assert.equal(timedStart(10 * HOUR, 0, HOUR, 0, 2000), 0)
})

test('resize end snaps, keeps the minimum duration and stops at midnight', () => {
  assert.equal(resizeEnd(11 * HOUR + 10, 0, HOUR, 9 * 60), 11 * 60 + 15)
  assert.equal(resizeEnd(8 * HOUR, 0, HOUR, 9 * 60), 9 * 60 + 15)
  assert.equal(resizeEnd(30 * HOUR, 0, HOUR, 9 * 60), 24 * 60)
})

test('resolveTarget returns day-level targets, timed targets and invalid zones', () => {
  const options = { hourHeight: HOUR, grabMinutes: 0, durationMinutes: 45, zones: ['timed', 'month'] as const }
  assert.equal(resolveTarget(null, 0, options), null)
  assert.deepEqual(resolveTarget({ zone: 'month', day: '2026-10-12', top: 0 }, 0, options), {
    zone: 'month',
    day: '2026-10-12',
  })
  assert.deepEqual(resolveTarget({ zone: 'allday', day: '2026-10-12', top: 0 }, 0, options), {
    zone: 'allday',
    day: '2026-10-12',
    invalid: true,
  })
  assert.deepEqual(resolveTarget({ zone: 'timed', day: '2026-10-12', top: 0 }, 9 * HOUR + 4, options), {
    zone: 'timed',
    day: '2026-10-12',
    minutes: 540,
    endMinutes: 585,
  })
})

test('edge velocity ramps up near the edges only', () => {
  assert.equal(edgeVelocity(500, 0, 1000), 0)
  assert.equal(edgeVelocity(-5, 0, 1000), 0)
  assert.ok(edgeVelocity(10, 0, 1000) < 0)
  assert.ok(edgeVelocity(990, 0, 1000) > 0)
  assert.equal(edgeVelocity(1000, 0, 1000), 18)
})

test('wall clock times on DST change days', () => {
  // 2026-03-08: clocks spring forward at 2:00 in New York; the day has 23 hours.
  assert.equal(wallClock('2026-03-08', 60).toISOString(), '2026-03-08T06:00:00.000Z')
  assert.equal(wallClock('2026-03-08', 9 * 60).toISOString(), '2026-03-08T13:00:00.000Z')
  // 2026-11-01: clocks fall back; 9:00 is EST.
  assert.equal(wallClock('2026-11-01', 9 * 60).toISOString(), '2026-11-01T14:00:00.000Z')
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2)
  assert.equal(daysBetween('2026-11-02', '2026-10-31'), -2)
})

test('moving an event across a DST change keeps its wall-clock time', () => {
  const event = { start: '2026-03-07T15:00:00.000Z', end: '2026-03-07T16:00:00.000Z' } // 10–11 EST
  const moved = moveEvent(event, { zone: 'month', day: '2026-03-08' }, '2026-03-07')
  assert.deepEqual(moved, { start: '2026-03-08T14:00:00.000Z', end: '2026-03-08T15:00:00.000Z', allDay: false }) // 10–11 EDT
  const timed = moveEvent(event, { zone: 'timed', day: '2026-03-08', minutes: 9 * 60 }, '2026-03-07')
  assert.deepEqual(timed, { start: '2026-03-08T13:00:00.000Z', end: '2026-03-08T14:00:00.000Z', allDay: false })
})

test('moving an all-day event shifts its dates', () => {
  const moved = moveEvent(
    { start: '2026-10-12', end: '2026-10-14', allDay: true },
    { zone: 'allday', day: '2026-10-14' },
    '2026-10-13',
  )
  assert.deepEqual(moved, { start: '2026-10-13', end: '2026-10-15', allDay: true })
})

test('task due for each zone', () => {
  const timed = { dateTime: '2026-10-12T14:30:00.000Z' } // 10:30 EDT
  assert.deepEqual(taskDueForTarget(timed, { zone: 'allday', day: '2026-10-13' }), { date: '2026-10-13' })
  assert.deepEqual(
    taskDueForTarget({ date: '2026-10-12' }, { zone: 'timed', day: '2026-10-13', minutes: 8 * 60 + 15 }),
    { dateTime: '2026-10-13T12:15:00.000Z' },
  )
  assert.deepEqual(taskDueForTarget(timed, { zone: 'month', day: '2026-11-02' }), {
    dateTime: '2026-11-02T15:30:00.000Z',
  }) // 10:30 EST
  assert.deepEqual(taskDueForTarget(null, { zone: 'month', day: '2026-11-02' }), { date: '2026-11-02' })
  assert.ok(sameDue({ dateTime: '2026-10-12T14:30:00Z' }, timed))
  assert.ok(!sameDue({ date: '2026-10-12' }, timed))
})
