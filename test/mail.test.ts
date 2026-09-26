import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import type {ImapFlow} from 'imapflow';
import {MailService} from '../src/mail.js';
import {composition, parseOperation} from '../shared/protocol.js';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const ref = {mailbox:'INBOX',uid:7,uidValidity:'99'};
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
