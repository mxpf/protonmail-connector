import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { parseCalendar } from '../src/calendar/parse.js';
import { fetchICS } from '../src/calendar/feed.js';
import { configSchema, validFeedURL } from '../src/calendar/config.js';
const feed = (events: string) =>
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + events.replace(/\n/g, '\r\n') + '\r\nEND:VCALENDAR\r\n';
const vevent = (body: string) => 'BEGIN:VEVENT\n' + body + '\nEND:VEVENT';
const range = { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' };
const parse = (ics: string, start = range.start, end = range.end) =>
  parseCalendar(ics, 'work', 'America/New_York', start, end);
const basic = vevent('UID:one\nDTSTART:20260924T140000Z\nDTEND:20260924T150000Z\nSUMMARY:One');
const config = () => ({
  ...configSchema.parse({
    calendars: [
      {
        id: 'work',
        name: 'Work',
        url: 'https://calendar.proton.me/api/calendar/v1/url/example/calendar.ics?secret=fixture',
        timezone: 'America/New_York',
        visibility: 'full',
      },
    ],
  }),
});

test('recurrence expansion respects EXDATE, moved overrides and cancellation', () => {
  const ics = feed(
    vevent(
      'UID:r\nDTSTART:20260901T140000Z\nDTEND:20260901T150000Z\nRRULE:FREQ=DAILY;COUNT=5\nEXDATE:20260902T140000Z\nSUMMARY:Daily',
    ) +
      '\n' +
      vevent(
        'UID:r\nRECURRENCE-ID:20260903T140000Z\nDTSTART:20260903T180000Z\nDTEND:20260903T190000Z\nSUMMARY:Moved',
      ) +
      '\n' +
      vevent('UID:r\nRECURRENCE-ID:20260904T140000Z\nSTATUS:CANCELLED'),
  );
  const events = parse(ics);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.title),
    ['Daily', 'Moved', 'Daily'],
  );
  assert.equal(events[1].start, '2026-09-03T18:00:00.000Z');
  assert.equal(new Set(events.map((e) => e.id)).size, 3);
  const movedInto = feed(
    vevent('UID:x\nDTSTART:20261001T140000Z\nDTEND:20261001T150000Z\nRRULE:FREQ=DAILY;COUNT=2') +
      '\n' +
      vevent(
        'UID:x\nRECURRENCE-ID:20261001T140000Z\nDTSTART:20260924T180000Z\nDTEND:20260924T190000Z\nSUMMARY:Moved earlier',
      ),
  );
  assert.equal(parse(movedInto).length, 1);
});
test('all-day dates use configured timezone and exclusive end across DST', () => {
  const events = parse(
    feed(
      vevent('UID:day\nDTSTART;VALUE=DATE:20261101\nDTEND;VALUE=DATE:20261102\nSUMMARY:All day'),
    ),
    '2026-11-01T00:00:00Z',
    '2026-11-03T00:00:00Z',
  );
  assert.equal(events[0].start, '2026-11-01T04:00:00.000Z');
  assert.equal(events[0].end, '2026-11-02T05:00:00.000Z');
  assert.equal(events[0].allDay, true);
});
test('detached recurrence instances keep their explicit times without inventing a series', () => {
  const instance = vevent('UID:detached\nRECURRENCE-ID:20260902T140000Z\nDTSTART:20260903T180000Z\nDTEND:20260903T190000Z\nSUMMARY:Moved');
  const cancelled = vevent('UID:detached\nRECURRENCE-ID:20260904T140000Z\nSTATUS:CANCELLED');
  const events = parse(feed(instance+'\n'+cancelled));
  assert.equal(events.length, 1);
  assert.equal(events[0].start, '2026-09-03T18:00:00.000Z');
  assert.equal(events[0].recurrenceId, '2026-09-02T14:00:00Z');
  assert.throws(()=>parse(feed(instance+'\n'+instance)), /Duplicate/);
  assert.throws(()=>parse(feed(instance.replace('SUMMARY:Moved','RRULE:FREQ=DAILY'))), /detached/);
});
test('malformed unused attendee metadata does not hide event timing or body failures', () => {
  const badAttendee = 'ATTENDEE;CN="Broken name:mailto:fixture@example.test\n^n';
  const events = parse(feed(basic.replace('SUMMARY:One', badAttendee+'\nSUMMARY:One')));
  assert.equal(events[0].title, 'One');
  assert.equal(events[0].start, '2026-09-24T14:00:00.000Z');
  assert.throws(()=>parse(feed(basic.replace('SUMMARY:One','DTSTART;VALUE="broken:20260924T140000Z'))));
  assert.throws(()=>parse(feed(basic.replace('SUMMARY:One',badAttendee+'\ninvalid content'))));
});
test('embedded timezone recurrences preserve local time across DST', () => {
  const zone =
    'BEGIN:VTIMEZONE\nTZID:America/New_York\nBEGIN:STANDARD\nDTSTART:19701101T020000\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\nEND:STANDARD\nBEGIN:DAYLIGHT\nDTSTART:19700308T020000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\nEND:DAYLIGHT\nEND:VTIMEZONE';
  ICAL.TimezoneService.reset();
  const events = parse(
    feed(
      zone +
        '\n' +
        vevent(
          'UID:dst\nDTSTART;TZID=America/New_York:20261031T090000\nDTEND;TZID=America/New_York:20261031T100000\nRRULE:FREQ=DAILY;COUNT=3',
        ),
    ),
    '2026-10-30T00:00:00Z',
    '2026-11-04T00:00:00Z',
  );
  assert.deepEqual(
    events.map((e) => e.start),
    ['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z'],
  );
  ICAL.TimezoneService.reset();
});
test('floating time, folded text, transparent and zero-duration events', () => {
  const events = parse(
    feed(vevent('UID:f\nDTSTART:20260924T090000\nSUMMARY:Folded\n  title\nTRANSP:TRANSPARENT')),
  );
  assert.equal(events[0].start, '2026-09-24T13:00:00.000Z');
  assert.equal(events[0].end, events[0].start);
  assert.equal(events[0].title, 'Folded title');
  assert.equal(events[0].busy, false);
});
test('reject unknown timezone and unsafe unsupported recurrence instead of assuming free', () => {
  assert.throws(
    () => parse(feed(vevent('UID:u\nDTSTART;TZID=Unknown/Zone:20260924T090000'))),
    /VTIMEZONE/,
  );
  assert.throws(
    () =>
      parse(
        feed(
          vevent(
            'UID:x\nRECURRENCE-ID;RANGE=THISANDFUTURE:20260924T090000Z\nDTSTART:20260924T100000Z',
          ),
        ),
      ),
    /RANGE/,
  );
  assert.throws(() => parse(feed(basic + '\n' + basic)), /Duplicate/);
  assert.throws(
    () => parse(feed(vevent('UID:fast\nDTSTART:20200101T000000Z\nRRULE:FREQ=SECONDLY'))),
    /limit/,
  );
});
test('fetch rejects arbitrary hosts, redirects, HTML, failures and oversized streams without leaking URL', async () => {
  assert.equal(
    validFeedURL('https://calendar.proton.me.evil.test/api/calendar/v1/url/x/calendar.ics'),
    false,
  );
  assert.equal(validFeedURL('http://127.0.0.1/calendar.ics'), false);
  assert.equal(
    validFeedURL('https://calendar.proton.me:444/api/calendar/v1/url/x/calendar.ics'),
    false,
  );
  const url = config().calendars[0].url;
  let seen = false;
  const ok: typeof fetch = async (_input, init) => {
    seen = true;
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return new Response(feed(basic));
  };
  assert.equal(await fetchICS(url, ok), feed(basic));
  assert.ok(seen);
  for (const response of [
    new Response('html'),
    new Response('', { status: 403 }),
    new Response('x'.repeat(5 * 1024 * 1024 + 1)),
    new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/' } }),
  ])
    await assert.rejects(
      fetchICS(url, async () => response),
      (error) =>
        error instanceof Error &&
        !error.message.includes('secret') &&
        /unavailable/.test(error.message),
    );
});
