import type { PointerEvent as ReactPointerEvent } from 'react'
import type { TaskSummary } from '../../tasks/types'

// Lets surfaces outside CalendarWorkspace (the sidebar) start a pointer drag the calendar renders and drops.
export type ExternalDragPayload = { kind: 'task'; task: TaskSummary }

type Listener = (payload: ExternalDragPayload, event: PointerEvent, origin: DOMRect) => void
let listener: Listener | null = null

export function onExternalDrag(next: Listener) {
  listener = next
  return () => {
    if (listener === next) listener = null
  }
}

export function beginExternalDrag(payload: ExternalDragPayload, event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0 || !listener) return false
  listener(payload, event.nativeEvent, event.currentTarget.getBoundingClientRect())
  return true
}
