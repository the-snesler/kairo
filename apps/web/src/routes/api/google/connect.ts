import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/google/connect')({
  server: { handlers: { GET: async ({ request }) => (await import('../../../server/google-oauth.server')).handleGoogleConnect(request) } },
})
