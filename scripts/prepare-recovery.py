#!/usr/bin/env python3
"""Prepare a verified private restore directory; never start or replace a service."""
import datetime, hashlib, json, os, pathlib, shutil, subprocess, sys, tarfile

def identity(path):
    digest=hashlib.sha256(); size=0
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''): digest.update(b); size+=len(b)
    return digest.hexdigest(),size

def prepare(archive,key,destination):
    os.umask(0o077)
    archive=archive.resolve();key=key.resolve();destination=destination.absolute()
    if sys.version_info<(3,12) or destination.exists(): raise ValueError('New private destination required')
    download=json.loads(pathlib.Path(str(archive)+'.json').read_text())
    restore=json.loads(pathlib.Path(str(archive)+'.restore.json').read_text())
    digest,size=identity(archive)
    if not (download.get('offServerVerified') is True and download.get('encrypted') is True and download.get('path')==str(archive)
            and download.get('sha256')==digest and download.get('bytes')==size
            and restore.get('validationVersion')==2 and restore.get('archive')==str(archive)
            and restore.get('archiveSha256')==digest and restore.get('archiveBytes')==size
            and restore.get('sqliteIntegrity')=='ok' and restore.get('sqliteDatabasesChecked',0)>=3
            and all(restore.get(k) is True for k in ['authenticatedDecryption','requiredComponentsPresent','configurationSchemasValid','requiredDatabaseSchemasValid','certificateParseable','keyStoreMaterialPresent','isolatedRestore'])):
        raise ValueError('Archive and successful version 2 receipts must match')
    destination.mkdir(mode=0o700); plain=destination/'snapshot.tar.gz'; restored=destination/'restored'
    try:
        restored.mkdir(mode=0o700)
        with plain.open('xb') as f: subprocess.run(['age','-d','-i',str(key),str(archive)],stdout=f,stderr=subprocess.PIPE,check=True)
        with tarfile.open(plain) as tar: tar.extractall(restored,filter='data')
        plain.unlink()
        result=subprocess.run(['node',str(pathlib.Path(__file__).with_name('validate-restored.mjs')),str(restored)],capture_output=True,text=True,check=True)
        if identity(archive)!=(digest,size): raise ValueError('Archive changed')
        receipt={'preparedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive':str(archive),'sha256':digest,'bytes':size,
                 'authenticatedDecryption':True,'servicesStarted':False,'validation':json.loads(result.stdout)}
        (destination/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
        return {'prepared':True,'directory':str(destination),'servicesStarted':False}
    except BaseException:
        shutil.rmtree(destination); raise

if __name__=='__main__':
    try:
        if len(sys.argv)!=4: raise ValueError('Supply archive, private key and NEW staging directory')
        print(json.dumps(prepare(*(pathlib.Path(p) for p in sys.argv[1:]))))
    except Exception:
        print('Recovery preparation failed; no existing state was changed.',file=sys.stderr);sys.exit(1)
