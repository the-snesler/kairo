import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDate, parseDuration, parseTime } from './parse'

test('parseTime reads 12- and 24-hour input', () => {
  assert.equal(parseTime('3pm'), 15 * 60)
  assert.equal(parseTime('3:30 PM'), 15 * 60 + 30)
  assert.equal(parseTime('330p'), 15 * 60 + 30)
  assert.equal(parseTime('12am'), 0)
  assert.equal(parseTime('12 pm'), 12 * 60)
  assert.equal(parseTime('15:45'), 15 * 60 + 45)
  assert.equal(parseTime('1545'), 15 * 60 + 45)
  assert.equal(parseTime('09'), 9 * 60)
  assert.equal(parseTime('0'), 0)
  assert.equal(parseTime('noon'), 12 * 60)
})

test('parseTime picks the period nearest the reference for bare hours', () => {
  assert.equal(parseTime('3', 14 * 60), 15 * 60)
  assert.equal(parseTime('3', 2 * 60), 3 * 60)
  assert.equal(parseTime('11', 23 * 60 + 30), 23 * 60)
})

test('parseTime rejects nonsense', () => {
  for (const text of ['', 'abc', '25', '3:75', '13pm', '0am']) assert.equal(parseTime(text), null, text)
})

test('parseDuration reads minutes and hours', () => {
  assert.equal(parseDuration('45'), 45)
  assert.equal(parseDuration('45m'), 45)
  assert.equal(parseDuration('45 min'), 45)
  assert.equal(parseDuration('1h'), 60)
  assert.equal(parseDuration('1.5h'), 90)
  assert.equal(parseDuration('1h 30m'), 90)
  assert.equal(parseDuration('1h30'), 90)
  assert.equal(parseDuration('2 hours'), 120)
  assert.equal(parseDuration('1:15'), 75)
  assert.equal(parseDuration(''), null)
  assert.equal(parseDuration('soon'), null)
})

test('parseDate reads common forms relative to today', () => {
  const today = new Date(2026, 9, 13) // Tue Oct 13 2026
  const key = (date: Date | null) => date && `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
  assert.equal(key(parseDate('Oct 20', today)), '2026-10-20')
  assert.equal(key(parseDate('sat oct 17', today)), '2026-10-17')
  assert.equal(key(parseDate('October 20, 2027', today)), '2027-10-20')
  assert.equal(key(parseDate('10/20', today)), '2026-10-20')
  assert.equal(key(parseDate('2026-11-02', today)), '2026-11-2')
  assert.equal(key(parseDate('tomorrow', today)), '2026-10-14')
  assert.equal(key(parseDate('fri', today)), '2026-10-16')
  assert.equal(key(parseDate('tue', today)), '2026-10-20')
  assert.equal(parseDate('whenever', today), null)
})
