import {test} from 'node:test';
import assert from 'node:assert/strict';
import {confirmedChecks,nextNotice,processResult,validBackup,pingWatchdog,reconcileRejectedDelivery} from '../scripts/email-monitor.mjs';
test('recovered health clears an obsolete rejected alert only after SMTP authentication succeeds',async()=>{
 const state:any={deliveryFailure:{safeRetry:true,code:'EAUTH'}};let saves=0;
 const run=(verify:any)=>reconcileRejectedDelivery({state,checks:{https:true},verify,persist:()=>saves++});
 assert.equal(await run(async()=>{throw Error('still rejected');}),false);assert.ok(state.deliveryFailure);assert.equal(saves,0);
 assert.equal(await run(async()=>true),true);assert.equal(state.deliveryFailure,undefined);assert.ok(state.deliveryAuthenticationReverifiedAt);assert.equal(saves,1);
 assert.equal(nextNotice(state,{https:true},'test'),null);
});
test('SMTP reconciliation preserves uncertain delivery and does not suppress active failures',async()=>{
 for(const state of [{pending:{status:'uncertain'},deliveryFailure:{safeRetry:true}},{deliveryFailure:{safeRetry:false}},{deliveryFailure:{safeRetry:true}}]){
  const before=JSON.stringify(state);const checks={https:!!state.pending||state.deliveryFailure.safeRetry===false};
  assert.equal(await reconcileRejectedDelivery({state,checks,verify:async()=>assert.fail('must not authenticate or resend'),persist:()=>assert.fail('must not alter state')}),false);
  assert.equal(JSON.stringify(state),before);
 }
});
test('transient faults do not alert; persistent failures require two attempts',async()=>{
 let n=0;assert.deepEqual(await confirmedChecks(async()=>({https:++n>1}),async()=>{}),{checks:{https:true},attempts:2});
 n=0;assert.deepEqual(await confirmedChecks(async()=>{n++;return {https:false};},async()=>{}),{checks:{https:false},attempts:2});assert.equal(n,2);
});
test('first healthy result stays quiet; failure changes and recovery notify once',()=>{
 assert.equal(nextNotice({}, {https:true},'test'),null);
 assert.equal(nextNotice({}, {https:false},'test')?.kind,'failure');
 assert.equal(nextNotice({notifiedSignature:'https'},{https:false},'test'),null);
 assert.equal(nextNotice({notifiedSignature:'https'},{https:true},'test')?.kind,'recovery');
});
test('accepted delivery is persisted and duplicate runs are quiet',async()=>{
 const state:any={};let sends=0,saves=0;
 const run=()=>processResult({state,checks:{https:false},label:'test',now:'now',send:async()=>{sends++;return {smtpAccepted:true};},persist:()=>saves++});
 assert.equal((await run()).delivery,'accepted');assert.equal((await run()).delivery,'quiet');assert.equal(sends,1);assert.ok(saves>=3);assert.equal(state.pending,undefined);
});
test('ambiguous SMTP delivery is not blindly retried; explicit rejection can retry',async()=>{
 for(const ambiguous of [true,false]){
  const state:any={};let sends=0;const send=async()=>{sends++;throw Object.assign(new Error(),ambiguous?{code:'ETIMEDOUT',command:'DATA'}:{responseCode:451,command:'DATA'});};
  const run=()=>processResult({state,checks:{https:false},label:'test',now:'now',send,persist:()=>{}});
  assert.equal((await run()).delivery,ambiguous?'uncertain':'rejected');await run();assert.equal(sends,ambiguous?1:2);
 }
});
test('restore evidence is bound to verified original archive identity and complete validation',()=>{
 const path='/private/test.age',hash='a'.repeat(64),d={offServerVerified:true,encrypted:true,path,bytes:10,sha256:hash};
 const r={archive:path,archiveBytes:10,archiveSha256:hash,validationVersion:2,authenticatedDecryption:true,requiredComponentsPresent:true,configurationSchemasValid:true,requiredDatabaseSchemasValid:true,certificateParseable:true,keyStoreMaterialPresent:true,isolatedRestore:true,sqliteIntegrity:'ok',sqliteDatabasesChecked:3};
 assert.equal(validBackup(d,r,path,10),true);
 for(const change of [{archiveSha256:'b'.repeat(64)},{validationVersion:1},{authenticatedDecryption:false},{sqliteDatabasesChecked:0}])assert.equal(validBackup(d,{...r,...change},path,10),false);
 assert.equal(validBackup(d,r,path,9),false);
});
test('only healthy hosted checks ping the external watchdog; local checks cannot hide server loss',async()=>{
 const config={mode:'server',watchdogUrl:'https://hc-ping.com/00000000-0000-0000-0000-000000000000'};let calls=0;
 const send=async()=>{calls++;return new Response('OK');};
 assert.equal((await pingWatchdog(config,{lastCheck:{healthy:true}},send)).accepted,true);
 assert.equal((await pingWatchdog({...config,mode:'yantra'},{lastCheck:{healthy:true}},send)).configured,false);
 for(const state of [{lastCheck:{healthy:false}},{lastCheck:{healthy:true},pending:{}},{lastCheck:{healthy:true},deliveryFailure:{}}])assert.equal((await pingWatchdog(config,state,send)).withheld,true);
 assert.equal(calls,1);
});
test('watchdog sends no mail or credentials, rejects redirects and reports network errors safely',async()=>{
 const config={mode:'server',watchdogUrl:'https://hc-ping.com/00000000-0000-0000-0000-000000000000',smtpToken:'do-not-send'};
 await pingWatchdog(config,{lastCheck:{healthy:true}},async(_url:any,init:any)=>{assert.equal(init.method,'POST');assert.equal(init.body,'');assert.equal(init.redirect,'error');assert.equal(init.headers,undefined);assert.ok(init.signal);return new Response('OK');});
 const failed=await pingWatchdog(config,{lastCheck:{healthy:true}},async()=>{throw Error(config.watchdogUrl);});
 assert.equal(failed.accepted,false);assert.ok(!JSON.stringify(failed).includes(config.watchdogUrl));
});
test('watchdog refuses unexpected destinations and credential-bearing URLs',async()=>{
 for(const url of ['http://hc-ping.com/00000000-0000-0000-0000-000000000000','https://example.com/00000000-0000-0000-0000-000000000000','https://hc-ping.com/00000000-0000-0000-0000-000000000000?secret=x']){
  const result=await pingWatchdog({mode:'server',watchdogUrl:url},{lastCheck:{healthy:true}},async()=>{assert.fail('must not transmit');});assert.equal(result.accepted,false);
 }
});
