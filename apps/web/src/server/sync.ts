import { and, eq } from 'drizzle-orm'
import { db, accountAccess, calendar, connectedAccount, googleEvent, icsSource, taskConnection, userCalendarSetting } from '@kairo/db'
import { applyGoogleSnapshot, applyIcsSnapshot, applyTodoistSync, finishJob, leaseJobs, reconcileProjection, reconcileTaskBlock } from '@kairo/core'
import { fetchIcs, GoogleCalendarClient, parseIcs, refreshGoogleToken, syncGoogleEvents, syncTodoist } from '@kairo/integrations'
import { decryptJson, encryptJson, googleCredentials } from './credentials'

type StoredGoogle = { accessToken: string; refreshToken: string; expiresAt: number }
type StoredTodoist = { token: string }

export async function clientForCalendar(calendarId: string, userId?: string) {
  const [row] = await db.select({ cal: calendar, account: connectedAccount, access: accountAccess })
    .from(calendar).innerJoin(connectedAccount, eq(calendar.connectedAccountId, connectedAccount.id))
    .innerJoin(accountAccess, eq(accountAccess.connectedAccountId, connectedAccount.id))
    .where(userId ? and(eq(calendar.id, calendarId), eq(accountAccess.userId, userId)) : eq(calendar.id, calendarId))
  if (!row) throw new Response('Calendar unavailable', { status: 404 })
  if (!row.account.encryptedCredentials) throw new Error('Google account has no saved credentials')
  let token = decryptJson<StoredGoogle>(row.account.encryptedCredentials)
  if (token.expiresAt < Date.now() + 60_000) {
    try {
      const refreshed = await refreshGoogleToken(googleCredentials(), token.refreshToken)
      token = { accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || token.refreshToken, expiresAt: Date.now() + (refreshed.expires_in || 3600) * 1000 }
      await db.update(connectedAccount).set({ encryptedCredentials: encryptJson(token), status: 'connected', lastError: null, updatedAt: new Date() }).where(eq(connectedAccount.id, row.account.id))
    } catch (error) {
      await db.update(connectedAccount).set({ status: 'reconnect', lastError: String(error), updatedAt: new Date() }).where(eq(connectedAccount.id, row.account.id))
      throw error
    }
  }
  return { client: new GoogleCalendarClient(token.accessToken), cal: row.cal }
}

export async function saveGoogleConnection(userId: string, accessToken: string, refreshToken: string, expiresIn: number) {
  const client = new GoogleCalendarClient(accessToken)
  const remoteCalendars = await client.listCalendars()
  const primary = remoteCalendars.find((item) => item.primary)
  if (!primary) throw new Error('Google account has no primary calendar')
  let [account] = await db.select().from(connectedAccount).where(and(eq(connectedAccount.provider, 'google'), eq(connectedAccount.providerSubject, primary.id)))
  const credential = encryptJson({ accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 })
  if (account) {
    const old = account.encryptedCredentials ? decryptJson<StoredGoogle>(account.encryptedCredentials) : null
    await db.update(connectedAccount).set({ encryptedCredentials: encryptJson({ accessToken, refreshToken: refreshToken || old?.refreshToken || '', expiresAt: Date.now() + expiresIn * 1000 }), status: 'connected', lastError: null, updatedAt: new Date() }).where(eq(connectedAccount.id, account.id))
  } else {
    [account] = await db.insert(connectedAccount).values({ ownerUserId: userId, provider: 'google', providerSubject: primary.id, displayName: primary.id, encryptedCredentials: credential }).returning()
  }
  await db.insert(accountAccess).values({ userId, connectedAccountId: account.id, role: 'owner' }).onConflictDoNothing()
  for (const item of remoteCalendars) {
    const [cal] = await db.insert(calendar).values({ connectedAccountId: account.id, googleCalendarId: item.id, name: item.summary || item.id, color: item.backgroundColor || '#8580b2', accessRole: item.accessRole || 'reader', timeZone: item.timeZone || null })
      .onConflictDoUpdate({ target: [calendar.connectedAccountId, calendar.googleCalendarId], set: { name: item.summary || item.id, color: item.backgroundColor || '#8580b2', accessRole: item.accessRole || 'reader', timeZone: item.timeZone || null, updatedAt: new Date() } }).returning()
    await db.insert(userCalendarSetting).values({ userId, calendarId: cal.id, visible: true, isDefault: item.primary || false, isMaybe: /maybe/i.test(item.summary || '') }).onConflictDoNothing()
  }
  return account
}

export async function syncGoogleCalendar(calendarId: string) {
  const { client, cal } = await clientForCalendar(calendarId)
  try {
    await syncGoogleEvents(client, cal.googleCalendarId, cal.syncCursor, async (events, cursor, { full }) => {
      const previous = await db.select({ googleEventId: googleEvent.googleEventId, colorId: googleEvent.colorId, color: googleEvent.color }).from(googleEvent).where(eq(googleEvent.calendarId, cal.id))
      const previousById = new Map(previous.map((item) => [item.googleEventId, item]))
      await applyGoogleSnapshot(db, cal.id, events, cursor, full)
      if (events.some((item) => item.colorId)) {
        try {
          const palette = (await client.getColors()).event
          for (const item of events) {
            if (!item.colorId || !palette[item.colorId]) continue
            const old = previousById.get(item.id)
            if (!old?.color || old.colorId !== item.colorId) await db.update(googleEvent).set({ color: palette[item.colorId].background }).where(and(eq(googleEvent.calendarId, cal.id), eq(googleEvent.googleEventId, item.id)))
          }
        } catch (error) { console.error('Google color palette unavailable', error) }
      }
    })
  } catch (error) {
    await db.update(calendar).set({ syncStatus: 'error', lastError: String(error), updatedAt: new Date() }).where(eq(calendar.id, calendarId))
    throw error
  }
}

export async function syncIcsSource(sourceId: string) {
  const [source] = await db.select().from(icsSource).where(eq(icsSource.id, sourceId))
  if (!source || source.status === 'removed') return
  try {
    const response = await fetchIcs(source.url, { etag: source.etag, lastModified: source.lastModified })
    if (response.status === 'not-modified') return
    const start = new Date(); start.setMonth(start.getMonth() - 6)
    const end = new Date(); end.setMonth(end.getMonth() + 18)
    const occurrences = parseIcs(response.body, start, end)
    await applyIcsSnapshot(db, sourceId, occurrences, response, { start, end })
  } catch (error) {
    await db.update(icsSource).set({ status: 'error', lastError: String(error), updatedAt: new Date() }).where(eq(icsSource.id, sourceId))
    throw error
  }
}

export async function ensureTodoistConnection(userId: string) {
  const [existing] = await db.select().from(taskConnection).where(eq(taskConnection.ownerUserId, userId))
  if (existing) return existing
  const token = process.env.TODOIST_API_TOKEN
  if (!token) return null
  const [connection] = await db.insert(taskConnection).values({ ownerUserId: userId, encryptedCredentials: encryptJson({ token }) }).returning()
  return connection
}

export async function syncTodoistConnection(connectionId: string) {
  const [connection] = await db.select().from(taskConnection).where(eq(taskConnection.id, connectionId))
  if (!connection) return
  const token = connection.encryptedCredentials ? decryptJson<StoredTodoist>(connection.encryptedCredentials).token : process.env.TODOIST_API_TOKEN
  if (!token) throw new Error('Todoist token missing')
  try {
    const result = await syncTodoist(token, connection.syncToken)
    await applyTodoistSync(db, connection.id, result)
  } catch (error) {
    await db.update(taskConnection).set({ status: 'error', lastError: String(error), updatedAt: new Date() }).where(eq(taskConnection.id, connection.id))
    throw error
  }
}

export async function processJobs() {
  const jobs = await leaseJobs(db)
  for (const job of jobs) {
    try {
      if (job.kind === 'projection') await reconcileProjection(db, job.targetId, async (id) => (await clientForCalendar(id)).client)
      if (job.kind === 'task-block') await reconcileTaskBlock(db, job.targetId, async (id) => (await clientForCalendar(id)).client)
      await finishJob(db, job.id)
    } catch (error) { await finishJob(db, job.id, error) }
  }
}

export async function syncAll(userId: string) {
  const results: string[] = []
  const accounts = await db.select({ calendarId: calendar.id }).from(calendar)
    .innerJoin(accountAccess, eq(accountAccess.connectedAccountId, calendar.connectedAccountId)).where(eq(accountAccess.userId, userId))
  for (const item of accounts) try { await syncGoogleCalendar(item.calendarId) } catch (error) { results.push(String(error)) }
  const sources = await db.select().from(icsSource).where(eq(icsSource.ownerUserId, userId))
  for (const source of sources) if (source.status !== 'removed') try { await syncIcsSource(source.id) } catch (error) { results.push(String(error)) }
  const connection = await ensureTodoistConnection(userId)
  if (connection) try { await syncTodoistConnection(connection.id) } catch (error) { results.push(String(error)) }
  await processJobs()
  return { errors: results }
}
