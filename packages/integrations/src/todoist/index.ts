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
