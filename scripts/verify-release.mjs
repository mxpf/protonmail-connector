import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sshCommand,sshArgs} from './ssh-options.mjs';

const revision=process.argv[2];
if(!/^[a-f0-9]{40}$/.test(revision??''))throw new Error('Supply the expected deployed Git commit.');
try {
  const current=execFileSync(sshCommand,[...sshArgs,'cat /opt/protonmail-connector/current/REVISION'],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
  if(current!==revision)throw new Error('Deployed revision differs.');
  const health=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('./health-hosted.mjs',import.meta.url))],{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']}));
  if(!health.healthy)throw new Error('Hosted health failed.');
  const discovery=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('./check-hosted-mcp.mjs',import.meta.url))],{env:{...process.env,PROTON_READ_ONLY_SMOKE:'1'},encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']}));
  if(!discovery.authenticated||!discovery.workflowSmoke)throw new Error('Workflow discovery or search failed.');
  console.log(JSON.stringify({revision,healthy:true,toolCount:discovery.toolCount,workflowSmoke:true,checks:health.checks}));
} catch {
  console.error('Release verification failed. Inspect the deployed revision, health checks, and tool discovery.');
  process.exitCode=1;
}
