import {execFileSync} from 'node:child_process';
const checks={};
for(const [name,path,expected,method] of [['https','/',200,'GET'],['oauthMetadata','/.well-known/oauth-authorization-server',200,'GET'],['mcpRejectsUnauthenticated','/mcp',401,'POST']]) {
  try {const r=await fetch('https://mail-tools.pfennig.haus'+path,{method,redirect:'error',signal:AbortSignal.timeout(15000)});checks[name]=r.status===expected;await r.body?.cancel();}
  catch {checks[name]=false;}
}
try {
 const result=JSON.parse(execFileSync(process.execPath,[new URL('./check-hosted-mcp.mjs',import.meta.url).pathname],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']}));
 checks.bridgeAndMcp=result.authenticated===true;
} catch {checks.bridgeAndMcp=false;}
const result={checkedAt:new Date().toISOString(),healthy:Object.values(checks).every(Boolean),checks};
console.log(JSON.stringify(result));if(!result.healthy) process.exitCode=1;
