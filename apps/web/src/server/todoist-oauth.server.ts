import '@tanstack/react-start/server-only'
import { randomBytes } from 'node:crypto'
import { exchangeTodoistCode, getTodoistUser, todoistAuthorizationUrl } from '@kairo/integrations'
import { requireUser } from './auth'
import { decryptJson, encryptJson, todoistCredentials } from './credentials'
import { processJobs, resumePendingPushes, saveTodoistConnection, syncTodoistConnection } from './sync'

type State = { userId: string; state: string; expiresAt: number }
const cookieName = 'kairo_todoist_state'
const cookiePath = '/api/todoist'

export async function handleTodoistConnect(request: Request) {
  const user = await requireUser(request.headers)
  const state = randomBytes(24).toString('base64url')
  const cookie = encryptJson({ userId: user.id, state, expiresAt: Date.now() + 10 * 60_000 } satisfies State)
  const url = todoistAuthorizationUrl(todoistCredentials(), state)
  return new Response(null, { status: 302, headers: { Location: url,
    'Set-Cookie': `${cookieName}=${cookie}; HttpOnly; SameSite=Lax; Path=${cookiePath}; Max-Age=600${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}` } })
}

export async function handleTodoistCallback(request: Request) {
  const url = new URL(request.url)
  const user = await requireUser(request.headers)
  const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  const clear = `${cookieName}=; HttpOnly; SameSite=Lax; Path=${cookiePath}; Max-Age=0`
  try {
    if (!cookie) throw new Error('Missing Todoist OAuth state cookie')
    const saved = decryptJson<State>(cookie)
    if (saved.userId !== user.id || saved.state !== url.searchParams.get('state') || saved.expiresAt < Date.now())
      throw new Error('Invalid Todoist OAuth state')
    const code = url.searchParams.get('code')
    if (!code) throw new Error(url.searchParams.get('error') || 'Todoist returned no authorization code')
    const tokens = await exchangeTodoistCode(todoistCredentials(), code)
    const subject = await getTodoistUser(tokens.access_token)
    const connection = await saveTodoistConnection(user.id, subject.id, tokens)
    await syncTodoistConnection(connection.id).catch((error) => console.error('Initial Todoist sync failed', error))
    await resumePendingPushes(connection.id)
    void processJobs().catch((error) => console.error('Task push failed', error))
    return new Response(null, { status: 302, headers: { Location: '/?connected=todoist', 'Set-Cookie': clear } })
  } catch (error) {
    return new Response(null, { status: 302, headers: { Location: `/?error=${encodeURIComponent(String(error))}`, 'Set-Cookie': clear } })
  }
}
