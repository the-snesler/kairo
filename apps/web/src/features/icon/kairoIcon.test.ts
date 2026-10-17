import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kairoIconSvg } from './kairoIcon'

test('renders every day of the month as outlined digits', () => {
  for (let day = 1; day <= 31; day++) {
    const svg = kairoIconSvg(day)
    assert.match(svg, /^<svg [^>]*viewBox="0 0 240 240">.*<\/svg>$/)
    assert.doesNotMatch(svg, /<text/)
    const digits = svg.match(/<path transform="translate\(/g) ?? []
    assert.equal(digits.length, String(day).length)
  }
})

test('keeps the number centred on the card face', () => {
  const offsets = (day: number) => [...kairoIconSvg(day).matchAll(/translate\(([\d.]+) /g)].map((m) => Number(m[1]))
  // Wide two-digit numbers start further left than narrow ones.
  assert.ok(offsets(20)[0] < offsets(11)[0])
  // A single digit sits right of where a two-digit number begins.
  assert.ok(offsets(8)[0] > offsets(28)[0])
})

test('rejects days outside 1–31', () => {
  for (const day of [0, 32, 1.5, Number.NaN]) assert.throws(() => kairoIconSvg(day), RangeError)
})
