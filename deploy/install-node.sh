#!/usr/bin/env bash
set -euo pipefail
node_version=v24.21.0
node_archive="node-${node_version}-linux-x64.tar.xz"
install -d -m 700 /root/node-installer
cd /root/node-installer
curl --fail --silent --show-error --location --proto '=https' -O "https://nodejs.org/dist/${node_version}/${node_archive}"
curl --fail --silent --show-error --location --proto '=https' -O "https://nodejs.org/dist/${node_version}/SHASUMS256.txt"
awk -v archive="$node_archive" '$2 == archive' SHASUMS256.txt > selected-sha256.txt
test -s selected-sha256.txt
sha256sum --check selected-sha256.txt
tar -xJf "$node_archive" -C /opt
ln -sfn "/opt/node-${node_version}-linux-x64" /opt/node-lts
for executable in node npm npx; do ln -sfn "/opt/node-lts/bin/$executable" "/usr/local/bin/$executable"; done
/usr/local/bin/node --version
