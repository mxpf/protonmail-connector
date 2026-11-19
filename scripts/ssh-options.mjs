import {homedir} from 'node:os';
import {join} from 'node:path';
import {existsSync} from 'node:fs';

export const sshCommand=process.platform==='win32' && existsSync('C:/Program Files/Git/usr/bin/ssh.exe')?'C:/Program Files/Git/usr/bin/ssh.exe':'ssh';
const directory=join(homedir(),'.ssh');
const pinnedHosts=join(directory,'protonmail_hetzner_known_hosts');
export const sshArgs=['-i',join(directory,'protonmail_hetzner_ed25519'),'-o','BatchMode=yes','-o','IdentitiesOnly=yes',
  '-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ForwardAgent=no','-o','ClearAllForwardings=yes',
  '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',
  ...(existsSync(pinnedHosts)?['-o',`UserKnownHostsFile=${pinnedHosts}`,'-o','GlobalKnownHostsFile=none','-o','UpdateHostKeys=no']:[]),
  'hausadmin@135.181.111.93'];
