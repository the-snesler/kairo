import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const dateInput = z.string().datetime({ offset: true })
const rangeInput = z.object({ start: dateInput, end: dateInput })
const decisionInput = z.object({ eventId: z.string(), state: z.enum(['undecided', 'yes', 'maybe', 'no']), calendarId: z.string().optional() })
const eventInput = z.object({ id: z.string().optional(), title: z.string().trim().min(1).max(500), start: dateInput, end: dateInput, allDay: z.boolean().default(false), calendarId: z.string(), eventColor: z.string().regex(/^#[a-fA-F0-9]{6}$/).optional(), description: z.string().max(20_000).optional(), location: z.string().max(500).optional() })

// TanStack replaces handler bodies with RPC stubs in the client build.
export const getViewer = createServerFn({ method: 'GET' }).handler(async () => (await import('./calendar.server')).getViewerImpl())
export const getCalendarSnapshot = createServerFn({ method: 'GET' }).validator(rangeInput).handler(async ({ data }) => (await import('./calendar.server')).getCalendarSnapshotImpl(data))
export const syncNow = createServerFn({ method: 'POST' }).handler(async () => (await import('./calendar.server')).syncNowImpl())
export const addIcsFeed = createServerFn({ method: 'POST' }).validator(z.object({ url: z.string().url(), name: z.string().trim().min(1).max(100) })).handler(async ({ data }) => (await import('./calendar.server')).addIcsFeedImpl(data))
export const deleteIcsFeed = createServerFn({ method: 'POST' }).validator(z.object({ id: z.string() })).handler(async ({ data }) => (await import('./calendar.server')).deleteIcsFeedImpl(data))
export const setCalendarVisibility = createServerFn({ method: 'POST' }).validator(z.object({ calendarId: z.string(), visible: z.boolean() })).handler(async ({ data }) => (await import('./calendar.server')).setCalendarVisibilityImpl(data))
export const setCalendarRole = createServerFn({ method: 'POST' }).validator(z.object({ calendarId: z.string(), role: z.enum(['default', 'maybe']), active: z.boolean() })).handler(async ({ data }) => (await import('./calendar.server')).setCalendarRoleImpl(data))
export const decideExternalEvent = createServerFn({ method: 'POST' }).validator(decisionInput).handler(async ({ data }) => (await import('./calendar.server')).decideExternalEventImpl(data))
export const resolveProjectionConflict = createServerFn({ method: 'POST' }).validator(z.object({ id: z.string(), action: z.enum(['restore', 'keep-google', 'remove-decision']) })).handler(async ({ data }) => (await import('./calendar.server')).resolveProjectionConflictImpl(data))
export const saveGoogleEvent = createServerFn({ method: 'POST' }).validator(eventInput).handler(async ({ data }) => (await import('./calendar.server')).saveGoogleEventImpl(data))
export const deleteGoogleEvent = createServerFn({ method: 'POST' }).validator(z.object({ id: z.string() })).handler(async ({ data }) => (await import('./calendar.server')).deleteGoogleEventImpl(data))
export const saveTaskBlock = createServerFn({ method: 'POST' }).validator(z.object({ id: z.string().optional(), taskId: z.string(), calendarId: z.string(), start: dateInput, end: dateInput })).handler(async ({ data }) => (await import('./calendar.server')).saveTaskBlockImpl(data))
export const deleteTaskBlock = createServerFn({ method: 'POST' }).validator(z.object({ id: z.string() })).handler(async ({ data }) => (await import('./calendar.server')).deleteTaskBlockImpl(data))
