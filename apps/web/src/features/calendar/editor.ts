import type { InspectorAnchor } from '../inspector/fields'
import type { EventDraft } from './EventPopover'
import type { CalendarEvent } from './types'

export interface EditorState {
  /** Stable across draft creation and event ID changes; replaced when another popup opens. */
  sessionId: string
  eventId: string | null
  draft: EventDraft | null
  anchor: InspectorAnchor
  fallback?: CalendarEvent
  saving?: boolean
}

/** Follow a saved event without reopening an editor the user has already left. */
export function followSavedEvent(
  editor: EditorState | null,
  sessionId: string,
  event: CalendarEvent,
): EditorState | null {
  if (!editor || editor.sessionId !== sessionId) return editor
  return { ...editor, eventId: event.id, draft: null, fallback: event, saving: false }
}
