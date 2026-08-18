# Missivus for Ghost — Build Brief

The spec. `/goal` conditions reference this file. Read it fully, then read the sibling repos end
to end — `/Users/rds/Projects/Solvetus/missivus-matomo` (origin of the PHP transport, decisions,
docs voice, docs/SECURITY.md incl. the issue-#1 lesson) and `/Users/rds/Projects/Solvetus/missivus-nextcloud`
(the reference for "empirical seam decision" and due-diligence-first). Missivus for Ghost is the
fourth platform and the **first JavaScript member of the family**: it ships the reusable JS/TS
Graph transport that the site already promises as "Missivus for Workers & Node".

## What it is

A free GPLv3 package (Solvetus Labs, family site https://missivus.com) that lets a self-hosted
Ghost instance send its **transactional** email — member magic links / sign-in, staff invites,
password resets, comment/notification alerts, test emails — through Microsoft Graph using
**application permissions and a shared mailbox**: client credentials, `Mail.Send` application
permission, Exchange application access policy scoped to ONE shared mailbox; no user login, no
delegated OAuth, nothing to click. Ghost today offers Nodemailer with SMTP or a Mailgun key only;
Microsoft is retiring SMTP AUTH Basic authentication (unchanged until December 2026, disabled by
default for existing tenants at end of December 2026, unavailable by default for new tenants
after, final removal to be announced 2H 2027). Business model: software free, Solvetus sells
installation and support.

**Scope boundary, stated plainly everywhere:** Ghost's *newsletter / bulk* sending is Mailgun-only
by design and is NOT covered — Missivus for Ghost handles transactional mail only. Documentation
and README must say so in the first screen.

## Due diligence first (before any design)

Search npm, GitHub and the Ghost forum for an existing Graph application-permission mail
transport for Ghost or for Nodemailer. If a maintained Nodemailer transport already does app-only
Graph well, evaluate depending on it vs. shipping our own; the family rule is zero third-party
runtime dependencies for the transport itself, so prefer our own class unless the existing one is
clearly better and tiny. Record the verdict in PLAN.md. If a Ghost-specific solution already
exists and works, STOP and report.

## Repos and packages

Two deliverables, decided:
1. **`@missivus/graph-transport`** — the reusable, dependency-free JS/TS Graph transport
   (client-credentials token with cache + safety margin, secret AND certificate/JWT-assertion
   auth, `sendMail`, large-attachment draft→uploadSession→send path above Graph's ceiling
   (verify ~3 MB), forced-From with warning, full fidelity: HTML+text, From name, Reply-To,
   To/Cc/Bcc, attachments, `saveToSentItems`; injectable `fetch` and cache; runs on Node ≥ 20 and
   on Cloudflare Workers — no Node-only APIs in the core; a small Nodemailer-transport adapter
   exported separately). Same redaction discipline as the PHP transport: error text built from
   operator-supplied URLs is described, never echoed; one redaction pass over every logged/returned
   string. Lives in this repo under `packages/graph-transport/`.
2. **`missivus-ghost`** — the Ghost integration in `packages/ghost/`, published as
   `@missivus/ghost` (or a plain module if npm scope proves awkward — decide, record).

Repo: `Solvetus/missivus-ghost` (public GitHub — create with `gh repo create Solvetus/missivus-ghost --public`
if absent). Monorepo (npm workspaces), local folder is this one, remote
`git@github.com:Solvetus/missivus-ghost.git`, branch `main`. Commit identity from the
`~/.gitconfig` includeIf for `/Users/rds/Projects/Solvetus/`. Do NOT publish to npm — the owner
does that; produce the tarballs with `npm pack` and document the publish steps.

## Read first (Ghost side)

Current Ghost major: `ghost/core/core/server/services/mail/GhostMailer.js` and how `mail.transport`
in `config.*.json` is resolved (`transport: "SMTP" | "Direct" | "Sendmail" | "Stub" |
custom module?`), Nodemailer's custom-transport contract, how Ghost validates `mail.from`, the
Ghost docs on config (`mail` section), Ghost's Docker image conventions (`config.production.json`
via env vars `mail__transport`, `mail__options__*`), and Ghost's members/magic-link mail path to
confirm it goes through the same GhostMailer.

## The seam — decide empirically, do not guess

Evaluate in this order and pick the first that works cleanly on the current Ghost major:
1. A **custom Nodemailer transport** referenced from Ghost config (`mail.transport` pointing at
   our module, or Ghost's supported custom-transport hook if one exists) — no Ghost core patch,
   survives Ghost upgrades.
2. A tiny **local SMTP-to-Graph shim** (listens on localhost, accepts Ghost's SMTP config, sends
   via Graph) — only if 1 is impossible; document as second-class.
3. If neither works without patching Ghost core, STOP and report with evidence.
Prove the seam catches: staff invite, member magic link, password reset, and the Ghost admin
"send test email" — show the log lines.

## Design goals (decided — same family rules, do not re-open)

- Auth: client credentials; secret AND certificate; default secret. Token cached in memory
  (and pluggable cache) with safety margin.
- Forced From = configured sender mailbox; warn when Ghost's `mail.from` differs; docs tell the
  operator to set `mail.from` to the shared mailbox.
- Fallback: none by default (fail loudly with the Graph error into Ghost's log); optional
  passthrough to a configured SMTP transport, default OFF, documented.
- Config: everything via Ghost `config.*.json` `mail.options` (and therefore env vars
  `mail__options__*` in Docker): tenantId, clientId, clientSecret | certificate{path,passphrase},
  sender, saveToSentItems, fallback. Secrets never logged; the redaction pass applies to
  everything written to Ghost's log.
- Zero third-party runtime dependencies in the transport; the Ghost adapter may depend only on
  what Ghost already ships (Nodemailer).
- Security: `docs/SECURITY.md` mirrors the siblings plus a Node/Ghost section (config file
  permissions, env var exposure in Docker, log redaction).
- Privacy disclosure: talks to `login.microsoftonline.com` and `graph.microsoft.com` — README and
  docs.
- Tests: `node:test` or vitest with a mocked Graph endpoint: token, refresh, secret + certificate
  auth, send happy path, header/recipient fidelity, inline and large attachments, forced-From,
  fallback OFF/ON, redaction incl. poisoned base-URL values; ESLint + TypeScript strict; type
  declarations shipped. Plus a real smoke run: official `ghost` Docker image (latest), our
  transport configured with placeholder credentials, trigger a staff invite and a member magic
  link, show the Missivus log lines and the loud AADSTS90002 failure — never silent. Also a
  Workers compatibility check for the transport package (`wrangler dev` with a 10-line worker
  importing it, token call mocked).
- Docs: `README.md` (root: opens with the mark from missivus-www `public/brand/missivus-mark.svg`
  copied into `.github/`; family sentence "Missivus for Ghost — send Ghost transactional email
  through Microsoft Graph with application permissions and a shared mailbox. No SMTP, no user
  login. Free, GPLv3." with the newsletter scope boundary right after), per-package READMEs,
  `docs/INSTALL.md` (same Entra + Exchange Online guide as the siblings; PowerShell blocks
  identical; plus the Ghost config and Docker env-var section), `docs/faq.md`, `docs/SECURITY.md`,
  `CONTRIBUTING.md`, `LICENSE`, `CHANGELOG.md`, `.github/social-preview.png` (sibling style,
  "for Ghost").
- Versions: 0.1.0 for both packages. GitHub Release with both `npm pack` tarballs attached.
- Do NOT touch any live server. Do NOT publish to npm.

## House rules

Secrets: never invent, print or commit. Latest versions. Small logical commits. One tasteful
line pointing to Solvetus for installation and support. Vault log line at the end to
`/Users/rds/Library/Mobile Documents/iCloud~md~obsidian/Documents/Omni/30_Projects/Missivus/Missivus.md`.
