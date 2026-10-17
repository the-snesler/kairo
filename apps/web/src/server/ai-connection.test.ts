import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { db, connectedAccount, task, taskConnection, taskEstimate, user } from '@kairo/db'
import { migrateDatabase } from '@kairo/db/migrate'
import { decryptJson } from './credentials'
import { geminiConnected, runUserEstimates, saveGeminiKey } from './ai-connection'

migrateDatabase()
db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' }).run()
db.insert(taskConnection).values({ id: 'tasks', ownerUserId: 'owner' }).run()
db.insert(task).values({ id: 'task', connectionId: 'tasks', todoistId: 'task', content: 'Work' }).run()

test('Gemini keys are encrypted, replaceable, scoped to the user, and disconnected without env fallback', async () => {
  const previousKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'env-key-must-not-be-used'
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    assert.equal((init?.headers as Record<string, string>)['x-goog-api-key'], 'replacement')
    return Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  estimates: [{ id: 'task', minutes: 45, confidence: 'high', rationale: 'Work' }],
                }),
              },
            ],
          },
        },
      ],
    })
  }
  try {
    assert.equal(await geminiConnected('owner'), false)
    await runUserEstimates('owner')
    assert.equal(calls, 0)
    await saveGeminiKey('owner', 'secret')
    const first = db.select().from(connectedAccount).where(eq(connectedAccount.provider, 'gemini')).get()!
    assert.ok(!first.encryptedCredentials!.includes('secret'))
    assert.deepEqual(decryptJson(first.encryptedCredentials!), { apiKey: 'secret' })
    await saveGeminiKey('owner', 'replacement')
    assert.equal(db.select().from(connectedAccount).all().length, 1)
    assert.equal(await geminiConnected('owner'), true)
    assert.equal(await geminiConnected('other-user'), false)
    await runUserEstimates('other-user')
    assert.equal(calls, 0)
    assert.equal((await runUserEstimates('owner')).estimated, 1)
    assert.equal(calls, 1)
    await saveGeminiKey('owner', null)
    assert.equal(await geminiConnected('owner'), false)
    await runUserEstimates('owner')
    assert.equal(calls, 1)
    assert.equal(db.select().from(taskEstimate).get()?.minutes, 45)
  } finally {
    globalThis.fetch = originalFetch
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = previousKey
  }
})
