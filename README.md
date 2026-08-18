<p align="center">
  <a href="https://missivus.com"><img src=".github/mark.svg" alt="Missivus" width="40" height="41"></a>
</p>

# Missivus for Ghost

**Missivus for Ghost — send Ghost transactional email through Microsoft Graph with application
permissions and a shared mailbox. No SMTP, no user login. Free, GPLv3.**

> **Scope boundary, stated plainly:** Ghost's *newsletter / bulk* sending is Mailgun-only by
> design and is **not** covered. Missivus for Ghost handles **transactional** mail only — member
> magic links and sign-in emails, staff invites, password resets, notification and test emails.

Microsoft is retiring basic-authentication SMTP for Microsoft 365 — disabled by default for
existing tenants at the end of December 2026, unavailable by default for new tenants after that,
with the final removal date to be announced in the second half of 2027 — and Ghost's transactional
mail speaks SMTP or a Mailgun key, nothing else. The result, once your tenant's switch flips, is a
Ghost that quietly sends nothing: no magic links, no staff invites, no password resets.

Missivus gives Ghost a mail path that talks to the Microsoft Graph API instead, using
**application permissions and a shared mailbox**: OAuth2 client credentials, the `Mail.Send`
application permission, and an Exchange application access policy that locks the app to one
mailbox. No user signs in, nothing is clicked, and nothing breaks when someone leaves the company.

Two packages in this monorepo:

- **[`@missivus/graph-transport`](packages/graph-transport/)** — the reusable, dependency-free
  JS/TS Graph mail transport. Runs on Node ≥ 20 **and Cloudflare Workers** (WinterCG APIs only:
  `fetch`, WebCrypto). Client secret or certificate credentials, token cache with a safety
  margin, full send fidelity, large attachments via upload sessions, a strict redaction pass on
  everything it logs, and a Nodemailer adapter. This is the "Missivus for Workers & Node" the
  family site promises.
- **[`@missivus/ghost`](packages/ghost/)** — the Ghost integration: a tiny local SMTP-to-Graph
  shim (`missivus-ghost`). Ghost 6 resolves `mail.transport` through a closed list with no
  custom-transport hook ([PLAN.md](PLAN.md) §3 has the evidence), so the supported seam is
  Ghost's own SMTP config pointing at the shim. Nothing in Ghost is patched; upgrades cannot
  break the wiring.

## Application permissions, not a delegated login

| | Delegated mailers | Missivus |
| --- | --- | --- |
| Who sends | A person's account, connected by clicking "Sign in" | The application itself |
| Setup | A human logs in and stays logged in | Admin creates an app registration once |
| Someone leaves the company | Mail breaks | Nothing happens |
| Mailbox licence | Usually a licensed user | A free shared mailbox |
| Blast radius | Whatever that person can do | One mailbox, enforced by Exchange |
| Extra services | Sometimes an SMTP relay in between | One 300-line local shim, no third-party service |

## What it does

- Sends Ghost's **transactional** email through Graph: member magic links / sign-in, staff
  invites, password resets, notification emails — everything Ghost's own mailer sends
- Client secret or certificate credentials (PS256 client assertions, RS256 escape hatch); tokens
  cached in memory with a five-minute safety margin
- Forces From to the shared mailbox (application-only sending cannot do otherwise); a differing
  requested sender is kept as Reply-To and logged
- **Nothing fails silently.** A Graph failure is logged at error level by the shim *and* answered
  to Ghost as an SMTP 554 carrying the Microsoft error text, so it lands in Ghost's own log too.
  Optional fallback to an SMTP server you configure, **off by default**
- Configuration rides Ghost's own `config.*.json` `mail.options` — and therefore Ghost's Docker
  `mail__options__*` env vars; secrets are redacted from everything the shim writes anywhere

## What you need

- A self-hosted Ghost 6 (any install: Docker, ghost-cli, source) and somewhere to run one small
  Node ≥ 20 process next to it
- A Microsoft 365 tenant and an account that can create app registrations and grant admin consent
- Thirty minutes for the Entra and Exchange setup — [docs/INSTALL.md](docs/INSTALL.md) spells out
  every click for someone who has never opened Entra

## Getting started

1. Follow [docs/INSTALL.md](docs/INSTALL.md): app registration → `Mail.Send` application
   permission → credential → shared mailbox → application access policy → run the shim → point
   Ghost's `mail` config at it → test.
2. Questions the guide does not answer are probably in [docs/faq.md](docs/faq.md).

> Missivus is free and open source (GPLv3). If you would rather not do the Entra and Exchange
> setup yourself, [Solvetus](https://solvetus.com) offers paid installation and support.

## External services

When configured, this software connects to `login.microsoftonline.com` (to obtain access tokens)
and `graph.microsoft.com` (to send mail). No other external service is contacted.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the standing security review — what is enforced,
what is verified, and which risks are accepted with reasons. To report a vulnerability, email
`security@missivus.com`; please do not open a public issue.

## Development

```bash
npm install          # dev-only toolchain; the packages have zero runtime dependencies
npm run build        # tsc, strict, ships .d.ts
npm test             # node:test against a scripted Graph, 84 tests
npm run lint         # eslint, typescript-eslint strict-type-checked
./smoke/ghost/run.sh # real smoke: official ghost Docker image + the shim, loud AADSTS failure
```

The transport core uses WinterCG APIs only — `smoke/workers/` holds the `wrangler dev`
compatibility check. Architecture, the seam evidence and the exact Ghost internals this depends
on are recorded in [PLAN.md](PLAN.md).

## Licence

[GPLv3](LICENSE).

## Support

Missivus is free and open source. If you would rather not do the Entra and Exchange setup yourself,
[Solvetus](https://solvetus.com) offers paid installation and support.
