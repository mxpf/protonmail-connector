// Offline structural recovery validation. No restored services or network sessions start.
import {readFileSync,statSync,realpathSync,readdirSync,openSync,readSync,closeSync} from 'node:fs';
import {resolve,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {X509Certificate} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig} from '../dist/src/config.js';
import {loadOAuthConfig} from '../dist/src/oauth.js';
import {loadConfig as loadCalendarConfig} from '../dist/src/calendar/config.js';
export function validateRestored(directory) {
 const root=realpathSync(directory);
 const inside=p=>{const real=realpathSync(p);if(!real.startsWith(root+sep))throw Error('Restored path escapes snapshot');return real;};
 const path=value=>{if(typeof value!=='string'||!value.startsWith('/')||value.split('/').includes('..'))throw Error('Invalid restored path');return inside(resolve(root,'.'+value));};
 const file=value=>{const p=path(value);if(!statSync(p).isFile()||statSync(p).size===0)throw Error('Missing required file');return p;};
 const service=file('/etc/systemd/system/proton-mail-connector.service');
 file('/etc/systemd/system/proton-bridge.service');file('/etc/caddy/Caddyfile');
 const revision=readFileSync(file('/opt/protonmail-connector/current/REVISION'),'utf8').trim();
 if(!/^[a-f0-9]{40}$/.test(revision))throw Error('Invalid release revision');
 const environment=Object.fromEntries([...readFileSync(service,'utf8').matchAll(/^Environment=([A-Z_]+)=(\/[^\s"']+)\s*$/gm)].map(m=>[m[1],m[2]]));
 // Check the actual service's referenced paths, never arbitrary database counts.
 let config,calendarCount=0;
 try {
  config=loadConfig(file(environment.PROTON_CONFIG));
  loadOAuthConfig(file(environment.PROTON_OAUTH_CONFIG));
  new X509Certificate(readFileSync(file(config.certificatePath)));
  if(environment.PROTON_CALENDAR_CONFIG)calendarCount=loadCalendarConfig(file(environment.PROTON_CALENDAR_CONFIG)).calendars.length;
 }catch{throw Error('Required restored configuration or certificate is invalid');}
 const requiredDatabases=[
  [file(environment.PROTON_OAUTH_DB),'oauth_records',{kind:['TEXT',1],key:['TEXT',2],value:['TEXT',0],expires:['INTEGER',0]}],
  [file(config.ledgerPath),'sends',{id:['TEXT',1],expires:['INTEGER',0],state:['TEXT',0],payload:['TEXT',0],message_id:['TEXT',0]}],
 ];
 for(const [name,table,expected] of requiredDatabases) {
  const db=new DatabaseSync(name,{readOnly:true});
  try {
   const columns=db.prepare(`PRAGMA table_info(${table})`).all();
   for(const [name,[type,pk]] of Object.entries(expected)) {
    const c=columns.find(c=>c.name===name);
    if(!c || c.type.toUpperCase()!==type || c.pk!==pk)throw Error('Required database schema is missing or incompatible');
   }
  }finally{db.close();}
 }
 const files=[];
 function walk(dir) {for(const entry of readdirSync(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isSymbolicLink()){inside(p);continue;}if(entry.isDirectory())walk(p);else if(entry.isFile())files.push(p);}}
 walk(root);
 const keys=path('/var/lib/protonbridge/.gnupg/private-keys-v1.d'),store=path('/var/lib/protonbridge/.password-store');
 if(!files.some(p=>p.startsWith(keys+sep)&&p.endsWith('.key')&&statSync(p).size>0) || !files.some(p=>p.startsWith(store+sep)&&p.endsWith('.gpg')&&statSync(p).size>0))throw Error('Required private key or password-store material is missing');
 let databases=0;
 for(const p of files) {
  // Reading only the header avoids loading Bridge's mailbox cache into memory.
  const fd=openSync(p,'r'),header=Buffer.alloc(16);
  try{readSync(fd,header,0,16,0);}finally{closeSync(fd);}
  if(!header.equals(Buffer.from('SQLite format 3\0')))continue;
  const db=new DatabaseSync(p,{readOnly:true});
  try{const rows=db.prepare('PRAGMA quick_check').all();if(rows.length!==1||Object.values(rows[0])[0]!=='ok')throw Error('Restored database integrity failed');databases++;}finally{db.close();}
 }
 return {validationVersion:2,requiredComponentsPresent:true,configurationSchemasValid:true,requiredDatabaseSchemasValid:true,certificateParseable:true,keyStoreMaterialPresent:true,calendarCount,sqliteDatabasesChecked:databases,sqliteIntegrity:'ok',isolatedRestore:true,liveServiceFailoverTested:false};
}
if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
 try{console.log(JSON.stringify(validateRestored(process.argv[2])));}catch{console.error('Restored snapshot is incomplete, invalid or incompatible.');process.exitCode=1;}
}
