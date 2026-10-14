import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveAttachmentToKdrive} from '../src/kdrive.js';
import {tools} from '../shared/protocol.js';
const args={message:{mailbox:'INBOX',uidValidity:'99',uid:1},index:0,destination:'/Private/test.bin',operationId:'729b0ba6-05ae-4fd1-a004-e4360fe14ef1'};
test('hosted attachment upload verifies exact bytes and repeated operation never uploads twice',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kdrive-test-'));let writes=0;let source='';
 const config={repository:'/unused',stateDirectory:dir,driveId:1,accessToken:'fake'};
 try{
  const runner=async(_c:any,p:string,_d:string,size:number,digest:string)=>{writes++;source=p;assert.deepEqual(readFileSync(p),Buffer.from('fixture'));return {verified:true,sha256:digest,size_bytes:size};};
  const result=await saveAttachmentToKdrive(args,async()=>Buffer.from('fixture'),config,runner) as any;
  assert.equal(result.status,'verified');assert.throws(()=>readFileSync(source));
  assert.deepEqual(await saveAttachmentToKdrive(args,async()=>{throw Error('No second mail read');},config,runner),result);assert.equal(writes,1);
  await assert.rejects(saveAttachmentToKdrive({...args,destination:'/Private/changed.bin'},async()=>Buffer.alloc(1),config,runner),/original request/);
 }finally{rmSync(dir,{recursive:true});}
});
test('uncertain or mismatched upload stays reserved and never replays',async()=>{
 for(const fault of ['throw','digest']){
  const dir=mkdtempSync(join(tmpdir(),'kdrive-test-'));let writes=0;
  const config={repository:'/unused',stateDirectory:dir,driveId:1,accessToken:'fake'};
  const runner=async()=>{writes++;if(fault==='throw')throw Error('SMTP secret should never escape');return {verified:true,sha256:'wrong',size_bytes:1};};
  try{
   const result=await saveAttachmentToKdrive(args,async()=>Buffer.from('x'),config,runner) as any;
   assert.equal(result.status,'needs_reconciliation');
   await saveAttachmentToKdrive(args,async()=>Buffer.from('x'),config,runner);assert.equal(writes,1);
   assert.doesNotMatch(readFileSync(join(dir,'proton-attachments',readdirSync(join(dir,'proton-attachments'))[0]!), 'utf8'),/secret/);
  }finally{rmSync(dir,{recursive:true});}
 }
});
test('attachment destinations reject traversal, public paths and controls',()=>{
 for(const destination of ['/Private/../x','/Private//x','/Public/x','/Private/a\nb','/Private/a\\b','/Private/./x'])assert.equal(tools.proton_save_attachment_to_kdrive.schema.safeParse({...args,destination}).success,false);
});
