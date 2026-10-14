import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
const client=new Client({name:'local-proton-check',version:'1'});
try {
 await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/src/server.js',import.meta.url))],env:process.env,stderr:'pipe'}));
 const tools=await client.listTools();if(tools.tools.length!==18)throw Error('Discovery failed');
 const result=await client.callTool({name:'proton_status',arguments:{}});
 if(result.isError)throw Error('Status failed');
 const status=JSON.parse(result.content.find(c=>c.type==='text').text);
 if(!status.connected||!status.imapAuthenticated||!status.smtpAuthenticated)throw Error('Authentication failed');
 console.log(JSON.stringify({authenticated:true}));
}finally{await client.close();}
