import type { VirtualElement } from '@floating-ui/react'
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react'
import { addDays, addMonths, format, isSameDay, isSameMonth, startOfMonth, startOfWeek } from 'date-fns'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import IconChevronLeft from '~icons/tabler/chevron-left'
import IconChevronRight from '~icons/tabler/chevron-right'
import { formatShortTime } from '../calendar/date'
import { formatDuration } from '../tasks/grouping'
import { DAY_MINUTES, parseDate, parseDuration, parseTime } from './parse'
import './inspector.css'

const MENU_CLASS = 'insp-menu'

export type InspectorAnchor = Element | VirtualElement

/**
 * Floating panel anchored beside `anchor`. Clicks inside field menus (portaled elsewhere) don't dismiss it.
 * `close` blurs the focused field first so edits that commit on blur are saved, not dropped.
 */
export function useInspector(anchor: InspectorAnchor, onClose: () => void) {
  const panel = useRef<HTMLElement | null>(null)
  // Edits can re-render the anchor card elsewhere (another day column); stay put instead of jumping to the corner.
  const reference = useMemo<VirtualElement>(() => {
    if (!(anchor instanceof Element)) return anchor
    let last = anchor.getBoundingClientRect()
    return { contextElement: anchor, getBoundingClientRect: () => anchor.isConnected ? (last = anchor.getBoundingClientRect()) : last }
  }, [anchor])
  const close = () => {
    const focused = document.activeElement
    if (focused instanceof HTMLElement && panel.current?.contains(focused)) focused.blur()
    onClose()
  }
  const floating = useFloating({ open: true, onOpenChange: open => { if (!open) close() }, elements: { reference: anchor instanceof Element ? anchor : anchor.contextElement ?? null }, placement: 'right-start', strategy: 'fixed', middleware: [offset(12), flip({ fallbackPlacements: ['left-start', 'bottom-start'] }), shift({ padding: 12 })], whileElementsMounted: autoUpdate })
  const { setPositionReference } = floating.refs
  useLayoutEffect(() => setPositionReference(reference), [reference, setPositionReference])
  const dismiss = useDismiss(floating.context, { outsidePress: event => !(event.target instanceof Element && event.target.closest(`.${MENU_CLASS}`)) })
  const role = useRole(floating.context, { role: 'dialog' })
  const { getFloatingProps } = useInteractions([dismiss, role])
  const { setFloating } = floating.refs
  const ref = useCallback((node: HTMLElement | null) => { panel.current = node; setFloating(node) }, [setFloating])
  return { ref, style: floating.floatingStyles, getFloatingProps, close }
}

function useMenu(open: boolean, reference: HTMLElement | null) {
  return useFloating({
    open, elements: { reference }, placement: 'bottom-start', strategy: 'fixed', whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 12 }), shift({ padding: 12 }), size({ padding: 12, apply({ availableHeight, elements }) { elements.floating.style.maxHeight = `${Math.max(120, Math.min(320, availableHeight))}px` } })],
  })
}

/** Escape inside a field closes only that field, not the whole inspector. */
function stopEscape(e: ReactKeyboardEvent) {
  e.nativeEvent.stopPropagation()
}

/** Selects the input's text once the click that focused it has finished placing the caret. */
function selectSoon(input: HTMLInputElement) {
  requestAnimationFrame(() => { if (document.activeElement === input) input.select() })
}

/** Character width for browsers without `field-sizing: content`. */
const fieldSize = (text: string, placeholder = '') => Math.max(3, (text || placeholder).length)

export interface ComboOption<T> { key: string, label: string, hint?: string, swatch?: string, value: T }

interface ComboProps<T> {
  display: string
  options: ComboOption<T>[]
  onCommit: (value: T) => void
  /** Accepts typed text. Without it the field behaves like a select. */
  parse?: (text: string) => T | null
  /** Option key nearest a parsed value, highlighted while typing. */
  nearest?: (value: T) => string | undefined
  selectedKey?: string
  placeholder?: string
  disabled?: boolean
  className?: string
  'aria-label': string
}

/** Inline text that turns into an input with a suggestion menu, like the time pickers in Notion Calendar. */
export function Combo<T>(props: ComboProps<T>) {
  const { options, parse } = props
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(props.display)
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const openRef = useRef(false)
  const centerNext = useRef(false)
  const menu = useMenu(open, input.current)
  const setMenuFloating = menu.refs.setFloating
  const setMenu = useCallback((node: HTMLDivElement | null) => { list.current = node; setMenuFloating(node) }, [setMenuFloating])
  const id = useId()
  useEffect(() => { if (!open) setText(props.display) }, [props.display, open])
  useLayoutEffect(() => {
    // Wait for the menu's max-height to be applied, or "center" can't scroll anywhere yet.
    if (!open || active < 0 || !menu.isPositioned) return
    list.current?.children[active]?.scrollIntoView({ block: centerNext.current ? 'center' : 'nearest' })
    centerNext.current = false
  }, [open, active, menu.isPositioned])

  const show = () => {
    if (props.disabled || openRef.current) return
    openRef.current = true
    centerNext.current = true
    setText(props.display)
    setActive(options.findIndex(option => option.key === props.selectedKey))
    setOpen(true)
  }
  const finish = (value: T | null) => {
    openRef.current = false
    setOpen(false)
    setText(props.display)
    if (value !== null) props.onCommit(value)
  }
  const typed = () => parse && text !== props.display ? parse(text) : null

  const keyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const target = e.currentTarget
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!openRef.current) return show()
      setActive(index => Math.max(0, Math.min(options.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!openRef.current) return show()
      finish(typed() ?? options[active]?.value ?? null)
      target.blur()
    } else if (e.key === 'Escape' && openRef.current) {
      stopEscape(e)
      finish(null)
      target.blur()
    }
  }

  return <>
    <input ref={input} className={`insp-value ${props.className ?? ''}`} value={open ? text : props.display} placeholder={props.placeholder} size={fieldSize(open ? text : props.display, props.placeholder)} disabled={props.disabled} readOnly={!parse}
      role="combobox" aria-label={props['aria-label']} aria-expanded={open} aria-controls={open ? id : undefined} aria-autocomplete={parse ? 'list' : 'none'}
      aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
      onFocus={e => { show(); if (parse) selectSoon(e.currentTarget) }} onClick={show}
      onBlur={() => { if (openRef.current) finish(typed()) }}
      onChange={e => {
        const next = e.target.value
        setText(next)
        const value = parse?.(next)
        const key = value != null ? props.nearest?.(value) : undefined
        if (key !== undefined) setActive(options.findIndex(option => option.key === key))
      }}
      onKeyDown={keyDown} />
    {open && options.length > 0 && <FloatingPortal>
      <div ref={setMenu} style={menu.floatingStyles} id={id} role="listbox" className={MENU_CLASS} onMouseDown={e => e.preventDefault()}>
        {options.map((option, index) => <div key={option.key} id={`${id}-${index}`} role="option" aria-selected={option.key === props.selectedKey}
          className={`insp-option${index === active ? ' is-active' : ''}${option.key === props.selectedKey ? ' is-selected' : ''}`}
          onMouseMove={() => index !== active && setActive(index)} onClick={() => { finish(option.value); input.current?.blur() }}>
          {option.swatch && <span className="insp-swatch" style={{ background: option.swatch }} />}
          <span className="insp-option-label">{option.label}</span>
          {option.hint && <span className="insp-option-hint">{option.hint}</span>}
        </div>)}
      </div>
    </FloatingPortal>}
  </>
}

const clockLabel = (minutes: number) => formatShortTime(new Date(2000, 0, 1, Math.floor(minutes / 60) % 24, minutes % 60))
const nearestQuarter = (minutes: number) => String((Math.round(minutes / 15) * 15) % DAY_MINUTES)

/** Time of day in minutes, with a quarter-hour menu. */
export function TimeField({ minutes, onCommit, ...rest }: { minutes: number, onCommit: (minutes: number) => void, disabled?: boolean, 'aria-label': string }) {
  const options = useMemo(() => Array.from({ length: DAY_MINUTES / 15 }, (_, i) => ({ key: String(i * 15), label: clockLabel(i * 15), value: i * 15 })), [])
  return <Combo {...rest} display={clockLabel(minutes)} options={options} selectedKey={nearestQuarter(minutes)} nearest={nearestQuarter}
    parse={text => parseTime(text, minutes)} onCommit={onCommit} />
}

/** End time chosen as a duration after `startMinutes`; menu rows read "4:15 PM  30m". Accepts typed times or durations. */
export function EndTimeField({ startMinutes, duration, onCommit, ...rest }: { startMinutes: number, duration: number, onCommit: (duration: number) => void, disabled?: boolean, 'aria-label': string }) {
  const options = useMemo(() => Array.from({ length: DAY_MINUTES / 15 }, (_, i) => {
    const length = (i + 1) * 15
    return { key: String(length), label: clockLabel(startMinutes + length), hint: formatDuration(length), value: length }
  }), [startMinutes])
  const nearest = (length: number) => String(Math.max(15, Math.min(DAY_MINUTES, Math.round(length / 15) * 15)))
  const parse = (text: string) => {
    const end = parseTime(text, (startMinutes + duration) % DAY_MINUTES)
    if (end !== null) return (end - startMinutes + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES
    const length = parseDuration(text)
    return length && length <= DAY_MINUTES ? length : null
  }
  return <Combo {...rest} display={clockLabel(startMinutes + duration)} options={duration > DAY_MINUTES ? [] : options} selectedKey={nearest(duration)} nearest={nearest} parse={parse} onCommit={onCommit} />
}

const DURATION_PRESETS = [15, 30, 45, 60, 90, 120, 180, 240]

export function DurationField({ minutes, prefix = '', onCommit, ...rest }: { minutes: number, prefix?: string, onCommit: (minutes: number) => void, disabled?: boolean, 'aria-label': string }) {
  const options = DURATION_PRESETS.map(length => ({ key: String(length), label: formatDuration(length), value: length }))
  const parse = (text: string) => { const length = parseDuration(text); return length && length >= 5 && length <= DAY_MINUTES ? length : null }
  const nearest = (length: number) => String(DURATION_PRESETS.reduce((best, preset) => Math.abs(preset - length) < Math.abs(best - length) ? preset : best))
  return <Combo {...rest} display={`${prefix}${formatDuration(minutes)}`} options={options} selectedKey={String(minutes)} nearest={nearest} parse={parse} onCommit={onCommit} />
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

export function formatFieldDate(date: Date, today = new Date()) {
  return format(date, date.getFullYear() === today.getFullYear() ? 'EEE MMM d' : 'EEE MMM d, yyyy')
}

/** Inline date with a month picker; also accepts typed dates ("oct 20", "fri", "tomorrow"). */
export function DateField({ value, onCommit, placeholder, disabled, className, ...rest }: { value: Date | null, onCommit: (date: Date) => void, placeholder?: string, disabled?: boolean, className?: string, 'aria-label': string }) {
  const today = new Date()
  const display = value ? formatFieldDate(value, today) : ''
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(display)
  const [cursor, setCursor] = useState(value ?? today)
  const [month, setMonth] = useState(startOfMonth(cursor))
  const input = useRef<HTMLInputElement>(null)
  const openRef = useRef(false)
  const menu = useMenu(open, input.current)
  const id = useId()
  useEffect(() => { if (!open) setText(display) }, [display, open])

  const moveTo = (date: Date) => { setCursor(date); setMonth(startOfMonth(date)) }
  const show = () => {
    if (disabled || openRef.current) return
    openRef.current = true
    setText(display)
    moveTo(value ?? today)
    setOpen(true)
  }
  const finish = (date: Date | null) => {
    openRef.current = false
    setOpen(false)
    setText(display)
    if (date && !(value && isSameDay(date, value))) onCommit(date)
  }
  const typed = () => text !== display ? parseDate(text, today) : null

  const keyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const target = e.currentTarget
    const step = ({ ArrowUp: -7, ArrowDown: 7, ...(text === display ? { ArrowLeft: -1, ArrowRight: 1 } : {}) } as Record<string, number>)[e.key]
    if (step) {
      e.preventDefault()
      if (!openRef.current) return show()
      moveTo(addDays(cursor, step))
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      moveTo(addMonths(cursor, e.key === 'PageUp' ? -1 : 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!openRef.current) return show()
      finish(typed() ?? cursor)
      target.blur()
    } else if (e.key === 'Escape' && openRef.current) {
      stopEscape(e)
      finish(null)
      target.blur()
    }
  }

  const first = startOfWeek(month, { weekStartsOn: 1 })
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i))
  return <>
    <input ref={input} className={`insp-value ${className ?? ''}`} value={open ? text : display} placeholder={placeholder} size={fieldSize(open ? text : display, placeholder)} disabled={disabled}
      role="combobox" aria-label={rest['aria-label']} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onFocus={e => { show(); selectSoon(e.currentTarget) }} onClick={show}
      onBlur={() => { if (openRef.current) finish(typed()) }}
      onChange={e => { setText(e.target.value); const date = parseDate(e.target.value, today); if (date) moveTo(date) }}
      onKeyDown={keyDown} />
    {open && <FloatingPortal>
      <div ref={menu.refs.setFloating} style={menu.floatingStyles} id={id} className={`${MENU_CLASS} insp-month`} onMouseDown={e => e.preventDefault()}>
        <div className="insp-month-head">
          <strong>{format(month, 'MMMM yyyy')}</strong>
          <button type="button" tabIndex={-1} aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><IconChevronLeft /></button>
          <button type="button" tabIndex={-1} aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><IconChevronRight /></button>
        </div>
        <div className="insp-month-grid" role="grid" aria-label={format(month, 'MMMM yyyy')}>
          {WEEKDAYS.map(name => <span key={name} className="insp-month-weekday">{name}</span>)}
          {days.map(day => <button type="button" tabIndex={-1} key={day.getTime()} aria-label={format(day, 'EEEE, MMMM d, yyyy')} aria-pressed={!!value && isSameDay(day, value)}
            className={[isSameMonth(day, month) ? '' : 'is-outside', isSameDay(day, today) ? 'is-today' : '', value && isSameDay(day, value) ? 'is-selected' : '', isSameDay(day, cursor) ? 'is-active' : ''].join(' ')}
            onClick={() => { finish(day); input.current?.blur() }}>{format(day, 'd')}</button>)}
        </div>
      </div>
    </FloatingPortal>}
  </>
}

/** Text that commits on blur or Enter and reverts on Escape. */
export function TextField({ value, onCommit, multiline, className, ...rest }: { value: string, onCommit: (value: string) => void, multiline?: boolean, placeholder?: string, disabled?: boolean, readOnly?: boolean, className?: string, autoFocus?: boolean, 'aria-label': string }) {
  const [text, setText] = useState(value)
  const [editing, setEditing] = useState(false)
  useEffect(() => { if (!editing) setText(value) }, [value, editing])
  const common = {
    ...rest, value: editing ? text : value, className: `insp-text ${className ?? ''}`,
    onFocus: () => { setText(value); setEditing(true) },
    onBlur: () => { setEditing(false); if (text !== value) onCommit(text) },
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const target = e.currentTarget
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); target.blur() }
      if (e.key === 'Escape' && text !== value) { stopEscape(e); setText(value); requestAnimationFrame(() => target.blur()) }
    },
  }
  return multiline ? <textarea rows={1} {...common} /> : <input {...common} />
}

export function Row({ icon, children, className }: { icon?: ReactNode, children: ReactNode, className?: string }) {
  return <div className={`insp-row ${className ?? ''}`}><span className="insp-row-icon">{icon}</span><div className="insp-row-body">{children}</div></div>
}
