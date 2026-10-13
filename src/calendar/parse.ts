import ICAL from 'ical.js';
import { Temporal } from '@js-temporal/polyfill';
import { createHash } from 'node:crypto';
import type { CalendarEvent } from './types.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const value = (c: ICAL.Component, name: string) => String(c.getFirstPropertyValue(name) ?? '');

// This function runs in an isolated, deadline-limited worker. TimezoneService is
// global in ical.js, so each feed gets its own worker and timezone registry.
export function parseCalendar(
  ics: string,
  calendarId: string,
  timezone: string,
  from: string,
  to: string,
): CalendarEvent[] {
  if (Buffer.byteLength(ics) > 5 * 1024 * 1024) throw new Error('Feed exceeds size limit.');
  // Attendees are not part of this read model. Some shared exports contain a
  // broken quoted ATTENDEE parameter and a stray RFC 6868 newline marker on the
  // following physical line. Omit only that unused property and its exact marker;
  // malformed timing, recurrence, event text or component structure still fails.
  let afterAttendee = false;
  const readable = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(line => {
    if (/^ATTENDEE[;:]/i.test(line)) { afterAttendee = true; return false; }
    if (afterAttendee && /^\^n$/i.test(line)) return false;
    afterAttendee = false;
    return true;
  }).join('\r\n');
  const root = new ICAL.Component(ICAL.parse(readable));
  if (root.name !== 'vcalendar' || value(root, 'version') !== '2.0')
    throw new Error('Invalid iCalendar feed.');
  for (const zone of root.getAllSubcomponents('vtimezone')) {
    const tzid = value(zone, 'tzid');
    if (!tzid || ICAL.TimezoneService.has(tzid)) throw new Error('Duplicate or invalid timezone.');
    ICAL.TimezoneService.register(new ICAL.Timezone({ component: zone, tzid }));
  }
  const instant = (t: ICAL.Time): number => {
    if (t.zone && t.zone !== ICAL.Timezone.localTimezone) return t.toUnixTime() * 1000;
    return Number(
      Temporal.ZonedDateTime.from(
        {
          timeZone: timezone,
          year: t.year,
          month: t.month,
          day: t.day,
          hour: t.isDate ? 0 : t.hour,
          minute: t.isDate ? 0 : t.minute,
          second: t.isDate ? 0 : t.second,
        },
        { disambiguation: 'compatible' },
      ).epochMilliseconds,
    );
  };
  if (root.getAllSubcomponents().some((c) => !['vevent', 'vtimezone'].includes(c.name)))
    throw new Error('Unsupported calendar component.');
  const components = root.getAllSubcomponents('vevent');
  if (components.length > 20000) throw new Error('Too many events.');
  const groups = new Map<string, ICAL.Component[]>();
  for (const c of components) {
    const uid = value(c, 'uid');
    if (!uid || uid.length > 1024) throw new Error('Missing or invalid event UID.');
    // Never silently interpret an unknown TZID as the host's local time.
    for (const prop of c.getAllProperties()) {
      const tz = prop.getParameter('tzid');
      if (tz && (typeof tz !== 'string' || !ICAL.TimezoneService.has(tz)))
        throw new Error('TZID needs an embedded VTIMEZONE.');
    }
    if (c.getFirstProperty('recurrence-id')?.getParameter('range'))
      throw new Error('RANGE recurrence overrides are not supported.');
    if (c.getAllProperties('rrule').length > 1 || c.hasProperty('exrule'))
      throw new Error('Unsupported recurrence rule.');
    if (c.getAllProperties('rdate').some((p) => p.type === 'period'))
      throw new Error('Period RDATE is not supported.');
    if (c.hasProperty('dtend') && c.hasProperty('duration'))
      throw new Error('Ambiguous event duration.');
    const list = groups.get(uid) ?? [];
    list.push(c);
    groups.set(uid, list);
  }
  const begin = Date.parse(from),
    end = Date.parse(to),
    output: CalendarEvent[] = [];
  let steps = 0;
  const append = (
    event: ICAL.Event,
    start: ICAL.Time,
    finish: ICAL.Time,
    rid: string | null,
    recurring: boolean,
  ) => {
    const c = event.component;
    if (value(c, 'status').toUpperCase() === 'CANCELLED') return;
    const s = instant(start),
      e = instant(finish);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) throw new Error('Invalid event time.');
    if (!(s < end && (e > begin || (e === s && s >= begin)))) return;
    const record = {
      calendarId,
      uid: event.uid,
      recurrenceId: rid,
      recurring,
      title: event.summary || '',
      description: event.description || '',
      location: event.location || '',
      start: new Date(s).toISOString(),
      end: new Date(e).toISOString(),
      allDay: start.isDate,
      ...(start.isDate ? { startDate: start.toString(), endDate: finish.toString() } : {}),
      busy: value(c, 'transp').toUpperCase() !== 'TRANSPARENT',
    };
    if (
      record.title.length > 2000 ||
      record.description.length > 20000 ||
      record.location.length > 4000
    )
      throw new Error('Event text exceeds safety limits.');
    output.push({ ...record, id: hash([calendarId, event.uid, rid]), revision: hash(record) });
    if (output.length > 10000) throw new Error('Too many occurrences in this window.');
  };
  for (const list of groups.values()) {
    const masters = list.filter((c) => !c.hasProperty('recurrence-id'));
    if (masters.length > 1) throw new Error('Duplicate master.');
    // Shared exports can retain detached instances after their series master is
    // removed. Their explicit DTSTART/DTEND still describes one real occurrence;
    // never invent or expand a missing master's recurrence rule.
    if (!masters.length) {
      const seen = new Set<string>();
      for (const c of list) {
        const rid = (c.getFirstPropertyValue('recurrence-id') as ICAL.Time).toString();
        if (seen.has(rid)) throw new Error('Duplicate recurrence override.');
        seen.add(rid);
        if (value(c, 'status').toUpperCase() === 'CANCELLED') continue;
        if (!c.hasProperty('dtstart') || c.hasProperty('rrule') || c.hasProperty('rdate'))
          throw new Error('Invalid detached recurrence instance.');
        const event = new ICAL.Event(c);
        append(event, event.startDate, event.endDate, rid, true);
      }
      continue;
    }
    const master = new ICAL.Event(masters[0]);
    if (value(master.component, 'status').toUpperCase() === 'CANCELLED') continue;
    if (!master.component.hasProperty('dtstart')) throw new Error('Event has no start.');
    const overrides = new Map<string, ICAL.Component>();
    for (const c of list.filter((c) => c.hasProperty('recurrence-id'))) {
      const rid = (c.getFirstPropertyValue('recurrence-id') as ICAL.Time).toString();
      if (overrides.has(rid)) throw new Error('Duplicate recurrence override.');
      overrides.set(rid, c);
      if (value(c, 'status').toUpperCase() !== 'CANCELLED') {
        if (!c.hasProperty('dtstart')) throw new Error('Override has no start.');
        const ex = new ICAL.Event(c);
        append(ex, ex.startDate, ex.endDate, rid, true);
      }
    }
    if (!master.isRecurring()) {
      if (overrides.size) throw new Error('Overrides require a recurring master.');
      append(master, master.startDate, master.endDate, null, false);
      continue;
    }
    const iterator = master.iterator();
    let occurrence: ICAL.Time | null;
    while ((occurrence = iterator.next())) {
      if (++steps > 100000) throw new Error('Recurrence expansion limit exceeded.');
      if (instant(occurrence) >= end) break;
      const rid = occurrence.toString();
      if (overrides.has(rid)) continue;
      const details = master.getOccurrenceDetails(occurrence);
      append(master, details.startDate, details.endDate, rid, true);
    }
  }
  return output.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}
