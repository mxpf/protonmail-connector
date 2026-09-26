#!/usr/bin/env bash
set -euo pipefail
# Run as protonbridge, with HOME=/var/lib/protonbridge.
test "$(id -un)" = protonbridge
cd "$HOME"
umask 077
mkdir -p "$HOME/.gnupg"
chmod 700 "$HOME/.gnupg"
if ! gpg --batch --list-secret-keys --with-colons | grep -q '^sec:'; then
  gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key 'Proton Bridge local credential store' rsa3072 encr 0
fi
store_key=$(gpg --batch --list-secret-keys --with-colons | awk -F: '$1 == "fpr" {print $10; exit}')
test -n "$store_key"
if [ ! -f "$HOME/.password-store/.gpg-id" ]; then
  pass init "$store_key"
fi
