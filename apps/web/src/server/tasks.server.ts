import '@tanstack/react-start/server-only'
import type { TaskPatch } from '@kairo/integrations'

// Applies the patch locally (optimistic), records it as pending, and enqueues a provider push.
// durationMinutes is Kairo-only (null clears the user override).
export async function updateTaskImpl(_data: TaskPatch & { id: string, durationMinutes?: number | null }): Promise<{ ok: true }> {
  throw new Error('Not implemented')
}
