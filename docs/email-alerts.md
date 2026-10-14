# Email alerts independent of Codex

Two operating-system schedules run every five minutes. The hosted server checks
HTTPS, OAuth metadata, unauthenticated rejection, authenticated status-only MCP,
grant revocation/rejection, and local MCP/Bridge authentication. Yantra runs the
external checks and verifies off-server backup freshness and matching version 2
restore evidence. Codex does not need to be open for either schedule.

The hosted timer works while Yantra sleeps. Yantra's LaunchAgent requires an awake,
online Mac and a logged-in user. Healthchecks.io independently watches for missing
hosted check-ins, covering a complete server outage while Yantra is unavailable.
Its free account sends its own outage and recovery emails to `max@pfennig.haus`.
The period is five minutes with five minutes of grace: expect an alert about ten
minutes after the last successful hosted check-in, plus email delivery time.

Both send directly through Proton SMTP submission with a dedicated custom-domain
token, not through the Bridge or connector being monitored. Sender and recipient
are fixed to `max@pfennig.haus`. The token can send as that address but cannot read
mail. Store the token only in mode-0600 private configuration outside Git. The
configuration keys are `mode` (`server` or `yantra`), `from`, `to`, `smtpToken`,
`stateDirectory`, and (Yantra only) `backupDirectory`.

The server configuration additionally contains a private `watchdogUrl` on
`hc-ping.com`. Only a healthy hosted run without pending/failed email delivery
posts an empty body to that URL. No mail, Proton credentials or diagnostic payload
is transmitted. The provider sees the server IP, check name and ping times. A
failed ping is recorded without printing its URL. Yantra must never ping this
check: doing so would hide a server outage. Protect the URL like a credential
because anyone holding it could falsely signal health.

The October 13 external test sent one real hosted check-in, then allowed a short
one-minute period plus one-minute grace to expire without stopping production.
Healthchecks.io changed the check to Down and its email was verified in Inbox.
The hosted service then resumed check-ins; the provider's recovery email was also
verified. The production five-plus-five-minute schedule was restored, the check
was named `Proton connector — hosted server watchdog`, and normal check-ins were
enabled in the hosted systemd job. A later separate-host recovery drill verified
the restored monitor and watchdog before rolling back to the original host.

Each failing check is retried once after ten seconds. Only a check failing both
attempts alerts. Unchanged failures stay quiet; changed failures and recovery send
one email per monitor. Emails identify the originating monitor. Persistent SMTP
rejections retry on a later run; interrupted or ambiguous delivery is retained as
`pending` and must be reconciled with Sent/Inbox before a resend. State, logs and
delivery receipts are private. No mail content is read by ordinary monitoring.

If a safely rejected alert becomes obsolete after health recovers, the monitor
verifies SMTP authentication before clearing that failure and resuming watchdog
check-ins. Failed authentication preserves the failure. An uncertain pending
transaction is never cleared or resent by this reconciliation. Regression tests
cover both cases; all 47 tests and type checking passed after the recovery-drill fix.

Yantra: `haus.proton.email-monitor` LaunchAgent, configuration
`~/.local/share/proton-connector/email-alerts.json`, state/logs beside it.
Server: `proton-email-monitor.timer`, configuration
`/var/lib/protonconnector/email-alerts.json`, state under
`/var/lib/protonconnector/email-monitor/`. The independent monitor code is under
`/opt/proton-connector-monitor/current`; its root-owned dependency/dist links use
the existing connector release. Installing this monitor does not restart Bridge
or redeploy the connector application.

Run `node scripts/email-monitor.mjs /private/config.json --test-alert` through a
one-shot OS job to test the actual scheduled process and SMTP path. It makes two
requests to a deliberately unavailable loopback endpoint and sends a clearly
labelled test. It never stops production. `email-test.json` prevents rerunning an
already accepted test. Verify the exact Message-ID and sender/recipient in Inbox
without marking the message read; SMTP acceptance alone is not inbox delivery.

Disable using `systemctl disable --now proton-email-monitor.timer` on the host
and `launchctl bootout gui/$UID/haus.proton.email-monitor` on Yantra. Revoke the
dedicated token in Proton SMTP settings only after disabling both jobs. Keep the
existing hourly Codex health and weekly backup schedules; they provide separate
follow-up and must not be mistaken for the email scheduler.
For planned downtime, pause the corresponding Healthchecks.io check explicitly;
stopping local jobs alone intentionally causes a missed-check-in alert.

An archived Bridge refresh token was rejected during the October 13 recovery
drill. Fresh owner sign-in subsequently passed on a replacement host, as did public
failover and rollback. A future restore may still require fresh authentication;
this is a recovery prerequisite, not a current health failure.
