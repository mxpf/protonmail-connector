# Disaster recovery

The encrypted state archive restores the connector configuration, OAuth and send
databases, five Calendar feeds, Bridge cache and credential store, service units,
Caddy site configuration, and the selected source revision. Provision the operating
system and install Node, the official signed Bridge package, Caddy, and that source
revision separately. Keep the decryption identity outside the hosted server.

## Cold restore

1. Match the archive's size and SHA-256 to its original verified download receipt
   and passing version 2 restore receipt. Authenticate the complete age decryption.
2. Extract into a private staging directory on a separate host. Run
   `scripts/validate-restored.mjs` there before installing any restored state.
3. Recreate the dedicated Bridge and connector users. Restore each private home
   with the correct ownership and permissions for the replacement machine.
4. Build the recorded source revision and run its type checks and tests. Install
   the restored service definitions, but leave them disabled and guarded against
   accidental startup. Keep IMAP, SMTP, and the application backend on loopback.
5. Decrypt the restored password store and test application startup. Do not start
   the archived Bridge session while the original production instance is running.

## Proton authentication

An authenticated archive does not guarantee that Proton will still accept its
saved refresh token. The October 13 archived token was rejected with Proton code
10013. Recovery must support a fresh owner sign-in through the official Bridge
CLI, including any additional authentication prompt.

Use a bounded window with the original Bridge stopped, an automatic restart on
the original host, and a shorter hard timeout for the recovery login process.
Passwords and authentication codes must remain in hidden prompts or private
process pipes, never command arguments, logs, receipts, or chat. After sign-in,
regenerate the local connector configuration and pin the recovered Bridge's public
certificate with `deploy/configure-connector.py`. Verify IMAP and SMTP login without
reading mail or sending a message. Stop the recovery instance before bringing the
original Bridge back online.

## Replacement-host cutover

Prepare rollback before changing routing. Record both server identities, original
address assignments, SSH host fingerprints, service state, and the exact restore
source in a private receipt. A direct request with a hostname override is useful
preflight, but is not proof of public failover.

For a same-location Hetzner replacement, the existing Primary IPv4 can be reassigned
while both servers are powered off. Preserve the original host and IP; do not let
temporary-resource cleanup delete the production address. Configure the new host's
network for the reassigned address and pin its previously recorded SSH key.
Keep both hosts' keys in a private rollback record. OpenSSH UpdateHostKeys can
remove the inactive host's keys for the shared address; restore the appropriate
verified key at each cutover rather than disabling host-key checks. The drill
used first-use SSH trust, not independent console attestation.
Keep certificate validation enabled. Caddy's certificate storage is not present
in the original state archive, so issuance or a separately protected certificate
recovery is a required step.

With the original host off, verify public DNS/routing, trusted HTTPS, OAuth
metadata, unauthenticated rejection, authenticated MCP initialization and status,
all seventeen application tools, and all five configured calendars. Revoke the
restricted health grant and verify subsequent HTTPS rejection. Record which
machine served the requests. Restoring an older OAuth database can require clients
whose grants were issued after the snapshot to sign in again.

The later independent email monitor and external-watchdog configuration must also
be recovered from their private off-server records and documented service files;
the earlier October 13 archives predate their installation. Only the active hosted
monitor may send watchdog check-ins. A stopped or failed replacement must not be
masked by check-ins from the original host or Yantra.

Restore original routing and service operation after a temporary drill, verify all
seven hosted health checks and the scheduled watchdog check-in, then remove the
temporary server, its temporary IPs, and plaintext staging copies. Preserve only
private evidence and the encrypted archives. A successful cold restore alone must
never be recorded as completed live failover.

## Verified October 13, 2026 (UTC October 14)

A separate Ubuntu replacement restored the checksum-matched encrypted archive,
passed authenticated decryption and version 2 validation of configuration, required
schemas, certificate/key material and all three SQLite databases. The recovered
release passed its 37 tests. Fresh owner sign-in with additional authentication
resolved the rejected archived Bridge session; IMAP and SMTP authentication passed.

The original server was powered off and its Primary IPv4 reassigned to the new
machine. The unchanged public hostname served the replacement with a newly issued
trusted certificate and a temporary identifying response header. All seven public
health checks passed, including authenticated HTTPS status and revoked-grant
rejection. Full tool discovery returned 17 actions and the read-only calendar list
returned five calendars. The replacement's systemd monitor passed and its external
watchdog check-in was accepted. No mail tool read, send or flag change was used.

Rollback restored the original machine and public address; all seven checks and
its watchdog passed again. The temporary server, both temporary IPs and its restored
plaintext state were deleted. The production IPv4 is retained independently of
server deletion. The full private receipt is
`~/.local/share/proton-connector/replacement-host-recovery-20261013.json`.

This verifies a manual, same-region replacement-host recovery and rollback, not
automatic failover or a regional/provider outage. Fresh Proton authentication may
require the owner's additional code; clients created after an archive may need to
sign in again. The existing state archives predate monitoring, so that configuration
was restored from separately protected off-server records and monitor source.

## Free recovery improvements

`proton-self-heal.timer` probes every two minutes on the existing host. It confirms
a local HTTP or Bridge failure twice before restarting the affected services,
allows at most two repair attempts per hour, and records the budget before action.
It leaves intentionally stopped services alone, respects backup/login locks and
`/run/proton-connector-maintenance`, and never changes credentials, provisions
resources, restores old data, sends mail or pings the external watchdog. Existing
independent monitoring continues to report unresolved failures. Stop this timer
and set the maintenance marker before planned service changes.

For manual disaster recovery, run `scripts/prepare-recovery.py` with the encrypted
archive, off-server key and a NEW private staging directory. It binds the bytes
to the original verified download and passing v2 restore receipts, decrypts with
authentication, safely extracts, validates all required state again and writes a
receipt. It refuses existing destinations and removes incomplete staging after
failure. It does not start the archived Bridge session or overwrite the live host.
Remove the plaintext staging directory after use. Continue the cold-restore and
cutover steps above; a replacement host and owner authentication may still be needed.

New backups include the hosted kDrive configuration and journals, monitoring and
self-heal service definitions, repair state, and the kDrive source revision when
installed. Older archives still need those later components recovered separately.
Reinstall both code revisions and dependencies before starting recovered services.
The current hosted monitor can use the connector release directly, so it does not
need a separate monitor code tree.
