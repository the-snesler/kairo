import { useState } from 'react'
import { Modal } from '../inspector/fields'
import { allowedScopes, defaultScope, describeChanges, diffRecurring, SCOPES } from './recurring'
import type { CalendarEvent, CalendarOption, RecurringScope } from './types'

export type RecurringScopeDialogProps = {
  busy?: boolean
  error?: string
  onConfirm: (scope: RecurringScope) => void
} & (
  | {
      mode: 'edit'
      original: CalendarEvent
      changed: CalendarEvent
      calendars: CalendarOption[]
      onDiscard: () => void
      onContinue: () => void
    }
  | { mode: 'delete'; original: CalendarEvent; onCancel: () => void }
)

/** Asks which occurrences of a repeating event an edit or delete applies to. */
export function RecurringScopeDialog(props: RecurringScopeDialogProps) {
  const { original, busy } = props
  const patch = props.mode === 'edit' ? diffRecurring(original, props.changed) : {}
  const allowed = allowedScopes(patch)
  const [scope, setScope] = useState<RecurringScope>(defaultScope(allowed))
  const selected = allowed.includes(scope) ? scope : defaultScope(allowed)
  const rows = props.mode === 'edit' ? describeChanges(original, props.changed, patch, props.calendars) : []
  const verb = props.mode === 'edit' ? 'Edit' : 'Delete'
  const confirm = () => !busy && props.onConfirm(selected)
  const dismiss = () => {
    if (busy) return
    if (props.mode === 'edit') props.onContinue()
    else props.onCancel()
  }

  return (
    <Modal
      aria-label={`${verb} repeat event`}
      className={`scope-dialog${busy ? ' is-busy' : ''}`}
      onDismiss={dismiss}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault()
          confirm()
        }
      }}
    >
      <h2 className="rec-title">
        {verb} repeat event “{original.title}”
      </h2>
      <div className="scope-options" role="radiogroup" aria-label="Apply to">
        {SCOPES.map(([value, label]) => (
          <label key={value} className={`rec-radio${allowed.includes(value) ? '' : ' is-disabled'}`}>
            <input
              type="radio"
              name="recurring-scope"
              checked={selected === value}
              disabled={busy || !allowed.includes(value)}
              onChange={() => setScope(value)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {rows.length > 0 && (
        <dl className="scope-changes">
          {rows.map((row) => (
            <div key={row.label} className="scope-change">
              <dt>{row.label}</dt>
              <dd>
                <span className="scope-new">{row.to}</span>
                <s className="scope-old">{row.from}</s>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {props.error && (
        <p className="scope-error" role="alert">
          {props.error}
        </p>
      )}
      <div className="rec-actions">
        {props.mode === 'edit' ? (
          <>
            <button type="button" className="rec-button is-danger" disabled={busy} onClick={props.onDiscard}>
              Discard change
            </button>
            <span className="rec-spacer" />
            <button type="button" className="rec-button" disabled={busy} onClick={props.onContinue}>
              Continue editing
            </button>
          </>
        ) : (
          <button type="button" className="rec-button" disabled={busy} onClick={props.onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="rec-button is-primary" disabled={busy} onClick={confirm}>
          {busy ? (props.mode === 'edit' ? 'Saving…' : 'Deleting…') : props.mode === 'edit' ? 'Save event' : 'Delete'}
        </button>
      </div>
    </Modal>
  )
}
