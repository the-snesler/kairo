import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedScopes, defaultScope, describeChanges, diffRecurring, isEmptyPatch } from './recurring'
import type { CalendarEvent } from './types'

const local = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m).toISOString()
const event: CalendarEvent = {
  id: 'e1',
  kind: 'google',
  title: 'ECON 570',
  start: local(16, 13, 20),
  end: local(16, 14, 10),
  calendarId: 'main',
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'],
  series: { masterId: 'm1', instanceId: 'abc_20261016T182000Z', originalStart: local(16, 13, 20) },
}

test('diffRecurring returns nothing for an unchanged event', () => {
  assert.deepEqual(diffRecurring(event, { ...event, start: new Date(event.start).toISOString() }), {})
  assert.equal(isEmptyPatch(diffRecurring(event, { ...event, description: '' })), true)
})

test('diffRecurring includes both ends when the time moves', () => {
  const moved = { ...event, start: local(16, 13, 45), end: local(16, 14, 35) }
  assert.deepEqual(diffRecurring(event, moved), { start: moved.start, end: moved.end })
  const longer = { ...event, end: local(16, 15) }
  assert.deepEqual(diffRecurring(event, longer), { start: event.start, end: longer.end })
})

test('diffRecurring reports only changed text fields', () => {
  assert.deepEqual(diffRecurring(event, { ...event, title: 'New', location: 'Room 1' }), {
    title: 'New',
    location: 'Room 1',
  })
  assert.deepEqual(diffRecurring({ ...event, location: 'Room' }, { ...event, location: undefined }), {
    location: '',
  })
})

test('diffRecurring maps a removed rule to null and a new rule to its lines', () => {
  assert.deepEqual(diffRecurring(event, { ...event, recurrence: undefined }), { recurrence: null })
  assert.deepEqual(diffRecurring(event, { ...event, recurrence: [] }), { recurrence: null })
  const daily = ['RRULE:FREQ=DAILY']
  assert.deepEqual(diffRecurring(event, { ...event, recurrence: daily }), { recurrence: daily })
})

test('diffRecurring flags all-day switches with the new dates', () => {
  const patch = diffRecurring(event, { ...event, allDay: true, start: '2026-10-16', end: '2026-10-17' })
  assert.deepEqual(patch, { allDay: true, start: '2026-10-16', end: '2026-10-17' })
})

test('allowedScopes follows the server rules', () => {
  assert.deepEqual(allowedScopes({ title: 'x' }), ['this', 'following', 'all'])
  assert.deepEqual(allowedScopes({ recurrence: null }), ['following', 'all'])
  assert.deepEqual(allowedScopes({ recurrence: ['RRULE:FREQ=DAILY'], title: 'x' }), ['following', 'all'])
  assert.deepEqual(allowedScopes({ calendarId: 'other' }), ['all'])
  assert.deepEqual(allowedScopes({ calendarId: 'other', recurrence: null }), ['all'])
  assert.equal(defaultScope(['this', 'following', 'all']), 'this')
  assert.equal(defaultScope(['following', 'all']), 'all')
})

test('describeChanges lists before and after values', () => {
  const changed = { ...event, title: 'Econ', calendarId: 'work', recurrence: undefined }
  const rows = describeChanges(event, changed, diffRecurring(event, changed), [
    { id: 'main', name: 'Main', color: '#000000' },
    { id: 'work', name: 'Work', color: '#ffffff' },
  ])
  assert.deepEqual(rows, [
    { label: 'Title', from: 'ECON 570', to: 'Econ' },
    { label: 'Calendar', from: 'Main', to: 'Work' },
    { label: 'Repeat', from: 'Every week on Fri', to: 'Does not repeat' },
  ])
  const moved = { ...event, start: local(17, 13, 20), end: local(17, 14, 10) }
  assert.deepEqual(
    describeChanges(event, moved, diffRecurring(event, moved)).map((row) => row.label),
    ['Date'],
  )
})
