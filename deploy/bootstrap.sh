#!/usr/bin/env bash
# Run as root on a new Ubuntu server; retains root key access until admin is tested.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl gnupg pass tmux sudo ufw unattended-upgrades debsig-verify nodejs npm
id hausadmin >/dev/null 2>&1 || useradd -m -s /bin/bash hausadmin
install -d -m 700 -o hausadmin -g hausadmin /home/hausadmin/.ssh
install -m 600 -o hausadmin -g hausadmin /root/.ssh/authorized_keys /home/hausadmin/.ssh/authorized_keys
printf '%s\n' 'hausadmin ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/hausadmin
chmod 440 /etc/sudoers.d/hausadmin
visudo -cf /etc/sudoers.d/hausadmin
id protonbridge >/dev/null 2>&1 || useradd -m -d /var/lib/protonbridge -s /bin/bash protonbridge
chmod 700 /var/lib/protonbridge
id protonconnector >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/protonconnector --shell /usr/sbin/nologin protonconnector
chmod 700 /var/lib/protonconnector
cat > /etc/ssh/sshd_config.d/00-protonmail-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
MaxAuthTries 3
EOF
sshd -t
systemctl reload ssh
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH administration'
ufw --force enable
systemctl enable --now unattended-upgrades
install -d -m 755 /opt/protonmail-connector
node --version
ufw status
