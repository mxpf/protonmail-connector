// One exact mail attachment -> private local snapshot -> direct kDrive upload and checksum verification.
// Usage: node scripts/attachment-to-kdrive.mjs request.json
// request: {message:{mailbox,uidValidity,uid},index,destination,kdriveRepository?}
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,statSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {messageRef} from '../dist/shared/protocol.js';
const p=process.argv[2];
if(!p || (statSync(p).mode & 0o077)) throw Error('Use a mode-0600 request file.');
const args=z.object({message:messageRef,index:z.number().int().min(0).max(1000),destination:z.string().startsWith('/').min(2),kdriveRepository:z.string().startsWith('/').default(join(homedir(),'Code/kdrive-connector'))}).strict().parse(JSON.parse(readFileSync(p,'utf8')));
const dir=mkdtempSync(join(tmpdir(),'proton-kdrive-'));
const transport=new StdioClientTransport({command:'ssh',args:['-i',join(homedir(),'.ssh/protonmail_hetzner_ed25519'),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','hausadmin@135.181.111.93','sudo','-H','-u','protonconnector','env','PROTON_CONFIG=/var/lib/protonconnector/config.json','/usr/local/bin/node','/opt/protonmail-connector/current/dist/src/server.js'],stderr:'pipe'});
const client=new Client({name:'proton-kdrive-transfer',version:'1.0.0'});
try {
 await client.connect(transport);
 const result=await client.callTool({name:'proton_read_attachment',arguments:{message:args.message,index:args.index}});
 if(result.isError) throw Error('Attachment could not be retrieved');
 const attachment=JSON.parse(result.content.find(c=>c.type==='text').text);
 const data=Buffer.from(attachment.base64,'base64');
 if(data.length!==attachment.size || data.length>8*1024*1024) throw Error('Attachment size mismatch');
 const sha256=createHash('sha256').update(data).digest('hex');
 // Never use an email-provided filename as a filesystem path.
 const source=join(dir,'attachment.bin');writeFileSync(source,data,{mode:0o600});
 const output=execFileSync(process.execPath,['--env-file-if-exists=.env','dist/transfer-cli.js','upload','--source',source,'--path',args.destination,'--size',String(data.length),'--sha256',sha256],{cwd:resolve(args.kdriveRepository),encoding:'utf8',timeout:1800000,stdio:['ignore','pipe','pipe']});
 console.log(output.trim());
} finally {await client.close();rmSync(dir,{recursive:true,force:true});}
