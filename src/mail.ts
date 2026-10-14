import {ImapFlow, type SearchObject} from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import sanitizeHtml from 'sanitize-html';
import {readFileSync} from 'node:fs';
import {randomUUID, createHash} from 'node:crypto';
import {checkServerIdentity, type PeerCertificate} from 'node:tls';
import {isIP} from 'node:net';
import type {z} from 'zod';
import type {Config} from './config.js';
import {SendLedger, type Prepared} from './send-ledger.js';
import {extractBody, parseMail, sourcePage, MAX_MESSAGE} from './body.js';
import {tools, composition, type MessageRef, type SearchInput, type ToolName, PublicError} from '../shared/protocol.js';
import {CalendarReader} from './calendar/service.js';
import {saveAttachmentToKdrive} from './kdrive.js';

const MAX_ATTACHMENT = 8 * 1024 * 1024;
const ALLOWED_RICH_TEXT_TAGS = ['p','br','strong','b','em','i','u','s','ul','ol','li','blockquote','a'] as const;

export function sanitizeRichHtml(value: string) {
  const fragment = sanitizeHtml(value, {
    allowedTags: [...ALLOWED_RICH_TEXT_TAGS],
    allowedAttributes: {a: ['href']},
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
  }).trim();
  if (!fragment) throw new PublicError('invalid_html', 'Rich-text body contains no permitted content.');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.5;color:#202124">${fragment}</div>`;
}
export function assertCurrentMailbox(client: Pick<ImapFlow, 'mailbox'>, ref: MessageRef) {
  if (!client.mailbox || client.mailbox.uidValidity.toString() !== ref.uidValidity)
    throw new PublicError('stale_reference', 'This mailbox changed. Search again before using the message.');
}
export function threadIds(value: string) {
  return [...new Set(value.match(/<[^<>\s\r\n]{1,990}>/g) ?? [])];
}

export class MailService {
  private busy = false;
  private ledger: SendLedger;
  private calendar?: CalendarReader;
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
  private async raw(client: ImapFlow, ref: MessageRef) {
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
    return Buffer.concat(chunks);
  }
  private async parsed(client: ImapFlow, ref: MessageRef) {
    const raw = await this.raw(client, ref);
    try { return await parseMail(raw); }
    catch { throw new PublicError('body_parse_failed', 'MIME parsing failed. Use proton_read_source with raw_mime for bounded recovery.'); }
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
    let references: string[] | undefined;
    if (args.replyToMessage) {
      const ref = args.replyToMessage;
      const reply = await this.connected(c => this.selected(c, ref, true, async () => {
        const source = await c.fetchOne(String(ref.uid), {envelope: true, headers: ['references','in-reply-to']}, {uid: true});
        const id = source && source.envelope?.messageId;
        if (!id || !/^<[^<>\s\r\n]{1,990}>$/.test(id)) throw new PublicError('invalid_reply_source', 'Source has no usable Message-ID.');
        const parsed = await parseMail(source && source.headers ? source.headers : Buffer.alloc(0));
        const ancestors = threadIds([parsed.references ?? parsed.inReplyTo ?? ''].flat().join(' '));
        // Retain the root and recent ancestry while bounding untrusted header size.
        const chain = [...new Set([...ancestors, id])];
        return {id, references: chain.length > 20 ? [chain[0]!, ...chain.slice(-19)] : chain};
      }));
      inReplyTo = reply.id; references = reply.references;
    }
    const messageId = `<${randomUUID()}@${this.config.sender.split('@')[1]}>`;
    const attachments: {filename: string; content: Buffer; contentType: string}[] = [];
    let attachmentBytes = 0;
    // Group references: one bounded, read-only download per source message.
    const sources = new Map<string, typeof args.attachments>();
    for (const item of args.attachments) {
      const key = JSON.stringify(item.message);
      sources.set(key, [...sources.get(key) ?? [], item]);
    }
    for (const items of sources.values()) {
      const ref = items[0]!.message;
      const parsed = await this.connected(c => this.selected(c, ref, true, () => this.parsed(c, ref)));
      for (const item of items) {
        const file = parsed.attachments[item.index];
        if (!file) throw new PublicError('attachment_missing', 'A selected source attachment no longer exists.');
        attachmentBytes += file.content.length;
        if (attachmentBytes > MAX_ATTACHMENT) throw new PublicError('attachments_too_large', 'Combined attachments exceed the 8 MiB limit.');
        attachments.push({filename: (file.filename ?? `attachment-${item.index + 1}`).replace(/[\\/\r\n\0]/g, '_').slice(0,200), content: file.content, contentType: file.contentType});
      }
    }
    const html = args.html === undefined ? undefined : sanitizeRichHtml(args.html);
    const mail = new MailComposer({from: this.config.sender, to: args.to, cc: args.cc, bcc: args.bcc,
      subject: args.subject, text: args.text, html, messageId, inReplyTo, references,
      attachments, keepBcc: draft, disableFileAccess: true, disableUrlAccess: true});
    const raw = await mail.compile().build();
    if (raw.length > MAX_MESSAGE) throw new PublicError('message_too_large', 'Composed message exceeds 12 MiB.');
    return {raw: raw.toString('base64'), envelope: {from: this.config.sender, to: [...new Set([...args.to, ...args.cc, ...args.bcc])]},
      messageId, preview: {from: this.config.sender, ...args, html, messageId, inReplyTo, references,
        attachmentPreview: attachments.map(a => ({filename:a.filename,contentType:a.contentType,size:a.content.length,sha256:createHash('sha256').update(a.content).digest('hex')}))}};
  }
  private async verifyDraftReply(c: ImapFlow, uid:number|undefined, mail:Prepared) {
    const expected=(mail.preview as {inReplyTo?:string;references?:string[]});
    if(!expected.inReplyTo)return undefined;
    try {
      if(!uid)throw Error('Missing draft reference');
      const result=await c.fetchOne(String(uid),{envelope:true,headers:['references','in-reply-to']},{uid:true});
      if(!result)throw Error('Draft readback unavailable');
      const parsed=await parseMail(result.headers??Buffer.alloc(0));
      const ids=threadIds([parsed.references??''].flat().join(' '));
      const retained=(parsed.inReplyTo??result.envelope?.inReplyTo)===expected.inReplyTo&&(expected.references??[]).every(id=>ids.includes(id));
      return {headersRetained:retained,warning:retained?undefined:'Proton did not retain the requested reply headers. This draft may appear outside the conversation. Use Reply in https://mail.proton.me when thread placement matters.'};
    } catch {return {headersRetained:null,warning:'Draft created, but reply threading could not be verified. Inspect it in https://mail.proton.me; do not create another copy.'};}
  }
  async execute(name: ToolName, input: unknown): Promise<unknown> {
    // Health authentication uses its own connections and must not mistake a slow
    // attachment upload for an outage or release the active operation's lock.
    if(name==='proton_status')return this.run(name,input);
    if (this.busy) throw new PublicError('busy', 'Another mail operation is running. Try again shortly.', 429);
    this.busy = true;
    try { return await this.run(name, input); } finally { this.busy = false; }
  }
  private async run(name: ToolName, input: unknown): Promise<unknown> {
    if (name === 'proton_save_attachment_to_kdrive') {
      const args = tools.proton_save_attachment_to_kdrive.schema.parse(input);
      return saveAttachmentToKdrive(args, async () => this.connected(c => this.selected(c,args.message,true,async()=>{
        const mail = await this.parsed(c,args.message);
        const attachment = mail.attachments[args.index];
        if (!attachment) throw new PublicError('attachment_missing','Attachment index does not exist.');
        if (attachment.content.length > MAX_ATTACHMENT) throw new PublicError('attachment_too_large','Attachment exceeds the 8 MiB limit.');
        return attachment.content;
      })));
    }
    if(name.startsWith('proton_calendar_')) {
      const path=process.env.PROTON_CALENDAR_CONFIG;
      if(!path) throw new PublicError('calendar_not_configured','Add Proton shared calendar links to the private calendar configuration before using calendar tools.');
      try {this.calendar??=CalendarReader.fromFile(path);return await this.calendar.execute(name,tools[name].schema.parse(input));}
      catch(error) {if(error instanceof PublicError)throw error;throw new PublicError('calendar_unavailable','Calendar configuration or feed could not be read. Check the private configuration; no partial availability is reported.');}
    }
    if (name === 'proton_prepare_forward') {
      const args = tools.proton_prepare_forward.schema.parse(input);
      const source = await this.connected(c => this.selected(c,args.message,true,()=>this.parsed(c,args.message)));
      const body = extractBody(source);
      if (body.body.incomplete || body.truncated) throw new PublicError('incomplete_forward', 'Source text is incomplete. Recover it before forwarding.');
      const text = `${args.text}\n\n---------- Forwarded message ----------\nFrom: ${source.from?.text ?? ''}\nDate: ${source.date?.toISOString() ?? ''}\nSubject: ${source.subject ?? ''}\nTo: ${Array.isArray(source.to) ? source.to.map(v=>v.text).join(', ') : source.to?.text ?? ''}\n\n${body.text}`;
      // Forward plain text only so the complete quote and preview agree.
      if (args.html) throw new PublicError('forward_html_unsupported', 'Use plain text for the forward introduction.');
      const mail = await this.compose(composition.parse({to:args.to,cc:args.cc,bcc:args.bcc,subject:args.subject,text,
        attachments: args.includeAttachments ? source.attachments.map((_,index)=>({message:args.message,index})) : []}));
      return this.ledger.prepare(mail);
    }
    if (name === 'proton_replace_draft') {
      const args = tools.proton_replace_draft.schema.parse(input);
      const mail = await this.compose(args.replacement,true);
      return this.connected(async c => {
        if (!c.capabilities.has('MOVE')) throw new PublicError('move_unavailable','Safe native MOVE is required.');
        const boxes = await c.list();
        const drafts = boxes.find(b=>b.specialUse==='\\Drafts'), trash = boxes.find(b=>b.specialUse==='\\Trash');
        if (!drafts || args.message.mailbox !== drafts.path || !trash) throw new PublicError('not_draft','Select an exact message in the Drafts folder; Trash must exist.');
        return this.selected(c,args.message,false,async()=>{
          const original = await c.fetchOne(String(args.message.uid),{flags:true},{uid:true});
          if (!original || !original.flags?.has('\\Draft')) throw new PublicError('not_draft','The source is no longer a draft.');
          if (createHash('sha256').update(await this.raw(c,args.message)).digest('hex') !== args.expectedSourceSha256)
            throw new PublicError('draft_changed','The draft changed. Read it again before editing.');
          const created = await c.append(drafts.path,Buffer.from(mail.raw,'base64'),['\\Draft']);
          if (!created || !created.uid || !created.uidValidity) throw new PublicError('draft_unconfirmed','Replacement creation is uncertain. Check Drafts; do not retry automatically.');
          const replacement = {mailbox:drafts.path,uid:created.uid,uidValidity:String(created.uidValidity)};
          const replyThreading = await this.verifyDraftReply(c,created.uid,mail);
          try {
            const moved = await c.messageMove(String(args.message.uid),trash.path,{uid:true});
            if (!moved) return {status:'replacement_created_original_move_unconfirmed',replacement,messageId:mail.messageId,replyThreading,doNotRetry:true};
            return {status:'replaced',replacement,messageId:mail.messageId,replyThreading,originalInTrash:{mailbox:trash.path,uid:moved.uidMap?.get(args.message.uid),uidValidity:moved.uidValidity?.toString()}};
          } catch { return {status:'replacement_created_original_move_unconfirmed',replacement,messageId:mail.messageId,replyThreading,doNotRetry:true}; }
        });
      });
    }
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
        let replyThreading;
        if((mail.preview as {inReplyTo?:string}).inReplyTo) {
          try {const lock=await c.getMailboxLock(drafts.path,{readOnly:true});try{replyThreading=await this.verifyDraftReply(c,result.uid,mail);}finally{lock.release();}}
          catch {replyThreading={headersRetained:null,warning:'Draft created; threading readback unavailable. Do not create another copy.'};}
        }
        return {status: 'created', messageId: mail.messageId, mailbox: drafts.path, uid: result.uid, uidValidity: result.uidValidity?.toString(),replyThreading};
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
      if (name === 'proton_thread') {
        const args = tools.proton_thread.schema.parse(input);
        const seed = await this.selected(c,args.message,true,async()=>{
          const m = await c.fetchOne(String(args.message.uid),{envelope:true,headers:['references','in-reply-to']},{uid:true});
          if (!m) throw new PublicError('message_missing','Source missing.');
          return threadIds(`${m.envelope?.messageId ?? ''} ${m.envelope?.inReplyTo ?? ''} ${m.headers?.toString() ?? ''}`);
        });
        if (!seed.length) throw new PublicError('thread_unavailable','Source has no usable threading headers.');
        const ids = [...seed.slice(0,1),...seed.slice(-19)].filter((id,i,a)=>a.indexOf(id)===i);
        const messages: unknown[] = []; let incomplete = seed.length > ids.length;
        for (const mailbox of [...new Set(args.mailboxes)]) {
          const lock = await c.getMailboxLock(mailbox,{readOnly:true});
          try {
            const hits = (await c.search({or:ids.flatMap(id=>['Message-ID','In-Reply-To','References'].map(header=>({header:{[header]:id}})))},{uid:true}) || []).sort((a,b)=>b-a);
            const room = args.limit-messages.length;
            if (hits.length>room) incomplete=true;
            if (room>0 && hits.length) {
              const rows = await c.fetchAll(hits.slice(0,room),{envelope:true,flags:true,size:true},{uid:true});
              messages.push(...rows.map(m=>({message:{mailbox,uid:m.uid,uidValidity:c.mailbox ? String(c.mailbox.uidValidity) : ''},envelope:m.envelope,flags:[...m.flags ?? []],size:m.size})));
            }
          } finally {lock.release();}
        }
        return {messages,searchedMailboxes:[...new Set(args.mailboxes)],incomplete,method:'Message-ID/References/In-Reply-To header matching; no subject guessing'};
      }
      if (name === 'proton_read_source') {
        const args = tools.proton_read_source.schema.parse(input);
        return this.selected(c, args.message, true, async () => {
          const meta = await c.fetchOne(String(args.message.uid), {envelope: true}, {uid: true});
          let source: Buffer;
          if (args.format === 'raw_mime') source = await this.raw(c, args.message);
          else {
            const mail = await this.parsed(c, args.message);
            if (typeof mail.html !== 'string') throw new PublicError('html_missing', 'No HTML body was decoded. Try raw_mime recovery.');
            source = Buffer.from(mail.html, 'utf8');
          }
          return {message: args.message, messageId: meta && meta.envelope?.messageId,
            format: args.format, ...sourcePage(source, args.offset, args.limit, args.sourceSha256)};
        });
      }
      if (name === 'proton_read' || name === 'proton_read_attachment') {
        const args = tools[name].schema.parse(input);
        return this.selected(c, args.message, true, async () => {
          const raw = await this.raw(c, args.message);
          const mail = await parseMail(raw).catch(()=>{throw new PublicError('body_parse_failed','MIME parsing failed. Use proton_read_source with raw_mime for bounded recovery.');});
          if (name === 'proton_read_attachment') {
            const {index} = tools.proton_read_attachment.schema.parse(input);
            const file = mail.attachments[index];
            if (!file) throw new PublicError('attachment_missing', 'Attachment index does not exist.');
            if (file.size > MAX_ATTACHMENT) throw new PublicError('attachment_too_large', 'Attachment exceeds the 8 MiB limit.');
            return {filename: file.filename, contentType: file.contentType, size: file.size, base64: file.content.toString('base64')};
          }
          return {message: args.message, subject: mail.subject, from: mail.from, to: mail.to, cc: mail.cc,
            date: mail.date, messageId: mail.messageId, sourceSha256:createHash('sha256').update(raw).digest('hex'), ...extractBody(mail),
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
