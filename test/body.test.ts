import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ImapFlow} from 'imapflow';
import {simpleParser} from 'mailparser';
import {extractBody, parseMail, sourcePage, MAX_HTML, MAX_MESSAGE, MAX_TEXT} from '../src/body.js';
import {MailService} from '../src/mail.js';
import {tools} from '../shared/protocol.js';

// Synthetic fixtures only. No mailbox exports or real correspondence in tests.
const cr = '\r\n';
const headers = ['From: sender@example.test', 'To: owner@example.test',
  'Message-ID: <body-regression@example.test>', 'MIME-Version: 1.0'];
const part = (type: string, body: string, encoding = '7bit', extra: string[] = []) =>
  [`Content-Type: ${type}`, `Content-Transfer-Encoding: ${encoding}`, ...extra, '', body].join(cr);
const multipart = (kind: string, boundary: string, parts: string[]) =>
  [`Content-Type: multipart/${kind}; boundary="${boundary}"`, '',
    ...parts.map(p => `--${boundary}${cr}${p}`), `--${boundary}--`].join(cr);
const raw = (body: string) => Buffer.from([...headers, body].join(cr));
const html = part('text/html; charset=utf-8', Buffer.from('<p>Visible café reply.</p><blockquote>Earlier reply.</blockquote>').toString('base64'), 'base64');
const attachment = part('application/pdf', 'cGRm', 'base64', ['Content-Disposition: attachment; filename="file.pdf"']);
const alternative = multipart('alternative', 'alt', [part('text/plain; charset=utf-8', ''), html]);
const images = Array.from({length: 19}, (_, i) => part('image/png', 'aW1hZ2U=', 'base64',
  [`Content-Disposition: inline; filename="image${i}.png"`, `Content-ID: <image${i}>`]));
const outlook = raw(multipart('mixed', 'outer', [multipart('related', 'related', [html, ...images])]));

test('HTML-only mixed and related messages recover text and preserve attachment identity', async () => {
  for (const fixture of [raw(multipart('mixed', 'mixed', [html, attachment])), outlook,
    raw(multipart('mixed', 'mixed', [alternative, attachment]))]) {
    const legacy = await simpleParser(fixture, {skipImageLinks: true, maxHtmlLengthToParse: MAX_MESSAGE});
    assert.equal((legacy.text ?? '').trim(), '', 'fixture reproduces the old empty-text failure');
    const parsed = await parseMail(fixture);
    const result = extractBody(parsed);
    assert.match(result.text, /Visible café reply\./);
    assert.match(result.text, /Earlier reply\./);
    assert.equal(result.body.source, 'html');
    assert.equal(result.body.incomplete, false);
    assert.equal(parsed.messageId, '<body-regression@example.test>');
    assert.deepEqual(parsed.attachments.map(a => [a.filename, a.contentType, a.size, a.contentId, a.content]),
      legacy.attachments.map(a => [a.filename, a.contentType, a.size, a.contentId, a.content]));
  }
});

test('MIME decoding handles quoted-printable, base64, Latin-1 and mixed-part ordering', async () => {
  for (const body of [part('text/html; charset=utf-8', '<p>caf=C3=A9</p>', 'quoted-printable'),
    part('text/html; charset=iso-8859-1', '<p>caf=E9</p>', 'quoted-printable'), html]) {
    const mail = await parseMail(raw(multipart('mixed', 'mixed', [body, attachment])));
    assert.match(extractBody(mail).text, /café/);
    assert.equal(mail.attachments.length, 1);
  }
  const mail = await parseMail(raw(multipart('mixed', 'mixed', [part('text/plain', 'First'), html, part('text/plain', 'Last')])));
  assert.match(extractBody(mail).text, /First[\s\S]*Visible café reply[\s\S]*Last/);
});

test('plain alternative is retained; whitespace-only plain falls back; attachments stay outside body', async () => {
  const meaningful = await parseMail(raw(multipart('alternative', 'alt', [part('text/plain', 'Plain reply'), html])));
  assert.equal(extractBody(meaningful).text, 'Plain reply');
  const whitespace = await parseMail(raw(multipart('mixed', 'mix', [multipart('alternative', 'alt', [part('text/plain', ' \t\r\n'), html]),
    part('text/plain', 'ATTACHMENT ONLY', '7bit', ['Content-Disposition: attachment; filename="note.txt"'])])));
  assert.match(extractBody(whitespace).text, /Visible café reply/);
  assert.doesNotMatch(extractBody(whitespace).text, /ATTACHMENT ONLY/);
  assert.equal(whitespace.attachments.length, 1);
});

test('fallback preserves quotes, links and surrounding text without active markup or resource loading', () => {
  const result = extractBody({text: '', html: 'Before<p>Hello <a href="https://example.test">link</a></p>' +
    '<blockquote>Quoted history</blockquote>After<script>SCRIPT_SECRET</script><style>STYLE_SECRET</style>' +
    '<img src="https://example.test/pixel"><iframe>FRAME_SECRET</iframe><svg>SVG_SECRET</svg>' +
    '<a href="javascript:bad()" onclick="bad()">safe label</a>'});
  assert.match(result.text, /Before[\s\S]*Hello[\s\S]*https:\/\/example.test[\s\S]*Quoted history[\s\S]*After/);
  assert.doesNotMatch(result.text, /SECRET|pixel|javascript|onclick/);
  assert.equal(result.body.incomplete, false);
});

test('empty/image-only extraction and every extraction budget report incomplete results', () => {
  for (const html of [false, '', '  ', '<img src="cid:image0">']) {
    const result = extractBody({text: '', html});
    assert.equal(result.text, '');
    assert.equal(result.body.status, 'incomplete');
    assert.deepEqual(result.body.reasons, ['no_readable_text']);
    assert.equal(result.body.recoveryTool, 'proton_read_source');
  }
  for (const [html, reason] of [
    ['x'.repeat(MAX_HTML + 1), 'html_input_limit'],
    ['<div>'.repeat(129) + 'deep' + '</div>'.repeat(129), 'html_structure_limit'],
    ['<br>'.repeat(20_001), 'html_structure_limit'],
  ]) {
    const result = extractBody({html});
    assert.equal(result.body.incomplete, true);
    assert.ok(result.body.reasons.includes(reason));
  }
  const result = extractBody({text: 'x'.repeat(MAX_TEXT + 1)});
  assert.equal(result.text.length, MAX_TEXT);
  assert.equal(result.truncated, true);
  assert.equal(result.body.status, 'truncated');
  assert.equal(result.body.incomplete, true);
  assert.deepEqual(result.body.reasons, ['text_output_limit']);
});

test('recovery pages are byte exact, bounded, hash bound and schema checked', () => {
  const source = Buffer.from('café'.repeat(20_000));
  let page = sourcePage(source, 0, 65536);
  const chunks = [Buffer.from(page.base64, 'base64')];
  assert.equal(page.bytes, 65536);
  while (page.nextOffset !== null) {
    page = sourcePage(source, page.nextOffset, 65536, page.sourceSha256);
    chunks.push(Buffer.from(page.base64, 'base64'));
  }
  assert.deepEqual(Buffer.concat(chunks), source);
  assert.throws(() => sourcePage(source, 1, 8, '0'.repeat(64)), /Source changed/);
  assert.throws(() => sourcePage(source, source.length + 1, 8), /beyond/);
  const message = {mailbox: 'INBOX', uid: 7, uidValidity: '99'};
  assert.equal(tools.proton_read_source.schema.safeParse({message, format: 'raw_mime', offset: 1}).success, false);
  assert.equal(tools.proton_read_source.schema.safeParse({message, format: 'raw_mime', limit: 65537}).success, false);
});

test('service recovery preserves UID, Message-ID, flags and attachment bytes; stale refs cannot download', async () => {
  const ref = {mailbox: 'INBOX', uid: 7, uidValidity: '99'};
  const flags = new Set(['\\Seen', '\\Flagged']);
  let validity = 99n, downloads = 0;
  let currentRaw = outlook;
  const locks: unknown[] = [];
  const fake = Object.assign(new EventEmitter(), {
    connect: async () => {}, close: () => {},
    getMailboxLock: async (path: string, opts: unknown) => { locks.push([path, opts]); return {release: () => {}}; },
    fetchOne: async (uid: string, _query: unknown, opts: unknown) => {
      assert.equal(uid, '7'); assert.deepEqual(opts, {uid: true});
      return {uid: 7, size: currentRaw.length, flags, envelope: {messageId: '<body-regression@example.test>'}};
    },
    download: async (uid: string, _part: unknown, opts: unknown) => {
      assert.equal(uid, '7'); assert.deepEqual(opts, {uid: true, maxBytes: MAX_MESSAGE + 1}); downloads++;
      return {content: Readable.from([currentRaw])};
    },
    messageFlagsAdd: async () => { throw new Error('Must not mutate flags'); },
    messageFlagsRemove: async () => { throw new Error('Must not mutate flags'); },
  });
  Object.defineProperty(fake, 'mailbox', {get: () => ({uidValidity: validity})});
  const dir = mkdtempSync(join(tmpdir(), 'proton-body-'));
  const service = new MailService({username: 'owner@example.test', sender: 'owner@example.test', password: 'fake',
    certificatePath: '/unused', tlsServerName: 'localhost', imapPort: 1143, smtpPort: 1025, ledgerPath: join(dir, 'send.db')},
    () => fake as unknown as ImapFlow);
  try {
    const read: any = await service.execute('proton_read', {message: ref});
    assert.deepEqual(read.message, ref);
    assert.equal(read.messageId, '<body-regression@example.test>');
    assert.equal(read.attachments.length, 19);
    assert.match(read.text, /Visible café reply/);
    const mime: any = await service.execute('proton_read_source', {message: ref, format: 'raw_mime', limit: 65536});
    assert.deepEqual(Buffer.from(mime.base64, 'base64'), outlook);
    assert.deepEqual(mime.message, ref);
    assert.equal(mime.messageId, read.messageId);
    const htmlPage: any = await service.execute('proton_read_source', {message: ref, format: 'html'});
    assert.match(Buffer.from(htmlPage.base64, 'base64').toString('utf8'), /Visible café reply/);
    const file: any = await service.execute('proton_read_attachment', {message: ref, index: 18});
    assert.equal(file.filename, 'image18.png'); assert.equal(file.base64, 'aW1hZ2U=');
    assert.deepEqual([...flags], ['\\Seen', '\\Flagged']);
    assert.ok(locks.every(lock => JSON.stringify(lock) === JSON.stringify(['INBOX', {readOnly: true}])));
    validity = 100n;
    const before = downloads;
    await assert.rejects(service.execute('proton_read_source', {message: ref, format: 'raw_mime'}), /mailbox changed/);
    assert.equal(downloads, before);
    validity = 99n;
    // A top-level HTML part above the parser conversion budget must still be
    // recoverable without invoking that parser through the raw MIME route.
    currentRaw = raw(part('text/html; charset=utf-8', 'x'.repeat(MAX_HTML + 1)));
    await assert.rejects(service.execute('proton_read', {message: ref}), /body|MIME parsing failed/i);
    const recovery: any = await service.execute('proton_read_source', {message: ref, format: 'raw_mime', limit: 128});
    assert.deepEqual(Buffer.from(recovery.base64, 'base64'), currentRaw.subarray(0, 128));
    assert.equal(recovery.nextOffset, 128);
    currentRaw = Buffer.alloc(MAX_MESSAGE + 1);
    const boundedDownloads = downloads;
    await assert.rejects(service.execute('proton_read_source', {message: ref, format: 'raw_mime'}), /12 MiB/);
    assert.equal(downloads, boundedDownloads);
  } finally { service.close(); rmSync(dir, {recursive: true}); }
});
