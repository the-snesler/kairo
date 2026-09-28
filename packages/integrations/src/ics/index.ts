import ICAL from 'ical.js';
import { createHash } from 'node:crypto';

export type IcsOccurrence = {
  uid: string; recurrenceId: string; title: string; description: string | null; location: string | null;
  start: string; end: string; allDay: boolean; cancelled: boolean; revision: string;
};
export type IcsFetch = { status: 'not-modified'; etag?: string; lastModified?: string } |
  { status: 'complete'; body: string; etag?: string; lastModified?: string };

export async function fetchIcs(url: string, cache: { etag?: string | null; lastModified?: string | null } = {}, requestFetch: typeof fetch = fetch): Promise<IcsFetch> {
  const headers: Record<string, string> = {};
  if (cache.etag) headers['If-None-Match'] = cache.etag;
  if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
  const response = await requestFetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  const etag = response.headers.get('etag') ?? undefined;
  const lastModified = response.headers.get('last-modified') ?? undefined;
  if (response.status === 304) return { status: 'not-modified', etag, lastModified };
  if (!response.ok) throw new Error(`ICS fetch failed (${response.status})`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > 10_000_000) throw new Error('ICS feed exceeds 10 MB');
  const body = await response.text();
  if (body.length > 10_000_000) throw new Error('ICS feed exceeds 10 MB');
  return { status: 'complete', body, etag, lastModified };
}

export function parseIcs(body: string, rangeStart: Date, rangeEnd: Date): IcsOccurrence[] {
  if (!(rangeStart < rangeEnd)) throw new Error('Invalid ICS range');
  if (!/^BEGIN:VCALENDAR\r?\n/i.test(body.trimStart()) || !/\r?\nEND:VCALENDAR\s*$/i.test(body))
    throw new Error('ICS response is incomplete');
  const root = new ICAL.Component(ICAL.parse(body));
  if (root.name !== 'vcalendar') throw new Error('ICS response is not a calendar');
  const components = root.getAllSubcomponents('vevent');
  const masters = new Map<string, ICAL.Event>();
  const exceptions = new Map<string, ICAL.Event[]>();
  for (const component of components) {
    const event = new ICAL.Event(component);
    if (!event.uid) throw new Error('ICS event has no UID');
    if (event.isRecurrenceException()) {
      const entries = exceptions.get(event.uid) ?? []; entries.push(event); exceptions.set(event.uid, entries);
    } else masters.set(event.uid, event);
  }
  const results: IcsOccurrence[] = [];
  for (const [uid, event] of masters) {
    for (const exception of exceptions.get(uid) ?? []) event.relateException(exception);
    const append = (occurrenceTime: ICAL.Time) => {
      const details = event.getOccurrenceDetails(occurrenceTime);
      const source = details.item;
      const start = details.startDate.toJSDate(); const end = details.endDate.toJSDate();
      if (end <= rangeStart || start >= rangeEnd) return;
      const recurrenceId = event.isRecurring() ? occurrenceTime.toString() : '';
      const cancelled = source.component.getFirstPropertyValue('status') === 'CANCELLED';
      const title = source.summary || '(Untitled)';
      const description = source.description || null; const location = source.location || null;
      const allDay = details.startDate.isDate;
      const normalized = { uid, recurrenceId, title, description, location,
        start: allDay ? details.startDate.toString().slice(0, 10) : start.toISOString(),
        end: allDay ? details.endDate.toString().slice(0, 10) : end.toISOString(), allDay, cancelled };
      const revision = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
      results.push({ ...normalized, revision });
    };
    if (!event.isRecurring()) { append(event.startDate); continue; }
    const iterator = event.iterator(); let count = 0;
    for (let next = iterator.next(); next; next = iterator.next()) {
      if (++count > 100_000) throw new Error('ICS recurrence exceeds bounded expansion limit');
      if (next.toJSDate() >= rangeEnd) break;
      append(next);
    }
  }
  // An exception without its master can be a valid detached event in some feeds.
  for (const [uid, entries] of exceptions) if (!masters.has(uid)) for (const event of entries) {
    const start = event.startDate.toJSDate(); const end = event.endDate.toJSDate();
    if (end <= rangeStart || start >= rangeEnd) continue;
    const recurrenceId = event.recurrenceId?.toString() ?? event.startDate.toString();
    const normalized = { uid, recurrenceId, title: event.summary || '(Untitled)', description: event.description || null,
      location: event.location || null, start: event.startDate.isDate ? event.startDate.toString().slice(0, 10) : start.toISOString(),
      end: event.endDate.isDate ? event.endDate.toString().slice(0, 10) : end.toISOString(), allDay: event.startDate.isDate,
      cancelled: event.component.getFirstPropertyValue('status') === 'CANCELLED' };
    results.push({ ...normalized, revision: createHash('sha256').update(JSON.stringify(normalized)).digest('hex') });
  }
  return results;
}
