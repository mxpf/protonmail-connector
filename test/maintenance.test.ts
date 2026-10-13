import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {request} from 'node:http';
import {validateRestored} from '../scripts/validate-restored.mjs';
import {uploadArchive} from '../scripts/archive-to-kdrive.mjs';
import {issueProbe,revokeProbe} from '../scripts/health-probe-grant.mjs';
import {checkHealth} from '../scripts/health-hosted.mjs';
import {tools} from '../shared/protocol.js';
import {OAuthStore,ProtonOAuth,HEALTH_SCOPE,opaque} from '../src/oauth.js';
import {createHttpApp} from '../src/http.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const oauthConfig={issuerUrl:'https://mail-tools.pfennig.haus',githubClientId:'fixture-client',githubClientSecret:'fixture-secret-not-a-real-secret',githubOwnerId:'123',githubOwnerLogin:'fixture'} as const;
const temp=()=>mkdtempSync(join(tmpdir(),'proton-maintenance-test-'));
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
function write(root:string,path:string,data:string|Buffer){const full=join(root,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,data,{mode:0o600});return full;}
function db(root:string,path:string,sql:string){const full=write(root,path,'');const d=new DatabaseSync(full);d.exec(sql);d.close();}
function fixture(root:string,certificate:Buffer){
 write(root,'etc/systemd/system/proton-mail-connector.service','[Service]\nEnvironment=PROTON_CONFIG=/var/lib/protonconnector/config.json\nEnvironment=PROTON_OAUTH_CONFIG=/var/lib/protonconnector/oauth-config.json\nEnvironment=PROTON_OAUTH_DB=/var/lib/protonconnector/oauth.sqlite\nEnvironment=PROTON_CALENDAR_CONFIG=/var/lib/protonconnector/calendar-config.json\n');
 write(root,'etc/systemd/system/proton-bridge.service','[Service]\nExecStart=/usr/bin/fixture\n');write(root,'etc/caddy/Caddyfile','fixture');write(root,'opt/protonmail-connector/current/REVISION','a'.repeat(40));
 write(root,'var/lib/protonconnector/config.json',JSON.stringify({username:'fixture@example.com',password:'fixture',sender:'fixture@example.com',certificatePath:'/var/lib/protonconnector/bridge-cert.pem',ledgerPath:'/var/lib/protonconnector/send-ledger.sqlite'}));
 write(root,'var/lib/protonconnector/oauth-config.json',JSON.stringify(oauthConfig));
 write(root,'var/lib/protonconnector/calendar-config.json',JSON.stringify({calendars:[{id:'fixture',name:'Fixture',url:'https://calendar.proton.me/api/calendar/v1/url/fixture/calendar.ics',timezone:'America/New_York'}]}));
 write(root,'var/lib/protonconnector/bridge-cert.pem',certificate);
 write(root,'var/lib/protonbridge/.gnupg/private-keys-v1.d/fixture.key','fixture-presence-only');write(root,'var/lib/protonbridge/.password-store/fixture.gpg','fixture-presence-only');
 db(root,'var/lib/protonconnector/oauth.sqlite','CREATE TABLE oauth_records(kind TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(kind,key));');
 db(root,'var/lib/protonconnector/send-ledger.sqlite','CREATE TABLE sends(id TEXT PRIMARY KEY,expires INTEGER,state TEXT,payload TEXT,message_id TEXT);');
}
test('restore validation requires exact schemas, configuration, certificate, key material and safe paths',()=>{
 const certDir=temp();
 try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(certDir,'key.pem'),'-out',join(certDir,'cert.pem'),'-days','1','-subj','/CN=fixture'],{stdio:'ignore'});
 const cert=readFileSync(join(certDir,'cert.pem'));
 const cases:[string,(root:string)=>void][]=[
  ['missing OAuth DB',r=>rmSync(join(r,'var/lib/protonconnector/oauth.sqlite'))],
  ['missing send DB',r=>rmSync(join(r,'var/lib/protonconnector/send-ledger.sqlite'))],
  ['unrelated valid SQLite DBs',r=>{for(const name of ['oauth.sqlite','send-ledger.sqlite']){rmSync(join(r,'var/lib/protonconnector',name));db(r,'var/lib/protonconnector/'+name,'CREATE TABLE unrelated(id TEXT);');}}],
  ['incompatible primary key',r=>{rmSync(join(r,'var/lib/protonconnector/oauth.sqlite'));db(r,'var/lib/protonconnector/oauth.sqlite','CREATE TABLE oauth_records(kind TEXT,key TEXT,value TEXT,expires INTEGER);');}],
  ['empty mail config',r=>write(r,'var/lib/protonconnector/config.json','{}')],
  ['invalid OAuth config',r=>write(r,'var/lib/protonconnector/oauth-config.json','{}')],
  ['missing calendar config',r=>rmSync(join(r,'var/lib/protonconnector/calendar-config.json'))],
  ['invalid calendar config',r=>write(r,'var/lib/protonconnector/calendar-config.json','{"calendars":[]}')],
  ['invalid certificate',r=>write(r,'var/lib/protonconnector/bridge-cert.pem','not a certificate')],
  ['empty keys',r=>rmSync(join(r,'var/lib/protonbridge/.gnupg/private-keys-v1.d/fixture.key'))],
  ['empty password store',r=>rmSync(join(r,'var/lib/protonbridge/.password-store/fixture.gpg'))],
  ['missing service',r=>rmSync(join(r,'etc/systemd/system/proton-bridge.service'))],
  ['invalid revision',r=>write(r,'opt/protonmail-connector/current/REVISION','not a revision')],
  ['escaping symlink',r=>symlinkSync(certDir,join(r,'outside'))],
 ];
 const good=temp();try{fixture(good,cert);const result=validateRestored(good);assert.equal(result.validationVersion,2);assert.equal(result.calendarCount,1);assert.equal(result.sqliteDatabasesChecked,2);assert.equal(result.liveServiceFailoverTested,false);
 const unit=join(good,'etc/systemd/system/proton-mail-connector.service');writeFileSync(unit,readFileSync(unit,'utf8').replace(/^Environment=PROTON_CALENDAR_CONFIG=.*\n/m,''));assert.equal(validateRestored(good).calendarCount,0);
 }finally{rmSync(good,{recursive:true,force:true});}
 for(const [label,mutate] of cases){const root=temp();try{fixture(root,cert);mutate(root);assert.throws(()=>validateRestored(root),undefined,label);}finally{rmSync(root,{recursive:true,force:true});}}
 }finally{rmSync(certDir,{recursive:true,force:true});}
});
function uploadFixture(root:string){
 const archive=write(root,'fixture.age','xy'),destination='/Private/Fixture';
 writeFileSync(archive+'.json',JSON.stringify({path:archive,bytes:2,sha256:hash('xy'),encrypted:true,offServerVerified:true}));
 const state={version:1,archive:'fixture.age',destination,partBytes:1,parts:[...'xy'].map((byte,index)=>({index,path:destination+'/fixture.age.part-'+String(index).padStart(3,'0'),bytes:1,sha256:hash(byte),state:'verified',result:{verified:true}})),completed:true,bytes:2,sha256:hash('xy')};
 writeFileSync(archive+'.cloud.json',JSON.stringify(state));return {archive,destination,state};
}
test('upload resume rejects truncated prefix, growth, mutation and inconsistent journals without writes',()=>{
 const mutations:[string,(f:ReturnType<typeof uploadFixture>)=>void][]=[
  ['truncated prefix',f=>writeFileSync(f.archive,'x')],['growth',f=>writeFileSync(f.archive,'xyz')],['same-size mutation',f=>writeFileSync(f.archive,'xz')],
  ['leftover parts',f=>{f.state.parts.push({...f.state.parts[1],index:2});}],['missing completed part',f=>{f.state.parts.pop();}],['gapped index',f=>{f.state.parts[1].index=3;}],['unknown upload outcome',f=>{f.state.parts[1].state='attempting';f.state.completed=false;}],['original identity',f=>{f.state.sha256=hash('zz');}],
 ];
 for(const [label,mutate] of mutations){const root=temp();try{const f=uploadFixture(root);mutate(f);writeFileSync(f.archive+'.cloud.json',JSON.stringify(f.state));const before=readFileSync(f.archive+'.cloud.json');let calls=0;
 assert.throws(()=>uploadArchive({...f,cli:()=>{calls++;return {verified:true};}}),undefined,label);assert.equal(calls,0);assert.deepEqual(readFileSync(f.archive+'.cloud.json'),before);
 }finally{rmSync(root,{recursive:true,force:true});}}
});
test('upload resumes only missing verified pieces and preserves original identity',()=>{
 const root=temp();try{const f=uploadFixture(root);f.state.parts.pop();f.state.completed=false;writeFileSync(f.archive+'.cloud.json',JSON.stringify(f.state));let calls=0;
 const cli=(args:string[])=>{calls++;assert.equal(readFileSync(args[2],'utf8'),'y');return {verified:true};};
 const result=uploadArchive({...f,cli});assert.equal(result.cloudBackupVerified,true);assert.equal(calls,1);assert.equal(result.sha256,hash('xy'));assert.equal(result.bytes,2);
 const before=readFileSync(f.archive+'.cloud.json');assert.equal(uploadArchive({...f,cli,verifyOnly:true}).localArchiveAndManifestVerified,true);assert.deepEqual(readFileSync(f.archive+'.cloud.json'),before);assert.equal(calls,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('upload detects a file changed while a piece is being transferred',()=>{
 const root=temp();try{const f=uploadFixture(root);f.state.parts=[];f.state.completed=false;writeFileSync(f.archive+'.cloud.json',JSON.stringify(f.state));let calls=0;
 assert.throws(()=>uploadArchive({...f,cli:()=>{calls++;writeFileSync(f.archive,'zz');return {verified:true};}}));assert.equal(calls,1);assert.equal(JSON.parse(readFileSync(f.archive+'.cloud.json','utf8')).completed,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('HTTPS health uses restricted, expiring and revocable grants; detects HTTP-only failures',async()=>{
 let now=Math.floor(Date.now()/1000),calls=0,badStatus=false;
 const store=new OAuthStore(':memory:',()=>now),provider=new ProtonOAuth(oauthConfig,store);
 const server=createHttpApp(provider,{execute:async(name:string)=>{assert.equal(name,'proton_status');calls++;return {connected:!badStatus,imapAuthenticated:true,smtpAuthenticated:true};}}).listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
 const localFetch:typeof fetch=async(input,init={})=>new Promise((resolve,reject)=>{
  const target=new URL(String(input));const headers=new Headers(init.headers);headers.set('Host','mail-tools.pfennig.haus');
  const req=request(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`,{method:init.method||'GET',headers:Object.fromEntries(headers)},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const h=new Headers();for(const [k,v] of Object.entries(res.headers))if(v)h.set(k,Array.isArray(v)?v.join(','):v);resolve(new Response([204,304].includes(res.statusCode!)?null:Buffer.concat(chunks),{status:res.statusCode,headers:h}));});});req.on('error',reject);req.end(init.body?String(init.body):undefined);
 });
 const issue=()=>issueProbe(store,provider.resource),revoke=(token:string)=>revokeProbe(store,token),sshCheck=()=>({authenticated:true});
 try{
  await assert.rejects(provider.clientsStore.registerClient({redirect_uris:['https://chatgpt.com/callback'],scope:HEALTH_SCOPE}));assert.throws(()=>provider.checkScopes([HEALTH_SCOPE]));
  const grant=issue();assert.equal(grant.expires_in,120);assert.equal(grant.refresh_token,undefined);
  const client=new Client({name:'health-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(provider.resource),{fetch:localFetch,requestInit:{headers:{Authorization:`Bearer ${grant.access_token}`}}}));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['proton_status']);const before=calls;
  for(const name of Object.keys(tools).filter(name=>name!=='proton_status')){try{const result=await client.callTool({name,arguments:{}});assert.equal(result.isError,true);}catch(error){assert.match(String(error),/not found|Unknown tool/i);}}
  assert.equal(calls,before);await client.close();revoke(grant.access_token);await assert.rejects(provider.verifyAccessToken(grant.access_token));
  const expired=issue();now+=121;await assert.rejects(provider.verifyAccessToken(expired.access_token));
  const healthy=await checkHealth({fetcher:localFetch,issue,revoke,sshCheck});assert.equal(healthy.healthy,true);assert.equal(healthy.checks.authenticatedHttpsMcp,true);assert.equal(healthy.checks.revokedProbeRejected,true);
  const failHttp:typeof fetch=(input,init)=>new Headers(init?.headers).has('Authorization')?Promise.resolve(new Response('unavailable',{status:503})):localFetch(input,init);
  const failed=await checkHealth({fetcher:failHttp,issue,revoke,sshCheck});assert.equal(failed.healthy,false);assert.equal(failed.checks.https,true);assert.equal(failed.checks.bridgeAndMcp,true);assert.equal(failed.checks.authenticatedHttpsMcp,false);assert.equal(failed.checks.probeGrantRevoked,true);
  badStatus=true;const malformed=await checkHealth({fetcher:localFetch,issue,revoke,sshCheck});assert.equal(malformed.healthy,false);assert.equal(malformed.checks.probeGrantRevoked,true);
  const denied=await checkHealth({fetcher:localFetch,issue:()=>({access_token:opaque()}),revoke:()=>{throw Error();},sshCheck});assert.equal(denied.checks.authenticatedHttpsMcp,false);assert.equal(denied.checks.probeGrantRevoked,false);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
