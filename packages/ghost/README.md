# @missivus/ghost

**Missivus for Ghost — send Ghost transactional email through Microsoft Graph with application
permissions and a shared mailbox. No SMTP, no user login. Free, GPLv3.**

> **Scope:** Ghost's *newsletter / bulk* sending is Mailgun-only by design and is **not**
> covered. This handles Ghost's **transactional** mail only — member magic links, staff invites,
> password resets, notifications.

Ghost 6 resolves `mail.transport` through a closed list with no custom-transport hook
([PLAN.md](https://github.com/Solvetus/missivus-ghost/blob/main/PLAN.md) §3 has the evidence), so
Missivus for Ghost runs as a tiny local **SMTP-to-Graph shim**: Ghost keeps its own supported
SMTP configuration and points it at `missivus-ghost`, which hands each message to
[`@missivus/graph-transport`](https://www.npmjs.com/package/@missivus/graph-transport). Nothing
in Ghost is patched; upgrades cannot break the wiring.

```bash
npm install -g @missivus/ghost
missivus-ghost --ghost-config /var/www/ghost/config.production.json
```

Ghost's `config.production.json` carries everything — one source of truth for Ghost and the shim
(and therefore Ghost's Docker `mail__options__*` env vars work too):

```json
"mail": {
  "from": "Example Ltd <noreply@example.com>",
  "transport": "SMTP",
  "options": {
    "host": "127.0.0.1",
    "port": 2525,
    "tenantId": "…", "clientId": "…", "clientSecret": "…",
    "sender": "noreply@example.com"
  }
}
```

- **Nothing fails silently.** A Graph failure is logged by the shim at error level and answered
  to Ghost as `554 Missivus: <redacted Microsoft error>` — so the AADSTS/Graph error text lands
  in Ghost's own log too. Optional fallback to an SMTP server you configure, **off by default**.
- **Forced From** to the shared mailbox; a differing Ghost `mail.from` is kept as Reply-To with
  a warning. Set `mail.from` to the shared mailbox and the warning stays quiet.
- **Secrets never logged** — the transport's redaction pass runs over everything, and Ghost's
  SMTP AUTH credentials are accepted unseen: never parsed, never stored.
- Binds `127.0.0.1:2525` by default; in Docker, run it as a sidecar on the compose network
  (`MISSIVUS_LISTEN_HOST=0.0.0.0`, never published with `-p`).

The full walkthrough — Entra app registration, `Mail.Send` application permission, shared
mailbox, the Exchange application access policy, systemd unit and docker-compose examples — is in
[docs/INSTALL.md](https://github.com/Solvetus/missivus-ghost/blob/main/docs/INSTALL.md).

When configured, this software connects to `login.microsoftonline.com` and
`graph.microsoft.com`. No other external service is contacted.

Part of [Solvetus/missivus-ghost](https://github.com/Solvetus/missivus-ghost). Security review:
[docs/SECURITY.md](https://github.com/Solvetus/missivus-ghost/blob/main/docs/SECURITY.md);
vulnerabilities to `security@missivus.com`.

> Missivus is free and open source (GPLv3). If you would rather not do the Entra and Exchange
> setup yourself, [Solvetus](https://solvetus.com) offers paid installation and support.
