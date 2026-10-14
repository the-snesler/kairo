import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/todoist/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => (await import('../../../server/todoist-oauth.server')).handleTodoistCallback(request),
    },
  },
})
