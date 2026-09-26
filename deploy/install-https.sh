#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
install -d -m 700 /root/caddy-installer
curl --fail --silent --show-error --location --proto '=https' https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /root/caddy-installer/gpg.key
gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /root/caddy-installer/gpg.key
curl --fail --silent --show-error --location --proto '=https' https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y --no-install-recommends caddy
install -m 644 /home/hausadmin/proton-Caddyfile /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
ufw allow 80/tcp comment 'HTTPS certificate validation and redirect'
ufw allow 443/tcp comment 'Authenticated web services'
caddy version
