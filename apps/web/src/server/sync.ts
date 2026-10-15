import { and, eq, isNotNull } from 'drizzle-orm'
import {
  db,
  accountAccess,
  calendar,
  connectedAccount,
  googleEvent,
  icsSource,
  task,
  taskConnection,
  userCalendarSetting,
} from '@kairo/db'
import {
  applyGoogleSnapshot,
  applyIcsSnapshot,
  applyTaskBlockMoves,
  applyTaskSync,
  clearPendingFields,
  enqueueJob,
  finishJob,
  leaseJobs,
  pushPendingPatch,
  reconcileProjection,
  reconcileTaskBlock,
  syncTaskBlocks,
} from '@kairo/core'
import {
  createTodoistProvider,
  fetchIcs,
  GOOGLE_EVENT_COLORS,
  GoogleCalendarClient,
  parseIcs,
  refreshGoogleToken,
  syncGoogleEvents,
  TODOIST_SCOPE,
  type TaskCreate,
  type TaskProvider,
  type TodoistOAuthToken,
} from '@kairo/integrations'
import { decryptJson, encryptJson, googleCredentials, todoistCredentials } from './credentials'

type StoredGoogle = { accessToken: string; refreshToken: string; expiresAt: number }
type StoredTaskTokens = { accessToken: string; refreshToken?: string; expiresAt: number }
const taskRefreshes = new Map<string, Promise<StoredTaskTokens>>()
export const taskProviders: Record<string, TaskProvider> = {
  todoist: createTodoistProvider({ oauth: todoistCredentials }),
}

export function taskProviderFor(connection: { provider: string }) {
  const provider = taskProviders[connection.provider]
  if (!provider) throw new Error(`Unknown task provider: ${connection.provider}`)
  return provider
}

export const connectionCanWrite = (connection: { provider: string; scope: string | null; status: string }) =>
  connection.status !== 'reconnect' && (taskProviders[connection.provider]?.canWrite?.(connection.scope) ?? true)

export async function clientForCalendar(calendarId: string, userId?: string) {
  const [row] = await db
    .select({ cal: calendar, account: connectedAccount, access: accountAccess })
    .from(calendar)
    .innerJoin(connectedAccount, eq(calendar.connectedAccountId, connectedAccount.id))
    .innerJoin(accountAccess, eq(accountAccess.connectedAccountId, connectedAccount.id))
    .where(userId ? and(eq(calendar.id, calendarId), eq(accountAccess.userId, userId)) : eq(calendar.id, calendarId))
  if (!row) throw new Response('Calendar unavailable', { status: 404 })
  if (!row.account.encryptedCredentials) throw new Error('Google account has no saved credentials')
  let token = decryptJson<StoredGoogle>(row.account.encryptedCredentials)
  if (token.expiresAt < Date.now() + 60_000) {
    try {
      const refreshed = await refreshGoogleToken(googleCredentials(), token.refreshToken)
      token = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || token.refreshToken,
        expiresAt: Date.now() + (refreshed.expires_in || 3600) * 1000,
      }
      await db
        .update(connectedAccount)
        .set({ encryptedCredentials: encryptJson(token), status: 'connected', lastError: null, updatedAt: new Date() })
        .where(eq(connectedAccount.id, row.account.id))
    } catch (error) {
      await db
        .update(connectedAccount)
        .set({ status: 'reconnect', lastError: String(error), updatedAt: new Date() })
        .where(eq(connectedAccount.id, row.account.id))
      throw error
    }
  }
  return { client: new GoogleCalendarClient(token.accessToken), cal: row.cal }
}

export async function saveGoogleConnection(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
) {
  const client = new GoogleCalendarClient(accessToken)
  const remoteCalendars = await client.listCalendars()
  const primary = remoteCalendars.find((item) => item.primary)
  if (!primary) throw new Error('Google account has no primary calendar')
  let [account] = await db
    .select()
    .from(connectedAccount)
    .where(and(eq(connectedAccount.provider, 'google'), eq(connectedAccount.providerSubject, primary.id)))
  const credential = encryptJson({ accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 })
  if (account) {
    const old = account.encryptedCredentials ? decryptJson<StoredGoogle>(account.encryptedCredentials) : null
    await db
      .update(connectedAccount)
      .set({
        encryptedCredentials: encryptJson({
          accessToken,
          refreshToken: refreshToken || old?.refreshToken || '',
          expiresAt: Date.now() + expiresIn * 1000,
        }),
        status: 'connected',
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(connectedAccount.id, account.id))
  } else {
    ;[account] = await db
      .insert(connectedAccount)
      .values({
        ownerUserId: userId,
        provider: 'google',
        providerSubject: primary.id,
        displayName: primary.id,
        encryptedCredentials: credential,
      })
      .returning()
  }
  await db.insert(accountAccess).values({ userId, connectedAccountId: account.id, role: 'owner' }).onConflictDoNothing()
  for (const item of remoteCalendars) {
    const [cal] = await db
      .insert(calendar)
      .values({
        connectedAccountId: account.id,
        googleCalendarId: item.id,
        name: item.summary || item.id,
        color: item.backgroundColor || '#8580b2',
        accessRole: item.accessRole || 'reader',
        timeZone: item.timeZone || null,
      })
      .onConflictDoUpdate({
        target: [calendar.connectedAccountId, calendar.googleCalendarId],
        set: {
          name: item.summary || item.id,
          color: item.backgroundColor || '#8580b2',
          accessRole: item.accessRole || 'reader',
          timeZone: item.timeZone || null,
          updatedAt: new Date(),
        },
      })
      .returning()
    await db
      .insert(userCalendarSetting)
      .values({
        userId,
        calendarId: cal.id,
        visible: true,
        isDefault: item.primary || false,
        isMaybe: /maybe/i.test(item.summary || ''),
      })
      .onConflictDoNothing()
  }
  return account
}

export async function syncGoogleCalendar(calendarId: string) {
  const { client, cal } = await clientForCalendar(calendarId)
  try {
    await syncGoogleEvents(client, cal.googleCalendarId, cal.syncCursor, async (events, cursor, { full }) => {
      const previous = await db
        .select({ googleEventId: googleEvent.googleEventId, colorId: googleEvent.colorId, color: googleEvent.color })
        .from(googleEvent)
        .where(eq(googleEvent.calendarId, cal.id))
      const previousById = new Map(previous.map((item) => [item.googleEventId, item]))
      await applyGoogleSnapshot(db, cal.id, events, cursor, full)
      for (const item of events) {
        const color = item.colorId && GOOGLE_EVENT_COLORS[item.colorId]
        if (!color) continue
        const old = previousById.get(item.id)
        if (!old?.color || old.colorId !== item.colorId)
          await db
            .update(googleEvent)
            .set({ color })
            .where(and(eq(googleEvent.calendarId, cal.id), eq(googleEvent.googleEventId, item.id)))
      }
    })
    await applyTaskBlockMoves(db, cal.id, connectionCanWrite)
  } catch (error) {
    await db
      .update(calendar)
      .set({ syncStatus: 'error', lastError: String(error), updatedAt: new Date() })
      .where(eq(calendar.id, calendarId))
    throw error
  }
}

export async function syncIcsSource(sourceId: string) {
  const [source] = await db.select().from(icsSource).where(eq(icsSource.id, sourceId))
  if (!source || source.status === 'removed') return
  try {
    const response = await fetchIcs(source.url, { etag: source.etag, lastModified: source.lastModified })
    if (response.status === 'not-modified') return
    const start = new Date()
    start.setMonth(start.getMonth() - 6)
    const end = new Date()
    end.setMonth(end.getMonth() + 18)
    const occurrences = parseIcs(response.body, start, end)
    await applyIcsSnapshot(db, sourceId, occurrences, response, { start, end })
  } catch (error) {
    await db
      .update(icsSource)
      .set({ status: 'error', lastError: String(error), updatedAt: new Date() })
      .where(eq(icsSource.id, sourceId))
    throw error
  }
}

export async function saveTodoistConnection(userId: string, providerSubject: string, tokens: TodoistOAuthToken) {
  const [existing] = await db.select().from(taskConnection).where(eq(taskConnection.ownerUserId, userId))
  if (existing?.providerSubject && existing.providerSubject !== providerSubject)
    throw new Error(
      'This workspace already has Todoist tasks from a different account. Reconnect the original account to preserve scheduled blocks.',
    )
  const credentials = encryptJson({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  } satisfies StoredTaskTokens)
  // Todoist may omit scope from the token response; we only ever request TODOIST_SCOPE.
  const scope = tokens.scope || TODOIST_SCOPE
  if (existing) {
    const [connection] = await db
      .update(taskConnection)
      .set({
        providerSubject,
        encryptedCredentials: credentials,
        scope,
        status: 'connected',
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(taskConnection.id, existing.id))
      .returning()
    return connection
  }
  const [connection] = await db
    .insert(taskConnection)
    .values({
      ownerUserId: userId,
      provider: 'todoist',
      providerSubject,
      encryptedCredentials: credentials,
      scope,
      status: 'connected',
    })
    .returning()
  return connection
}

// Task provider credentials are { accessToken, refreshToken?, expiresAt }; refreshing goes through the provider.
async function taskAccessToken(connectionId: string, provider: TaskProvider, force = false): Promise<string> {
  const label = provider.label ?? provider.id
  const [connection] = await db.select().from(taskConnection).where(eq(taskConnection.id, connectionId))
  if (!connection?.encryptedCredentials) throw new Error(`${label} is not connected`)
  if (connection.status === 'reconnect') throw new Error(`Reconnect ${label} to resume sync`)
  const encryptedCredentials = connection.encryptedCredentials
  const stored = decryptJson<StoredTaskTokens>(encryptedCredentials)
  if (!stored.accessToken || !Number.isFinite(stored.expiresAt)) {
    await db
      .update(taskConnection)
      .set({ status: 'reconnect', lastError: `Reconnect ${label} to replace the old API token`, updatedAt: new Date() })
      .where(eq(taskConnection.id, connectionId))
    throw new Error(`Reconnect ${label} to replace the old API token`)
  }
  if (!force && stored.expiresAt > Date.now() + 60_000) return stored.accessToken
  if (!stored.refreshToken || !provider.refreshToken) {
    if (!force && stored.expiresAt > Date.now()) return stored.accessToken
    await db
      .update(taskConnection)
      .set({ status: 'reconnect', lastError: `${label} access expired; reconnect your account`, updatedAt: new Date() })
      .where(eq(taskConnection.id, connectionId))
    throw new Error(`${label} access expired; reconnect your account`)
  }
  const inProgress = taskRefreshes.get(connectionId)
  if (inProgress) return (await inProgress).accessToken
  const refresh = (async (): Promise<StoredTaskTokens> => {
    try {
      const tokens = await provider.refreshToken!(stored.refreshToken!)
      const [latest] = await db.select().from(taskConnection).where(eq(taskConnection.id, connectionId))
      if (latest?.encryptedCredentials !== encryptedCredentials && latest?.encryptedCredentials)
        return decryptJson<StoredTaskTokens>(latest.encryptedCredentials)
      if (!tokens.refreshToken) {
        await db
          .update(taskConnection)
          .set({
            status: 'reconnect',
            lastError: `${label} did not return the rotated refresh token. Reconnect to avoid token replay.`,
            updatedAt: new Date(),
          })
          .where(eq(taskConnection.id, connectionId))
        throw new Error(`${label} refresh token could not be recovered; reconnect your account`)
      }
      const next: StoredTaskTokens = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: Date.now() + tokens.expiresIn * 1000,
      }
      const updated = await db
        .update(taskConnection)
        .set({
          encryptedCredentials: encryptJson(next),
          status: 'connected',
          lastError: null,
          updatedAt: new Date(),
          ...(tokens.scope ? { scope: tokens.scope } : {}),
        })
        .where(and(eq(taskConnection.id, connectionId), eq(taskConnection.encryptedCredentials, encryptedCredentials)))
        .returning()
      if (!updated.length) {
        const [newer] = await db.select().from(taskConnection).where(eq(taskConnection.id, connectionId))
        if (newer?.encryptedCredentials) return decryptJson<StoredTaskTokens>(newer.encryptedCredentials)
        throw new Error(`${label} connection disappeared during refresh`)
      }
      return next
    } catch (error) {
      if (['invalid-grant', 'unauthorized'].includes(provider.classifyError?.(error) ?? 'transient')) {
        await db
          .update(taskConnection)
          .set({
            status: 'reconnect',
            lastError: `${label} authorization expired; reconnect your account`,
            updatedAt: new Date(),
          })
          .where(
            and(eq(taskConnection.id, connectionId), eq(taskConnection.encryptedCredentials, encryptedCredentials)),
          )
      }
      throw error
    }
  })()
  taskRefreshes.set(connectionId, refresh)
  try {
    return (await refresh).accessToken
  } finally {
    taskRefreshes.delete(connectionId)
  }
}

// Runs a provider call with a fresh token, refreshing once when the provider says the token was rejected.
async function withTaskToken<T>(connectionId: string, provider: TaskProvider, run: (token: string) => Promise<T>) {
  const unauthorized = (error: unknown) => provider.classifyError?.(error) === 'unauthorized'
  try {
    return await run(await taskAccessToken(connectionId, provider))
  } catch (error) {
    if (!unauthorized(error)) throw error
    const token = await taskAccessToken(connectionId, provider, true)
    try {
      return await run(token)
    } catch (retryError) {
      if (unauthorized(retryError))
        await db
          .update(taskConnection)
          .set({
            status: 'reconnect',
            lastError: `${provider.label ?? provider.id} rejected the renewed token; reconnect your account`,
            updatedAt: new Date(),
          })
          .where(eq(taskConnection.id, connectionId))
      throw retryError
    }
  }
}

// A Tasks calendar overrides Default; retain the first writable fallback when neither is set.
export async function taskMirrorCalendarId(userId: string) {
  const rows = await db
    .select({ cal: calendar, setting: userCalendarSetting })
    .from(calendar)
    .innerJoin(accountAccess, eq(calendar.connectedAccountId, accountAccess.connectedAccountId))
    .leftJoin(
      userCalendarSetting,
      and(eq(userCalendarSetting.calendarId, calendar.id), eq(userCalendarSetting.userId, userId)),
    )
    .where(eq(accountAccess.userId, userId))
  const writable = rows.filter((row) => row.cal.accessRole === 'owner' || row.cal.accessRole === 'writer')
  return (
    (writable.find((row) => row.setting?.isTasks) ?? writable.find((row) => row.setting?.isDefault) ?? writable[0])?.cal
      .id ?? null
  )
}

export async function syncTaskConnection(connectionId: string) {
  const [connection] = await db.select().from(taskConnection).where(eq(taskConnection.id, connectionId))
  if (!connection) return
  try {
    const provider = taskProviderFor(connection)
    const result = await withTaskToken(connectionId, provider, (token) => provider.sync(token, connection.syncToken))
    const touched = await applyTaskSync(db, connection.id, result)
    await syncTaskBlocks(
      db,
      { connectionId: connection.id },
      await taskMirrorCalendarId(connection.ownerUserId),
      touched,
    )
  } catch (error) {
    const [current] = await db.select().from(taskConnection).where(eq(taskConnection.id, connectionId))
    if (current?.status !== 'reconnect')
      await db
        .update(taskConnection)
        .set({ status: 'error', lastError: String(error), updatedAt: new Date() })
        .where(eq(taskConnection.id, connection.id))
    throw error
  }
}
export const syncTodoistConnection = syncTaskConnection

// Drops pending edits that can never be sent and forces a full resync so the provider's values show again.
async function discardPending(
  connectionId: string,
  tasks: { id: string; pendingPatch: string | null }[],
  lastError?: string,
) {
  for (const item of tasks) if (item.pendingPatch) clearPendingFields(db, item.id, JSON.parse(item.pendingPatch))
  await db.update(taskConnection).set({ syncToken: null }).where(eq(taskConnection.id, connectionId))
  await syncTaskConnection(connectionId).catch((error) => console.error('Task resync failed', error))
  if (lastError)
    await db.update(taskConnection).set({ lastError, updatedAt: new Date() }).where(eq(taskConnection.id, connectionId))
}

// After a (re)connect: push parked edits if we can write now, otherwise give them up.
export async function resumePendingPushes(connectionId: string) {
  const [connection] = await db.select().from(taskConnection).where(eq(taskConnection.id, connectionId))
  if (!connection) return
  const pending = await db
    .select({ id: task.id, pendingPatch: task.pendingPatch })
    .from(task)
    .where(and(eq(task.connectionId, connectionId), isNotNull(task.pendingPatch)))
  if (!pending.length) return
  if (!connectionCanWrite(connection))
    return discardPending(
      connectionId,
      pending,
      `Reconnect ${taskProviderFor(connection).label ?? connection.provider} to edit tasks`,
    )
  for (const item of pending) await enqueueJob(db, 'task-push', item.id)
}

export async function pushTask(taskId: string) {
  const [row] = await db
    .select({ item: task, connection: taskConnection })
    .from(task)
    .innerJoin(taskConnection, eq(task.connectionId, taskConnection.id))
    .where(eq(task.id, taskId))
  if (!row?.item.pendingPatch) return
  const { item, connection } = row
  const provider = taskProviderFor(connection)
  const label = provider.label ?? provider.id
  // Waiting on a reconnect: park (resumePendingPushes re-enqueues). Sync can't run either, so nothing is masked meanwhile.
  if (connection.status === 'reconnect') return
  // Connected without write access: these edits can never be sent.
  if (!connectionCanWrite(connection)) return discardPending(connection.id, [item], `Reconnect ${label} to edit tasks`)
  const context = {
    current:
      item.dueDate || item.dueDateTime
        ? {
            timed: !!item.dueDateTime,
            recurring: item.dueRecurring,
            string: item.dueString,
            timeZone: item.dueTimeZone,
          }
        : null,
    cursor: connection.syncToken,
  }
  const result = await pushPendingPatch(
    db,
    taskId,
    (current, patch) =>
      withTaskToken(connection.id, provider, (token) => provider.update(token, current.todoistId, patch, context)),
    (error) => ['rejected', 'forbidden'].includes(provider.classifyError?.(error) ?? 'transient'),
  )
  if (result.status === 'rejected') {
    const forbidden = provider.classifyError?.(result.error) === 'forbidden'
    if (forbidden) await db.update(taskConnection).set({ scope: null }).where(eq(taskConnection.id, connection.id))
    const message = forbidden
      ? `Reconnect ${label} to edit tasks`
      : result.error instanceof Error
        ? result.error.message
        : String(result.error)
    return discardPending(connection.id, [], `Couldn't update "${item.content}": ${message}`)
  }
  // Recurring tasks change shape on the provider side (closing advances the due date), so read it back now.
  if (result.status === 'pushed' && item.dueRecurring)
    await syncTaskConnection(connection.id).catch((error) => console.error('Task resync failed', error))
}

// Creates the task with the provider, stores it right away, then syncs to fill in what the provider decided (project).
export async function createProviderTask(userId: string, input: TaskCreate) {
  const connections = await db.select().from(taskConnection).where(eq(taskConnection.ownerUserId, userId))
  const connection = connections.find(
    (item) =>
      !!item.providerSubject &&
      !!item.encryptedCredentials &&
      !!taskProviders[item.provider]?.create &&
      connectionCanWrite(item),
  )
  if (!connection)
    throw new Error(connections.length ? 'Reconnect Todoist to create tasks' : 'Connect Todoist to create tasks')
  const provider = taskProviderFor(connection)
  const externalId = await withTaskToken(connection.id, provider, (token) =>
    provider.create!(token, input, { cursor: connection.syncToken }),
  )
  const timed = !!input.due && 'dateTime' in input.due
  const [created] = await db
    .insert(task)
    .values({
      connectionId: connection.id,
      todoistId: externalId,
      content: input.title,
      description: input.description || null,
      dueDate: input.due && 'date' in input.due ? input.due.date : null,
      dueDateTime: input.due && 'dateTime' in input.due ? new Date(input.due.dateTime) : null,
      durationMinutes: timed ? (input.durationMinutes ?? null) : null,
      // The length picked on the calendar is the user's choice, so later syncs can't shorten it.
      durationOverrideMinutes: timed ? (input.durationMinutes ?? null) : null,
    })
    .onConflictDoNothing()
    .returning()
  if (created) await syncTaskBlocks(db, { taskIds: [created.id] }, await taskMirrorCalendarId(userId), [created.id])
  await syncTaskConnection(connection.id).catch((error) => console.error('Task sync failed', error))
  return created?.id ?? null
}

export async function processJobs() {
  const jobs = await leaseJobs(db)
  for (const job of jobs) {
    try {
      if (job.kind === 'projection')
        await reconcileProjection(db, job.targetId, async (id) => (await clientForCalendar(id)).client)
      if (job.kind === 'task-block')
        await reconcileTaskBlock(db, job.targetId, async (id) => (await clientForCalendar(id)).client)
      if (job.kind === 'task-push') await pushTask(job.targetId)
      await finishJob(db, job)
    } catch (error) {
      await finishJob(db, job, error)
    }
  }
}

export async function syncAll(userId: string) {
  const results: string[] = []
  const accounts = await db
    .select({ calendarId: calendar.id })
    .from(calendar)
    .innerJoin(accountAccess, eq(accountAccess.connectedAccountId, calendar.connectedAccountId))
    .where(eq(accountAccess.userId, userId))
  for (const item of accounts)
    try {
      await syncGoogleCalendar(item.calendarId)
    } catch (error) {
      results.push(String(error))
    }
  const sources = await db.select().from(icsSource).where(eq(icsSource.ownerUserId, userId))
  for (const source of sources)
    if (source.status !== 'removed')
      try {
        await syncIcsSource(source.id)
      } catch (error) {
        results.push(String(error))
      }
  const [connection] = await db.select().from(taskConnection).where(eq(taskConnection.ownerUserId, userId))
  if (connection)
    try {
      await syncTodoistConnection(connection.id)
    } catch (error) {
      results.push(String(error))
    }
  await processJobs()
  return { errors: results }
}
