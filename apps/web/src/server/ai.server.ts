import '@tanstack/react-start/server-only'
import { requireUser } from './auth'
import { saveGeminiKey } from './ai-connection'

export async function setGeminiKeyImpl(data: { apiKey: string | null }) {
  const user = await requireUser()
  await saveGeminiKey(user.id, data.apiKey)
  return { ok: true }
}
