# MITRA maintenance

The hosted connector, Bridge, email monitor, and self-heal timer operate independently
of the workstation. MITRA owns the weekly encrypted download and offline restore
check. Missed workstation runs must be reported when the next run starts.

## Daily mail workflows

`proton_search_mailboxes` searches up to ten explicit folders. Each folder returns
its own bounded page and continuation. Keep the original filters when continuing,
and pass the returned UIDVALIDITY. Failed folders and further pages make coverage
incomplete. UID ordering applies within each folder.

`proton_read_thread` retrieves up to ten header-linked messages with body extraction
status. Missing headers, limits, read failures, and incomplete bodies remain visible.
`proton_draft_reply` takes an exact reply source and explicit recipients, creates
one draft, and returns a fresh readback and source hash. A readback failure retains
the created draft reference and requires inspection before another create request.

`proton_attachment_transfer_status` checks one operation UUID using the private
journal. It performs no upload. A verified result describes the checksum readback
at upload time. A missing journal cannot establish that a remote file is absent.

## Backups and recovery

Run `scripts/backup-maintenance.ps1` on MITRA. It downloads a fresh encrypted server
snapshot, checks its size and SHA-256, decrypts it in a private temporary directory,
and verifies the exact configuration and database schemas. The Python executable
must be version 3.12 or newer. The configured bundled runtime can be supplied with
`-Python` when automatic discovery is unavailable.
Use `-VerifyLatest` to recheck the latest downloaded artifact and its original
receipt without generating another server snapshot.

An active weekly job in this chat runs the backup and restore check on MITRA on
Sundays at 04:00 America/New_York. MITRA and the app must be available for it to run.
The hosted monitoring and recovery timers continue independently.

The working recovery identity is
`%LOCALAPPDATA%\ProtonConnector\private\backup-identity.txt`, with owner-only Windows
permissions. The hosted server receives only its public recipient.

An independent copy is stored in private kDrive at
`/Private/07 System/Proton Mail Connector recovery key 2026-11-19/backup-identity.txt`.
The cloud copy was read back on November 19, 2026, and its SHA-256 matched the
working identity exactly. This owner-approved recovery copy is deliberately kept
outside MITRA so the identity survives loss of the workstation.

To recover the identity on a replacement workstation, sign into the owner's kDrive,
open that exact folder, and download `backup-identity.txt` into an owner-only local
directory. On MITRA, restore it to the working path above. Apply and verify the
directory's owner-only Windows ACLs before placing the key there. Keep the key's
contents in private files and process pipes. Check its public recipient with
`age-keygen -y`, compare it with the server's backup recipient record, and run
`scripts/backup-maintenance.ps1 -VerifyLatest` against a matching downloaded archive
and checksum receipt. Retain the cloud recovery copy when rebuilding MITRA.

Existing backup recipients and archives are retained. The MITRA identity added on
November 19 cannot decrypt backups made before it was added. The original identity
for the older archives remains unrecovered.

Downloaded archives and their checksum and restore receipts live under the same
private directory in `backups`. Windows validation verifies owner-only ACLs across
the restored tree. Linux validation enforces Unix permissions. Decrypted temporary
files are removed after verification. A passing receipt verifies an offline data
restore. A replacement-host failover drill is a separate operation.

## Releases

The GitHub Release checks workflow runs clean installation, typechecking, Node and
Python tests, production dependency audit, deployment script syntax, and Git
integrity. A successful run uploads a build labeled with the exact source revision.
Use the existing atomic release process in `deploy/README.md`, retaining the previous
release. Archive release sources with Unix line endings.

After activation, run `node scripts/verify-release.mjs <full-Git-commit>`. It checks
the active revision, public OAuth discovery, unauthenticated rejection, restricted
authenticated HTTPS health and revocation, eighteen existing and four new tools,
a read-only synthetic Inbox search, and an unknown transfer journal lookup.
Check all services and both scheduled maintenance jobs after activation.

## Client acceptance

An ordinary ChatGPT chat on MITRA and the owner's actual phone both completed a
read-only Inbox search for the synthetic subject `MITRA-PROTON-SMOKE-7F41C92B`.
Both returned zero matches. The phone result was reported by the owner on November 19.
Mobile viewport emulation alone does not establish phone authentication.
