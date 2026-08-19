# Frequently asked questions

### Does this handle my Ghost newsletter?

No, and it never will. Ghost's newsletter / bulk sending is built around Mailgun and nothing
else — that is a Ghost design decision, not a Missivus limitation. Missivus carries Ghost's
**transactional** email only: member magic links and sign-in emails, staff invites, password
resets, and notification emails.

### Does the shared mailbox need a licence?

No. Shared mailboxes in Microsoft 365 are free up to 50 GB, and Missivus only sends from it. That
is much of the point of this design.

### Why not just configure SMTP?

Microsoft is retiring basic-authentication SMTP AUTH for Microsoft 365 — it is disabled by default
for existing tenants from the end of December 2026, unavailable to new tenants from 2027, and the
final removal date will be announced in 2027 — and Ghost's SMTP settings have no way to obtain
OAuth tokens. The workarounds are an SMTP relay daemon between Ghost and Microsoft —
one more service, usually delegated-auth — or tenant-level exceptions Microsoft is actively
closing. Missivus talks to the Graph API with application permissions instead. (Yes, Ghost still
*speaks* SMTP to the local shim — across localhost or a Docker network, not across the internet,
and with no Microsoft credentials in it.)

### Why does Missivus for Ghost run as a separate process?

Because Ghost offers no seam for a custom mail transport: `mail.transport` is resolved through a
closed list (`SMTP`, `sendmail`, `direct`, `ses`, `mailgun`, `stub`) that throws on anything else,
and Ghost's adapter system has no mail type. [PLAN.md](../PLAN.md) §3 records the evidence. The
shim rides Ghost's own supported SMTP configuration, which is why a Ghost upgrade cannot break
the wiring.

### Client secret or certificate?

Start with the secret: two clicks, and the guide assumes it. A certificate is stronger — it never
travels in a request body — and Missivus supports it fully; move to it later if you want, without
reinstalling anything.

### How do I rotate the secret?

Create a new secret in Entra (Part 3 of the install guide), update `clientSecret` in the config,
restart the shim, send yourself a password-reset email, then delete the old secret in Entra. Mail
keeps flowing throughout.

### Is the application access policy really necessary?

Yes. Without it, `Mail.Send` lets the app send as **anyone in your tenant**. The policy narrows it
to the one shared mailbox. Treat it as part of the installation, not hardening you might do later.

### Emails arrive "from" the shared mailbox even though Ghost asked for another sender. Why?

Application-only sending can only send as the mailbox the policy allows. Missivus forces the From,
keeps the requested address as Reply-To, and logs a warning naming both. Point Ghost's `mail.from`
at the shared mailbox and the warning goes quiet.

### What happens when Microsoft rejects a send?

Nothing is swallowed, ever. The shim logs the redacted Microsoft error at error level and answers
Ghost with `554 5.0.0 Missivus: <the same error>`, which Ghost wraps into its own log as
`Failed to send email. Reason: …` and shows in the admin UI where it has one. If you explicitly
configure the SMTP fallback (off by default), the message is relayed there — and the Graph
failure is still logged first.

### Can I use the transport outside Ghost?

Yes — that is the point of the split. `@missivus/graph-transport` is a dependency-free JS/TS
library that runs on Node ≥ 20 and Cloudflare Workers, with a Nodemailer adapter
(`@missivus/graph-transport/nodemailer`) for any Node app that already uses Nodemailer.

### What happens to attachments over 3 MB?

Ghost's transactional email never attaches files, so the shim path caps at Graph's ~3 MB request
ceiling and refuses larger messages loudly. The transport library itself handles big attachments
properly — draft, chunked upload session, send — which needs the `Mail.ReadWrite` application
permission; that path is for other users of `@missivus/graph-transport`.

### What do the Microsoft error codes mean?

The table at the end of [INSTALL.md](INSTALL.md) maps the common ones (`AADSTS7000215`,
`AADSTS90002`, `AADSTS700038`, `ErrorAccessDenied`, `MailboxNotEnabledForRESTAPI`, …) to their
fixes.

### Does it work with Ghost in Docker?

Yes — that is the best-supported shape: the shim runs as a sidecar container on the same Docker
network, configured by the same `mail__options__*` env vars Ghost already uses. See Part 6 of
[INSTALL.md](INSTALL.md). Outbound HTTPS to `login.microsoftonline.com` and
`graph.microsoft.com` must be allowed.

### Where do I report a bug? A vulnerability?

Bugs: <https://github.com/Solvetus/missivus-ghost/issues>. Vulnerabilities:
`security@missivus.com`, not a public issue. Never paste a secret or a PEM into either.
