import { ESTIMATE_PROMPT, promptTasks, sanitizeEstimates, type DurationEstimator, type FetchLike } from './estimator.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models';

const responseSchema = {
  type: 'OBJECT',
  properties: { estimates: { type: 'ARRAY', items: { type: 'OBJECT',
    properties: {
      id: { type: 'STRING' },
      minutes: { type: 'INTEGER' },
      confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
      rationale: { type: 'STRING' },
    },
    required: ['id', 'minutes', 'confidence', 'rationale'],
    propertyOrdering: ['id', 'minutes', 'confidence', 'rationale'] } } },
  required: ['estimates'],
};

export function createGeminiEstimator(options: { apiKey: string; model?: string; fetch?: FetchLike }): DurationEstimator {
  const model = options.model || GEMINI_DEFAULT_MODEL;
  const fetcher = options.fetch ?? fetch;
  return {
    provider: 'gemini',
    model,
    async estimate(tasks) {
      if (!tasks.length) return [];
      const response = await fetcher(`${endpoint}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: ESTIMATE_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: promptTasks(tasks) }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema, temperature: 0.2 },
        }),
      });
      if (!response.ok) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = await response.json() as any;
      if (body.promptFeedback?.blockReason) throw new Error(`Gemini blocked prompt: ${body.promptFeedback.blockReason}`);
      const text = body.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
      if (!text) throw new Error(`Gemini returned no content (${body.candidates?.[0]?.finishReason ?? 'unknown'})`);
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { throw new Error('Gemini returned invalid JSON'); }
      return sanitizeEstimates(Array.isArray(parsed) ? parsed : parsed?.estimates, tasks);
    },
  };
}
