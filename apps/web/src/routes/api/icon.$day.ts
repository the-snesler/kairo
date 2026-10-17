import { createFileRoute } from '@tanstack/react-router'
import { kairoIconSvg } from '../../features/icon/kairoIcon'

// /api/icon/1 … /api/icon/31 are fixed images; /api/icon/today uses the server's clock.
export const Route = createFileRoute('/api/icon/$day')({
  server: {
    handlers: {
      GET: ({ params }) => {
        const today = params.day === 'today'
        const day = today ? new Date().getDate() : Number(params.day)
        if (!Number.isInteger(day) || day < 1 || day > 31) return new Response('Not found', { status: 404 })
        return new Response(kairoIconSvg(day), {
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': today ? 'no-cache' : 'public, max-age=604800',
          },
        })
      },
    },
  },
})
