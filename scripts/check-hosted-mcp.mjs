import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {homedir} from 'node:os';
import {sshCommand,sshArgs} from './ssh-options.mjs';
const transport = new StdioClientTransport({command:sshCommand,args:[
  ...sshArgs,
  'sudo','-H','-u','protonconnector','env','PROTON_CONFIG=/var/lib/protonconnector/config.json',
  'PROTON_CALENDAR_CONFIG=/var/lib/protonconnector/calendar-config.json',
  'PROTON_KDRIVE_CONFIG=/var/lib/protonconnector/kdrive-config.json',
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
  if (!sourceRecovery?.annotations?.readOnlyHint || result.tools.length!==22)
    throw new Error('Hosted connector does not expose read-only source recovery.');
  const status=await client.callTool({name:'proton_status',arguments:{}});
  if (status.isError) throw new Error('Connection check failed.');
  let workflowSmoke=false;
  if(process.env.PROTON_READ_ONLY_SMOKE==='1') {
    const searched=await client.callTool({name:'proton_search_mailboxes',arguments:{mailboxes:['INBOX'],subject:'MITRA-PROTON-SMOKE-7F41C92B',limitPerMailbox:1}});
    if(searched.isError)throw new Error('Read-only search failed.');
    const page=JSON.parse(searched.content.find(c=>c.type==='text').text);
    if(page.results.length!==1 || page.results[0].error)throw new Error('Inbox search failed.');
    const transfer=await client.callTool({name:'proton_attachment_transfer_status',arguments:{operationId:'00000000-0000-4000-8000-000000000000'}});
    if(transfer.isError)throw new Error('Transfer journal lookup failed.');
    const operation=JSON.parse(transfer.content.find(c=>c.type==='text').text);
    if(operation.status!=='not_found')throw new Error('Unexpected synthetic operation.');
    workflowSmoke=true;
  }
  console.log(JSON.stringify({mcpConnected:true,toolCount:result.tools.length,authenticated:true,richTextSchema,sourceRecovery:true,workflowSmoke}));
} finally {await client.close();}
