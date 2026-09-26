import {ImapFlow, type SearchObject} from 'imapflow';
import {simpleParser} from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {checkServerIdentity, type PeerCertificate} from 'node:tls';
import {isIP} from 'node:net';
import type {z} from 'zod';
import type {Config} from './config.js';
import {SendLedger, type Prepared} from './send-ledger.js';
import {tools, composition, type MessageRef, type SearchInput, type ToolName, PublicError} from '../shared/protocol.js';

const MAX_MESSAGE = 12 * 1024 * 1024;
const MAX_ATTACHMENT = 8 * 1024 * 1024;
export function assertCurrentMailbox(client: Pick<ImapFlow, 'mailbox'>, ref: MessageRef) {
  if (!client.mailbox || client.mailbox.uidValidity.toString() !== ref.uidValidity)
    throw new PublicError('stale_reference', 'This mailbox changed. Search again before using the message.');
}

export class MailService {
  private busy = false;
  private ledger: SendLedger;
  constructor(private config: Config, private createClient?: () => ImapFlow) {
    this.ledger = new SendLedger(config.ledgerPath);
  }
  close() { this.ledger.close(); }
  private tls() {
    return {ca: readFileSync(this.config.certificatePath),
      servername: isIP(this.config.tlsServerName) ? undefined : this.config.tlsServerName,
      checkServerIdentity: (_name: string, cert: PeerCertificate) => checkServerIdentity(this.config.tlsServerName,cert),
      rejectUnauthorized: true};
  }
  private smtp() {
    return nodemailer.createTransport({host:'127.0.0.1',port:this.config.smtpPort,
      secure:false,requireTLS:true,tls:this.tls(),auth:{user:this.config.username,pass:this.config.password},
      connectionTimeout:10_000,greetingTimeout:10_000,socketTimeout:30_000,logger:false,debug:false});
  }
  private async connected<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.createClient?.() ?? new ImapFlow({host: '127.0.0.1', port: this.config.imapPort,
      secure: false, doSTARTTLS: true, tls: this.tls(),
      auth: {user: this.config.username, pass: this.config.password}, logger: false,
      disableAutoIdle: true, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000});
    client.on('error', () => {}); // Operation errors are handled without logging credentials or mail.
    try { await client.connect(); return await fn(client); }
    finally { client.close(); }
  }
  private async selected<T>(client: ImapFlow, ref: MessageRef, readOnly: boolean, fn: () => Promise<T>) {
    const lock = await client.getMailboxLock(ref.mailbox, {readOnly});
    try {
      assertCurrentMailbox(client, ref);
      const found = await client.fetchOne(String(ref.uid), {uid: true}, {uid: true});
      if (!found || found.uid !== ref.uid) throw new PublicError('message_missing', 'The message is no longer present. Search again.');
      return await fn();
    } finally { lock.release(); }
  }
  private async parsed(client: ImapFlow, ref: MessageRef) {
    const meta = await client.fetchOne(String(ref.uid), {size: true}, {uid: true});
    if (!meta || meta.size === undefined || meta.size > MAX_MESSAGE)
      throw new PublicError('message_too_large', 'Message missing or larger than the 12 MiB retrieval limit.');
    const {content} = await client.download(String(ref.uid), undefined, {uid: true, maxBytes: MAX_MESSAGE + 1});
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of content) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > MAX_MESSAGE) { content.destroy(); throw new PublicError('message_too_large', 'Message exceeds retrieval limit.'); }
      chunks.push(buffer);
    }
    return simpleParser(Buffer.concat(chunks), {skipImageLinks: true, maxHtmlLengthToParse: MAX_MESSAGE});
  }
  private async search(client: ImapFlow, args: SearchInput) {
    const lock = await client.getMailboxLock(args.mailbox, {readOnly: true});
    try {
      const uidValidity = client.mailbox ? client.mailbox.uidValidity.toString() : '';
      if (args.beforeUid === 1) return {mailbox: args.mailbox, messages: [], nextBeforeUid: null};
      const query: SearchObject = {all: true};
      for (const k of ['from', 'to', 'subject', 'text', 'since', 'before'] as const) if (args[k]) query[k] = args[k];
      if (args.unread !== undefined) query.seen = !args.unread;
      if (args.beforeUid) query.uid = `1:${args.beforeUid - 1}`;
      const ids = (await client.search(query, {uid: true}) || []).sort((a, b) => b - a);
      const chosen = ids.slice(0, args.limit);
      const messages = chosen.length ? await client.fetchAll(chosen, {envelope: true, flags: true, size: true}, {uid: true}) : [];
      return {mailbox: args.mailbox, messages: messages.sort((a,b) => b.uid-a.uid).map(m => ({
        message: {mailbox: args.mailbox, uidValidity, uid: m.uid},
        envelope: m.envelope, flags: [...m.flags ?? []], size: m.size,
      })), nextBeforeUid: ids.length > chosen.length ? chosen.at(-1) : null};
    } finally { lock.release(); }
  }
  private async compose(args: z.infer<typeof composition>, draft = false): Promise<Prepared> {
    let inReplyTo: string | undefined;
    if (args.replyToMessage) {
      const ref = args.replyToMessage;
      inReplyTo = await this.connected(c => this.selected(c, ref, true, async () => {
        const source = await c.fetchOne(String(ref.uid), {envelope: true}, {uid: true});
        const id = source && source.envelope?.messageId;
        if (!id || !/^<[^<>\s\r\n]{1,990}>$/.test(id)) throw new PublicError('invalid_reply_source', 'Source has no usable Message-ID.');
        return id;
      }));
    }
    const messageId = `<${randomUUID()}@${this.config.sender.split('@')[1]}>`;
    const mail = new MailComposer({from: this.config.sender, to: args.to, cc: args.cc, bcc: args.bcc,
      subject: args.subject, text: args.text, messageId, inReplyTo, references: inReplyTo,
      keepBcc: draft, disableFileAccess: true, disableUrlAccess: true});
    const raw = await mail.compile().build();
    return {raw: raw.toString('base64'), envelope: {from: this.config.sender, to: [...new Set([...args.to, ...args.cc, ...args.bcc])]},
      messageId, preview: {from: this.config.sender, ...args, messageId}};
  }
  async execute(name: ToolName, input: unknown): Promise<unknown> {
    if (this.busy) throw new PublicError('busy', 'Another mail operation is running. Try again shortly.', 429);
    this.busy = true;
    try { return await this.run(name, input); } finally { this.busy = false; }
  }
  private async run(name: ToolName, input: unknown): Promise<unknown> {
    if (name === 'proton_prepare_send') return this.ledger.prepare(await this.compose(composition.parse(input)));
    if (name === 'proton_send_prepared') {
      const {token} = tools.proton_send_prepared.schema.parse(input);
      return this.ledger.send(token, async mail => {
        const transport = this.smtp();
        try {
          const result = await transport.sendMail({envelope: mail.envelope, raw: Buffer.from(mail.raw, 'base64')});
          if (result.rejected?.length) throw new Error('Some recipients rejected');
        } finally { transport.close(); }
      });
    }
    if (name === 'proton_create_draft') {
      const mail = await this.compose(composition.parse(input), true);
      return this.connected(async c => {
        const drafts = (await c.list()).find(box => box.specialUse === '\\Drafts');
        if (!drafts) throw new PublicError('drafts_missing', 'No Drafts folder was identified.');
        const result = await c.append(drafts.path, Buffer.from(mail.raw, 'base64'), ['\\Draft']);
        if (!result) throw new PublicError('draft_unconfirmed', 'Draft creation was not confirmed. Check Drafts before trying again.');
        return {status: 'created', messageId: mail.messageId, mailbox: drafts.path, uid: result.uid, uidValidity: result.uidValidity?.toString()};
      });
    }
    return this.connected(async c => {
      if (name === 'proton_status') {
        tools.proton_status.schema.parse(input);
        const transport = this.smtp();
        try {await transport.verify();} finally {transport.close();}
        return {connected:true,imapAuthenticated:true,smtpAuthenticated:true,account:this.config.username};
      }
      if (name === 'proton_list_mailboxes') {
        tools.proton_list_mailboxes.schema.parse(input);
        return (await c.list()).map(b => ({path: b.path, specialUse: b.specialUse, selectable: !b.flags.has('\\Noselect')}));
      }
      if (name === 'proton_search') return this.search(c, tools.proton_search.schema.parse(input));
      if (name === 'proton_read' || name === 'proton_read_attachment') {
        const args = tools[name].schema.parse(input);
        return this.selected(c, args.message, true, async () => {
          const mail = await this.parsed(c, args.message);
          if (name === 'proton_read_attachment') {
            const {index} = tools.proton_read_attachment.schema.parse(input);
            const file = mail.attachments[index];
            if (!file) throw new PublicError('attachment_missing', 'Attachment index does not exist.');
            if (file.size > MAX_ATTACHMENT) throw new PublicError('attachment_too_large', 'Attachment exceeds the 8 MiB limit.');
            return {filename: file.filename, contentType: file.contentType, size: file.size, base64: file.content.toString('base64')};
          }
          const body = mail.text ?? '';
          return {message: args.message, subject: mail.subject, from: mail.from, to: mail.to, cc: mail.cc,
            date: mail.date, messageId: mail.messageId, text: body.slice(0,64_000), truncated: body.length > 64_000,
            attachments: mail.attachments.map((a,index) => ({index, filename: a.filename, contentType: a.contentType, size: a.size}))};
        });
      }
      if (name === 'proton_set_flags') {
        const args = tools.proton_set_flags.schema.parse(input);
        return this.selected(c, args.message, false, async () => {
          for (const [flag, enabled] of [['\\Seen',args.read],['\\Flagged',args.starred]] as const) {
            if (enabled === undefined) continue;
            const ok = await (enabled ? c.messageFlagsAdd(String(args.message.uid), [flag], {uid:true}) : c.messageFlagsRemove(String(args.message.uid), [flag], {uid:true}));
            if (!ok) throw new PublicError('change_unconfirmed', 'Flag change was not confirmed. Read the message flags again.');
          }
          return {status:'updated'};
        });
      }
      if (name === 'proton_move') {
        const args = tools.proton_move.schema.parse(input);
        // Native MOVE avoids the COPY/EXPUNGE fallback that could purge unrelated deleted mail.
        if (!c.capabilities.has('MOVE')) throw new PublicError('move_unavailable', 'The server does not support safe native MOVE.');
        if (args.destination === args.message.mailbox) return {status:'unchanged'};
        const target = (await c.list()).find(b => b.path === args.destination && !b.flags.has('\\Noselect'));
        if (!target) throw new PublicError('folder_missing','Destination is not an existing selectable folder.');
        return this.selected(c,args.message,false,async () => {
          const result = await c.messageMove(String(args.message.uid),args.destination,{uid:true});
          if (!result) throw new PublicError('move_unconfirmed','Move was not confirmed. Search source and destination before retrying.');
          return {status:'moved', mailbox:args.destination, uidValidity: result.uidValidity?.toString(), uid:result.uidMap?.get(args.message.uid)};
        });
      }
      throw new PublicError('unknown_tool','Unknown mail operation.');
    });
  }
}
