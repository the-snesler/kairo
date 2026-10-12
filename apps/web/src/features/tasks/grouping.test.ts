import assert from 'node:assert/strict'
import test from 'node:test'
import { dueLabel, formatDuration, groupTasks, taskGroupId } from './grouping'
import type { TaskSummary } from './types'

const now = new Date(2026, 9, 12, 14, 30) // Mon Oct 12 2026, 2:30 PM local
const local = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m).toISOString()
let n = 0
const task = (over: Partial<TaskSummary>): TaskSummary => ({ id: `t${n++}`, title: 'Task', priority: 1, due: null, recurring: false, durationMinutes: 30, durationSource: 'default', completed: false, ...over })

test('groups by local due day relative to now', () => {
  const cases: [TaskSummary['due'], string][] = [
    [null, 'none'],
    [{ date: '2026-10-11' }, 'overdue'],
    [{ dateTime: local(11, 23, 59) }, 'overdue'],
    [{ date: '2026-10-12' }, 'today'],
    [{ dateTime: local(12, 0, 5) }, 'today'],
    [{ dateTime: local(12, 23, 59) }, 'today'],
    [{ date: '2026-10-13' }, 'tomorrow'],
    [{ dateTime: local(13, 0, 0) }, 'tomorrow'],
    [{ date: '2026-10-14' }, 'week'],
    [{ date: '2026-10-18' }, 'week'],
    [{ date: '2026-10-19' }, 'later'],
    [{ date: '2027-01-01' }, 'later'],
  ]
  for (const [due, expected] of cases) assert.equal(taskGroupId(task({ due }), now), expected, JSON.stringify(due))
})

test('omits empty groups and completed tasks, keeps group order', () => {
  const groups = groupTasks([
    task({ due: null }), task({ due: { date: '2026-10-12' } }), task({ due: { date: '2026-10-01' } }),
    task({ due: { date: '2026-10-13' }, completed: true }),
  ], now)
  assert.deepEqual(groups.map(g => g.id), ['overdue', 'today', 'none'])
  assert.deepEqual(groups.map(g => g.label), ['Overdue', 'Today', 'No date'])
})

test('sorts timed by time, then all-day, then priority desc, then title', () => {
  const [today] = groupTasks([
    task({ title: 'b all-day p1', due: { date: '2026-10-12' }, priority: 1 }),
    task({ title: 'late', due: { dateTime: local(12, 16) } }),
    task({ title: 'a all-day p1', due: { date: '2026-10-12' }, priority: 1 }),
    task({ title: 'urgent all-day', due: { date: '2026-10-12' }, priority: 4 }),
    task({ title: 'early', due: { dateTime: local(12, 9) }, priority: 1 }),
  ], now)
  assert.deepEqual(today.tasks.map(t => t.title), ['early', 'late', 'urgent all-day', 'a all-day p1', 'b all-day p1'])
})

test('multi-day groups sort by day first', () => {
  const [week] = groupTasks([
    task({ title: 'fri', due: { date: '2026-10-16' }, priority: 4 }),
    task({ title: 'wed timed', due: { dateTime: local(14, 10) } }),
    task({ title: 'wed', due: { date: '2026-10-14' } }),
  ], now)
  assert.deepEqual(week.tasks.map(t => t.title), ['wed timed', 'wed', 'fri'])
})

test('due labels', () => {
  assert.equal(dueLabel(task({ due: { date: '2026-10-12' } }), 'today', now), '')
  assert.equal(dueLabel(task({ due: { date: '2026-10-14' } }), 'week', now), 'Wed')
  assert.equal(dueLabel(task({ due: { date: '2026-10-01' } }), 'overdue', now), 'Oct 1')
  assert.equal(dueLabel(task({ due: { date: '2027-02-03' } }), 'later', now), 'Feb 3, 2027')
  assert.match(dueLabel(task({ due: { dateTime: local(12, 9) } }), 'today', now), /9:00/)
  assert.match(dueLabel(task({ due: { dateTime: local(14, 9) } }), 'week', now), /^Wed 9:00/)
})

test('formats durations', () => {
  assert.equal(formatDuration(45), '45m')
  assert.equal(formatDuration(60), '1h')
  assert.equal(formatDuration(90), '1h 30m')
})
