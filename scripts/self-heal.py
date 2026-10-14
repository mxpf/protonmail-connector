#!/usr/bin/env python3
"""Bounded same-host repair. Never provisions a host, sends mail or changes credentials."""
import datetime, fcntl, json, os, pathlib, subprocess, time, urllib.request

STATE = pathlib.Path('/var/lib/proton-self-heal/state.json')
UNITS = ('proton-bridge', 'proton-mail-connector')

def plan(first, second, attempts, now):
    if any(first.get(k) not in ('active', 'failed') or second.get(k) not in ('active', 'failed') for k in UNITS):
        return []  # An operator stop is not an outage to undo.
    if any(not isinstance(t, (int, float)) or t > now for t in attempts):
        return []
    if sum(t >= now - 3600 for t in attempts) >= 2:
        return []
    if first.get('bridge') is False and second.get('bridge') is False:
        return list(UNITS)
    if first.get('http') is False and second.get('http') is False:
        return ['proton-mail-connector']
    return []

def save(value):
    STATE.parent.mkdir(mode=0o700, exist_ok=True)
    temporary = STATE.with_suffix('.tmp')
    with temporary.open('w') as f:
        json.dump(value, f, indent=2); f.flush(); os.fsync(f.fileno())
    temporary.chmod(0o600); temporary.replace(STATE)
    fd = os.open(STATE.parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def probe():
    result = {}
    for unit in UNITS:
        result[unit] = subprocess.run(['systemctl', 'is-active', unit], capture_output=True, text=True, timeout=10).stdout.strip()
    try:
        req = urllib.request.Request('http://127.0.0.1:3100/', headers={'Host': 'mail-tools.pfennig.haus'})
        with urllib.request.urlopen(req, timeout=5) as response: result['http'] = response.status == 200
    except Exception: result['http'] = False
    env = ['PROTON_CONFIG=/var/lib/protonconnector/config.json', 'PROTON_CALENDAR_CONFIG=/var/lib/protonconnector/calendar-config.json']
    try:
        completed = subprocess.run(['sudo','-H','-u','protonconnector','env',*env,'/usr/local/bin/node',
            '/opt/protonmail-connector/current/scripts/check-local-mcp.mjs'], capture_output=True, text=True, timeout=65)
        result['bridge'] = completed.returncode == 0 and json.loads(completed.stdout).get('authenticated') is True
    except Exception: result['bridge'] = False
    return result

def main():
    os.umask(0o077)
    if os.geteuid() != 0: raise RuntimeError('Root required')
    locks = []
    try:
        for name in ('proton-self-heal', 'proton-connector-backup', 'proton-bridge-login'):
            lock = open('/run/' + name + '.lock', 'a'); locks.append(lock)
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: return
        if pathlib.Path('/run/proton-connector-maintenance').exists(): return
        state = json.loads(STATE.read_text()) if STATE.exists() else {'attempts': []}
        first = probe(); second = first
        if first.get('http') is not True or first.get('bridge') is not True:
            time.sleep(10); second = probe()
        now = time.time(); actions = plan(first, second, state['attempts'], now)
        state.update(checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), checks=second, planned=actions)
        if actions:
            # Persist the budget before action so interrupted repairs cannot loop.
            state['attempts'] = [t for t in state['attempts'] if t >= now - 3600] + [now]
            state['lastRepair'] = {'startedAt': now, 'services': actions, 'verified': False}
        save(state)
        for unit in actions:
            subprocess.run(['systemctl','reset-failed',unit], check=True, capture_output=True, timeout=10)
            subprocess.run(['systemctl','restart',unit], check=True, capture_output=True, timeout=70)
        if actions:
            time.sleep(15); after = probe()
            state['lastRepair'].update(verified=after.get('http') is True and after.get('bridge') is True, checks=after)
            save(state)
    finally:
        for lock in locks: lock.close()

if __name__ == '__main__':
    try: main()
    except Exception:
        print('Bounded service recovery could not complete. Existing independent health alerts remain active.')
        raise SystemExit(1)
