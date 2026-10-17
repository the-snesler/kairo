import { runUserEstimates } from '../ai-connection'
import { db, user } from '@kairo/db'
import { processJobs, syncAll } from '../sync'

let timer: ReturnType<typeof setInterval> | undefined
let estimateTimer: ReturnType<typeof setInterval> | undefined
let estimateDelay: ReturnType<typeof setTimeout> | undefined
let running = false
let estimating = false

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

async function estimateTick() {
  if (estimating) return
  estimating = true
  try {
    const users = await db.select({ id: user.id }).from(user)
    for (const account of users) {
      try {
        const result = await runUserEstimates(account.id)
        for (const error of result.errors) console.error('Task estimates:', error)
      } catch (error) {
        console.error('Task estimates:', error)
      }
    }
  } catch (error) {
    console.error('Task estimate worker:', error)
  } finally {
    estimating = false
  }
}

function startEstimates() {
  const run = () => void estimateTick()
  estimateDelay = setTimeout(run, 60_000)
  estimateTimer = setInterval(run, 60 * 60_000)
}

export function startSyncWorker() {
  if (timer) return () => stopSyncWorker()
  void tick()
  timer = setInterval(() => void tick(), 5 * 60_000)
  startEstimates()
  return () => stopSyncWorker()
}

export function stopSyncWorker() {
  if (timer) clearInterval(timer)
  if (estimateTimer) clearInterval(estimateTimer)
  if (estimateDelay) clearTimeout(estimateDelay)
  timer = estimateTimer = estimateDelay = undefined
}
