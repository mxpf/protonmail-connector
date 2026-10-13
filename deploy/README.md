# Deployment architecture

This repository captures a working, owner-specific deployment of Proton Mail
Connector. It is not a one-command installer for arbitrary accounts: review and
adapt the hostname, owner identity, OAuth app, mailbox address, SSH destination,
and filesystem paths before using the deployment helpers on another server.

## Components

- Official Proton Mail Bridge runs as a dedicated Unix user with a local Pass/GPG
  credential store and its required mailbox cache.
- IMAP and SMTP listen on loopback only, with STARTTLS and certificate verification.
- The connector runs as a separate unprivileged systemd service. Node 24+ is required.
- Caddy terminates HTTPS and proxies to the connector on loopback port 3100.
- GitHub verifies the configured owner's numeric account ID, with no email or
  repository scopes. The connector issues its own OAuth grants to the assistant.

The service units and Caddyfile are included here as deployment references.
Bootstrap scripts change system packages, users, SSH configuration, and firewall
rules. Read them before running them on a host.

## Private configuration

Provision these on the server, outside the checkout, with owner-only permissions:

- `PROTON_CONFIG`: Bridge username/password, sender, ports, trusted certificate
  path, TLS server name, and send-ledger path; schema in `src/config.ts`.
- `PROTON_OAUTH_CONFIG`: issuer URL, GitHub client ID/secret, and owner ID/login;
  schema in `src/oauth.ts`.
- `PROTON_OAUTH_DB`: private SQLite file for short-lived login/consent state and
  OAuth grants. The send ledger is a separate private SQLite database.

Authenticate to the official Bridge CLI interactively. The `proton-bridge-login`
helper stops the background daemon under a lock and restores it afterward.
`configure-connector.py` captures Bridge credentials privately on that host and
pins the Bridge certificate for runtime verification. The OAuth setup helper
accepts the GitHub client secret through a hidden terminal prompt.

Do not commit runtime configuration, credentials, certificates, mailbox exports,
SQLite files, or SSH private keys. Detailed owner operations notes remain local
and are excluded from Git.

## Release and verification

Run `npm ci`, `npm run check`, `npm test`, and `npm run build`. Install code and
production dependencies in a root-owned release directory. Keep private state
outside releases. Set the public logo file to mode 0644 when copying from macOS.
Switch the `current` symlink and restart only the connector service; retain the
previous release for rollback.

Verify HTTPS, public OAuth metadata, rejection of unauthenticated MCP calls,
owner sign-in, consent, and authenticated tool discovery. Test phone access through
ordinary ChatGPT separately from an SSH or local Work task. A healthy Bridge
connection does not by itself establish that the mobile OAuth flow works.

The latest recorded release is `20261013-08`, built from source commit `f02fe61`.
All 17 tests, type checking, and build passed. Hosted discovery found eleven tools,
including read-only source recovery, and authenticated to Bridge. Five previously
affected messages now return readable text through the public connector. Live
checks also verified message identity and flags; the three primary regressions
preserved attachment metadata and bytes, including a message with 19 inline images.
Raw MIME pagination and decoded HTML recovery were verified on the hosted service.
Only counts and verification results were recorded; no private correspondence is
included in the repository or regression fixtures.

The previous release `20261008-07` remains available for rollback. Existing OAuth
grants and rich-text composition are unchanged. Clients caching tool discovery may
need a refresh to see `proton_read_source`; existing `proton_read` calls receive
the body fix immediately. Phone UI completion remains unverified in this project's
recorded checks. No messages were sent or mailbox flags changed during deployment.

## Privacy and operational limits

The host can decrypt mail through Bridge. Root access or a compromised host can
therefore expose mail and Bridge sessions; an unattended Pass/GPG store does not
eliminate that threat. Mail content returned by tools is shared with the assistant
service handling the request. GitHub is used only for identity verification.

Off-host backups, restore testing, and external monitoring are not implemented
in this deployment. No test email has been sent in the recorded setup checks.
