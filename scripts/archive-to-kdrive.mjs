// Upload an encrypted archive in independently verified 64 MiB pieces.
// A retry validates local bytes against verified receipts and refuses an uncertain write.
import {openSync,readSync,closeSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync,unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
const archive=resolve(process.argv[2]),destination=process.argv[3],repo=process.argv[4]||join(homedir(),'Code/kdrive-connector');
if(!archive.endsWith('.age') || !destination?.startsWith('/Private/'))throw Error('Supply an age archive and private kDrive directory');
const manifestPath=archive+'.cloud.json';
const state=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):{version:1,archive:basename(archive),destination,partBytes:64*1024*1024,parts:[],completed:false};
if(state.destination!==destination)throw Error('Existing manifest has a different destination');
const save=()=>{writeFileSync(manifestPath,JSON.stringify(state,null,2)+'\n',{mode:0o600});chmodSync(manifestPath,0o600);};
const dir=join(dirname(archive),'.upload-parts');mkdirSync(dir,{recursive:true,mode:0o700});
const fd=openSync(archive,'r'),buffer=Buffer.alloc(state.partBytes);const whole=createHash('sha256');let index=0,total=0;
const cli=(args)=>JSON.parse(execFileSync(process.execPath,['--env-file-if-exists=.env','dist/transfer-cli.js',...args],{cwd:repo,encoding:'utf8',timeout:1800000,stdio:['ignore','pipe','pipe']}));
try {
 for(;;){let used=0;while(used<buffer.length){const n=readSync(fd,buffer,used,buffer.length-used,null);if(!n)break;used+=n;}if(!used)break;
  const bytes=buffer.subarray(0,used);whole.update(bytes);total+=used;
  const hash=createHash('sha256').update(bytes).digest('hex');const name=basename(archive)+'.part-'+String(index).padStart(3,'0'),path=destination+'/'+name;
  let part=state.parts[index];
  if(part && (part.sha256!==hash || part.bytes!==used || part.path!==path))throw Error('Archive differs from saved manifest');
  if(part?.state==='attempting')throw Error('A prior upload is uncertain. Inspect its kDrive receipt before retrying.');
  if(part?.state==='verified'){if(!part.result?.verified)throw Error('Missing verified upload receipt');}
  else {
   part={index,path,bytes:used,sha256:hash,state:'attempting'};state.parts[index]=part;save();
   const file=join(dir,name);writeFileSync(file,bytes,{mode:0o600,flag:'w'});
   try {const result=cli(['upload','--source',file,'--path',path,'--size',String(used),'--sha256',hash]);
    if(!result.verified)throw Error('Upload not verified');part.state='verified';part.result=result;save();}
   finally {unlinkSync(file);}
  }
  console.log(JSON.stringify({part:index,verified:true,bytes:used}));index++;
 }
 state.completed=true;state.sha256=whole.digest('hex');state.bytes=total;save();
 console.log(JSON.stringify({cloudBackupVerified:true,manifestPath,parts:index,bytes:total,sha256:state.sha256}));
}finally{closeSync(fd);}
