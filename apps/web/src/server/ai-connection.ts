import { and, eq } from 'drizzle-orm'
import { db, connectedAccount } from '@kairo/db'
import { createGeminiEstimator, runEstimates } from '@kairo/ai'
import { decryptJson, encryptJson } from './credentials'

export async function geminiConnected(userId: string) {
  const [connection] = await db
    .select({ id: connectedAccount.id })
    .from(connectedAccount)
    .where(and(eq(connectedAccount.ownerUserId, userId), eq(connectedAccount.provider, 'gemini')))
  return !!connection
}

export async function saveGeminiKey(userId: string, apiKey: string | null) {
  if (apiKey === null) {
    await db
      .delete(connectedAccount)
      .where(and(eq(connectedAccount.ownerUserId, userId), eq(connectedAccount.provider, 'gemini')))
    return
  }
  const encryptedCredentials = encryptJson({ apiKey })
  await db
    .insert(connectedAccount)
    .values({ ownerUserId: userId, provider: 'gemini', providerSubject: userId, encryptedCredentials })
    .onConflictDoUpdate({
      target: [connectedAccount.provider, connectedAccount.providerSubject],
      set: { encryptedCredentials, updatedAt: new Date() },
    })
}

export async function runUserEstimates(userId: string) {
  const [connection] = await db
    .select()
    .from(connectedAccount)
    .where(and(eq(connectedAccount.ownerUserId, userId), eq(connectedAccount.provider, 'gemini')))
  if (!connection?.encryptedCredentials) return { selected: 0, estimated: 0, errors: [] }
  const { apiKey } = decryptJson<{ apiKey: string }>(connection.encryptedCredentials)
  const estimator = createGeminiEstimator({ apiKey, model: process.env.AI_MODEL })
  return runEstimates(db, estimator, { ownerUserId: userId })
}
