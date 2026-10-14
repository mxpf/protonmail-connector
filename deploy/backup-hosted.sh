#!/usr/bin/env bash
# Root-only snapshot. Output contains encrypted artifact metadata only.
set -euo pipefail
umask 077
test "$(id -u)" = 0
exec 9>/run/proton-connector-backup.lock
flock -n 9 || { echo 'Backup already running' >&2; exit 1; }
recipient=/etc/proton-connector-backup.age.pub
test -s "$recipient"
work=$(mktemp -d /var/tmp/proton-backup.XXXXXXXX)
connector_active=false
bridge_active=false
systemctl is-active --quiet proton-mail-connector && connector_active=true
systemctl is-active --quiet proton-bridge && bridge_active=true
resume() {
  if "$bridge_active"; then systemctl start proton-bridge; fi
  if "$connector_active"; then systemctl start proton-mail-connector; fi
}
cleanup() { resume; rm -rf -- "$work"; }
trap cleanup EXIT
mkdir -p "$work/snapshot" /var/lib/proton-backups
chmod 700 /var/lib/proton-backups
# Freeze both writers only while copying. Encryption/compression runs after restart.
systemctl stop proton-mail-connector
systemctl stop proton-bridge
extras=()
for item in etc/systemd/system/proton-email-monitor.service etc/systemd/system/proton-email-monitor.timer \
  etc/systemd/system/proton-self-heal.service etc/systemd/system/proton-self-heal.timer \
  var/lib/proton-self-heal opt/kdrive-transfer/current/REVISION; do
  if test -e "/$item"; then extras+=("$item"); fi
done
tar -C / --exclude='S.gpg-agent*' --exclude='S.dirmngr' --exclude='*.sock' -cf - \
  var/lib/protonconnector var/lib/protonbridge \
  etc/caddy/Caddyfile etc/systemd/system/proton-mail-connector.service \
  etc/systemd/system/proton-bridge.service opt/protonmail-connector/current/REVISION "${extras[@]}" \
  | tar -C "$work/snapshot" -xf -
resume
connector_active=false
bridge_active=false
stamp=$(date -u +%Y%m%dT%H%M%SZ)
output=/var/lib/proton-backups/proton-state-$stamp.tar.gz.age
tar -C "$work/snapshot" -czf - . | age -R "$recipient" -o "$output.partial"
mv "$output.partial" "$output"
python3 - "$output" <<'PY'
import hashlib,json,sys,pathlib
p=pathlib.Path(sys.argv[1]);h=hashlib.sha256()
with p.open('rb') as f:
 for b in iter(lambda:f.read(1048576),b''):h.update(b)
print(json.dumps({'path':str(p),'bytes':p.stat().st_size,'sha256':h.hexdigest(),'encrypted':True}))
PY
