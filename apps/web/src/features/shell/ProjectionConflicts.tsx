type Conflict = {
  id: string
  title: string
  kind: string
  sourceName: string
  calendarName: string
  lastError: string | null
}

const reasons: Record<string, string> = {
  remote_changed: 'The Google event was edited outside Kairo.',
  remote_deleted: 'The Google event was deleted outside Kairo.',
  source_withdrawn: 'This event disappeared from its ICS feed.',
  move_unsupported: 'Google cannot move this event type to the selected calendar.',
}

export function ProjectionConflicts({ conflicts, busyId, onResolve }: {
  conflicts: Conflict[]
  busyId: string | null
  onResolve: (id: string, action: 'restore' | 'keep-google' | 'remove-decision') => void
}) {
  return <div className="settings-group projection-conflicts">
    <h3>Needs review {conflicts.length > 0 && <span className="conflict-count">{conflicts.length}</span>}</h3>
    {!conflicts.length && <p>Your Maybe decisions are in sync.</p>}
    {conflicts.map((conflict) => <div className="conflict-card" key={conflict.id}>
      <strong>{conflict.title}</strong>
      <span>{conflict.sourceName} → {conflict.calendarName}</span>
      <p>{reasons[conflict.kind] || conflict.lastError || 'This Google copy needs review before Kairo can sync it again.'}</p>
      <div className="conflict-actions">
        <button disabled={!!busyId || conflict.kind === 'source_withdrawn' || conflict.kind === 'move_unsupported'} title={conflict.kind === 'source_withdrawn' ? 'The source event is no longer in the feed' : conflict.kind === 'move_unsupported' ? 'This Google event type cannot be moved' : 'Replace the Google copy with the ICS source event'} onClick={() => onResolve(conflict.id, 'restore')}>Restore from source</button>
        <button disabled={!!busyId} title="Keep the Google event as an independent event and hide the ICS copy" onClick={() => onResolve(conflict.id, 'keep-google')}>Keep Google edit</button>
        <button disabled={!!busyId} title="Return the ICS event to undecided and delete its managed Google copy" onClick={() => onResolve(conflict.id, 'remove-decision')}>Remove decision</button>
      </div>
      {busyId === conflict.id && <span className="conflict-working">Resolving…</span>}
    </div>)}
  </div>
}
