import type { ReactNode } from 'react'
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { Toaster } from 'sonner'
import styles from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Kairo — calendar, tasks, maybe' },
    ],
    links: [{ rel: 'stylesheet', href: styles }],
  }),
  component: Root,
})

function Root() {
  return (
    <Document>
      <Outlet />
    </Document>
  )
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster position="bottom-right" theme="dark" />
        <Scripts />
      </body>
    </html>
  )
}
