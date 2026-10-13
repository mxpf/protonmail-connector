#!/usr/bin/env python3
"""Authenticate/decrypt and validate an offline restore without starting services."""
import datetime,hashlib,json,os,pathlib,subprocess,sys,tarfile,tempfile

def identity_of(archive):
 digest=hashlib.sha256();size=0
 with archive.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk);size+=len(chunk)
 return digest.hexdigest(),size

def check(archive,identity):
 if sys.version_info < (3,12):raise RuntimeError('Use Python 3.12 or newer.')
 os.umask(0o077)
 digest,size=identity_of(archive)
 with tempfile.TemporaryDirectory(prefix='proton-restore-') as work:
  root=pathlib.Path(work);plain=root/'snapshot.tar.gz';restored=root/'restored';restored.mkdir(mode=0o700)
  with plain.open('xb') as f:subprocess.run(['age','-d','-i',str(identity),str(archive)],stdout=f,stderr=subprocess.PIPE,check=True)
  with tarfile.open(plain) as tar:tar.extractall(restored,filter='data')
  validator=pathlib.Path(__file__).resolve().with_name('validate-restored.mjs')
  result=subprocess.run(['node',str(validator),str(restored)],capture_output=True,text=True,check=True)
  if identity_of(archive)!=(digest,size):raise RuntimeError('Archive changed during verification.')
  receipt={'archive':str(archive),'archiveSha256':digest,'archiveBytes':size,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'authenticatedDecryption':True,**json.loads(result.stdout)}
  output=pathlib.Path(str(archive)+'.restore.json');temporary=output.with_suffix('.tmp')
  temporary.write_text(json.dumps(receipt,indent=2)+'\n');temporary.chmod(0o600);temporary.replace(output)
  return receipt

if __name__=='__main__':
 try:
  if len(sys.argv)!=3:raise RuntimeError('Supply encrypted archive and private identity paths.')
  print(json.dumps(check(pathlib.Path(sys.argv[1]).resolve(),pathlib.Path(sys.argv[2]).resolve())))
 except Exception:
  # Never echo subprocess output, configuration values or decrypted source data.
  print('Restore validation failed; no successful receipt was written.',file=sys.stderr);sys.exit(1)
