import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const dateInput = z.string().datetime({ offset: true })
const rangeInput = z.object({ start: dateInput, end: dateInput })
const decisionInput = z.object({
  eventId: z.string(),
  state: z.enum(['undecided', 'yes', 'maybe', 'no']),
  calendarId: z.string().optional(),
})
const eventInput = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(500),
  start: dateInput,
  end: dateInput,
  allDay: z.boolean().default(false),
  calendarId: z.string(),
  eventColor: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .optional(),
  description: z.string().max(20_000).optional(),
  location: z.string().max(500).optional(),
  // Makes a new or single event repeat; series edits go through saveRecurringEvent.
  recurrence: z.array(z.string().max(1000)).max(20).nullable().optional(),
  timeZone: z.string().max(100).optional(),
})
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const scopeInput = z.enum(['this', 'following', 'all'])
const recurringPatchInput = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    start: z.union([dateInput, dateOnly]).optional(),
    end: z.union([dateInput, dateOnly]).optional(),
    allDay: z.boolean().optional(),
    calendarId: z.string().optional(),
    eventColor: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    description: z.string().max(20_000).optional(),
    location: z.string().max(500).optional(),
    recurrence: z.array(z.string().max(1000)).max(20).nullable().optional(),
  })
  .refine(
    (patch) =>
      patch.allDay === undefined ||
      [patch.start, patch.end].every(
        (value) => value === undefined || dateOnly.safeParse(value).success === patch.allDay,
      ),
    { message: 'Start and end must be dates for all-day events and date-times otherwise' },
  )

// TanStack replaces handler bodies with RPC stubs in the client build.
export const getViewer = createServerFn({ method: 'GET' }).handler(async () =>
  (await import('./calendar.server')).getViewerImpl(),
)
export const getCalendarSnapshot = createServerFn({ method: 'GET' })
  .validator(rangeInput)
  .handler(async ({ data }) => (await import('./calendar.server')).getCalendarSnapshotImpl(data))
export const syncNow = createServerFn({ method: 'POST' }).handler(async () =>
  (await import('./calendar.server')).syncNowImpl(),
)
export const addIcsFeed = createServerFn({ method: 'POST' })
  .validator(z.object({ url: z.string().url(), name: z.string().trim().min(1).max(100) }))
  .handler(async ({ data }) => (await import('./calendar.server')).addIcsFeedImpl(data))
export const deleteIcsFeed = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => (await import('./calendar.server')).deleteIcsFeedImpl(data))
export const setCalendarVisibility = createServerFn({ method: 'POST' })
  .validator(z.object({ calendarId: z.string(), visible: z.boolean() }))
  .handler(async ({ data }) => (await import('./calendar.server')).setCalendarVisibilityImpl(data))
export const setCalendarRole = createServerFn({ method: 'POST' })
  .validator(z.object({ calendarId: z.string(), role: z.enum(['default', 'maybe', 'tasks']), active: z.boolean() }))
  .handler(async ({ data }) => (await import('./calendar.server')).setCalendarRoleImpl(data))
export const decideExternalEvent = createServerFn({ method: 'POST' })
  .validator(decisionInput)
  .handler(async ({ data }) => (await import('./calendar.server')).decideExternalEventImpl(data))
export const resolveProjectionConflict = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string(), action: z.enum(['restore', 'keep-google', 'remove-decision']) }))
  .handler(async ({ data }) => (await import('./calendar.server')).resolveProjectionConflictImpl(data))
export const saveGoogleEvent = createServerFn({ method: 'POST' })
  .validator(eventInput)
  .handler(async ({ data }) => (await import('./calendar.server')).saveGoogleEventImpl(data))
export const deleteGoogleEvent = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => (await import('./calendar.server')).deleteGoogleEventImpl(data))
export const saveRecurringEvent = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string(),
      scope: scopeInput,
      patch: recurringPatchInput,
      timeZone: z.string().max(100).optional(),
    }),
  )
  .handler(async ({ data }) => (await import('./calendar.server')).saveRecurringEventImpl(data))
export const deleteRecurringEvent = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string(), scope: scopeInput }))
  .handler(async ({ data }) => (await import('./calendar.server')).deleteRecurringEventImpl(data))
export const getAdjacentOccurrence = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.string(), direction: z.enum(['prev', 'next']) }))
  .handler(async ({ data }) => (await import('./calendar.server')).getAdjacentOccurrenceImpl(data))
const taskDueInput = z
  .union([z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), z.object({ dateTime: dateInput })])
  .nullable()
const taskInput = z.object({
  id: z.string(),
  title: z.string().trim().min(1).max(500).optional(),
  due: taskDueInput.optional(),
  completed: z.boolean().optional(),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .nullable()
    .optional(),
})
export const updateTask = createServerFn({ method: 'POST' })
  .validator(taskInput)
  .handler(async ({ data }) => (await import('./tasks.server')).updateTaskImpl(data))
