import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const origin='https://mail-tools.pfennig.haus';
export async function authenticatedProbe({url,token,fetcher=fetch}) {
 const client=new Client({name:'proton-https-health',version:'1.0.0'});
 // Fixed bearer header; no browser login, refresh token or OAuth client cache.
 const transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`}},fetch:(input,init)=>fetcher(input,{...init,redirect:'error',signal:AbortSignal.timeout(15000)})});
 try {
  await client.connect(transport);
  const listed=await client.listTools();
  if(listed.tools.length!==1 || listed.tools[0].name!=='proton_status')throw Error('Probe scope is not restricted');
  const result=await client.callTool({name:'proton_status',arguments:{}});
  if(result.isError)throw Error('Status failed');
  const block=result.content?.find(c=>c.type==='text');
  const status=block?JSON.parse(block.text):null;
  if(status?.connected!==true || status.imapAuthenticated!==true || status.smtpAuthenticated!==true)throw Error('Bridge authentication failed');
  return true;
 }finally{await client.close();}
}
export async function checkHealth({fetcher=fetch,issue,revoke,sshCheck}) {
 const checks={};
 for(const [name,path,expected,method] of [['https','/',200,'GET'],['oauthMetadata','/.well-known/oauth-authorization-server',200,'GET'],['mcpRejectsUnauthenticated','/mcp',401,'POST']]) {
  try {const r=await fetcher(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(15000)});checks[name]=r.status===expected;await r.body?.cancel();}catch{checks[name]=false;}
 }
 let token;
 try {token=(await issue()).access_token;if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error();checks.authenticatedHttpsMcp=await authenticatedProbe({url:origin+'/mcp',token,fetcher});}
 catch {checks.authenticatedHttpsMcp=false;}
 finally {
  checks.probeGrantRevoked=false;checks.revokedProbeRejected=false;
  if(token){try{
   await revoke(token);checks.probeGrantRevoked=true;
   const response=await fetcher(origin+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
   checks.revokedProbeRejected=response.status===401;await response.body?.cancel();
  }catch{/* Cleanup and rejection are separately visible without exposing the token. */}}
 }
 try {checks.bridgeAndMcp=(await sshCheck()).authenticated===true;}catch{checks.bridgeAndMcp=false;}
 return {checkedAt:new Date().toISOString(),healthy:Object.values(checks).every(Boolean),checks};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const ssh=['-i',`${homedir()}/.ssh/protonmail_hetzner_ed25519`,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','hausadmin@135.181.111.93'];
 const command='sudo -H -u protonconnector env PROTON_OAUTH_CONFIG=/var/lib/protonconnector/oauth-config.json PROTON_OAUTH_DB=/var/lib/protonconnector/oauth.sqlite /usr/local/bin/node /opt/protonmail-connector/current/scripts/health-probe-grant.mjs';
 const result=await checkHealth({
  issue:()=>JSON.parse(execFileSync('ssh',[...ssh,command],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']})),
  revoke:token=>JSON.parse(execFileSync('ssh',[...ssh,command+' --revoke'],{input:token,encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']})),
  sshCheck:()=>JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('./check-hosted-mcp.mjs',import.meta.url))],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']})),
 });
 console.log(JSON.stringify(result));if(!result.healthy)process.exitCode=1;
}
