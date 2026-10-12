import type { AiEnv, DurationEstimator, FetchLike } from './estimator.js';
import { createGeminiEstimator } from './gemini.js';

type Factory = (env: AiEnv, fetch?: FetchLike) => DurationEstimator | null;

const providers: Record<string, Factory> = {
  gemini: (env, fetch) => env.GEMINI_API_KEY ? createGeminiEstimator({ apiKey: env.GEMINI_API_KEY, model: env.AI_MODEL, fetch }) : null,
};

// Returns null unless the selected provider is configured: task text leaves the server only when opted in.
export function createEstimator(env: AiEnv = process.env, fetch?: FetchLike): DurationEstimator | null {
  const name = (env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  const factory = providers[name];
  if (!factory) throw new Error(`Unknown AI_PROVIDER: ${name}`);
  return factory(env, fetch);
}
