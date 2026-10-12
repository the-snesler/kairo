export type TodoistItem = {
  id: string; content?: string; description?: string; project_id?: string | null; priority?: number;
  due?: { date?: string; datetime?: string; timezone?: string | null; is_recurring?: boolean } | null;
  duration?: { amount: number; unit: 'minute' | 'day' } | null;
  checked?: boolean; is_deleted?: boolean; added_at?: string; updated_at?: string; completed_at?: string | null;
};
export type TodoistSync = { sync_token: string; full_sync: boolean; items?: TodoistItem[] };
export class TodoistApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'TodoistApiError'; }
}
export type TodoistOAuthCredentials = { clientId: string; clientSecret: string; redirectUri: string };
export type TodoistOAuthToken = { access_token: string; refresh_token?: string; expires_in: number; token_type?: string; scope?: string };

export function todoistAuthorizationUrl(credentials: TodoistOAuthCredentials, state: string) {
  const url = new URL('https://app.todoist.com/oauth/authorize');
  url.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: credentials.redirectUri,
    scope: 'data:read', state, response_type: 'code' }).toString();
  return url.toString();
}

async function todoistTokenRequest(credentials: TodoistOAuthCredentials, params: Record<string, string>, requestFetch: typeof fetch) {
  const response = await requestFetch('https://api.todoist.com/oauth/access_token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, ...params }),
  });
  const result = await response.json() as TodoistOAuthToken & { error?: string };
  if (!response.ok) throw new TodoistApiError(response.status, result.error || 'Todoist token request failed');
  if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0)
    throw new Error('Invalid Todoist token response');
  if (result.scope && !result.scope.split(/[\s,]+/).some(scope => scope === 'data:read' || scope === 'data:read_write'))
    throw new Error('Todoist did not grant read access');
  return result;
}

export function exchangeTodoistCode(credentials: TodoistOAuthCredentials, code: string, requestFetch: typeof fetch = fetch) {
  return todoistTokenRequest(credentials, { code, redirect_uri: credentials.redirectUri }, requestFetch);
}

export function refreshTodoistToken(credentials: TodoistOAuthCredentials, refreshToken: string, requestFetch: typeof fetch = fetch) {
  return todoistTokenRequest(credentials, { grant_type: 'refresh_token', refresh_token: refreshToken }, requestFetch);
}

export async function getTodoistUser(token: string, requestFetch: typeof fetch = fetch): Promise<{ id: string }> {
  const response = await requestFetch('https://api.todoist.com/api/v1/user', { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new TodoistApiError(response.status, await response.text());
  const user = await response.json() as { id?: string | number };
  if (user.id == null) throw new Error('Todoist user response has no ID');
  return { id: String(user.id) };
}
export async function syncTodoist(token: string, cursor?: string | null, requestFetch: typeof fetch = fetch): Promise<TodoistSync> {
  const body = new URLSearchParams({ sync_token: cursor ?? '*', resource_types: JSON.stringify(['items']) });
  const response = await requestFetch('https://api.todoist.com/api/v1/sync', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!response.ok) throw new TodoistApiError(response.status, await response.text());
  const data = await response.json() as TodoistSync;
  if (!data.sync_token || typeof data.full_sync !== 'boolean') throw new Error('Invalid Todoist sync response');
  return data;
}
