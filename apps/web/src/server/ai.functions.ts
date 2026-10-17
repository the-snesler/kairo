import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const setGeminiKey = createServerFn({ method: 'POST' })
  .validator(z.object({ apiKey: z.string().trim().min(1).max(500).nullable() }))
  .handler(async ({ data }) => (await import('./ai.server')).setGeminiKeyImpl(data))
