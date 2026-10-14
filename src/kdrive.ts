import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,lstatSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PublicError,tools} from '../shared/protocol.js';

export const kdriveConfigSchema=z.object({repository:z.string().startsWith('/'),stateDirectory:z.string().startsWith('/'),driveId:z.number().int().positive(),accessToken:z.string().min(1)}).strict();
const configSchema=kdriveConfigSchema;
type Config=z.infer<typeof configSchema>;
type Args=z.infer<typeof tools.proton_save_attachment_to_kdrive.schema>;
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const exec=promisify(execFile);
function privateConfig():Config {
  const path=process.env.PROTON_KDRIVE_CONFIG;
  if(!path)throw new PublicError('kdrive_not_configured','Hosted attachment transfer is not configured.');
  const s=lstatSync(path);
  if(!s.isFile()||(s.mode&0o077))throw new Error('Private configuration required');
  return configSchema.parse(JSON.parse(readFileSync(path,'utf8')));
}
function persist(path:string,record:unknown,exclusive=false) {
  const target=exclusive?path:`${path}.${randomUUID()}.tmp`;
  const fd=openSync(target,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(record)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  if(!exclusive)renameSync(target,path);
  const dir=openSync(join(path,'..'),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
}
async function upload(config:Config,source:string,destination:string,bytes:number,digest:string) {
  const result=await exec(process.execPath,[join(config.repository,'dist/transfer-cli.js'),'upload','--source',source,'--path',destination,'--size',String(bytes),'--sha256',digest,'--quiet'],{
    cwd:config.repository,timeout:120000,maxBuffer:65536,
    env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,
      XDG_STATE_HOME:config.stateDirectory,INFOMANIAK_DRIVE_ID:String(config.driveId),INFOMANIAK_ACCESS_TOKEN:config.accessToken},
  });
  return JSON.parse(result.stdout);
}
export async function saveAttachmentToKdrive(input:Args,readAttachment:()=>Promise<Buffer>,config=privateConfig(),runner=upload) {
  const args=tools.proton_save_attachment_to_kdrive.schema.parse(input);
  const directory=join(config.stateDirectory,'proton-attachments');mkdirSync(directory,{recursive:true,mode:0o700});
  const s=lstatSync(directory);if(!s.isDirectory()||(s.mode&0o077))throw new Error('Private state required');
  const path=join(directory,args.operationId+'.json');
  const requestHash=hash(JSON.stringify({message:args.message,index:args.index,destination:args.destination}));
  let old;
  try{old=JSON.parse(readFileSync(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(old){
    if(old.requestHash!==requestHash)throw new PublicError('operation_conflict','Use the original request with this operationId.');
    if(old.status==='verified')return old.result;
    return {status:'needs_reconciliation',operationId:args.operationId,doNotRetry:true};
  }
  if(readdirSync(directory).length>=10000)throw new PublicError('transfer_limit','Transfer journal needs maintenance.');
  const record:{requestHash:string;status:string;operationId:string;createdAt:string;result?:unknown;receiptPath?:string;size?:number;sha256?:string}={requestHash,status:'reserved',operationId:args.operationId,createdAt:new Date().toISOString()};
  // The durable reservation precedes any network write and survives interruption.
  try{persist(path,record,true);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')return {status:'needs_reconciliation',operationId:args.operationId,doNotRetry:true};throw e;}
  let temp:string|undefined;
  try {
    const bytes=await readAttachment();
    if(!bytes.length||bytes.length>8*1024*1024)throw new PublicError('attachment_size','Attachment must contain between 1 byte and 8 MiB.');
    const digest=hash(bytes);record.size=bytes.length;record.sha256=digest;record.status='uploading';persist(path,record);
    temp=mkdtempSync(join(tmpdir(),'proton-attachment-'));const source=join(temp,'attachment.bin');writeFileSync(source,bytes,{mode:0o600});
    const result=await runner(config,source,args.destination,bytes.length,digest);
    if(result.verified!==true||result.sha256!==digest||result.size_bytes!==bytes.length)throw new Error('Unverified upload');
    record.status='verified';record.receiptPath=result.receipt_path;
    record.result={status:'verified',operationId:args.operationId,destination:args.destination,size:bytes.length,sha256:digest};
    persist(path,record);return record.result;
  }catch(error){
    record.status='needs_reconciliation';
    // Keep the CLI receipt locally, never expose arbitrary subprocess output.
    try{const e=JSON.parse(String((error as {stderr?:string}).stderr));if(typeof e.receipt?.receipt_path==='string')record.receiptPath=e.receipt.receipt_path;}catch{}
    persist(path,record);
    if(error instanceof PublicError)throw error;
    return {status:'needs_reconciliation',operationId:args.operationId,doNotRetry:true};
  }finally{if(temp)rmSync(temp,{recursive:true,force:true});}
}
