import { createHash } from 'node:crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { task, taskEstimate } from '@kairo/db/schema'
import type { DurationEstimator, EstimateInput } from './estimator.js'

type Db = any
export type RunEstimatesOptions = { batchSize?: number; maxAgeDays?: number; limit?: number; now?: Date }
export type RunEstimatesResult = { selected: number; estimated: number; errors: string[] }

export const estimateInputHash = (input: Pick<EstimateInput, 'title' | 'description' | 'projectName'>) =>
  createHash('sha256')
    .update(JSON.stringify([input.title, input.description ?? '', input.projectName ?? '']))
    .digest('hex')

// Open tasks with no user or provider duration whose estimate is missing, stale, or for different text.
export function selectTasksNeedingEstimate(
  db: Db,
  { maxAgeDays = 14, limit, now = new Date() }: RunEstimatesOptions = {},
) {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000
  const rows: {
    id: string
    title: string
    description: string | null
    projectName: string | null
    inputHash: string | null
    estimatedAt: Date | null
  }[] = db
    .select({
      id: task.id,
      title: task.content,
      description: task.description,
      projectName: task.projectName,
      inputHash: taskEstimate.inputHash,
      estimatedAt: taskEstimate.estimatedAt,
    })
    .from(task)
    .leftJoin(taskEstimate, eq(taskEstimate.taskId, task.id))
    .where(
      and(
        eq(task.completed, false),
        eq(task.deleted, false),
        isNull(task.durationOverrideMinutes),
        isNull(task.durationMinutes),
      ),
    )
    .orderBy(asc(taskEstimate.estimatedAt), asc(task.id))
    .all()
  const due = rows.flatMap(({ inputHash, estimatedAt, ...input }) => {
    const hash = estimateInputHash(input)
    return !inputHash || inputHash !== hash || !estimatedAt || estimatedAt.getTime() < cutoff
      ? [{ ...input, hash }]
      : []
  })
  return limit === undefined ? due : due.slice(0, limit)
}

export async function runEstimates(
  db: Db,
  estimator: DurationEstimator,
  options: RunEstimatesOptions = {},
): Promise<RunEstimatesResult> {
  const batchSize = Math.max(1, options.batchSize ?? 25)
  const pending = selectTasksNeedingEstimate(db, options)
  const result: RunEstimatesResult = { selected: pending.length, estimated: 0, errors: [] }
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    const hashes = new Map(batch.map((t) => [t.id, t.hash]))
    try {
      const estimates = await estimator.estimate(batch.map(({ hash, ...input }) => input))
      const estimatedAt = new Date()
      db.transaction((tx: Db) => {
        for (const e of estimates) {
          const inputHash = hashes.get(e.id)
          if (!inputHash) continue
          const value = {
            minutes: e.minutes,
            confidence: e.confidence,
            rationale: e.rationale,
            provider: estimator.provider,
            model: estimator.model,
            inputHash,
            estimatedAt,
          }
          tx.insert(taskEstimate)
            .values({ taskId: e.id, ...value })
            .onConflictDoUpdate({ target: taskEstimate.taskId, set: value })
            .run()
          hashes.delete(e.id)
          result.estimated++
        }
      })
    } catch (error) {
      result.errors.push(`Batch ${i / batchSize + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}
