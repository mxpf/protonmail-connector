import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import type { CalendarConfig } from './config.js';
import { validFeedURL } from './config.js';
import type { CalendarEvent, Snapshot } from './types.js';
export async function fetchICS(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!validFeedURL(url)) throw new Error('Invalid feed URL.');
  try {
    const response = await fetcher(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'text/calendar', 'User-Agent': 'Owner-Calendar-Connector/0.1' },
    });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 5 * 1024 * 1024) throw new Error();
        parts.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const text = Buffer.concat(parts).toString('utf8');
    if (!/^BEGIN:VCALENDAR\r?\n/.test(text.trimStart())) throw new Error();
    return text;
  } catch {
    throw new Error(
      'Calendar feed unavailable or invalid. Check its sharing link in the private configuration.',
    );
  }
}
export function expand(
  ics: string,
  c: CalendarConfig,
  start: string,
  end: string,
): Promise<CalendarEvent[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parse-worker.js', import.meta.url), {
      workerData: { ics, id: c.id, timezone: c.timezone, start, end },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    let settled = false;
    const finish = (error?: Error, events?: CalendarEvent[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(events!);
    };
    const timer = setTimeout(
      () =>
        finish(new Error('Calendar expansion timed out. Narrow the query or simplify this feed.')),
      5000,
    );
    worker.once('message', (message) =>
      message.error ? finish(new Error(message.error)) : finish(undefined, message.events),
    );
    worker.once('error', () => finish(new Error('Calendar expansion failed.')));
    worker.once('exit', () => finish(new Error('Calendar worker stopped unexpectedly.')));
  });
}
export class Feeds {
  private cache = new Map<string, { ics: string; fetchedAt: string; at: number }>();
  private inflight = new Map<string, Promise<{ ics: string; fetchedAt: string; at: number }>>();
  constructor(
    private ttl: number,
    private fetcher: typeof fetch = fetch,
  ) {}
  async read(c: CalendarConfig, start: string, end: string): Promise<Snapshot> {
    let entry = this.cache.get(c.id);
    if (!entry || Date.now() - entry.at >= this.ttl * 1000) {
      let pending = this.inflight.get(c.id);
      if (!pending) {
        pending = fetchICS(c.url, this.fetcher)
          .then((ics) => {
            const fresh = { ics, fetchedAt: new Date().toISOString(), at: Date.now() };
            this.cache.set(c.id, fresh);
            return fresh;
          })
          .finally(() => this.inflight.delete(c.id));
        this.inflight.set(c.id, pending);
      }
      entry = await pending;
    }
    return {
      events: await expand(entry.ics, c, start, end),
      fetchedAt: entry.fetchedAt,
      snapshotId: createHash('sha256').update(entry.ics).digest('hex'),
    };
  }
}
