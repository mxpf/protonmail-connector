import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {ImapFlow} from 'imapflow';
import {MailService} from '../src/mail.js';

function fixture() {
  let folder='';
  const locks:{folder:string;readOnly:boolean}[]=[];
  const fake=Object.assign(new EventEmitter(),{
    connect:async()=>{},close:()=>{},
    mailbox:{uidValidity:99n},
    getMailboxLock:async(path:string,options:{readOnly:boolean})=>{
      if(path==='Broken')throw Error('Private failure');
      folder=path;locks.push({folder:path,readOnly:options.readOnly});return {release:()=>{}};
    },
    search:async(query:{uid?:string})=>query.uid?[1]:[1,2,3],
    fetchAll:async(ids:number[])=>ids.map(uid=>({uid,envelope:{subject:folder},flags:new Set(),size:10})),
  });
  const service=new MailService({username:'owner@example.com',sender:'owner@example.com',password:'fake',certificatePath:'/unused',tlsServerName:'localhost',imapPort:1143,smtpPort:1025,ledgerPath:':memory:'},()=>fake as unknown as ImapFlow);
  return {service,locks,fake};
}

test('folder search bounds each page, preserves per-folder continuation, and reports failed folders',async()=>{
  const f=fixture();
  try {
    const first:any=await f.service.execute('proton_search_mailboxes',{mailboxes:['INBOX','Sent','Broken'],limitPerMailbox:2,subject:'fixture'});
    assert.equal(first.incomplete,true);
    assert.deepEqual(first.results[0].messages.map((m:any)=>m.message.uid),[3,2]);
    assert.equal(first.results[1].messages[0].message.mailbox,'Sent');
    assert.equal(first.results[2].error,'search_failed');
    assert.doesNotMatch(JSON.stringify(first),/Private failure/);
    const next:any=await f.service.execute('proton_search_mailboxes',{mailboxes:['INBOX'],subject:'fixture',continuations:[first.results[0].nextContinuation]});
    assert.equal(next.results[0].messages[0].message.uid,1);
    assert.equal(next.incomplete,false);
    f.fake.mailbox.uidValidity=100n;
    const stale:any=await f.service.execute('proton_search_mailboxes',{mailboxes:['INBOX'],continuations:[first.results[0].nextContinuation]});
    assert.equal(stale.results[0].error,'stale_reference');
    assert.ok(f.locks.every(lock=>lock.readOnly));
    await assert.rejects(f.service.execute('proton_search_mailboxes',{mailboxes:['INBOX'],continuations:[{mailbox:'Sent',uidValidity:'99',beforeUid:2}]}),/selected folder/);
  }finally{f.service.close();}
});

test('reply verification failure returns the created draft without creating another copy',async()=>{
  const f=fixture();let created=0;
  const run=(f.service as any).run.bind(f.service);
  (f.service as any).run=async(name:string,args:unknown)=>{
    if(name==='proton_create_draft'){created++;return {status:'created',mailbox:'Drafts',uid:8,uidValidity:'99'};}
    if(name==='proton_read')throw Error('readback unavailable');
    return run(name,args);
  };
  try {
    const result:any=await f.service.execute('proton_draft_reply',{replyToMessage:{mailbox:'INBOX',uid:1,uidValidity:'99'},to:['reader@example.com'],subject:'Re: Test',text:'Reply'});
    assert.equal(created,1);assert.equal(result.uid,8);assert.equal(result.verification,'unconfirmed');assert.equal(result.doNotRetry,true);
  }finally{f.service.close();}
});

test('conversation reading marks failed reads and incomplete bodies without changing flags',async()=>{
 const f=fixture();const run=(f.service as any).run.bind(f.service);let reads=0;
 (f.service as any).run=async(name:string,args:unknown)=>{
  if(name==='proton_thread')return {messages:[{message:{mailbox:'INBOX',uid:1,uidValidity:'99'}},{message:{mailbox:'Sent',uid:2,uidValidity:'99'}}],incomplete:false,searchedMailboxes:['INBOX','Sent']};
  if(name==='proton_read'){reads++;if(reads===2)throw Error('Private error');return {text:'partial',body:{incomplete:true},truncated:false};}
  return run(name,args);
 };
 try{
  const result:any=await f.service.execute('proton_read_thread',{message:{mailbox:'INBOX',uid:1,uidValidity:'99'},mailboxes:['INBOX','Sent']});
  assert.equal(result.incomplete,true);assert.equal(result.messages.length,2);assert.equal(result.messages[1].error,'read_failed');
  assert.doesNotMatch(JSON.stringify(result),/Private error/);
 }finally{f.service.close();}
});
