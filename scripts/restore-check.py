#!/usr/bin/env python3
"""Decrypt to a private disposable directory; validate a restored snapshot without network services."""
import json,os,pathlib,shutil,sqlite3,subprocess,sys,tarfile,tempfile
if sys.version_info < (3,12):raise SystemExit('Use Python 3.12 or newer for safe archive extraction.')
os.umask(0o077)
archive=pathlib.Path(sys.argv[1]);identity=pathlib.Path(sys.argv[2])
with tempfile.TemporaryDirectory(prefix='proton-restore-') as work:
 root=pathlib.Path(work); plain=root/'snapshot.tar.gz'; restored=root/'restored';restored.mkdir(mode=0o700)
 with plain.open('xb') as f:subprocess.run(['age','-d','-i',str(identity),str(archive)],stdout=f,stderr=subprocess.PIPE,check=True)
 with tarfile.open(plain) as tar:tar.extractall(restored,filter='data')
 required=['var/lib/protonconnector/config.json','var/lib/protonconnector/oauth-config.json','var/lib/protonbridge/.gnupg','var/lib/protonbridge/.password-store','opt/protonmail-connector/current/REVISION']
 for name in required:
  if not (restored/name).exists():raise RuntimeError('Missing required backup component')
 for name in required[:2]:json.loads((restored/name).read_text())
 databases=0
 for path in restored.rglob('*'):
  if path.is_file():
   with path.open('rb') as f:header=f.read(16)
   if header==b'SQLite format 3\x00':
    con=sqlite3.connect(str(path));result=con.execute('PRAGMA quick_check').fetchone();con.close()
    if result!=('ok',):raise RuntimeError('Restored database integrity failed')
    databases+=1
 if databases<2:raise RuntimeError('Expected OAuth and send-ledger databases')
 receipt={'archive':str(archive),'authenticatedDecryption':True,'requiredComponentsPresent':True,'sqliteDatabasesChecked':databases,'sqliteIntegrity':'ok','isolatedRestore':True,'liveServiceFailoverTested':False}
 pathlib.Path(str(archive)+'.restore.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt))
