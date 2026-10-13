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
  const prepare=result.tools.find(tool=>tool.name==='proton_prepare_send');
  const richTextSchema=Boolean(prepare?.inputSchema?.properties?.html);
  if (!richTextSchema) throw new Error('Hosted connector does not expose the rich-text composition field.');
  const sourceRecovery=result.tools.find(tool=>tool.name==='proton_read_source');
  if (!sourceRecovery?.annotations?.readOnlyHint || result.tools.length!==11)
    throw new Error('Hosted connector does not expose read-only source recovery.');
  const status=await client.callTool({name:'proton_status',arguments:{}});
  if (status.isError) throw new Error('Connection check failed.');
  console.log(JSON.stringify({mcpConnected:true,toolCount:result.tools.length,authenticated:true,richTextSchema,sourceRecovery:true}));
} finally {await client.close();}
