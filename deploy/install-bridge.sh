#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
bridge_version=3.22.0-1
install -d -m 700 /root/proton-bridge-installer
cd /root/proton-bridge-installer
curl --fail --location --proto '=https' --tlsv1.2 -o bridge.deb "https://proton.me/download/bridge/protonmail-bridge_${bridge_version}_amd64.deb"
curl --fail --location --proto '=https' --tlsv1.2 -o bridge_pubkey.gpg https://proton.me/download/bridge/bridge_pubkey.gpg
curl --fail --location --proto '=https' --tlsv1.2 -o bridge.pol https://proton.me/download/bridge/bridge.pol
install -d /usr/share/debsig/keyrings/E2C75D68E6234B07 /etc/debsig/policies/E2C75D68E6234B07
gpg --batch --yes --dearmor --output /usr/share/debsig/keyrings/E2C75D68E6234B07/debsig.gpg bridge_pubkey.gpg
install -m 644 bridge.pol /etc/debsig/policies/E2C75D68E6234B07/bridge.pol
debsig-verify bridge.deb
apt-get install -y ./bridge.deb
sudo -H -u protonbridge protonmail-bridge --cli --help
