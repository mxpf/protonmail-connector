# Maintenance and feature completion

## Mail workflows

- `proton_prepare_forward` includes the complete decoded source text and optional
  attachments. It returns a preview and single-use send token. It never sends by
  itself. The attachment preview includes byte counts and SHA-256 digests.
- Compositions accept exact message/attachment references, with an 8 MiB combined
  attachment limit and a 12 MiB composed-message limit. No local paths or URLs are
  accepted as attachment sources.
- `proton_replace_draft` needs the `sourceSha256` from a fresh read. It appends the
  new draft before moving the old draft to Trash, leaving a recoverable copy. An
  uncertain move returns the replacement identity: inspect it, never blindly retry.
- `proton_thread` finds header-linked messages in the explicitly supplied folders.
  It does not guess by subject or claim complete account-wide conversation coverage.
  Hosted verification grouped six existing messages in Sent and Inbox. Proton did
  not retain the supplied reply headers on a synthetic draft; draft grouping is
  therefore not guaranteed. Replies now preserve a bounded References ancestry,
and draft creation/replacement reads headers back and reports whether Proton
retained them. A failed readback never retries draft creation. Use Reply in Proton
Mail when native conversation placement matters. This does not affect grouping
existing retained headers.

## Calendar

Calendar support reuses the owner's September 24, 2026 Calendar implementation:
the bounded ICS fetcher, isolated recurrence parser, timezone handling and tests.
The mail connector exposes list, event search and provisional availability tools.
It does not edit Proton Calendar or send invitations. Shared feeds can lag changes.
For immediate changes or event creation/editing, use the signed-in Proton Calendar
website at https://calendar.proton.me. Tool responses include this fallback and
clarify that fetchedAt is a download time, not a guarantee of up-to-date contents.
Unsupported recurrence/timezone data fails closed rather than reporting free time.
Detached recurrence instances retain their explicit occurrence times; a missing
series is never invented. Attendee metadata is not returned. A malformed attendee
field in the shared export is ignored without relaxing parsing of event times.

Set `PROTON_CALENDAR_CONFIG` to a mode-0600 JSON file outside Git:

```json
{
  "calendars": [
    {"id":"personal","name":"Personal","url":"<private Proton ICS sharing link>","timezone":"America/New_York","visibility":"full"}
  ],
  "cacheSeconds": 60
}
```

Only HTTPS feeds on calendar.proton.me with the documented ICS path are accepted;
redirects are rejected. Links are credentials and never returned by tools. Configure
`busy` visibility for connector-side text redaction. Enabling a calendar makes its
configured data available to authenticated owner clients of this connector.

## Direct kDrive attachment transfers

`node scripts/attachment-to-kdrive.mjs /absolute/private-request.json` reads one
exact attachment over the authenticated SSH MCP transport and uploads its bytes
through the existing local kDrive transfer CLI. The request file must be mode 0600:

```json
{"message":{"mailbox":"Drafts","uidValidity":"123","uid":1},"index":0,"destination":"/Private/00 Inbox/selected-file.pdf"}
```

The destination is explicitly supplied, not derived from an email filename. The
local snapshot is private and removed after use; bytes and credentials never enter
the model context. kDrive independently downloads and checks the uploaded digest.
An existing destination is not overwritten. An ambiguous upload must be inspected
through its saved kDrive receipt before retrying. The legacy script requires Yantra. The hosted `proton_save_attachment_to_kdrive`
action now performs the transfer on the existing server without Yantra. It accepts
an exact message, attachment index, destination under `/Private/`, and a UUID
operationId. Reuse that ID for retries. Durable reservations prevent repeated or
uncertain uploads; existing destinations are never overwritten. The server keeps
private receipts and verifies the downloaded bytes against the source digest.
Configure `PROTON_KDRIVE_CONFIG` with a private JSON file containing repository,
stateDirectory, driveId and accessToken. No credentials or attachment bytes are
returned through the hosted save action.

## Encrypted off-server backups and restore checks

Install age on the server and local executor. Generate the private recovery
identity on the local executor, outside Git/cloud sync; install only its public
recipient at `/etc/proton-connector-backup.age.pub`. Install
`deploy/backup-hosted.sh` root-owned, mode 0700, at
`/usr/local/sbin/proton-connector-backup`.

`node scripts/backup-hosted.mjs` briefly stops Bridge and the connector to snapshot
their complete state, credentials, grant/send databases, Bridge credential store,
service definitions, Caddy configuration and release revision. Both services resume
before compression/encryption. A lock prevents overlapping backups. Only encrypted
bytes are downloaded, and size/SHA-256 must match the server before finalization.
Do not send the private recovery identity with the backups.

With Python >=3.12, run:

```sh
python3 scripts/restore-check.py /path/snapshot.tar.gz.age /path/backup-identity.txt
```

The check authenticates/decrypts, safely extracts to a private temporary directory,
validates the service-referenced mail/OAuth/Calendar configurations, the pinned
certificate, exact OAuth/send-ledger database schemas, required service files and
nonempty private-key/password-store material. It checks every SQLite database and
then removes the restored plaintext. Build the connector first (`npm run build`):
the validator uses the same configuration schemas as the application. A successful
mode-0600 `.restore.json` receipt has `validationVersion: 2`, the archive byte count
and SHA-256, and the check time. Require that identity to match the checksum-verified
download receipt; an old receipt is not evidence for changed archive bytes.
This is an isolated data restore, not a live failover test. A replacement
host still needs Node, Bridge, system accounts and the selected application release.
Never start a restored production Bridge/grant database alongside the live service.

`scripts/archive-to-kdrive.mjs` can make an additional private cloud copy in
independently verified parts. A failed or uncertain part must be reconciled before
retrying. Before any cloud write, the uploader checks the complete archive against
its original checksum-verified `.age.json` download receipt and every saved part.
Truncated, extended, changed or inconsistent archives fail without rewriting the
manifest. A local lock prevents concurrent transfers. Recheck an existing archive
and manifest without uploading with `--verify-only`; this verifies local evidence,
not a new download from the cloud. Keep the `.cloud.json` manifest with its archive: restore by downloading
parts in numeric order, concatenating them, checking the manifest's whole-file
SHA-256 and byte count, then running the isolated restore check above. A partially
uploaded set is not a completed cloud backup.

## Monitoring

`node scripts/health-hosted.mjs` runs outside the hosted server. It checks verified
HTTPS, OAuth metadata, rejection of unauthenticated MCP, and authenticated HTTPS
MCP initialization, discovery and Bridge IMAP/SMTP status. An SSH-only helper issues
a 120-second OAuth grant limited to `proton_status`, with no refresh token. The
probe uses the deployed bearer verifier and HTTP transport, revokes the grant in
cleanup and confirms that HTTPS rejects it afterward. Its token stays in private
process pipes. Public OAuth registration cannot request this maintenance scope.
The existing SSH discovery check remains a supplementary diagnostic. It reads no
mail and exits nonzero on any failure. This does not test a user's browser sign-in,
consent session, cached tool discovery or phone app.
The Codex heartbeat owns the cadence, quiet-state behavior, backup freshness checks
and notifications; it depends on Yantra and Codex being available.
The configured schedule checks health hourly and takes a full encrypted backup
with an isolated restore check on Sundays at 04:00 in the owner's local timezone.
Normal successful runs stay quiet. Failures, recovery and overdue backups notify
the owner. Keep at least four completed, restore-tested local snapshots.

## Dependency advisory

SDK 1.31.0 includes the fix for
[GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h).
The advisory concerns HTTP OAuth clients; this application's SDK server and SSH
stdio diagnostic clients are explicitly outside its affected usage. The package
is upgraded anyway. Existing owner grants do not need to be revoked for this fix.
