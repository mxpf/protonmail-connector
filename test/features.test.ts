import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {simpleParser} from 'mailparser';
import type {ImapFlow} from 'imapflow';
import {MailService} from '../src/mail.js';
import {CalendarReader} from '../dist/src/calendar/service.js';
const ref={mailbox:'Drafts',uidValidity:'99',uid:7};
const source=Buffer.from('From: sender@example.com\r\nTo: owner@example.com\r\nSubject: Source\r\nMessage-ID: <source@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nSource body\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="proof.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECA//+\r\n--x--\r\n');
function fixture() {
 let appended:Buffer|undefined;let moved=false;let validity=99n;let failMove=false;
 const fake=Object.assign(new EventEmitter(),{
  capabilities:new Map([['MOVE',true]]),mailbox:{uidValidity:validity},
  connect:async()=>{},close:()=>{},getMailboxLock:async()=>({release:()=>{}}),
  list:async()=>[{path:'Drafts',specialUse:'\\Drafts'},{path:'Trash',specialUse:'\\Trash'}],
  fetchOne:async()=>({uid:7,size:source.length,flags:new Set(['\\Draft']),envelope:{messageId:'<source@example.com>'}}),
  download:async()=>({content:Readable.from([source])}),
  append:async(_path:string,raw:Buffer)=>{appended=Buffer.from(raw);return {uid:8,uidValidity:99n};},
  messageMove:async()=>{if(failMove)throw Error('network failed');moved=true;return {uidValidity:98n,uidMap:new Map([[7,9]])};},
 });
 const service=new MailService({username:'owner@example.com',sender:'owner@example.com',password:'fake',certificatePath:'/unused',tlsServerName:'localhost',imapPort:1143,smtpPort:1025,ledgerPath:':memory:'},()=>fake as unknown as ImapFlow);
 return {service,fake,get appended(){return appended},get moved(){return moved},set failMove(v:boolean){failMove=v}};
}
test('forward preview includes complete source and byte-exact attachments without sending',async()=>{
 const f=fixture();try {
  const result=await f.service.execute('proton_prepare_forward',{message:ref,to:['owner@example.com'],subject:'Fwd: Source',text:'Please see below.'}) as any;
  assert.match(result.preview.text,/Please see below\.[\s\S]*Source body/);
  assert.equal(result.preview.from,'owner@example.com');
  assert.equal(result.preview.attachmentPreview[0].sha256,createHash('sha256').update(Buffer.from('AAECA//+','base64')).digest('hex'));
  assert.equal(f.appended,undefined);assert.equal(f.moved,false);
  await assert.rejects(f.service.execute('proton_prepare_forward',{message:ref,to:['owner@example.com'],subject:'Fwd',text:'Hi',html:'<p>Hi</p>'}),/plain text/);
 }finally{f.service.close()}
});
test('draft replacement checks immutable hash, retains attachment bytes, recovers original in Trash',async()=>{
 const f=fixture();try {
  const replacement={to:['owner@example.com'],subject:'Edited',text:'New body',attachments:[{message:ref,index:0}]};
  await assert.rejects(f.service.execute('proton_replace_draft',{message:ref,expectedSourceSha256:'0'.repeat(64),replacement}),/draft changed/);
  assert.equal(f.appended,undefined);assert.equal(f.moved,false);
  const result=await f.service.execute('proton_replace_draft',{message:ref,expectedSourceSha256:createHash('sha256').update(source).digest('hex'),replacement}) as any;
  assert.equal(result.status,'replaced');assert.equal(f.moved,true);
  const mail=await simpleParser(f.appended!);assert.equal(mail.subject,'Edited');
  assert.deepEqual(mail.attachments[0]!.content,Buffer.from('AAECA//+','base64'));
 }finally{f.service.close()}
});
test('uncertain original move returns replacement identity and prevents blind duplication',async()=>{
 const f=fixture();f.failMove=true;try {
  const result=await f.service.execute('proton_replace_draft',{message:ref,expectedSourceSha256:createHash('sha256').update(source).digest('hex'),replacement:{to:['owner@example.com'],subject:'Edited',text:'New'}}) as any;
  assert.equal(result.status,'replacement_created_original_move_unconfirmed');assert.equal(result.replacement.uid,8);assert.equal(result.doNotRetry,true);
 }finally{f.service.close()}
});
test('thread lookup uses exact headers and explicit folders with bounded results',async()=>{
 const f=fixture();const queries:any[]=[];
 Object.assign(f.fake,{search:async(q:unknown)=>{queries.push(q);return [2,3];},fetchAll:async(ids:number[])=>ids.map(uid=>({uid,envelope:{messageId:`<${uid}@example.com>`},flags:new Set(),size:30}))});
 try {const result=await f.service.execute('proton_thread',{message:ref,mailboxes:['Drafts'],limit:1}) as any;
  assert.equal(result.messages.length,1);assert.equal(result.incomplete,true);assert.deepEqual(result.searchedMailboxes,['Drafts']);
  assert.equal(queries[0].or[0].header['Message-ID'],'<source@example.com>');assert.equal(f.moved,false);
 }finally{f.service.close()}
});
const calendar={id:'test',name:'Test',url:'https://calendar.proton.me/api/calendar/v1/url/fixture/calendar.ics',timezone:'America/New_York',visibility:'full' as const};
const ics='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTART:20261013T140000Z\r\nDTEND:20261013T150000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:Test event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
test('calendar recurrence, stable pagination and provisional availability; feed errors fail closed',async()=>{
 const c=new CalendarReader({calendars:[calendar],cacheSeconds:60},async()=>new Response(ics));
 const window={start:'2026-10-13T00:00:00Z',end:'2026-10-15T00:00:00Z'};
 const result=await c.execute('proton_calendar_events',{calendarId:'test',...window,limit:1}) as any;
 assert.equal(result.total,2);assert.equal(result.nextOffset,1);
 await assert.rejects(c.execute('proton_calendar_events',{calendarId:'test',...window,offset:1}),/snapshotId/);
 const availability=await c.execute('proton_calendar_availability',window) as any;assert.equal(availability.busy.length,2);
 const failed=new CalendarReader({calendars:[calendar],cacheSeconds:60},async()=>new Response('',{status:503}));
 await assert.rejects(failed.execute('proton_calendar_availability',window),/unavailable/);
});
test('busy calendar redacts event fields and rejects text search',async()=>{
 const c=new CalendarReader({calendars:[{...calendar,visibility:'busy'}],cacheSeconds:60},async()=>new Response(ics));
 const a={calendarId:'test',start:'2026-10-13T00:00:00Z',end:'2026-10-15T00:00:00Z'};
 const r=await c.execute('proton_calendar_events',a) as any;assert.equal(r.events[0].title,'Busy');
 await assert.rejects(c.execute('proton_calendar_events',{...a,query:'test'}),/busy-only/);
});
