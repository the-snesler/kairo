export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'

export type GoogleCredentials = { clientId: string; clientSecret: string; redirectUri: string }
export type GoogleTokens = { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string }
export type GoogleEvent = {
  id: string
  etag?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  colorId?: string
  eventType?: string
  recurringEventId?: string
  originalStartTime?: GoogleTime
  start?: GoogleTime
  end?: GoogleTime
  recurrence?: string[]
  attendees?: Array<{ email?: string; responseStatus?: string; self?: boolean }>
  extendedProperties?: { private?: Record<string, string> }
  updated?: string
}
export type GoogleTime = { date?: string; dateTime?: string; timeZone?: string }
export type GoogleCalendar = {
  id: string
  summary?: string
  backgroundColor?: string
  colorId?: string
  accessRole?: string
  primary?: boolean
  timeZone?: string
}
export type GoogleColors = {
  calendar: Record<string, { background: string; foreground: string }>
  event: Record<string, { background: string; foreground: string }>
}
// Event colors as Google Calendar's UI draws them. The API takes only these ids, and its /colors endpoint
// still returns the older pastel palette, which matches poorly (e.g. grey lands on Basil).
export const GOOGLE_EVENT_COLORS: Record<string, string> = {
  '1': '#7986cb',
  '2': '#33b679',
  '3': '#8e24aa',
  '4': '#e67c73',
  '5': '#f6bf26',
  '6': '#f4511e',
  '7': '#039be5',
  '8': '#616161',
  '9': '#3f51b5',
  '10': '#0b8043',
  '11': '#d50000',
}
const GRAPHITE = '8'
// sRGB hex → OKLCh (lightness, chroma, hue in radians).
function oklch(hex: string) {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const c = parseInt(hex.slice(index, index + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, Math.hypot(A, B), Math.atan2(B, A)]
}
/** Id of the Google event color nearest to a #rrggbb hex: greys go to Graphite, other colors match mostly on hue. */
export function closestEventColorId(hex: string) {
  const [L, C, H] = oklch(hex)
  if (C < 0.06) return GRAPHITE
  const distance = (candidate: string) => {
    const [L2, C2, H2] = oklch(candidate)
    const dh = Math.min(Math.abs(H - H2), 2 * Math.PI - Math.abs(H - H2))
    return (0.3 * (L - L2)) ** 2 + 0.5 * (C - C2) ** 2 + 4 * (Math.min(C, C2) * dh) ** 2
  }
  return Object.entries(GOOGLE_EVENT_COLORS)
    .filter(([id]) => id !== GRAPHITE)
    .sort(([, a], [, b]) => distance(a) - distance(b))[0][0]
}
export class GoogleApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GoogleApiError'
  }
}

export function googleAuthorizationUrl(credentials: GoogleCredentials, state: string) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: credentials.redirectUri,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString()
  return url.toString()
}

async function tokenRequest(credentials: GoogleCredentials, params: Record<string, string>): Promise<GoogleTokens> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, ...params }),
  })
  const data = (await response.json()) as GoogleTokens & { error?: string }
  if (!response.ok) throw new GoogleApiError(response.status, data.error ?? 'Google token exchange failed')
  return data
}

export function exchangeGoogleCode(credentials: GoogleCredentials, code: string) {
  return tokenRequest(credentials, { code, redirect_uri: credentials.redirectUri, grant_type: 'authorization_code' })
}
export function refreshGoogleToken(credentials: GoogleCredentials, refreshToken: string) {
  return tokenRequest(credentials, { refresh_token: refreshToken, grant_type: 'refresh_token' })
}

export class GoogleCalendarClient {
  constructor(
    private accessToken: string,
    private requestFetch: typeof fetch = fetch,
  ) {}
  private async request<T>(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<T> {
    const response = await this.requestFetch(`https://www.googleapis.com/calendar/v3${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) throw new GoogleApiError(response.status, await response.text())
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>)
  }
  async listCalendars(): Promise<GoogleCalendar[]> {
    const all: GoogleCalendar[] = []
    let pageToken: string | undefined
    do {
      const q = new URLSearchParams({ maxResults: '250' })
      if (pageToken) q.set('pageToken', pageToken)
      const page = await this.request<{ items?: GoogleCalendar[]; nextPageToken?: string }>(
        `/users/me/calendarList?${q}`,
      )
      all.push(...(page.items ?? []))
      pageToken = page.nextPageToken
    } while (pageToken)
    return all
  }
  getColors() {
    return this.request<GoogleColors>('/colors')
  }
  async listRangeEvents(calendarId: string, start: Date, end: Date): Promise<GoogleEvent[]> {
    const all: GoogleEvent[] = []
    let pageToken: string | undefined
    do {
      const q = new URLSearchParams({
        singleEvents: 'true',
        showDeleted: 'false',
        maxResults: '2500',
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
      })
      if (pageToken) q.set('pageToken', pageToken)
      const page = await this.request<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
      )
      all.push(...(page.items ?? []))
      pageToken = page.nextPageToken
    } while (pageToken)
    return all
  }
  async listEventPage(calendarId: string, syncToken?: string, pageToken?: string) {
    // No time-window filters: the exact same query is valid for full and incremental sync.
    const q = new URLSearchParams({ maxResults: '2500', showDeleted: 'true', singleEvents: 'false' })
    if (syncToken) q.set('syncToken', syncToken)
    if (pageToken) q.set('pageToken', pageToken)
    return this.request<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
      `/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
    )
  }
  getEvent(calendarId: string, eventId: string) {
    return this.request<GoogleEvent>(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    )
  }
  createEvent(calendarId: string, event: Partial<GoogleEvent>) {
    return this.request<GoogleEvent>(`/calendars/${encodeURIComponent(calendarId)}/events`, 'POST', event)
  }
  updateEvent(calendarId: string, eventId: string, event: Partial<GoogleEvent>, etag?: string) {
    return this.request<GoogleEvent>(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      'PATCH',
      event,
      etag ? { 'If-Match': etag } : undefined,
    )
  }
  deleteEvent(calendarId: string, eventId: string, etag?: string) {
    return this.request<void>(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      'DELETE',
      undefined,
      etag ? { 'If-Match': etag } : undefined,
    )
  }
  moveEvent(fromCalendarId: string, eventId: string, toCalendarId: string) {
    const q = new URLSearchParams({ destination: toCalendarId })
    return this.request<GoogleEvent>(
      `/calendars/${encodeURIComponent(fromCalendarId)}/events/${encodeURIComponent(eventId)}/move?${q}`,
      'POST',
    )
  }
  async findByPrivateProperty(calendarId: string, key: string, value: string): Promise<GoogleEvent | undefined> {
    const q = new URLSearchParams({ privateExtendedProperty: `${key}=${value}`, maxResults: '1' })
    const page = await this.request<{ items?: GoogleEvent[] }>(
      `/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
    )
    return page.items?.[0]
  }
  findProjection(calendarId: string, projectionId: string) {
    return this.findByPrivateProperty(calendarId, 'kairoProjectionId', projectionId)
  }
}

export async function syncGoogleEvents(
  client: GoogleCalendarClient,
  calendarId: string,
  cursor: string | null,
  apply: (events: GoogleEvent[], cursor: string, context: { full: boolean; complete: boolean }) => Promise<void>,
) {
  async function run(token?: string) {
    const events: GoogleEvent[] = []
    let pageToken: string | undefined
    let nextSyncToken: string | undefined
    do {
      const page = await client.listEventPage(calendarId, token, pageToken)
      events.push(...(page.items ?? []))
      pageToken = page.nextPageToken
      nextSyncToken = page.nextSyncToken
    } while (pageToken)
    if (!nextSyncToken) throw new Error('Google event sync ended without a cursor')
    // Apply a complete snapshot atomically with the new cursor at the storage boundary.
    await apply(events, nextSyncToken, { full: !token, complete: true })
    return nextSyncToken
  }
  try {
    return await run(cursor ?? undefined)
  } catch (error) {
    if (cursor && error instanceof GoogleApiError && error.status === 410) return run()
    throw error
  }
}
