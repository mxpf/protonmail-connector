import {readFileSync,writeFileSync,renameSync,statSync,readdirSync,mkdirSync,unlinkSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {request} from 'node:http';
import nodemailer from 'nodemailer';
import {checkHealth} from './health-hosted.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function save(path,value) {
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const temp=path+'.'+process.pid+'.tmp';
 writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temp,path);
}
const read=path=>JSON.parse(readFileSync(path,'utf8'));
export function validBackup(download,restore,path,size) {
 return download.offServerVerified===true && download.encrypted===true && download.path===path &&
  download.bytes===size && /^[a-f0-9]{64}$/.test(download.sha256) && restore.archive===path &&
  restore.archiveBytes===size && restore.archiveSha256===download.sha256 && restore.validationVersion===2 &&
  ['authenticatedDecryption','requiredComponentsPresent','configurationSchemasValid','requiredDatabaseSchemasValid','certificateParseable','keyStoreMaterialPresent','isolatedRestore'].every(k=>restore[k]===true) &&
  restore.sqliteIntegrity==='ok' && restore.sqliteDatabasesChecked>=3;
}
export function backupCheck(directory,now=Date.now()) {
 const candidates=readdirSync(directory).filter(n=>/^proton-state-\d{8}T\d{6}Z\.tar\.gz\.age$/.test(n)).sort().reverse();
 for(const name of candidates) {
  const path=resolve(directory,name);
  try {
   const size=statSync(path).size,d=read(path+'.json'),r=read(path+'.restore.json');
   if(!validBackup(d,r,path,size))continue;
   const stamp=name.slice(13,29),date=Date.parse(stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,'$1-$2-$3T$4:$5:$6Z'));
   return {valid:Number.isFinite(date)&&date<=now+300000&&now-date<=8*86400000,archive:name,ageDays:(now-date)/86400000};
  }catch{/* Incomplete archives never count as verified backups. */}
 }
 return {valid:false};
}
export function nextNotice(state,checks,label,now=new Date().toISOString(),test=false) {
 const failed=Object.keys(checks).filter(k=>checks[k]!==true).sort();
 const signature=failed.join(',');
 if(signature===(state.notifiedSignature??''))return null;
 const recovered=!failed.length;
 return {id:randomUUID(),signature,createdAt:now,failed,kind:recovered?'recovery':'failure',
  subject:`${test?'TEST — ':''}[Proton connector] ${recovered?'RECOVERED':'FAILURE'} — ${label}`,
  text:`${test?'This is an authorized alert-delivery test. The production connector was not interrupted.\n\n':''}Proton connector ${recovered?'checks have recovered.':'checks failed twice.'}\nMonitor: ${label}\nChecked: ${now}\n${failed.length?'Failing checks: '+failed.join(', ')+'\nNext step: inspect the indicated service or backup check. No automatic redeployment was attempted.':'All checks are passing again.'}\n\nThis email was sent independently of Codex. No mail contents or credentials are included.`};
}
export async function processResult({state,checks,label,send,persist,now,test=false}) {
 state.lastCheck={checkedAt:now,checks,healthy:Object.values(checks).every(v=>v===true)};
 // An interrupted or ambiguous SMTP transaction needs reconciliation, never a blind resend.
 if(state.pending){persist(state);return {delivery:'needs-reconciliation'};}
 const notice=nextNotice(state,checks,label,now,test);
 if(!notice){persist(state);return {delivery:'quiet'};}
 state.pending={...notice,status:'sending'};persist(state);
 try {
  const receipt=await send(notice);
  state.notifiedSignature=notice.signature;state.lastNotification={...notice,...receipt,status:'accepted'};delete state.pending;delete state.deliveryFailure;persist(state);
  return {delivery:'accepted',id:notice.id};
 }catch(e) {
  const safeRetry=Number.isInteger(e.responseCode)&&e.responseCode>=400 || ['CONN','AUTH','EHLO','HELO','STARTTLS','MAIL FROM','RCPT TO'].includes(e.command);
  state.deliveryFailure={at:now,safeRetry,code:/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'SMTP_ERROR'};
  if(safeRetry)delete state.pending;else state.pending.status='uncertain';
  persist(state);return {delivery:safeRetry?'rejected':'uncertain'};
 }
}
function smtpTransport(config) {
 if(config.from!=='max@pfennig.haus'||config.to!=='max@pfennig.haus'||!config.smtpToken)throw Error('Invalid alert identity configuration');
 return nodemailer.createTransport({host:'smtp.protonmail.ch',port:587,secure:false,requireTLS:true,auth:{user:config.from,pass:config.smtpToken},tls:{minVersion:'TLSv1.2',rejectUnauthorized:true},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000,logger:false,debug:false});
}
export async function reconcileRejectedDelivery({state,checks,verify,persist}) {
 // A rejected alert may become obsolete when service health recovers. Authenticate
 // SMTP again before clearing that failure; never resend or clear uncertain mail.
 if(!state.deliveryFailure?.safeRetry||state.pending||!Object.values(checks).every(v=>v===true))return false;
 try {if(await verify()!==true)return false;}catch{return false;}
 delete state.deliveryFailure;
 state.deliveryAuthenticationReverifiedAt=new Date().toISOString();persist(state);
 return true;
}
export function sender(config) {
 const transport=smtpTransport(config);
 return async notice=>{
  try {
   const messageId=`<proton-monitor-${notice.id}@pfennig.haus>`;
   const result=await transport.sendMail({from:{name:'Proton connector alerts',address:config.from},to:config.to,envelope:{from:config.from,to:[config.to]},messageId,subject:notice.subject,text:notice.text});
   if(!result.accepted?.includes(config.to))throw Error('Recipient not accepted');
   return {messageId,sender:config.from,recipient:config.to,smtpAccepted:true};
  }finally{transport.close();}
 };
}
export async function actualChecks(config) {
 let health;
 if(config.mode==='server') {
  const grant=join(here,'health-probe-grant.mjs');
  health=await checkHealth({
   issue:()=>JSON.parse(execFileSync(process.execPath,[grant],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']})),
   revoke:token=>JSON.parse(execFileSync(process.execPath,[grant,'--revoke'],{input:token,encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']})),
   sshCheck:()=>JSON.parse(execFileSync(process.execPath,[join(here,'check-local-mcp.mjs')],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']}))
  });
 }else {
  try {health=JSON.parse(execFileSync(process.execPath,[join(here,'health-hosted.mjs')],{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']}));}
  catch(e){try{health=JSON.parse(String(e.stdout));}catch{health={checks:{monitorProbe:false}};}}
 }
 const checks={...health.checks};
 if(config.mode==='yantra') {try{checks.offServerBackup=backupCheck(config.backupDirectory).valid;}catch{checks.offServerBackup=false;}}
 return checks;
}
async function simulatedFailure() {
 return new Promise(resolve=>{
  const req=request('http://127.0.0.1:1/proton-alert-drill',{timeout:3000},res=>{res.resume();resolve({simulatedFailure:true});});
  req.on('timeout',()=>req.destroy());req.on('error',()=>resolve({simulatedFailure:false}));req.end();
 });
}
export async function confirmedChecks(probe,delay=()=>pause(10000)) {
 const first=await probe();
 if(Object.values(first).every(v=>v===true))return {checks:first,attempts:1};
 await delay();const second=await probe();
 // Only report a check that failed in both attempts; transient faults remain quiet.
 const checks=Object.fromEntries([...new Set([...Object.keys(first),...Object.keys(second)])].map(k=>[k,first[k]===true||second[k]===true]));
 return {checks,attempts:2};
}
export async function pingWatchdog(config,state,fetcher=fetch) {
 if(config.mode!=='server'||!config.watchdogUrl)return {configured:false};
 const status={configured:true,checkedAt:new Date().toISOString(),accepted:false};
 // Only the hosted monitor may keep this alive. A local Mac must never mask a dead host.
 if(!state.lastCheck?.healthy||state.pending||state.deliveryFailure)return {...status,withheld:true};
 try {
  const url=new URL(config.watchdogUrl);
  if(url.protocol!=='https:'||url.hostname!=='hc-ping.com'||url.port||url.username||url.password||url.search||url.hash||!/^\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(url.pathname))throw Error('Invalid watchdog URL');
  const response=await fetcher(url,{method:'POST',body:'',redirect:'error',signal:AbortSignal.timeout(10000)});
  await response.body?.cancel();
  return {...status,accepted:response.status===200};
 }catch{return status;}
}
async function main() {
 process.umask(0o077);
 const configPath=process.argv[2],test=process.argv[3]==='--test-alert';
 if(!configPath || process.argv.slice(3).some(v=>v!=='--test-alert'))throw Error('Supply config path and optional --test-alert');
 if(statSync(configPath).mode&0o077)throw Error('Alert configuration must be private');
 const config=read(configPath);if(!['yantra','server'].includes(config.mode))throw Error('Invalid mode');
 const statePath=join(config.stateDirectory,test?'email-test.json':'email-monitor.json');
 mkdirSync(config.stateDirectory,{recursive:true,mode:0o700});
 const lock=statePath+'.lock';
 try {writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}
 catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(readFileSync(lock,'utf8'));try{process.kill(pid,0);return;}catch(x){if(x.code!=='ESRCH')throw x;}unlinkSync(lock);writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}
 try {
  let state={};try{state=read(statePath);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(test&&state.lastNotification?.smtpAccepted){console.log(JSON.stringify({delivery:'test-already-sent'}));return;}
  const {checks,attempts}=await confirmedChecks(test?simulatedFailure:()=>actualChecks(config),test?async()=>{}:undefined);
  if(!test)await reconcileRejectedDelivery({state,checks,persist:s=>save(statePath,s),verify:async()=>{
   const transport=smtpTransport(config);try{return await transport.verify();}finally{transport.close();}
  }});
  state.probeAttempts=attempts;state.executedAt=new Date().toISOString();
  state.scheduler=process.env.PROTON_MONITOR_SCHEDULER||'manual';
  const result=await processResult({state,checks,label:config.mode==='server'?'hosted server':'Yantra external checks',send:sender(config),persist:s=>save(statePath,s),now:new Date().toISOString(),test});
  if(!test){state.watchdog=await pingWatchdog(config,state);save(statePath,state);if(state.watchdog.configured&&!state.watchdog.accepted)process.exitCode=1;}
  console.log(JSON.stringify({checkedAt:state.lastCheck.checkedAt,healthy:state.lastCheck.healthy,attempts,...result}));
  if(['uncertain','rejected','needs-reconciliation'].includes(result.delivery))process.exitCode=1;
 }finally{unlinkSync(lock);}
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Email monitor failed; inspect private state. No credential or server response logged.');process.exitCode=1;});
