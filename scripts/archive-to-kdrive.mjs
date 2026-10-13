// Bind every upload/resume to the immutable, checksum-verified download receipt.
import {openSync,readSync,closeSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync,unlinkSync,renameSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function readPart(fd,size) {
 const buffer=Buffer.alloc(size);let used=0;
 while(used<size){const n=readSync(fd,buffer,used,size-used,null);if(!n)break;used+=n;}
 return buffer.subarray(0,used);
}
export function preflight(archive,destination,state,receipt) {
 if(!archive.endsWith('.age') || !destination?.startsWith('/Private/'))throw Error('Supply an age archive and private kDrive directory');
 if(receipt.offServerVerified!==true || receipt.encrypted!==true || resolve(receipt.path)!==archive || !Number.isSafeInteger(receipt.bytes) || receipt.bytes<=0 || !/^[a-f0-9]{64}$/.test(receipt.sha256))throw Error('Missing valid checksum-verified download receipt');
 if(state.archive!==basename(archive) || state.destination!==destination || !Number.isSafeInteger(state.partBytes) || state.partBytes<1 || state.partBytes>64*1024*1024 || !Array.isArray(state.parts))throw Error('Invalid or mismatched manifest');
 if((state.bytes!==undefined && state.bytes!==receipt.bytes) || (state.sha256!==undefined && state.sha256!==receipt.sha256))throw Error('Archive identity differs from saved manifest');
 const fd=openSync(archive,'r'),whole=createHash('sha256'),parts=[];let total=0;
 try{for(;;){const bytes=readPart(fd,state.partBytes);if(!bytes.length)break;whole.update(bytes);total+=bytes.length;const index=parts.length;
  parts.push({index,path:destination+'/'+basename(archive)+'.part-'+String(index).padStart(3,'0'),bytes:bytes.length,sha256:digest(bytes)});
 }}finally{closeSync(fd);}
 if(total!==receipt.bytes || whole.digest('hex')!==receipt.sha256)throw Error('Archive checksum or length differs from original receipt');
 if(state.parts.length>parts.length || (state.completed && state.parts.length!==parts.length))throw Error('Saved part count differs from complete archive');
 for(let i=0;i<state.parts.length;i++){
  const saved=state.parts[i],expected=parts[i];
  if(!saved || ['index','path','bytes','sha256'].some(key=>saved[key]!==expected[key]))throw Error('Saved parts differ from complete archive');
  if(saved.state!=='verified' || saved.result?.verified!==true)throw Error('A prior upload is uncertain. Inspect its kDrive receipt before retrying.');
 }
 return {bytes:receipt.bytes,sha256:receipt.sha256,parts};
}
export function uploadArchive({archive,destination,cli,verifyOnly=false,onPart=()=>{}}) {
 archive=resolve(archive);const manifestPath=archive+'.cloud.json',lockPath=manifestPath+'.lock';
 // A private lock prevents simultaneous jobs from overwriting each other's journal.
 const lock=openSync(lockPath,'wx',0o600);
 try {
  const state=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):{version:2,archive:basename(archive),destination,partBytes:64*1024*1024,parts:[],completed:false};
  const receipt=JSON.parse(readFileSync(archive+'.json','utf8'));
  const plan=preflight(archive,destination,state,receipt);
  if(verifyOnly)return {localArchiveAndManifestVerified:true,parts:plan.parts.length,bytes:plan.bytes,sha256:plan.sha256};
  const save=()=>{const temporary=manifestPath+'.tmp';writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{mode:0o600});chmodSync(temporary,0o600);renameSync(temporary,manifestPath);};
  // Persist original identity before any network write. Never replace it on resume.
  state.version=2;state.bytes=plan.bytes;state.sha256=plan.sha256;save();
  const dir=join(dirname(archive),'.upload-parts');mkdirSync(dir,{recursive:true,mode:0o700});
  const fd=openSync(archive,'r');
  try {for(const expected of plan.parts){
   const bytes=readPart(fd,state.partBytes);
   if(bytes.length!==expected.bytes || digest(bytes)!==expected.sha256)throw Error('Archive changed after preflight');
   if(!state.parts[expected.index]) {
    const part={...expected,state:'attempting'};state.parts.push(part);save();
    const file=join(dir,basename(expected.path));writeFileSync(file,bytes,{mode:0o600,flag:'wx'});
    try{const result=cli(['upload','--source',file,'--path',part.path,'--size',String(part.bytes),'--sha256',part.sha256]);
     if(result.verified!==true)throw Error('Upload not verified');part.state='verified';part.result=result;save();
    }finally{unlinkSync(file);}
   }
   onPart({part:expected.index,verified:true,bytes:expected.bytes});
  }
  if(readPart(fd,1).length)throw Error('Archive grew after preflight');
  }finally{closeSync(fd);}
  preflight(archive,destination,state,receipt); // Includes earlier parts changed during transfer.
  state.completed=true;save();
  return {cloudBackupVerified:true,manifestPath,parts:plan.parts.length,bytes:plan.bytes,sha256:plan.sha256};
 }finally{closeSync(lock);unlinkSync(lockPath);}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {
  const args=process.argv.slice(2),verifyOnly=args.includes('--verify-only'),positional=args.filter(a=>a!=='--verify-only');
  const [archive,destination,repo=join(homedir(),'Code/kdrive-connector')]=positional;
  const cli=args=>JSON.parse(execFileSync(process.execPath,['--env-file-if-exists=.env','dist/transfer-cli.js',...args],{cwd:repo,encoding:'utf8',timeout:1800000,stdio:['ignore','pipe','pipe']}));
  console.log(JSON.stringify(uploadArchive({archive,destination,cli,verifyOnly,onPart:part=>console.log(JSON.stringify(part))})));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
