// Provider-agnostic task contract. A task has exactly one date: the provider's due date.
export type TaskDue =
  | { date: string } // YYYY-MM-DD, all-day
  | { dateTime: string } // ISO 8601 instant, timed

export type TaskPatch = {
  title?: string
  due?: TaskDue | null
  completed?: boolean
}

export type NormalizedTask = {
  externalId: string
  title: string
  description: string | null
  projectId: string | null
  projectName: string | null
  projectColor: string | null // hex
  priority: number
  due: (TaskDue & { timeZone?: string | null, string?: string | null, recurring?: boolean }) | null
  durationMinutes: number | null
  completed: boolean
  completedAt?: Date | null
  deleted: boolean
  updatedAt: Date | null
}

// Color for tasks whose project has none. Keep in sync with TASK_COLOR in CalendarWorkspace.tsx.
export const DEFAULT_TASK_COLOR = '#f22420'

export type TaskProviderCapabilities = { dueTime: boolean, complete: boolean, edit: boolean }

// What Kairo knows about the task's current provider due, so update() can skip a read.
export type TaskUpdateContext = {
  current?: { timed: boolean, recurring: boolean, string: string | null, timeZone: string | null } | null
  cursor?: string | null
}

export type TaskTokens = { accessToken: string, refreshToken?: string, expiresIn: number, scope?: string }

// How a failed provider call should be handled: refresh and retry, reconnect, give up on the edit, or retry later.
export type TaskErrorKind = 'unauthorized' | 'invalid-grant' | 'forbidden' | 'rejected' | 'transient'

export interface TaskProvider {
  readonly id: string
  readonly label?: string
  readonly capabilities: TaskProviderCapabilities
  sync(token: string, cursor: string | null): Promise<TaskSyncResult>
  update(token: string, externalId: string, patch: TaskPatch, context?: TaskUpdateContext): Promise<void>
  refreshToken?(refreshToken: string): Promise<TaskTokens>
  classifyError?(error: unknown): TaskErrorKind
  // Whether a granted OAuth scope allows update(); providers without scopes may omit this.
  canWrite?(scope: string | null): boolean
  taskUrl?(externalId: string): string
}

// `projects` lists projects seen in this sync so stored tasks can be renamed/recolored without being resent.
export type TaskSyncResult = { tasks: NormalizedTask[], cursor: string, full: boolean, projects?: { id: string, name: string, color: string | null }[] }

// A patch the provider refused for good (validation, unsupported edit). Retrying will not help.
export class TaskPatchError extends Error {
  constructor(message: string) { super(message); this.name = 'TaskPatchError' }
}
