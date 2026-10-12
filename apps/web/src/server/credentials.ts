import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { GoogleCredentials, TodoistOAuthCredentials } from '@kairo/integrations'

function key() {
  const value = process.env.ENCRYPTION_KEY
  if (!value || value.length < 32) throw new Error('ENCRYPTION_KEY must contain at least 32 characters')
  return createHash('sha256').update(value).digest()
}

export function encryptJson(value: unknown): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), nonce)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
}

export function decryptJson<T>(value: string): T {
  const [version, nonce, tag, body] = value.split('.')
  if (version !== 'v1' || !nonce || !tag || !body) throw new Error('Unsupported encrypted credential format')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(nonce, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')) as T
}

function projectRoot() {
  // The app runs from apps/web under pnpm, and from /app in Docker.
  return process.cwd().endsWith('/apps/web') ? resolve(process.cwd(), '../..') : process.cwd()
}

export function googleCredentials(): GoogleCredentials {
  let clientId = process.env.GOOGLE_CLIENT_ID
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if ((!clientId || !clientSecret) && process.env.GOOGLE_OAUTH_CLIENT_FILE) {
    const filename = process.env.GOOGLE_OAUTH_CLIENT_FILE
    const path = isAbsolute(filename) ? filename : resolve(projectRoot(), filename)
    const file = JSON.parse(readFileSync(path, 'utf8')) as { web?: { client_id?: string; client_secret?: string }; installed?: { client_id?: string; client_secret?: string } }
    const source = file.web ?? file.installed
    clientId ||= source?.client_id
    clientSecret ||= source?.client_secret
  }
  if (!clientId || !clientSecret) throw new Error('Google OAuth client credentials are missing')
  return { clientId, clientSecret, redirectUri: new URL('/api/google/callback', process.env.BETTER_AUTH_URL || 'http://localhost:3000').toString() }
}

export function todoistCredentials(): TodoistOAuthCredentials {
  const clientId = process.env.TODOIST_CLIENT_ID
  const clientSecret = process.env.TODOIST_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Todoist OAuth client credentials are missing')
  return { clientId, clientSecret,
    redirectUri: new URL('/api/todoist/callback', process.env.BETTER_AUTH_URL || 'http://localhost:3000').toString() }
}
