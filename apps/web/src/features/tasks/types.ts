export type { TaskDue, TaskPatch } from '@kairo/integrations'
import type { TaskDue } from '@kairo/integrations'

export type DurationSource = 'user' | 'provider' | 'ai' | 'default'

export interface TaskSummary {
  id: string
  title: string
  description?: string | null
  projectName?: string | null
  // Hex color of the task's project, if the provider has one.
  color?: string | null
  priority: number
  due: TaskDue | null
  recurring: boolean
  durationMinutes: number
  durationSource: DurationSource
  completed: boolean
  url?: string | null
  // True while a local edit is waiting to reach the provider.
  pending?: boolean
}

export const DEFAULT_TASK_MINUTES = 30
