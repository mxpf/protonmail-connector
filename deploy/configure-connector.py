#!/usr/bin/env python3
"""Run as root on the Bridge host. Credentials never leave this machine."""
import fcntl
import json
import os
import pathlib
import pwd
import pty
import re
import select
import subprocess
import time

os.umask(0o077)
assert os.geteuid() == 0
lock = open('/run/proton-bridge-login.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
home = '/var/lib/protonbridge'
subprocess.run(['systemctl', 'stop', 'proton-bridge'], check=True)
try:
    master, slave = pty.openpty()
    process = subprocess.Popen(['sudo','-H','-u','protonbridge','protonmail-bridge','--cli','--log-level','error'],
        stdin=slave, stdout=slave, stderr=slave, cwd=home, start_new_session=True)
    os.close(slave)
    output = b''
    def until_prompt():
        global output
        part = b''
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if select.select([master],[],[],1)[0]:
                try:
                    block = os.read(master,65536)
                except OSError:
                    break
                if not block:
                    break
                part += block
                if b'>>> ' in part:
                    output += part
                    return
        raise RuntimeError('Bridge CLI prompt unavailable; no credentials printed.')
    try:
        until_prompt()
        # CLI prompt can appear before asynchronous account loading has finished.
        ready_deadline = time.monotonic() + 30
        while time.monotonic() < ready_deadline:
            os.write(master,b'list\n')
            time.sleep(1)
            latest = b''
            while select.select([master],[],[],0.2)[0]:
                latest += os.read(master,65536)
            output += latest
            if b'connected' in latest:
                break
        os.write(master,b'info 0\n')
        # Wait for complete IMAP/SMTP output, not readline's echoed prompt.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if select.select([master],[],[],1)[0]:
                output += os.read(master,65536)
                if output.count(b'Security:') >= 2:
                    break
        os.write(master,b'exit\n')
        process.wait(timeout=15)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        os.close(master)
    # Never print subprocess output: it contains the Bridge-specific password.
    text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', output.decode(errors='replace'))
    def field(label):
        found = re.findall(r'^' + re.escape(label) + r':\s*(\S+)\s*$', text, re.M)
        if not found or len(set(found)) != 1:
            print('CLI diagnostic:', {word: word.lower() in text.lower() for word in
                ['Username:', 'Password:', 'IMAP Settings', 'no accounts', 'not found', 'connected', 'locked', 'signed out', 'unknown command']})
            raise RuntimeError('Unable to identify exactly one ' + label + ' value; no credentials printed.')
        return found[0]
    config = dict(username=field('Username'), password=field('Password'), sender='max@pfennig.haus',
        imapPort=int(field('IMAP port')), smtpPort=int(field('SMTP port')),
        certificatePath='/var/lib/protonconnector/bridge-cert.pem', tlsServerName='127.0.0.1',
        ledgerPath='/var/lib/protonconnector/send-ledger.sqlite')
    if field('Security') != 'STARTTLS' or config['username'] != 'max@pfennig.haus':
        raise RuntimeError('Unexpected Bridge identity or TLS mode; configuration not saved.')
finally:
    subprocess.run(['systemctl','start','proton-bridge'], check=True)

# Fetch only the PUBLIC TLS certificate over loopback on the trusted SSH host.
# No credentials are used in this bootstrap. Runtime clients must verify this CA.
certificate = None
for attempt in range(15):
    p = subprocess.run(['openssl','s_client','-connect','127.0.0.1:1143','-starttls','imap','-showcerts'],
        input=b'a logout\n', stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    match = re.search(rb'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', p.stdout, re.S)
    if match:
        certificate = match[0] + b'\n'
        break
    time.sleep(1)
if not certificate:
    raise RuntimeError('Bridge TLS certificate unavailable; configuration not saved.')
account = pwd.getpwnam('protonconnector')
for name, data in [('bridge-cert.pem',certificate),('config.json',json.dumps(config).encode())]:
    path = pathlib.Path('/var/lib/protonconnector') / name
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_bytes(data)
    os.chmod(tmp,0o600)
    os.chown(tmp, account.pw_uid, account.pw_gid)
    os.replace(tmp,path)
print('Private connector configuration and public TLS certificate saved on the server. No credentials exported.')
