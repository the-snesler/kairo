import '@tanstack/react-start/server-only'
import { randomBytes } from 'node:crypto'
import { exchangeGoogleCode, googleAuthorizationUrl } from '@kairo/integrations'
import { requireUser } from './auth'
import { decryptJson, encryptJson, googleCredentials } from './credentials'
import { saveGoogleConnection, syncAll } from './sync'

type State = { userId: string; state: string; expiresAt: number }

export async function handleGoogleConnect(request: Request) {
  const user = await requireUser(request.headers)
  const state = randomBytes(24).toString('base64url')
  const cookie = encryptJson({ userId: user.id, state, expiresAt: Date.now() + 10 * 60_000 })
  const url = googleAuthorizationUrl(googleCredentials(), state)
  return new Response(null, { status: 302, headers: { Location: url, 'Set-Cookie': `kairo_google_state=${cookie}; HttpOnly; SameSite=Lax; Path=/api/google; Max-Age=600${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}` } })
}

export async function handleGoogleCallback(request: Request) {
  const url = new URL(request.url)
  const user = await requireUser(request.headers)
  const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('kairo_google_state='))?.slice('kairo_google_state='.length)
  const clear = 'kairo_google_state=; HttpOnly; SameSite=Lax; Path=/api/google; Max-Age=0'
  try {
    if (!cookie) throw new Error('Missing OAuth state cookie')
    const saved = decryptJson<State>(cookie)
    if (saved.userId !== user.id || saved.state !== url.searchParams.get('state') || saved.expiresAt < Date.now()) throw new Error('Invalid OAuth state')
    const code = url.searchParams.get('code')
    if (!code) throw new Error(url.searchParams.get('error') || 'Google returned no authorization code')
    const tokens = await exchangeGoogleCode(googleCredentials(), code)
    await saveGoogleConnection(user.id, tokens.access_token, tokens.refresh_token || '', tokens.expires_in || 3600)
    void syncAll(user.id).catch((error) => console.error('Initial Google sync failed', error))
    return new Response(null, { status: 302, headers: { Location: '/?connected=google', 'Set-Cookie': clear } })
  } catch (error) {
    return new Response(null, { status: 302, headers: { Location: `/?error=${encodeURIComponent(String(error))}`, 'Set-Cookie': clear } })
  }
}
