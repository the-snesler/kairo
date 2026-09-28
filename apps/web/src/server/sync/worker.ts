import { db, user } from '@kairo/db'
import { processJobs, syncAll } from '../sync'

let timer: ReturnType<typeof setInterval> | undefined
let running = false

async function tick() {
  if (running) return
  running = true
  try {
    const users = await db.select({ id: user.id }).from(user)
    for (const account of users) {
      const result = await syncAll(account.id)
      for (const error of result.errors) console.error('Calendar sync:', error)
    }
    if (!users.length) await processJobs()
  } catch (error) {
    console.error('Calendar worker:', error)
  } finally {
    running = false
  }
}

export function startSyncWorker() {
  if (timer) return () => stopSyncWorker()
  void tick()
  timer = setInterval(() => void tick(), 5 * 60_000)
  return () => stopSyncWorker()
}

export function stopSyncWorker() {
  if (timer) clearInterval(timer)
  timer = undefined
}
