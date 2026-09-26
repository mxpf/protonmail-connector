import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {homedir} from 'node:os';
const transport = new StdioClientTransport({command:'ssh',args:[
  '-i',`${homedir()}/.ssh/protonmail_hetzner_ed25519`,'-o','BatchMode=yes','-o','IdentitiesOnly=yes',
  '-o','StrictHostKeyChecking=yes','hausadmin@135.181.111.93',
  'sudo','-H','-u','protonconnector','env','PROTON_CONFIG=/var/lib/protonconnector/config.json',
  '/usr/local/bin/node','/opt/protonmail-connector/current/dist/src/server.js',
],stderr:'pipe'});
const client=new Client({name:'hosted-proton-check',version:'0.1.0'});
try {
  await client.connect(transport);
  const result=await client.listTools();
  const status=await client.callTool({name:'proton_status',arguments:{}});
  if (status.isError) throw new Error('Connection check failed.');
  console.log(JSON.stringify({mcpConnected:true,toolCount:result.tools.length,authenticated:true}));
} finally {await client.close();}
