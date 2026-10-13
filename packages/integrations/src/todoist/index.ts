import { TaskPatchError, type NormalizedTask, type TaskErrorKind, type TaskPatch, type TaskProvider, type TaskUpdateContext } from '../tasks.js';

// API v1 due objects carry the time in `date` (YYYY-MM-DDTHH:MM:SS floating, or ...Z fixed with `timezone`).
export type TodoistDue = { date?: string; datetime?: string; timezone?: string | null; string?: string | null; lang?: string | null; is_recurring?: boolean };
export type TodoistItem = {
  id: string; content?: string; description?: string; project_id?: string | null; priority?: number;
  due?: TodoistDue | null;
  duration?: { amount: number; unit: 'minute' | 'day' } | null;
  checked?: boolean; is_deleted?: boolean; added_at?: string; updated_at?: string; completed_at?: string | null;
};
export type TodoistProject = { id: string; name?: string; color?: string; inbox_project?: boolean; is_deleted?: boolean };
// https://developer.todoist.com/guides/#colors
const todoistColors: Record<string, string> = {
  berry_red: '#b8256f', red: '#db4035', orange: '#ff9933', yellow: '#fad000', olive_green: '#afb83b', lime_green: '#7ecc49',
  green: '#299438', mint_green: '#6accbc', teal: '#158fad', sky_blue: '#14aaf5', light_blue: '#96c3eb', blue: '#4073ff',
  grape: '#884dff', violet: '#af38eb', lavender: '#eb96eb', magenta: '#e05194', salmon: '#ff8d85', charcoal: '#808080',
  grey: '#b8b8b8', taupe: '#ccac93',
};
export const todoistColor = (name: string | undefined) => (name && todoistColors[name]) || null;
type ProjectInfo = { name: string; color: string | null };
export type TodoistSync = { sync_token: string; full_sync: boolean; items?: TodoistItem[]; projects?: TodoistProject[]; user?: { tz_info?: { timezone?: string } } };
export class TodoistApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'TodoistApiError'; }
}
export type TodoistOAuthCredentials = { clientId: string; clientSecret: string; redirectUri: string };
export type TodoistOAuthToken = { access_token: string; refresh_token?: string; expires_in: number; token_type?: string; scope?: string };
export const TODOIST_SCOPE = 'data:read_write';
const api = 'https://api.todoist.com/api/v1';

export const todoistScopeCanWrite = (scope?: string | null) => !!scope && scope.split(/[\s,]+/).includes('data:read_write');
export const todoistTaskUrl = (id: string) => `https://app.todoist.com/app/task/${encodeURIComponent(id)}`;

export function todoistAuthorizationUrl(credentials: TodoistOAuthCredentials, state: string) {
  const url = new URL('https://app.todoist.com/oauth/authorize');
  url.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: credentials.redirectUri,
    scope: TODOIST_SCOPE, state, response_type: 'code' }).toString();
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

async function todoistGet<T>(token: string, path: string, requestFetch: typeof fetch): Promise<T> {
  const response = await requestFetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new TodoistApiError(response.status, await response.text());
  return response.json() as Promise<T>;
}

export async function getTodoistUser(token: string, requestFetch: typeof fetch = fetch): Promise<{ id: string; timeZone: string | null }> {
  const user = await todoistGet<{ id?: string | number; tz_info?: { timezone?: string } }>(token, '/user', requestFetch);
  if (user.id == null) throw new Error('Todoist user response has no ID');
  return { id: String(user.id), timeZone: user.tz_info?.timezone || null };
}

async function todoistSyncRequest(token: string, body: URLSearchParams, requestFetch: typeof fetch) {
  const response = await requestFetch(`${api}/sync`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!response.ok) throw new TodoistApiError(response.status, await response.text());
  return response.json();
}

export async function syncTodoist(token: string, cursor?: string | null, requestFetch: typeof fetch = fetch,
  resourceTypes = ['items']): Promise<TodoistSync> {
  const data = await todoistSyncRequest(token, new URLSearchParams({ sync_token: cursor ?? '*', resource_types: JSON.stringify(resourceTypes) }), requestFetch) as TodoistSync;
  if (!data.sync_token || typeof data.full_sync !== 'boolean') throw new Error('Invalid Todoist sync response');
  return data;
}

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  return Object.fromEntries(parts.map(part => [part.type, part.value])) as Record<string, string>;
}
const zoneOffset = (ms: number, timeZone: string) => {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};

// Floating Todoist times are wall-clock times in the user's Todoist timezone.
export function floatingToInstant(local: string, timeZone: string) {
  const [day, time = '00:00:00'] = local.split('T');
  const [y, m, d] = day.split('-').map(Number), [h, min, s] = time.split(':').map(part => parseInt(part, 10));
  const guess = Date.UTC(y, m - 1, d, h || 0, min || 0, s || 0);
  return new Date(guess - zoneOffset(guess - zoneOffset(guess, timeZone), timeZone));
}

export function instantToFloating(iso: string, timeZone: string) {
  const p = zonedParts(Date.parse(iso), timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const dueRaw = (due?: TodoistDue | null) => due?.datetime ?? due?.date ?? null;
const utcSeconds = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function normalizeTodoistDue(due: TodoistDue | null | undefined, userTimeZone: string | null): NormalizedTask['due'] {
  const raw = dueRaw(due);
  if (!due || !raw) return null;
  const extra = { timeZone: due.timezone ?? null, string: due.string ?? null, recurring: !!due.is_recurring };
  if (!raw.includes('T')) return { date: raw.slice(0, 10), ...extra };
  const fixed = /(Z|[+-]\d\d:\d\d)$/.test(raw);
  return { dateTime: (fixed ? new Date(raw) : floatingToInstant(raw, due.timezone || userTimeZone || 'UTC')).toISOString(), ...extra };
}

export function normalizeTodoistItem(item: TodoistItem, projects: Map<string, ProjectInfo>, userTimeZone: string | null): NormalizedTask {
  const project = item.project_id ? projects.get(item.project_id) : undefined;
  return { externalId: item.id, title: item.content ?? '', description: item.description || null, projectId: item.project_id ?? null,
    projectName: project?.name ?? null, projectColor: project?.color ?? null, priority: item.priority ?? 1,
    due: normalizeTodoistDue(item.due, userTimeZone),
    durationMinutes: item.duration ? item.duration.amount * (item.duration.unit === 'day' ? 1440 : 1) : null,
    completed: !!item.checked, completedAt: item.completed_at ? new Date(item.completed_at) : null, deleted: !!item.is_deleted,
    updatedAt: item.updated_at ? new Date(item.updated_at) : null };
}

// Kairo's cursor wraps the sync token with the user's timezone (needed to read floating times on incremental syncs).
type Cursor = { v: 1 | 2 | 3; token: string; tz: string | null };
function parseCursor(cursor: string | null): Cursor | null {
  try { const value = cursor ? JSON.parse(cursor) : null; return [1, 2, 3].includes(value?.v) && typeof value.token === 'string' ? value : null; }
  catch { return null; }
}

type DueState = NonNullable<TaskUpdateContext['current']> & { lang?: string | null };
const dueState = (due?: TodoistDue | null): DueState | null => dueRaw(due) ? { timed: dueRaw(due)!.includes('T'), recurring: !!due!.is_recurring,
  string: due!.string ?? null, timeZone: due!.timezone ?? null, lang: due!.lang ?? null } : null;

// Builds the Sync API due for a move. Recurring tasks keep their string so the recurrence survives (as Todoist's own clients do).
export async function todoistDueArg(current: DueState | null | undefined, due: TaskPatch['due'], userTimeZone: () => Promise<string | null>) {
  const recurring = !!current?.recurring, currentTimed = !!current?.timed;
  if (due === null) {
    if (recurring) throw new TaskPatchError('Todoist recurring tasks cannot lose their date; edit the recurrence in Todoist');
    return null;
  }
  if (!due) return undefined;
  const timed = 'dateTime' in due;
  if (recurring && timed !== currentTimed)
    throw new TaskPatchError(`Todoist recurring tasks can only move to another ${currentTimed ? 'time' : 'day'}; change the recurrence in Todoist`);
  const date = !timed ? due.date : current?.timeZone ? utcSeconds(due.dateTime) : instantToFloating(due.dateTime, (await userTimeZone()) || 'UTC');
  if (recurring) return { date, string: current!.string, lang: current!.lang ?? undefined, is_recurring: true, ...(current!.timeZone ? { timezone: current!.timeZone } : {}) };
  return { date, ...(timed && current?.timeZone ? { timezone: current.timeZone } : {}) };
}

export function classifyTodoistError(error: unknown): TaskErrorKind {
  if (error instanceof TaskPatchError) return 'rejected';
  if (!(error instanceof TodoistApiError)) return 'transient';
  if ((error.status === 400 || error.status === 401) && /invalid_grant|invalid_token/i.test(error.message)) return 'invalid-grant';
  if (error.status === 401) return 'unauthorized';
  if (error.status === 403) return 'forbidden';
  return error.status === 400 || error.status === 404 ? 'rejected' : 'transient';
}

export type TodoistProviderOptions = { fetch?: typeof fetch; oauth?: () => TodoistOAuthCredentials };

export function createTodoistProvider(options: TodoistProviderOptions = {}): TaskProvider {
  const requestFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    id: 'todoist',
    label: 'Todoist',
    capabilities: { dueTime: true, complete: true, edit: true },
    canWrite: todoistScopeCanWrite,
    taskUrl: todoistTaskUrl,
    classifyError: classifyTodoistError,
    async refreshToken(refreshToken) {
      if (!options.oauth) throw new Error('Todoist OAuth is not configured');
      const tokens = await refreshTodoistToken(options.oauth(), refreshToken, requestFetch);
      return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresIn: tokens.expires_in, scope: tokens.scope };
    },
    async sync(token, cursor) {
      const previous = parseCursor(cursor);
      // Older cursors predate projects/user resources or project colors (v3: Inbox uncolored): start over so they are filled.
      const data = await syncTodoist(token, previous?.v === 3 ? previous.token : null, requestFetch, ['items', 'projects', 'user']);
      const tz = data.user?.tz_info?.timezone || previous?.tz || null;
      const projects = new Map<string, ProjectInfo>((data.projects ?? []).filter(project => !project.is_deleted && project.name)
        // The Inbox is charcoal in Todoist; leave it uncolored so it gets the default task color.
        .map(project => [project.id, { name: project.name!, color: project.inbox_project ? null : todoistColor(project.color) }]));
      return { tasks: (data.items ?? []).map(item => normalizeTodoistItem(item, projects, tz)), cursor: JSON.stringify({ v: 3, token: data.sync_token, tz } satisfies Cursor),
        full: data.full_sync, projects: [...projects].map(([id, project]) => ({ id, ...project })) };
    },
    // With context (stored due + cursor) a due edit is a single request; without it we read the task and user first.
    async update(token, externalId, patch, context = {}) {
      const commands: { type: string; uuid: string; args: Record<string, unknown> }[] = [];
      const args: Record<string, unknown> = { id: externalId };
      let current: DueState | null | undefined = context.current;
      if (patch.title !== undefined) args.content = patch.title;
      if (patch.due !== undefined) {
        if (current === undefined) current = dueState((await todoistGet<{ due?: TodoistDue | null }>(token, `/tasks/${encodeURIComponent(externalId)}`, requestFetch)).due);
        const cursorTz = parseCursor(context.cursor ?? null)?.tz;
        args.due = await todoistDueArg(current, patch.due, async () => cursorTz || (await getTodoistUser(token, requestFetch)).timeZone);
      }
      if (Object.keys(args).length > 1) commands.push({ type: 'item_update', uuid: crypto.randomUUID(), args });
      // item_close completes regular tasks and advances recurring ones; a recurring "uncomplete" is a due restore, not a command.
      if (patch.completed === true || (patch.completed === false && !current?.recurring))
        commands.push({ type: patch.completed ? 'item_close' : 'item_uncomplete', uuid: crypto.randomUUID(), args: { id: externalId } });
      if (!commands.length) return;
      const result = await todoistSyncRequest(token, new URLSearchParams({ commands: JSON.stringify(commands) }), requestFetch) as
        { sync_status?: Record<string, 'ok' | { error?: string; error_code?: number; http_code?: number }> };
      for (const command of commands) {
        const status = result.sync_status?.[command.uuid];
        if (status === 'ok') continue;
        const message = `Todoist ${command.type} failed: ${status?.error || 'no status returned'}`;
        if (status?.http_code === 401 || status?.http_code === 403) throw new TodoistApiError(status.http_code, message);
        if (status && (status.http_code ?? 400) < 500) throw new TaskPatchError(message);
        throw new Error(message);
      }
    },
  };
}
