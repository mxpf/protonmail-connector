import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
export function validFeedURL(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      u.hostname === 'calendar.proton.me' &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.hash &&
      u.pathname.startsWith('/api/calendar/v1/url/') &&
      u.pathname.endsWith('/calendar.ics')
    );
  } catch {
    return false;
  }
}
const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Use an IANA time zone');
export const calendarSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    name: z.string().min(1).max(120),
    url: z.string().max(4096).refine(validFeedURL, 'Use a Proton shared calendar ICS URL'),
    timezone,
    visibility: z.enum(['full', 'busy']).default('full'),
  })
  .strict();
export const configSchema = z
  .object({
    calendars: z
      .array(calendarSchema)
      .min(1)
      .max(25)
      .refine(
        (cs) => new Set(cs.map((c) => c.id)).size === cs.length,
        'Calendar IDs must be unique',
      ),
    cacheSeconds: z.number().int().min(30).max(900).default(60),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type CalendarConfig = z.infer<typeof calendarSchema>;
export function loadConfig(path: string): Config {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error('Configuration must be a private file (mode 600).');
  // Zod errors can include a secret URL; never print the failed input.
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Calendar configuration must be valid JSON.');
  }
  const result = configSchema.safeParse(input);
  if (!result.success)
    throw new Error('Invalid calendar configuration. Check the documented schema.');
  return result.data;
}
