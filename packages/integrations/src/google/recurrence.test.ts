import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatRecurrence,
  matchPreset,
  nthWeekday,
  parseRecurrence,
  presetsFor,
  summarizeRecurrence,
  untilBefore,
  untilToDate,
  withEnd,
} from './recurrence.js'

const friday = new Date(2026, 9, 16, 13, 20)
const lastFriday = new Date(2026, 9, 30, 13, 20)

test('parse and format round-trip, preserving extra lines and omitting INTERVAL=1', () => {
  const lines = ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261113T000000Z;WKST=SU', 'EXDATE:20261019T132000Z']
  const parsed = parseRecurrence(lines)!
  assert.equal(parsed.supported, true)
  assert.deepEqual(parsed.rule, {
    freq: 'WEEKLY',
    interval: 2,
    byDay: [{ day: 'MO' }, { day: 'WE' }],
    until: '20261113T000000Z',
    wkst: 'SU',
  })
  assert.deepEqual(parsed.extra, ['EXDATE:20261019T132000Z'])
  assert.deepEqual(parsed.raw, lines)
  assert.deepEqual(formatRecurrence(parsed.rule!, parsed.extra), lines)

  const monthly = parseRecurrence(['rrule:freq=monthly;interval=1;byday=-1fr;count=4'])!
  assert.deepEqual(monthly.rule, { freq: 'MONTHLY', interval: 1, byDay: [{ day: 'FR', nth: -1 }], count: 4 })
  assert.deepEqual(formatRecurrence(monthly.rule!), ['RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=4'])
  assert.deepEqual(formatRecurrence({ freq: 'YEARLY', interval: 1, byMonth: [3], byMonthDay: [1, -1] }), [
    'RRULE:FREQ=YEARLY;BYMONTHDAY=1,-1;BYMONTH=3',
  ])
})

test('parse flags unsupported rules', () => {
  assert.equal(parseRecurrence(null), null)
  assert.equal(parseRecurrence([]), null)
  assert.equal(parseRecurrence(['EXDATE:20261019T132000Z']), null)

  const setpos = parseRecurrence(['RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'])!
  assert.equal(setpos.rule, null)
  assert.equal(setpos.supported, false)
  assert.equal(parseRecurrence(['RRULE:FREQ=DAILY;BYHOUR=9'])!.rule, null)
  assert.equal(parseRecurrence(['RRULE:FREQ=HOURLY'])!.rule, null)

  const two = parseRecurrence(['RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY'])!
  assert.deepEqual(two.rule, { freq: 'DAILY', interval: 1 })
  assert.equal(two.supported, false)

  const exrule = parseRecurrence(['RRULE:FREQ=DAILY', 'EXRULE:FREQ=WEEKLY'])!
  assert.equal(exrule.supported, false)
  assert.deepEqual(exrule.extra, ['EXRULE:FREQ=WEEKLY'])
  assert.equal(summarizeRecurrence(exrule.raw, friday).label, 'Custom')
  assert.equal(summarizeRecurrence(setpos.raw, friday).hint, undefined)
})

test('presets for a 3rd Friday', () => {
  const presets = presetsFor(friday)
  assert.deepEqual(
    presets.map(({ key, label, hint }) => [key, label, hint]),
    [
      ['none', 'Does not repeat', undefined],
      ['daily', 'Every day', undefined],
      ['weekdays', 'Every weekday', 'Mon–Fri'],
      ['weekly', 'Every week', 'on Fri'],
      ['biweekly', 'Every 2 weeks', 'on Fri'],
      ['monthly-day', 'Every month', 'on the 16th'],
      ['monthly-nth', 'Every month', 'on the 3rd Fri'],
      ['yearly', 'Every year', 'on Oct 16'],
    ],
  )
  assert.deepEqual(
    presets.map((preset) => (preset.rule ? formatRecurrence(preset.rule)[0] : null)),
    [
      null,
      'RRULE:FREQ=DAILY',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      'RRULE:FREQ=WEEKLY;BYDAY=FR',
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=16',
      'RRULE:FREQ=MONTHLY;BYDAY=3FR',
      'RRULE:FREQ=YEARLY',
    ],
  )
  for (const preset of presets) {
    assert.equal(matchPreset(preset.rule ? formatRecurrence(preset.rule) : null, friday), preset.key)
  }
})

test('presets use "last" only for a 5th weekday', () => {
  const last = presetsFor(lastFriday).find((preset) => preset.key === 'monthly-nth')!
  assert.equal(last.hint, 'on the last Fri')
  assert.deepEqual(last.rule?.byDay, [{ day: 'FR', nth: -1 }])
  assert.deepEqual(nthWeekday(lastFriday), { day: 'FR', nth: 5, last: true })

  // Feb 27 2026 is the 4th and last Friday: prefer "4th".
  const fourth = new Date(2026, 1, 27, 9)
  assert.deepEqual(nthWeekday(fourth), { day: 'FR', nth: 4, last: true })
  assert.equal(presetsFor(fourth).find((preset) => preset.key === 'monthly-nth')!.hint, 'on the 4th Fri')
})

test('matchPreset compares semantically', () => {
  assert.equal(matchPreset(undefined, friday), 'none')
  assert.equal(matchPreset(['RRULE:FREQ=WEEKLY'], friday), 'weekly')
  assert.equal(matchPreset(['RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2'], friday), 'biweekly')
  assert.equal(matchPreset(['RRULE:FREQ=WEEKLY;BYDAY=FR,TH,WE,TU,MO'], friday), 'weekdays')
  assert.equal(matchPreset(['RRULE:FREQ=MONTHLY'], friday), 'monthly-day')
  assert.equal(matchPreset(['RRULE:FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=16'], friday), 'yearly')
  assert.equal(matchPreset(['RRULE:FREQ=DAILY', 'EXDATE:20261019T132000Z'], friday), 'daily')
  assert.equal(matchPreset(['RRULE:FREQ=MONTHLY;BYDAY=-1FR'], lastFriday), 'monthly-nth')

  assert.equal(matchPreset(['RRULE:FREQ=DAILY;COUNT=4'], friday), null)
  assert.equal(matchPreset(['RRULE:FREQ=WEEKLY;UNTIL=20261113T000000Z'], friday), null)
  assert.equal(matchPreset(['RRULE:FREQ=WEEKLY;BYDAY=MO'], friday), null)
  assert.equal(matchPreset(['RRULE:FREQ=DAILY;INTERVAL=3'], friday), null)
  assert.equal(matchPreset(['RRULE:FREQ=MONTHLY;BYDAY=-1FR'], friday), null)
  assert.equal(matchPreset(['RRULE:FREQ=DAILY;BYSETPOS=1'], friday), null)
})

test('summarizeRecurrence describes presets, custom rules and endings', () => {
  assert.deepEqual(summarizeRecurrence(null, friday), { label: 'Does not repeat' })
  assert.deepEqual(summarizeRecurrence(['RRULE:FREQ=WEEKLY'], friday), { label: 'Every week', hint: 'on Fri' })
  assert.deepEqual(summarizeRecurrence(['RRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=WE,MO'], friday), {
    label: 'Every 3 weeks',
    hint: 'on Mon, Wed',
  })
  assert.deepEqual(summarizeRecurrence(['RRULE:FREQ=DAILY;INTERVAL=2'], friday), { label: 'Every 2 days' })
  assert.deepEqual(summarizeRecurrence(['RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15'], friday), {
    label: 'Every month',
    hint: 'on the 1st, 15th',
  })
  assert.deepEqual(
    summarizeRecurrence(
      [`RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=${untilBefore(new Date(2026, 10, 13, 13, 21).toISOString(), false)}`],
      friday,
    ),
    {
      label: 'Every week',
      hint: 'on Fri, until Nov 13',
    },
  )
  assert.deepEqual(summarizeRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20271113'], friday), {
    label: 'Every week',
    hint: 'on Fri, until Nov 13, 2027',
  })
  assert.deepEqual(summarizeRecurrence(['RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4'], friday), {
    label: 'Every 2 weeks',
    hint: 'on Fri, 4 times',
  })
  assert.deepEqual(summarizeRecurrence(['RRULE:FREQ=DAILY;INTERVAL=2;COUNT=4'], friday), {
    label: 'Every 2 days',
    hint: '4 times',
  })
})

test('untilBefore ends a series just before an occurrence', () => {
  assert.equal(untilBefore('2026-10-16T13:20:00-07:00', false), '20261016T201959Z')
  assert.equal(untilBefore('2026-11-01T00:00:00Z', false), '20261031T235959Z')
  assert.equal(untilBefore('2026-10-16', true), '20261015')
  assert.equal(untilBefore('2026-03-01', true), '20260228')
  assert.equal(untilBefore('2026-01-01', true), '20251231')
})

test('untilToDate and withEnd', () => {
  assert.equal(untilToDate('20261113T201959Z').toISOString(), '2026-11-13T20:19:59.000Z')
  assert.equal(untilToDate('20261113').toISOString(), '2026-11-13T23:59:59.000Z')

  const rule = { freq: 'DAILY' as const, interval: 1, count: 3 }
  assert.deepEqual(withEnd(rule, { until: '20261113' }), { freq: 'DAILY', interval: 1, until: '20261113' })
  assert.deepEqual(withEnd(rule, null), { freq: 'DAILY', interval: 1 })
  assert.deepEqual(rule, { freq: 'DAILY', interval: 1, count: 3 })
})
