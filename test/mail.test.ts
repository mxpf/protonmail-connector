import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import type {ImapFlow} from 'imapflow';
import {simpleParser} from 'mailparser';
import {MailService, sanitizeRichHtml} from '../src/mail.js';
import {composition, parseOperation} from '../shared/protocol.js';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const ref = {mailbox:'INBOX',uid:7,uidValidity:'99'};
test('health remains available during a slow operation without unlocking concurrent writes',async()=>{
 const service=new MailService({username:'owner@example.com',sender:'owner@example.com',password:'fake',certificatePath:'/unused',tlsServerName:'localhost',imapPort:1143,smtpPort:1025,ledgerPath:':memory:'});
 let finish!:()=>void;
 const pending=new Promise<void>(resolve=>{finish=resolve});
 (service as any).run=async(name:string)=>name==='proton_status'?{connected:true}:pending;
 try{
  const operation=service.execute('proton_save_attachment_to_kdrive',{});
  assert.deepEqual(await service.execute('proton_status',{}),{connected:true});
  await assert.rejects(service.execute('proton_set_flags',{}),/Another mail operation/);
  finish();await operation;
 }finally{finish();service.close();}
});
test('message reads use readonly lock and bounded UID download; stale IDs cannot mutate', async()=>{
  const calls: unknown[]=[];
  let validity=99n;
  const fake = Object.assign(new EventEmitter(),{
    get mailbox() {return {uidValidity:validity};},
    connect:async()=>{},close:()=>{},
    getMailboxLock:async(path:string,opts:unknown)=>{calls.push(['lock',path,opts]);return {release:()=>{}};},
    fetchOne:async(uid:string,query:unknown,opts:unknown)=>{calls.push(['fetch',uid,opts]);return {uid:7,size:100};},
    download:async(uid:string,part:unknown,opts:unknown)=>{calls.push(['download',uid,opts]);return {content:Readable.from(['From: sender@example.com\r\nSubject: Test\r\n\r\nHello'])};},
    messageFlagsAdd:async()=>{throw new Error('Must not mutate');},
  });
  Object.defineProperty(fake,'mailbox',{get:()=>({uidValidity:validity})});
  const dir=mkdtempSync(join(tmpdir(),'proton-mail-'));
  const service=new MailService({username:'owner@example.com',sender:'owner@example.com',password:'fake',certificatePath:'/unused',tlsServerName:'localhost',imapPort:1143,smtpPort:1025,ledgerPath:join(dir,'send.db')},()=>fake as unknown as ImapFlow);
  try {
    const read=await service.execute('proton_read',{message:ref}) as {text:string};
    assert.equal(read.text,'Hello');
    assert.deepEqual(calls[0],['lock','INBOX',{readOnly:true}]);
    assert.ok(calls.some(c=>JSON.stringify(c)===JSON.stringify(['download','7',{uid:true,maxBytes:12*1024*1024+1}])));
    validity=100n;
    await assert.rejects(service.execute('proton_set_flags',{message:ref,read:true}),/mailbox changed/);
  } finally {service.close();rmSync(dir,{recursive:true});}
});
test('reject header injection and permanent deletion tool requests',()=>{
  assert.equal(composition.safeParse({to:['a@example.com'],subject:'hi\r\nBcc: b@example.com',text:'hi'}).success,false);
  assert.throws(()=>parseOperation({tool:'proton_delete_forever',args:{message:ref}}),/Unknown/);
});

test('rich-text drafts use multipart alternatives and sanitize unsafe markup',async()=>{
  let appended: Buffer | undefined;
  const fake = Object.assign(new EventEmitter(),{
    connect:async()=>{},close:()=>{},
    list:async()=>[{path:'Drafts',specialUse:'\\Drafts',flags:new Set<string>()}],
    append:async(_path:string,raw:Buffer)=>{appended=Buffer.from(raw);return {uid:8,uidValidity:99n};},
  });
  const dir=mkdtempSync(join(tmpdir(),'proton-mail-rich-'));
  const service=new MailService({username:'owner@example.com',sender:'owner@example.com',password:'fake',certificatePath:'/unused',tlsServerName:'localhost',imapPort:1143,smtpPort:1025,ledgerPath:join(dir,'send.db')},()=>fake as unknown as ImapFlow);
  try {
    await service.execute('proton_create_draft',{
      to:['reader@example.com'],subject:'Rich test',text:'Hello world\n\nOne item',
      html:'<p onclick="steal()">Hello <strong>world</strong></p><script>alert(1)</script><ul><li>One item</li></ul><a href="javascript:steal()">bad link</a>',
    });
    assert.ok(appended);
    assert.match(appended.toString(),/multipart\/alternative/i);
    const parsed=await simpleParser(appended);
    assert.equal(parsed.text,'Hello world\n\nOne item');
    assert.match(String(parsed.html),/font-family:-apple-system/);
    assert.match(String(parsed.html),/<strong>world<\/strong>/);
    assert.match(String(parsed.html),/<ul><li>One item<\/li><\/ul>/);
    assert.doesNotMatch(String(parsed.html),/script|onclick|javascript:/i);
  } finally {service.close();rmSync(dir,{recursive:true});}
});

test('rich-text sanitizer permits only email-safe formatting and links',()=>{
  const html=sanitizeRichHtml('<p><em>Hello</em> <a href="https://example.com">there</a></p><img src="https://tracker.example/pixel"><style>body{display:none}</style>');
  assert.match(html,/<em>Hello<\/em>/);
  assert.match(html,/href="https:\/\/example.com"/);
  assert.doesNotMatch(html,/<img|tracker|<style|display:none/i);
  assert.throws(()=>sanitizeRichHtml('<script>alert(1)</script>'),/no permitted content/);
});
