import { createFileRoute } from '@tanstack/react-router'
import { addDays, startOfDay } from 'date-fns'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import IconAlertCircle from '~icons/tabler/alert-circle'
import IconChevronDown from '~icons/tabler/chevron-down'
import IconCircleDashed from '~icons/tabler/circle-dashed'
import IconPlus from '~icons/tabler/plus'
import IconX from '~icons/tabler/x'
import { CalendarWorkspace, type CalendarEvent } from '../features/calendar/CalendarWorkspace'
import type { RecurringEventPatch, RecurringScope } from '../features/calendar/types'
import { Sidebar } from '../features/shell/Sidebar'
import { ProjectionConflicts } from '../features/shell/ProjectionConflicts'
import { TaskPopover, type TaskChange } from '../features/tasks/TaskPopover'
import {
  addIcsFeed,
  decideExternalEvent,
  deleteGoogleEvent,
  deleteIcsFeed,
  deleteRecurringEvent,
  getAdjacentOccurrence,
  getCalendarSnapshot,
  getViewer,
  resolveProjectionConflict,
  saveGoogleEvent,
  saveRecurringEvent,
  setCalendarRole,
  setCalendarVisibility,
  syncNow,
  updateTask,
} from '../server/calendar.functions'
import '../features/shell/app.css'

export const Route = createFileRoute('/')({ loader: () => getViewer(), component: Home })

type Snapshot = Awaited<ReturnType<typeof getCalendarSnapshot>>

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const isoDate = (value: string) => new Date(value).toISOString()

function Home() {
  const viewer = Route.useLoaderData()
  if (!viewer.user) return <AuthPage setup={viewer.needsSetup} />
  return <Dashboard user={viewer.user} />
}

function AuthPage({ setup }: { setup: boolean }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/auth/${setup ? 'sign-up' : 'sign-in'}/email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setup ? { name, email, password } : { email, password }),
      })
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        throw new Error(result.message || 'Could not sign in')
      }
      window.location.reload()
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
      setBusy(false)
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-glow" />
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <span className="auth-logo">K</span>
          <span>Kairo</span>
        </div>
        <h1>{setup ? 'Make time for what matters.' : 'Welcome back.'}</h1>
        <p>
          {setup
            ? 'Create the owner account for your private calendar workspace.'
            : 'Sign in to your calendar workspace.'}
        </p>
        {setup && (
          <label>
            Name
            <input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={setup ? 12 : undefined}
            required
          />
        </label>
        {error && (
          <div className="auth-error">
            <IconAlertCircle /> {error}
          </div>
        )}
        <button className="primary-button" disabled={busy}>
          {busy ? 'One moment…' : setup ? 'Create workspace' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}

function Dashboard({ user }: { user: { id: string; name: string; email: string } }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [selectedDate, setSelectedDate] = useState(() => startOfDay(new Date()))
  const [visibleDays, setVisibleDays] = useState<Date[]>(() =>
    Array.from({ length: 7 }, (_, i) => addDays(startOfDay(new Date()), i)),
  )
  const [visibleCalendarIds, setVisibleCalendarIds] = useState<Set<string>>(new Set())
  const [feedDialog, setFeedDialog] = useState(false)
  const [settingsDialog, setSettingsDialog] = useState(false)
  const [feedUrl, setFeedUrl] = useState('')
  const [feedName, setFeedName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [undo, setUndo] = useState<{ id: number; label: string; action: () => void } | null>(null)
  const [openTask, setOpenTask] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const [conflictBusy, setConflictBusy] = useState<string | null>(null)
  const rangeRef = useRef({ start: addDays(startOfDay(new Date()), -20), end: addDays(startOfDay(new Date()), 42) })
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    const current = ++requestRef.current
    try {
      const result = await getCalendarSnapshot({
        data: { start: rangeRef.current.start.toISOString(), end: rangeRef.current.end.toISOString() },
      })
      if (current !== requestRef.current) return
      setSnapshot(result)
      setVisibleCalendarIds((previous) =>
        previous.size ? previous : new Set(result.calendars.filter((item) => item.visible).map((item) => item.id)),
      )
      setError('')
    } catch (cause) {
      if (current === requestRef.current) setError(String(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!snapshot) return
    const params = new URLSearchParams(window.location.search)
    const authError = params.get('error')
    const connected = params.get('connected')
    if (authError) setError(authError)
    else if (connected) setToast(`${connected === 'todoist' ? 'Todoist' : 'Google Calendar'} connected`)
    if (authError || connected) window.history.replaceState(null, '', window.location.pathname)
  }, [snapshot])

  const visibleRange = useCallback(
    (start: Date, end: Date) => {
      if (start >= addDays(rangeRef.current.start, 7) && end <= addDays(rangeRef.current.end, -7)) return
      rangeRef.current = { start: addDays(start, -21), end: addDays(end, 35) }
      void load()
    },
    [load],
  )
  const visibleDaysChange = useCallback(
    (days: Date[]) =>
      setVisibleDays((old) =>
        old.map((day) => day.toDateString()).join() === days.map((day) => day.toDateString()).join() ? old : days,
      ),
    [],
  )

  async function refresh() {
    setBusy(true)
    try {
      const result = await syncNow()
      if (result.errors.length) setError(result.errors.join(' · '))
      await load()
      if (!result.errors.length) setToast('Up to date')
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function mutation(action: () => Promise<unknown>) {
    try {
      await action()
      await load()
    } catch (cause) {
      setError(String(cause))
      throw cause
    }
  }

  async function eventSave(event: CalendarEvent) {
    const calendarId = event.calendarId
    if (!calendarId) throw new Error('Choose a calendar')
    await mutation(() =>
      saveGoogleEvent({
        data: {
          id: event.id,
          title: event.title,
          start: new Date(event.start).toISOString(),
          end: new Date(event.end).toISOString(),
          allDay: !!event.allDay,
          calendarId,
          eventColor: event.eventColor,
          description: event.description,
          location: event.location,
          recurrence: event.recurrence?.length ? event.recurrence : null,
          timeZone: browserTimeZone(),
        },
      }),
    )
  }

  async function recurringSave(event: CalendarEvent, patch: RecurringEventPatch, scope: RecurringScope) {
    // All-day occurrences keep YYYY-MM-DD dates; timed ones are sent as UTC instants.
    const date = (value: string) => ((patch.allDay ?? event.allDay) ? value.slice(0, 10) : isoDate(value))
    const data = {
      ...patch,
      ...(patch.start ? { start: date(patch.start) } : {}),
      ...(patch.end ? { end: date(patch.end) } : {}),
    }
    await mutation(() =>
      saveRecurringEvent({ data: { id: event.id, scope, patch: data, timeZone: browserTimeZone() } }),
    )
  }

  async function taskChange(id: string, patch: TaskChange) {
    // Completing a recurring task advances its due date, so undo restores the date it had.
    const previousDue = snapshot?.tasks.find((item) => item.id === id)?.due ?? null
    await mutation(() => updateTask({ data: { id, ...patch } }))
    if (patch.completed)
      setUndo({
        id: Date.now(),
        label: 'Task completed',
        action: () => {
          void taskChange(id, { completed: false, due: previousDue }).catch(() => {})
        },
      })
  }

  async function eventCreate(event: Omit<CalendarEvent, 'id'>) {
    const calendarId =
      event.calendarId || snapshot?.calendars.find((item) => item.isDefault)?.id || snapshot?.calendars[0]?.id
    if (!calendarId) throw new Error('Connect a writable Google calendar first')
    await mutation(() =>
      saveGoogleEvent({
        data: {
          title: event.title,
          start: new Date(event.start).toISOString(),
          end: new Date(event.end).toISOString(),
          allDay: !!event.allDay,
          calendarId,
          eventColor: event.eventColor,
          description: event.description,
          location: event.location,
          recurrence: event.recurrence?.length ? event.recurrence : null,
          timeZone: browserTimeZone(),
        },
      }),
    )
  }

  async function addFeed(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await addIcsFeed({ data: { name: feedName, url: feedUrl } })
      setFeedDialog(false)
      setFeedName('')
      setFeedUrl('')
      await load()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function removeFeed(id: string, name: string) {
    if (!window.confirm(`Remove ${name} from Kairo? Its decisions and existing Google copies will be kept.`)) return
    try {
      await mutation(() => deleteIcsFeed({ data: { id } }))
      setToast('Feed removed')
    } catch {
      /* mutation displays the error. */
    }
  }

  async function toggleCalendar(id: string) {
    const previous = visibleCalendarIds
    const next = new Set(previous)
    next.has(id) ? next.delete(id) : next.add(id)
    setVisibleCalendarIds(next)
    try {
      await setCalendarVisibility({ data: { calendarId: id, visible: next.has(id) } })
    } catch (cause) {
      setVisibleCalendarIds(previous)
      setError(String(cause))
    }
  }

  async function resolveConflict(id: string, action: 'restore' | 'keep-google' | 'remove-decision') {
    setConflictBusy(id)
    try {
      await resolveProjectionConflict({ data: { id, action } })
      await load()
      setToast(
        action === 'restore'
          ? 'Google event restored from the feed'
          : action === 'keep-google'
            ? 'Google edit kept as an independent event'
            : 'Decision removed',
      )
    } catch (cause) {
      setError(String(cause))
    } finally {
      setConflictBusy(null)
    }
  }

  const events = useMemo(
    () => snapshot?.events.filter((event) => !event.calendarId || visibleCalendarIds.has(event.calendarId)) || [],
    [snapshot, visibleCalendarIds],
  )
  const calendars = snapshot?.calendars || []
  const openTaskSummary = openTask && snapshot?.tasks.find((item) => item.id === openTask.id)

  return (
    <div className="app-layout">
      <Sidebar
        selectedDate={selectedDate}
        visibleDays={visibleDays}
        calendars={calendars}
        visibleCalendarIds={visibleCalendarIds}
        sources={snapshot?.sources || []}
        tasks={snapshot?.tasks || []}
        onTaskOpen={(id, anchor) => setOpenTask({ id, anchor })}
        onTaskComplete={(id) => {
          void taskChange(id, { completed: true }).catch(() => {})
        }}
        syncBusy={busy}
        onDateChange={setSelectedDate}
        onToggleCalendar={toggleCalendar}
        onAddFeed={() => setFeedDialog(true)}
        onConnectGoogle={() => {
          window.location.href = '/api/google/connect'
        }}
        onSync={refresh}
        onSettings={() => setSettingsDialog(true)}
      />
      <main className="app-main">
        {Boolean(error || snapshot?.errors.length) && (
          <div className="status-banner">
            <IconAlertCircle />
            <span>{error || snapshot?.errors.join(' · ')}</span>
            <button aria-label="Dismiss" onClick={() => setError('')}>
              <IconX />
            </button>
          </div>
        )}
        {toast && (
          <div className="toast" role="status" onAnimationEnd={() => setToast('')}>
            {toast}
          </div>
        )}
        {undo && (
          <div className="toast toast-undo" role="status" key={undo.id} onAnimationEnd={() => setUndo(null)}>
            {undo.label}
            <button
              onClick={() => {
                undo.action()
                setUndo(null)
              }}
            >
              Undo
            </button>
          </div>
        )}
        {openTask && openTaskSummary && (
          <TaskPopover
            key={openTask.id}
            task={openTaskSummary}
            anchor={openTask.anchor}
            canEdit={snapshot?.connections.todoistCanWrite ?? false}
            onClose={() => setOpenTask(null)}
            onChange={(patch) => taskChange(openTask.id, patch)}
          />
        )}
        {!snapshot ? (
          <div className="loading-state">Loading your calendar…</div>
        ) : (
          <CalendarWorkspace
            events={events}
            calendars={calendars}
            date={selectedDate}
            toolbarActions={
              <>
                <button className="utility-button" aria-label="Add Maybe feed" onClick={() => setFeedDialog(true)}>
                  <IconCircleDashed /> <span className="utility-feed-label">Add Maybe feed</span>
                </button>
                <button className="utility-button" aria-label="Settings" onClick={() => setSettingsDialog(true)}>
                  {Boolean(snapshot.conflicts.length) && (
                    <span className="utility-conflict-count" aria-label={`${snapshot.conflicts.length} sync conflicts`}>
                      {snapshot.conflicts.length}
                    </span>
                  )}
                  {user.name
                    .split(' ')
                    .map((part) => part[0])
                    .slice(0, 2)
                    .join('')
                    .toUpperCase()}{' '}
                  <IconChevronDown />
                </button>
              </>
            }
            onDateChange={setSelectedDate}
            onVisibleDaysChange={visibleDaysChange}
            onVisibleRangeChange={visibleRange}
            onEventChange={eventSave}
            onEventCreate={eventCreate}
            onEventDelete={(event) => mutation(() => deleteGoogleEvent({ data: { id: event.id } }))}
            onRecurringEventChange={recurringSave}
            onRecurringEventDelete={(event, scope) =>
              mutation(() => deleteRecurringEvent({ data: { id: event.id, scope } }))
            }
            onFindOccurrence={(event, direction) => getAdjacentOccurrence({ data: { id: event.id, direction } })}
            onDecisionChange={(event, state, calendarId) =>
              mutation(() => decideExternalEvent({ data: { eventId: event.id, state, calendarId } }))
            }
            onTaskChange={taskChange}
            onTaskOpen={(id, anchor) => setOpenTask({ id, anchor })}
          />
        )}
      </main>

      {feedDialog && (
        <div className="dialog-backdrop" onMouseDown={() => setFeedDialog(false)}>
          <form className="app-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={addFeed}>
            <button className="dialog-close" type="button" onClick={() => setFeedDialog(false)} aria-label="Close">
              <IconX />
            </button>
            <div className="dialog-kicker">
              <IconCircleDashed /> MAYBE
            </div>
            <h2>Add a calendar feed</h2>
            <p>Events from this ICS feed stay undecided until you choose Yes, Maybe, or No.</p>
            <label>
              Feed name
              <input
                value={feedName}
                onChange={(event) => setFeedName(event.target.value)}
                placeholder="Community events"
                required
                autoFocus
              />
            </label>
            <label>
              ICS URL
              <input
                type="url"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
                placeholder="https://example.com/calendar.ics"
                required
              />
            </label>
            <button className="primary-button" disabled={busy}>
              <IconPlus /> Add feed
            </button>
          </form>
        </div>
      )}

      {settingsDialog && (
        <div className="dialog-backdrop" onMouseDown={() => setSettingsDialog(false)}>
          <div className="app-dialog settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <button className="dialog-close" onClick={() => setSettingsDialog(false)} aria-label="Close">
              <IconX />
            </button>
            <div className="dialog-kicker">WORKSPACE</div>
            <h2>Settings</h2>
            <p>{user.email}</p>
            <div className="settings-group">
              <h3>Connections</h3>
              <button
                onClick={() => {
                  window.location.href = '/api/google/connect'
                }}
              >
                {snapshot?.connections.google ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
              </button>
              <button
                onClick={() => {
                  window.location.href = '/api/todoist/connect'
                }}
              >
                {snapshot?.connections.todoist || snapshot?.connections.todoistNeedsReconnect
                  ? 'Reconnect Todoist'
                  : 'Connect Todoist'}
              </button>
            </div>
            <div className="settings-group">
              <h3>Calendar roles</h3>
              <p>
                Tasks use Default unless you choose another calendar. Click the selected Tasks role to return to
                Default.
              </p>
              {calendars.map((cal) => (
                <div className="setting-calendar" key={cal.id}>
                  <span className="setting-swatch" style={{ background: cal.color }} /> <span>{cal.name}</span>
                  <button
                    className={cal.isDefault ? 'active' : ''}
                    onClick={() => {
                      void mutation(() =>
                        setCalendarRole({ data: { calendarId: cal.id, role: 'default', active: true } }),
                      )
                    }}
                  >
                    Default
                  </button>
                  <button
                    className={cal.isMaybe ? 'active' : ''}
                    onClick={() => {
                      void mutation(() =>
                        setCalendarRole({ data: { calendarId: cal.id, role: 'maybe', active: true } }),
                      )
                    }}
                  >
                    Maybe
                  </button>
                  <button
                    className={snapshot?.taskCalendarId === cal.id ? 'active' : ''}
                    disabled={cal.accessRole !== 'owner' && cal.accessRole !== 'writer'}
                    aria-pressed={snapshot?.taskCalendarId === cal.id}
                    onClick={() => {
                      void mutation(() =>
                        setCalendarRole({ data: { calendarId: cal.id, role: 'tasks', active: !cal.isTasks } }),
                      )
                    }}
                  >
                    Tasks
                  </button>
                </div>
              ))}
            </div>
            <ProjectionConflicts
              conflicts={snapshot?.conflicts || []}
              busyId={conflictBusy}
              onResolve={(id, action) => void resolveConflict(id, action)}
            />
            <div className="settings-group">
              <h3>Maybe feeds</h3>
              {snapshot?.sources.map((source) => (
                <div className="setting-feed" key={source.id}>
                  <span>{source.name}</span>
                  <button onClick={() => void removeFeed(source.id, source.name)}>Remove</button>
                </div>
              ))}
            </div>
            <div className="settings-group">
              <h3>Account</h3>
              <button
                onClick={async () => {
                  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' })
                  location.reload()
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
