import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/google/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => (await import('../../../server/google-oauth.server')).handleGoogleCallback(request),
    },
  },
})
