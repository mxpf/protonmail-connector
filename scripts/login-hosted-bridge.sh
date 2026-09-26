#!/usr/bin/env bash
set -euo pipefail
exec ssh -t -i "$HOME/.ssh/protonmail_hetzner_ed25519" \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  hausadmin@135.181.111.93 sudo /usr/local/sbin/proton-bridge-login
