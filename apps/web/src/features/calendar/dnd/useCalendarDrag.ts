import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { edgeVelocity, targetKey } from './geometry'
import type { DropTarget } from './geometry'

const THRESHOLD_PX = 4

export interface DragSession<T> {
  data: T
  pointerId: number
  startX: number
  startY: number
  /** Latest pointer position in client coordinates. */
  x: number
  y: number
  /** Pointer offset inside the ghost, preserved while dragging. */
  grabX: number
  grabY: number
  width: number
  height: number
  phase: 'pending' | 'dragging'
}

export interface DragView<T> {
  data: T
  target: DropTarget | null
  width: number
  height: number
}

export interface ScrollArea {
  element: HTMLElement
  rect: DOMRect
  /** Top edge of the scrollable time grid (below sticky headers). */
  gridTop: number
  horizontal: boolean
}

export interface CalendarDragOptions<T> {
  /** Drop target under the pointer; called whenever the pointer moves or the content scrolls. */
  resolve: (session: DragSession<T>) => DropTarget | null
  /** Runs once per animation frame while dragging (after the ghost moves). */
  onFrame?: (session: DragSession<T>) => void
  /** Runs when a drag that passed the threshold ends, before onDrop (drop) or on its own (cancel). */
  onFinish?: (session: DragSession<T>) => void
  onDrop: (session: DragSession<T>, target: DropTarget | null) => void
  scrollArea?: (session: DragSession<T>) => ScrollArea | null
  cursor?: (session: DragSession<T>) => 'move' | 'resize'
}

export interface BeginGeometry {
  grabX: number
  grabY: number
  width: number
  height: number
}

/**
 * Pointer drag state machine: idle → pending (until the pointer travels THRESHOLD_PX, so clicks still work)
 * → dragging → drop | cancel (Escape, pointercancel, window blur). The ghost is moved through a ref in
 * requestAnimationFrame; React state only changes when dragging starts/ends or the drop target changes.
 */
export function useCalendarDrag<T>(options: CalendarDragOptions<T>) {
  const optionsRef = useRef(options)
  useLayoutEffect(() => { optionsRef.current = options })
  const [view, setView] = useState<DragView<T> | null>(null)
  const session = useRef<DragSession<T> | null>(null)
  const ghost = useRef<HTMLElement | null>(null)
  const frame = useRef(0)
  const dirty = useRef(false)
  const key = useRef('')
  const teardownRef = useRef<() => void>(() => {})

  const placeGhost = () => {
    const current = session.current
    if (ghost.current && current) ghost.current.style.transform = `translate3d(${current.x - current.grabX}px, ${current.y - current.grabY}px, 0)`
  }

  const ghostRef = useCallback((node: HTMLElement | null) => {
    ghost.current = node
    placeGhost()
  }, [])

  const setRootClass = (name: string, on: boolean) => document.documentElement.classList.toggle(name, on)

  const updateTarget = (current: DragSession<T>) => {
    const target = optionsRef.current.resolve(current)
    const next = targetKey(target)
    if (next === key.current) return
    key.current = next
    setRootClass('cal-drag-invalid', !!target?.invalid)
    setView(view => view && { ...view, target })
  }

  const tick = () => {
    const current = session.current
    if (!current || current.phase !== 'dragging') return
    const area = optionsRef.current.scrollArea?.(current)
    if (area) {
      const { rect } = area
      const insideX = current.x >= rect.left && current.x <= rect.right
      const insideY = current.y >= rect.top && current.y <= rect.bottom
      const vy = insideX ? edgeVelocity(current.y, area.gridTop, rect.bottom) : 0
      const vx = area.horizontal && insideY ? edgeVelocity(current.x, rect.left, rect.right, 32, 12) : 0
      const step = (v: number) => v === 0 ? 0 : Math.sign(v) * Math.max(1, Math.round(Math.abs(v)))
      if (vy || vx) {
        const top = area.element.scrollTop
        const left = area.element.scrollLeft
        area.element.scrollTop += step(vy)
        area.element.scrollLeft += step(vx)
        if (area.element.scrollTop !== top || area.element.scrollLeft !== left) dirty.current = true
      }
    }
    if (dirty.current) {
      dirty.current = false
      placeGhost()
      optionsRef.current.onFrame?.(current)
      updateTarget(current)
    }
    frame.current = requestAnimationFrame(tick)
  }

  const finish = (drop: boolean) => {
    const current = session.current
    teardownRef.current()
    if (!current || current.phase !== 'dragging') return
    const target = drop ? optionsRef.current.resolve(current) : null
    // A completed drag must not also count as a click on whatever is under the pointer.
    if (drop) {
      const swallow = (event: MouseEvent) => { event.stopPropagation(); event.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    }
    optionsRef.current.onFinish?.(current)
    if (drop) optionsRef.current.onDrop(current, target)
  }

  const begin = useCallback((data: T, event: PointerEvent, geometry: BeginGeometry) => {
    if (session.current || event.button !== 0) return false
    const current: DragSession<T> = {
      data, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      grabX: Math.min(Math.max(geometry.grabX, 0), geometry.width), grabY: Math.min(Math.max(geometry.grabY, 0), geometry.height),
      width: geometry.width, height: geometry.height, phase: 'pending',
    }
    session.current = current

    const onMove = (pointer: PointerEvent) => {
      if (pointer.pointerId !== current.pointerId) return
      current.x = pointer.clientX
      current.y = pointer.clientY
      if (current.phase === 'pending') {
        if (Math.hypot(current.x - current.startX, current.y - current.startY) < THRESHOLD_PX) return
        current.phase = 'dragging'
        key.current = ''
        window.getSelection()?.removeAllRanges()
        setRootClass('cal-drag-active', true)
        setRootClass('cal-drag-resize', optionsRef.current.cursor?.(current) === 'resize')
        setView({ data: current.data, target: null, width: current.width, height: current.height })
        frame.current = requestAnimationFrame(tick)
      }
      dirty.current = true
    }
    const onUp = (pointer: PointerEvent) => { if (pointer.pointerId === current.pointerId) finish(true) }
    const onCancel = (pointer: PointerEvent) => { if (pointer.pointerId === current.pointerId) finish(false) }
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return
      key.preventDefault()
      key.stopPropagation()
      finish(false)
    }
    const onBlur = () => finish(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    teardownRef.current = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      cancelAnimationFrame(frame.current)
      setRootClass('cal-drag-active', false)
      setRootClass('cal-drag-resize', false)
      setRootClass('cal-drag-invalid', false)
      session.current = null
      key.current = ''
      teardownRef.current = () => {}
      setView(null)
    }
    return true
  // tick/finish only read refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => teardownRef.current(), [])

  return { view, begin, ghostRef }
}
