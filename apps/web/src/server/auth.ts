import '@tanstack/react-start/server-only'
import { count } from 'drizzle-orm'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { db, user } from '@kairo/db'
import * as schema from '@kairo/db/schema'

export async function getAuthStatus() {
  const [result] = await db.select({ count: count() }).from(user)
  return { needsSetup: result.count === 0 }
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'sqlite', schema }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? 'http://localhost:3000',
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  databaseHooks: {
    user: {
      create: {
        before: async () => {
          if (!(await getAuthStatus()).needsSetup) {
            throw new APIError('FORBIDDEN', { message: 'Registration is closed' })
          }
        },
      },
    },
  },
  plugins: [tanstackStartCookies()],
})

export async function getSession(headers: Headers = getRequestHeaders()) {
  return auth.api.getSession({ headers })
}

export async function requireUser(headers?: Headers) {
  const session = await getSession(headers)
  if (!session) throw new Response('Unauthorized', { status: 401 })
  return session.user
}

export async function bootstrapOwner(input: { name: string; email: string; password: string }) {
  if (!(await getAuthStatus()).needsSetup) {
    throw new APIError('FORBIDDEN', { message: 'Registration is closed' })
  }
  return auth.api.signUpEmail({ body: input })
}
