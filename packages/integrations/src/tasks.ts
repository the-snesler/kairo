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
  priority: number
  due: (TaskDue & { timeZone?: string | null, string?: string | null, recurring?: boolean }) | null
  durationMinutes: number | null
  completed: boolean
  deleted: boolean
  updatedAt: Date | null
}

export type TaskProviderCapabilities = { dueTime: boolean, complete: boolean, edit: boolean }

export interface TaskProvider {
  readonly id: string
  readonly capabilities: TaskProviderCapabilities
  sync(token: string, cursor: string | null): Promise<{ tasks: NormalizedTask[], cursor: string, full: boolean }>
  update(token: string, externalId: string, patch: TaskPatch): Promise<void>
}
