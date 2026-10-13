<img src="assets/proton-mail-connector-logo.png" alt="Proton Mail Connector logo" width="160" height="160">

# Proton Mail Connector

A self-hosted MCP connector that gives an AI assistant access to the owner's
actual Proton Mail account through the official Proton Mail Bridge.

Built as part of an independent systems practice: keep mail in Proton, run the
connection on infrastructure you control, and make assistant actions explicit.
The hosted design is intended to work without leaving a personal computer on.
This is an independent project, not an official Proton product.

## What it does

Eleven tools support folder listing, bounded message search, reading messages and
attachments, creating drafts, preparing and sending plain-text or sanitized
rich-text email, moving messages, setting read/star flags, and checking the
connection. Rich-text messages are sent as multipart email with a required
plain-text fallback. The connector permits basic paragraphs, emphasis, lists,
quotes, and safe links; it removes scripts, images, tracking content, custom
styles, and unsafe URLs.

Message reads recover HTML-only bodies when the MIME parser supplies no readable
text, including nested Outlook-style messages with inline attachments. Reads
return `body.source` (`parsed_text`, `html`, or `none`), `body.status`,
`body.incomplete`, and reasons alongside the existing `text` and `truncated` fields.
Empty extraction is reported as incomplete, not proof that an email has no body.
Quoted replies are retained; images are not OCRed.

For incomplete results, `proton_read_source` retrieves raw MIME or decoded HTML in
base64 pages of at most 64 KiB, using the exact mailbox/UID/UIDVALIDITY reference.
Follow `nextOffset` with the returned `sourceSha256` for subsequent pages; join
decoded bytes before interpreting UTF-8 HTML. Recovery HTML is unsanitized data:
never render it, execute it, or load remote resources. Neither reading nor recovery
changes message flags. Retrieval is capped at 12 MiB, HTML fallback at 2 Mi
characters with 128 levels and 20,000 tags, and returned text at 64,000 characters.

Sending uses an exact preview and a short-lived, single-use token. The assistant
is instructed to send only on explicit user authorization. A durable ledger
prevents reuse and does not automatically retry an uncertain delivery.

## How it works

![AI assistant connects over HTTPS and OAuth to the hosted MCP connector, which uses loopback IMAP and SMTP with TLS to reach Proton Mail Bridge and Proton Mail. GitHub verifies the owner’s identity.](assets/how-it-works.png)

The connector runs on a Linux server behind Caddy. Bridge and the connector use
separate Unix accounts. Mail ports stay on loopback; the public endpoint requires
OAuth. GitHub checks the owner's identity without requesting email or repository
scopes. Both authorization hops use S256 PKCE, and refresh tokens rotate.

The server can decrypt mail through Bridge, and content retrieved by the assistant
is shared with that assistant service. This is not a claim of end-to-end encryption
through the AI provider.

## Status and limits

- Hosted deployment is running; live checks verified folder listing, inbox search,
  and creating, reading, and moving a private test draft to Trash.
- ChatGPT account linking was verified on desktop. Source now exposes 17 tools.
- A mobile approval-session fix was deployed on September 22, 2026. A successful
  ordinary mobile chat test is not yet recorded in this project.
- Twenty-nine automated tests cover MIME body recovery, paginated source recovery,
  message bounds, mutation safety, send replay,
  owner verification, consent/cookie binding, PKCE, token rotation/revocation,
  and MCP protocol discovery. A live self-send from max@pfennig.haus was accepted and located in both Sent and Inbox on October 13, 2026.

Forwarding with attachments, recoverable draft replacement, header-based conversation
lookup, and read-only Proton Calendar feeds are implemented. Direct kDrive
attachment transfers use the configured local executor. Calendar edits and invitations
are not supported. See [maintenance workflows and limits](docs/maintenance.md).

This is owner-specific software, not a general multi-user service or turnkey installer.

## Development

Requires Node 24 or newer.

```sh
npm ci
npm run check
npm test
npm run build
```

`src/server.ts` provides the stdio MCP entry point; `src/http.ts` provides the hosted
HTTP/OAuth endpoint. Both use the same mail service and tool definitions.

See [deployment documentation](deploy/README.md) for configuration and operational
boundaries. The `scripts/` helpers target the owner's existing deployment; adapt
them before use elsewhere. Credentials and runtime databases belong outside Git.

The `.codex-plugin/` manifest and `.app.json` describe the owner's registered
ChatGPT connector. Publishing this source does not grant access to that mailbox
or install the connector for another account.

The project logo is in [assets](assets/proton-mail-connector-logo.png).
