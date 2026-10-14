import { randomUUID } from 'node:crypto'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const id = () => text('id').primaryKey().$defaultFn(randomUUID)
const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' })
const now = () => new Date()

// Better Auth's core models use these property names and Date-valued timestamps.
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().$defaultFn(now),
  updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().$defaultFn(now),
  updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().$defaultFn(now),
  updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().$defaultFn(now),
  updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
})

export const connectedAccount = sqliteTable(
  'connected_account',
  {
    id: id(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerSubject: text('provider_subject'),
    displayName: text('display_name'),
    encryptedCredentials: text('encrypted_credentials'),
    status: text('status').notNull().default('connected'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at').notNull().$defaultFn(now),
    updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
  },
  (table) => [uniqueIndex('connected_account_provider_subject').on(table.provider, table.providerSubject)],
)

export const accountAccess = sqliteTable(
  'account_access',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    connectedAccountId: text('connected_account_id')
      .notNull()
      .references(() => connectedAccount.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('owner'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.connectedAccountId] })],
)

export const calendar = sqliteTable(
  'calendar',
  {
    id: id(),
    connectedAccountId: text('connected_account_id')
      .notNull()
      .references(() => connectedAccount.id, { onDelete: 'cascade' }),
    googleCalendarId: text('google_calendar_id').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    accessRole: text('access_role'),
    timeZone: text('time_zone'),
    syncCursor: text('sync_cursor'),
    syncStatus: text('sync_status').notNull().default('pending'),
    lastSyncedAt: timestamp('last_synced_at'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at').notNull().$defaultFn(now),
    updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
  },
  (table) => [uniqueIndex('calendar_account_google_id').on(table.connectedAccountId, table.googleCalendarId)],
)

export const userCalendarSetting = sqliteTable(
  'user_calendar_setting',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    calendarId: text('calendar_id')
      .notNull()
      .references(() => calendar.id, { onDelete: 'cascade' }),
    visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    isMaybe: integer('is_maybe', { mode: 'boolean' }).notNull().default(false),
    isTasks: integer('is_tasks', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.userId, table.calendarId] })],
)

export const googleEvent = sqliteTable(
  'google_event',
  {
    id: id(),
    calendarId: text('calendar_id')
      .notNull()
      .references(() => calendar.id, { onDelete: 'cascade' }),
    googleEventId: text('google_event_id').notNull(),
    recurringEventId: text('recurring_event_id'),
    originalStartTime: text('original_start_time'),
    etag: text('etag'),
    eventType: text('event_type'),
    title: text('title').notNull().default(''),
    description: text('description'),
    location: text('location'),
    startAt: timestamp('start_at'),
    endAt: timestamp('end_at'),
    startDate: text('start_date'),
    endDate: text('end_date'),
    timeZone: text('time_zone'),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    status: text('status').notNull().default('confirmed'),
    responseStatus: text('response_status'),
    colorId: text('color_id'),
    color: text('color'),
    htmlLink: text('html_link'),
    projectionId: text('projection_id'),
    taskBlockId: text('task_block_id'),
    rawJson: text('raw_json'),
    updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
  },
  (table) => [
    uniqueIndex('google_event_calendar_google_id').on(table.calendarId, table.googleEventId),
    index('google_event_range').on(table.startAt, table.endAt),
  ],
)

export const icsSource = sqliteTable(
  'ics_source',
  {
    id: id(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    lastSuccessfulFetchAt: timestamp('last_successful_fetch_at'),
    nextPollAt: timestamp('next_poll_at'),
    status: text('status').notNull().default('pending'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at').notNull().$defaultFn(now),
    updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
  },
  (table) => [index('ics_source_owner').on(table.ownerUserId)],
)

export const externalEvent = sqliteTable(
  'external_event',
  {
    id: id(),
    sourceId: text('source_id')
      .notNull()
      .references(() => icsSource.id, { onDelete: 'cascade' }),
    uid: text('uid').notNull(),
    recurrenceId: text('recurrence_id').notNull().default(''),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    startAt: timestamp('start_at'),
    endAt: timestamp('end_at'),
    startDate: text('start_date'),
    endDate: text('end_date'),
    timeZone: text('time_zone'),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    recurrenceRule: text('recurrence_rule'),
    status: text('status').notNull().default('confirmed'),
    sourceRevision: text('source_revision').notNull(),
    rawIcs: text('raw_ics'),
    firstSeenAt: timestamp('first_seen_at').notNull().$defaultFn(now),
    lastSeenAt: timestamp('last_seen_at').notNull().$defaultFn(now),
    withdrawnAt: timestamp('withdrawn_at'),
  },
  (table) => [
    uniqueIndex('external_event_identity').on(table.sourceId, table.uid, table.recurrenceId),
    index('external_event_range').on(table.startAt, table.endAt),
  ],
)

export const eventDecision = sqliteTable(
  'event_decision',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    externalEventId: text('external_event_id')
      .notNull()
      .references(() => externalEvent.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['undecided', 'yes', 'maybe', 'no'] })
      .notNull()
      .default('undecided'),
    destinationCalendarId: text('destination_calendar_id').references(() => calendar.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at'),
    updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
  },
  (table) => [uniqueIndex('event_decision_user_external').on(table.userId, table.externalEventId)],
)

export const eventProjection = sqliteTable('event_projection', {
  id: id(),
  decisionId: text('decision_id')
    .notNull()
    .references(() => eventDecision.id, { onDelete: 'cascade' })
    .unique(),
  destinationCalendarId: text('destination_calendar_id').references(() => calendar.id, { onDelete: 'set null' }),
  googleEventId: text('google_event_id'),
  lastAppliedSourceRevision: text('last_applied_source_revision'),
  lastAppliedEtag: text('last_applied_etag'),
  syncState: text('sync_state').notNull().default('pending'),
  conflictKind: text('conflict_kind'),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
})

export const taskConnection = sqliteTable('task_connection', {
  id: id(),
  provider: text('provider').notNull().default('todoist'),
  scope: text('scope'),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  providerSubject: text('provider_subject'),
  encryptedCredentials: text('encrypted_credentials'),
  syncToken: text('sync_token'),
  status: text('status').notNull().default('pending'),
  lastSyncedAt: timestamp('last_synced_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().$defaultFn(now),
  updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
})

export const task = sqliteTable(
  'task',
  {
    id: id(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => taskConnection.id, { onDelete: 'cascade' }),
    todoistId: text('todoist_id').notNull(),
    content: text('content').notNull(),
    description: text('description'),
    projectId: text('project_id'),
    projectName: text('project_name'),
    projectColor: text('project_color'),
    priority: integer('priority').notNull().default(1),
    dueDate: text('due_date'),
    dueDateTime: timestamp('due_date_time'),
    dueTimeZone: text('due_time_zone'),
    dueString: text('due_string'),
    dueRecurring: integer('due_recurring', { mode: 'boolean' }).notNull().default(false),
    // Duration reported by the provider; durationOverrideMinutes is set in Kairo and wins.
    durationMinutes: integer('duration_minutes'),
    durationOverrideMinutes: integer('duration_override_minutes'),
    // JSON TaskPatch awaiting push to the provider; sync must not overwrite these fields.
    pendingPatch: text('pending_patch'),
    completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
    completedAt: timestamp('completed_at'),
    deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
    providerUpdatedAt: timestamp('provider_updated_at'),
    updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
  },
  (table) => [uniqueIndex('task_connection_todoist_id').on(table.connectionId, table.todoistId)],
)

export const taskBlock = sqliteTable(
  'task_block',
  {
    id: id(),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    calendarId: text('calendar_id')
      .notNull()
      .references(() => calendar.id, { onDelete: 'cascade' }),
    googleEventId: text('google_event_id'),
    startAt: timestamp('start_at').notNull(),
    endAt: timestamp('end_at').notNull(),
    syncState: text('sync_state').notNull().default('pending'),
    lastAppliedEtag: text('last_applied_etag'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at').notNull().$defaultFn(now),
    updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
  },
  (table) => [index('task_block_task').on(table.taskId)],
)

export const taskEstimate = sqliteTable('task_estimate', {
  taskId: text('task_id')
    .primaryKey()
    .references(() => task.id, { onDelete: 'cascade' }),
  minutes: integer('minutes').notNull(),
  confidence: text('confidence', { enum: ['low', 'medium', 'high'] }),
  rationale: text('rationale'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputHash: text('input_hash').notNull(),
  estimatedAt: timestamp('estimated_at').notNull().$defaultFn(now),
})

export const syncJob = sqliteTable(
  'sync_job',
  {
    id: id(),
    jobKey: text('job_key').notNull().unique(),
    kind: text('kind').notNull(),
    targetId: text('target_id').notNull(),
    nextRunAt: timestamp('next_run_at').notNull().$defaultFn(now),
    leaseUntil: timestamp('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at').notNull().$defaultFn(now),
    updatedAt: timestamp('updated_at').notNull().$defaultFn(now),
  },
  (table) => [index('sync_job_due').on(table.nextRunAt, table.leaseUntil)],
)
