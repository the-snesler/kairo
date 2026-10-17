import assert from 'node:assert/strict'
import test from 'node:test'
import { followSavedEvent, type EditorState } from './editor'
import type { CalendarEvent } from './types'

const event: CalendarEvent = {
  id: 'saved',
  kind: 'google',
  title: 'Meeting',
  start: '2026-10-16T10:00:00Z',
  end: '2026-10-16T11:00:00Z',
}
const draft: EditorState = {
  sessionId: 'session',
  eventId: null,
  draft: event,
  anchor: {
    getBoundingClientRect: () => ({
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      top: 10,
      left: 10,
      bottom: 30,
      right: 30,
      toJSON: () => ({}),
    }),
  },
}

test('creation follows the saved ID in the same popup with a fallback until refresh', () => {
  const saved = followSavedEvent(draft, 'session', event)!
  assert.equal(saved.sessionId, draft.sessionId)
  assert.equal(saved.anchor, draft.anchor)
  assert.equal(saved.eventId, 'saved')
  assert.equal(saved.draft, null)
  assert.equal(saved.fallback, event)
  assert.equal(saved.saving, false)
})

test('moving follows the new ID without replacing the popup session or anchor', () => {
  const original = { ...draft, eventId: 'old', draft: null, saving: true }
  const moved = followSavedEvent(original, 'session', event)!
  assert.equal(moved.eventId, 'saved')
  assert.equal(moved.sessionId, original.sessionId)
  assert.equal(moved.anchor, original.anchor)
  assert.equal(moved.saving, false)
})

test('a late save cannot reopen a closed popup or replace a newer popup', () => {
  assert.equal(followSavedEvent(null, 'session', event), null)
  const reopened = { ...draft, sessionId: 'new-session' }
  assert.equal(followSavedEvent(reopened, 'session', event), reopened)
})
