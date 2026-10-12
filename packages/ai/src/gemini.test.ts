import assert from 'node:assert/strict';
import test from 'node:test';
import { clampMinutes, createEstimator, createGeminiEstimator, GEMINI_DEFAULT_MODEL, type FetchLike } from './index.js';

const tasks = [
  { id: 'a', title: 'Write report', description: 'Quarterly numbers', projectName: 'Work' },
  { id: 'b', title: 'Buy milk', description: null, projectName: null },
];

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const content = (value: unknown) => reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: 'STOP' }] });

test('createEstimator is off without a key and picks gemini by default', () => {
  assert.equal(createEstimator({}), null);
  const estimator = createEstimator({ GEMINI_API_KEY: 'k' })!;
  assert.equal(estimator.provider, 'gemini');
  assert.equal(estimator.model, GEMINI_DEFAULT_MODEL);
  assert.equal(createEstimator({ GEMINI_API_KEY: 'k', AI_MODEL: 'custom' })!.model, 'custom');
  assert.throws(() => createEstimator({ AI_PROVIDER: 'nope', GEMINI_API_KEY: 'k' }), /Unknown AI_PROVIDER/);
});

test('gemini sends a structured-output request and sanitizes the reply', async () => {
  let url = '', init: RequestInit | undefined;
  const fetch: FetchLike = async (u, i) => {
    url = u; init = i;
    return content({ estimates: [
      { id: 'a', minutes: 92, confidence: 'medium', rationale: 'Drafting and checking.' },
      { id: 'b', minutes: 1, confidence: 'certain', rationale: 'Quick errand.' },
      { id: 'a', minutes: 10, confidence: 'high', rationale: 'duplicate' },
      { id: 'zzz', minutes: 30, confidence: 'high', rationale: 'unknown' },
    ] });
  };
  const result = await createGeminiEstimator({ apiKey: 'secret', model: 'm', fetch }).estimate(tasks);
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent');
  assert.equal((init!.headers as Record<string, string>)['x-goog-api-key'], 'secret');
  const body = JSON.parse(init!.body as string);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.responseSchema.properties.estimates.type, 'ARRAY');
  assert.match(body.systemInstruction.parts[0].text, /focused working time/);
  assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), [
    { id: 'a', title: 'Write report', description: 'Quarterly numbers', project: 'Work' },
    { id: 'b', title: 'Buy milk' },
  ]);
  assert.deepEqual(result, [
    { id: 'a', minutes: 90, confidence: 'medium', rationale: 'Drafting and checking.' },
    { id: 'b', minutes: 5, confidence: 'low', rationale: 'Quick errand.' },
  ]);
});

test('gemini surfaces http errors, blocks, and bad JSON; skips empty input', async () => {
  let calls = 0;
  const make = (response: () => Response) => createGeminiEstimator({ apiKey: 'k', fetch: async () => (calls++, response()) });
  assert.deepEqual(await make(() => content({ estimates: [] })).estimate([]), []);
  assert.equal(calls, 0);
  await assert.rejects(make(() => reply({ error: 'quota' }, 429)).estimate(tasks), /Gemini 429/);
  await assert.rejects(make(() => reply({ promptFeedback: { blockReason: 'SAFETY' } })).estimate(tasks), /blocked/);
  await assert.rejects(make(() => reply({ candidates: [{ content: { parts: [{ text: '{nope' }] } }] })).estimate(tasks), /invalid JSON/);
});

test('clampMinutes rounds to 5 within bounds', () => {
  assert.deepEqual([0, 7, 8, 62, 1000].map(clampMinutes), [5, 5, 10, 60, 480]);
});
