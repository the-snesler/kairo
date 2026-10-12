import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from '@kairo/db';
import { migrateDatabase } from '@kairo/db/migrate';
import { task, taskConnection, taskEstimate, user } from '@kairo/db/schema';
import { estimateInputHash, runEstimates, selectTasksNeedingEstimate, type DurationEstimator, type EstimateInput } from './index.js';

migrateDatabase();
db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' }).run();
db.insert(taskConnection).values({ id: 'conn', ownerUserId: 'owner' }).run();
const add = (id: string, extra: Partial<typeof task.$inferInsert> = {}) =>
  db.insert(task).values({ id, connectionId: 'conn', todoistId: id, content: `Task ${id}`, ...extra }).run();
const estimateRow = (taskId: string, hash: string, estimatedAt = new Date()) =>
  db.insert(taskEstimate).values({ taskId, minutes: 20, confidence: 'high', rationale: '', provider: 'fake', model: 'old', inputHash: hash, estimatedAt }).run();

function fakeEstimator(fail?: (tasks: EstimateInput[]) => boolean) {
  const calls: EstimateInput[][] = [];
  const estimator: DurationEstimator = { provider: 'fake', model: 'fake-1', async estimate(tasks) {
    calls.push(tasks);
    if (fail?.(tasks)) throw new Error('boom');
    return [...tasks.map(t => ({ id: t.id, minutes: 45, confidence: 'medium' as const, rationale: 'r' })),
      { id: 'not-in-batch', minutes: 10, confidence: 'low' as const, rationale: '' }];
  } };
  return { estimator, calls };
}

add('fresh');
add('override', { durationOverrideMinutes: 15 });
add('provider', { durationMinutes: 60 });
add('done', { completed: true });
add('gone', { deleted: true });
add('current', { description: 'd', projectName: 'p' });
estimateRow('current', estimateInputHash({ title: 'Task current', description: 'd', projectName: 'p' }));
add('edited');
estimateRow('edited', 'stale-hash');
add('old');
estimateRow('old', estimateInputHash({ title: 'Task old', description: null, projectName: null }), new Date(Date.now() - 20 * 86_400_000));

test('selects open undurationed tasks that are unestimated, edited, or stale', () => {
  assert.deepEqual(selectTasksNeedingEstimate(db).map(t => t.id).sort(), ['edited', 'fresh', 'old']);
  assert.deepEqual(selectTasksNeedingEstimate(db, { maxAgeDays: 30 }).map(t => t.id).sort(), ['edited', 'fresh']);
  assert.deepEqual(selectTasksNeedingEstimate(db, { limit: 1 }).map(t => t.id), ['fresh']);
});

test('runEstimates batches, upserts, and isolates batch failures', async () => {
  const { estimator, calls } = fakeEstimator(tasks => tasks.some(t => t.id === 'fresh'));
  const result = await runEstimates(db, estimator, { batchSize: 1 });
  assert.equal(calls.length, 3);
  assert.equal(result.selected, 3);
  assert.equal(result.estimated, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /boom/);
  const edited = db.select().from(taskEstimate).where(eq(taskEstimate.taskId, 'edited')).get()!;
  assert.equal(edited.minutes, 45);
  assert.equal(edited.model, 'fake-1');
  assert.equal(edited.inputHash, estimateInputHash({ title: 'Task edited', description: null, projectName: null }));
  assert.equal(db.select().from(taskEstimate).where(eq(taskEstimate.taskId, 'not-in-batch')).get(), undefined);

  const retry = fakeEstimator();
  assert.deepEqual(await runEstimates(db, retry.estimator), { selected: 1, estimated: 1, errors: [] });
  assert.deepEqual(retry.calls.map(c => c.map(t => t.id)), [['fresh']]);
  assert.equal((await runEstimates(db, retry.estimator)).selected, 0);
});
