export type Confidence = 'low' | 'medium' | 'high';
export type EstimateInput = { id: string; title: string; description: string | null; projectName: string | null };
export type Estimate = { id: string; minutes: number; confidence: Confidence; rationale: string };

export interface DurationEstimator {
  readonly provider: string;
  readonly model: string;
  estimate(tasks: EstimateInput[]): Promise<Estimate[]>;
}

export type AiEnv = Record<string, string | undefined>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const MIN_MINUTES = 5;
export const MAX_MINUTES = 480;
const confidences = new Set<string>(['low', 'medium', 'high']);

export const clampMinutes = (value: number) =>
  Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(value / 5) * 5));

// Validates raw model output: drops unknown/duplicate ids and malformed rows, clamps minutes.
export function sanitizeEstimates(raw: unknown, tasks: EstimateInput[]): Estimate[] {
  const pending = new Set(tasks.map(t => t.id));
  const out: Estimate[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = typeof item?.id === 'string' ? item.id : String(item?.id ?? '');
    const minutes = Number(item?.minutes);
    if (!pending.delete(id) || !Number.isFinite(minutes) || minutes <= 0) continue;
    out.push({ id, minutes: clampMinutes(minutes),
      confidence: confidences.has(item.confidence) ? item.confidence : 'low',
      rationale: typeof item.rationale === 'string' ? item.rationale.slice(0, 500) : '' });
  }
  return out;
}

export const ESTIMATE_PROMPT = `You estimate how long tasks take. For each task, give a realistic estimate of focused working time in minutes for one person doing it alone, start to finish, excluding waiting on others. Use the title, description, and project for context. Prefer common sense over optimism; short chores are often 5-15 minutes, substantial work may take hours. Round to 5 minutes, between ${MIN_MINUTES} and ${MAX_MINUTES}. Set confidence to low when the task is vague. Give a one-sentence rationale. Return exactly one entry per task id.`;

export const promptTasks = (tasks: EstimateInput[]) => JSON.stringify(tasks.map(t => ({
  id: t.id, title: t.title, ...(t.description ? { description: t.description.slice(0, 2000) } : {}),
  ...(t.projectName ? { project: t.projectName } : {}) })));
