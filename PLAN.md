# Missivus for Ghost — Implementation Plan

The spec is `docs/BRIEF.md`. Everything marked **(verified)** below was checked empirically against
the cited source — the current Ghost major's source tree, the `@tryghost/nodemailer` package Ghost
resolves its transport through, the Microsoft Graph v1.0 reference, or the sibling repositories —
not recalled from memory. Sibling repos: `missivus-matomo` (origin of the transport design and its
security review, v0.1.4), `missivus-wordpress`, and `missivus-nextcloud` (the reference for
due-diligence-first and the empirical seam decision). This repo is the fourth platform and the
first JavaScript member of the family: `packages/graph-transport` is the reusable JS/TS transport
the missivus.com site promises as "Missivus for Workers & Node".

## 0. Due diligence (done before any design, 2026-08-18)

Searched for an existing way to send Ghost's **transactional** mail (member magic links, staff
invites, password resets, notification and test emails) through Microsoft Graph with
**application** permissions:

- **npm**: searched for Graph mail transports for Nodemailer and standalone senders
  (`nodemailer "microsoft graph"`, `graph nodemailer`, "microsoft-graph-mail-sender"). The only
  live candidate is `nodemailer-msgraph-transport` (v1.0.1, 2025-08-12, one maintainer) — a
  Nodemailer transport that does app-only Graph, but it depends on `@azure/msal-node` and
  `nodemailer` at runtime, has no certificate/JWT-assertion path of its own beyond what msal
  wraps, no large-attachment upload-session path, no redaction discipline, and — decisive for
  Ghost — **cannot be wired into Ghost anyway**, because Ghost has no custom-transport hook (see
  §3). `microsoft-graph-mail-sender` (v0.1.8, last touched 2023) is delegated-flow-flavoured and
  abandoned. The family rule is zero third-party runtime dependencies in the transport itself;
  neither package is "clearly better and tiny", so we ship our own class. **Verdict: build.**
- **GitHub**: repo/code searches for a Ghost + Graph mail integration ("ghost microsoft graph
  mail", "GhostMailer graph", `"Mail.Send" ghost cms`). Nothing exists that touches Ghost's mail
  path. The hits are the same external SMTP→Graph relay daemons the Nextcloud due diligence
  catalogued (SMTP2Graph and friends) — generic services, not Ghost integrations, and delegated
  or unscoped in their auth guidance. Competitors, not duplicates.
- **Ghost forum**: `forum.ghost.org/search.json?q=microsoft graph sendmail transport` returns an
  empty result set **(verified via the Discourse JSON API)**; broader searches surface only
  Office-365-SMTP-basic-auth threads (e.g. "Cannot use Office 365 for SMTP", #22273) — people
  hitting exactly the problem this package solves, with no Graph solution offered.

**Verdict: no duplicate exists. Build.** SMTP relay daemons and the msal-based Nodemailer
transport are recorded as competitors for the README comparison, as with the siblings.

## 1. What this does

Two packages, one seam. `@missivus/graph-transport` is the reusable, dependency-free JS/TS
Microsoft Graph mail transport (client credentials, `Mail.Send` application permission, one shared
mailbox behind an Exchange application access policy) that runs on Node ≥ 20 and Cloudflare
Workers. `@missivus/ghost` wires it to Ghost as a tiny local **SMTP-to-Graph shim**: Ghost keeps
its own supported `mail.transport: "SMTP"` configuration and points it at the shim, which hands
each message to the Graph transport. Ghost is never patched; upgrades cannot break the wiring
because the wiring is Ghost's own documented SMTP config.

**Scope boundary, stated everywhere:** Ghost's *newsletter / bulk* sending is Mailgun-only by
design and is NOT covered — Missivus for Ghost handles transactional mail only.

## 2. Supported platform **(verified)**

| | Ghost 6 |
|---|---|
| Latest release | v6.58.0 (repo at 6.58.1-rc.0 on `main`) |
| Transport resolution | `ghost/core/core/server/services/mail/ghost-mailer.js` → `require('@tryghost/nodemailer')` pinned at **2.3.1** |
| Node floor for the packages | Node ≥ 20 (dist is plain ES2022 JS; the test suite uses Node's native TS type-stripping, Node ≥ 23.6 for dev only) |
| Workers | core transport uses only WinterCG APIs: `fetch`, `crypto.subtle`, `TextEncoder`, `btoa`-free base64 via `Uint8Array` — no Node-only API in `src/` except in the `./node` and shim entry points |

## 3. The seam — decision and evidence

**Decision: brief option 2 — a local SMTP-to-Graph shim, documented as second-class exactly as the
brief instructs, because option 1 (a custom Nodemailer transport referenced from Ghost config) is
impossible on the current Ghost major without patching core.** Evidence:

1. **Ghost's transport switch is closed.** `GhostMailer`'s constructor **(verified, Ghost `main`,
   `ghost-mailer.js` L107–122)**:
   ```js
   const nodemailer = require('@tryghost/nodemailer');
   let transport = config.get('mail') && config.get('mail').transport || 'direct';
   ...
   this.transport = nodemailer(transport, options);
   ```
   and `@tryghost/nodemailer` (2.3.8 inspected, 2.3.1 pinned — same structure) is a `switch` over
   exactly `smtp | mailgun | sendmail | ses | direct | stub`, whose `default:` **throws**
   `EmailError: Unknown mail transport: {transport}`. There is no module loading, no path
   resolution, no registry — a config value naming our module can never reach
   `nodemailer.createTransport`.
2. **Config cannot smuggle a transport in.** Nodemailer accepts a custom transport only as an
   object with a `send` function; Ghost's `mail.options` comes from JSON config / env vars and can
   only carry data, never a function **(verified: the `smtp` case passes `options` straight to
   `createTransport`, which treats a function-less object as SMTP options)**.
3. **No adapter type for mail.** Ghost's adapter system covers `storage, scheduling, sso, cache,
   redirects, route-settings, jobs` **(verified, `adapter-manager/base-classes.ts` L16–23)** —
   nothing mail-shaped.
4. **Every transactional path funnels through the one GhostMailer seam we sit behind:**
   - members magic links / signin: `services/members/service.js` L16 `const {GhostMailer} =
     require('../mail');`, L32 `const ghostMailer = new GhostMailer();`, L82 `sendEmail:
     ghostMailer.send.bind(ghostMailer)` **(verified)**;
   - staff invites, password resets, the mail API: `api/endpoints/mail.js` constructs
     `new mailService.GhostMailer()` and `authentication/invitations` use the same service
     **(verified)**;
   so catching GhostMailer's transport catches everything the brief lists.
5. **The "admin send test email" caveat:** the `mail` API controller still exists
   (`api/endpoints/mail.js`, `send`/`docName: 'mail'`) but **no route in the current admin router
   exposes `/mail/`** **(verified: `web/api/endpoints/admin/routes.js` has no mail route)** — the
   old "Send test email" button's endpoint is gone from Ghost 6. The admin-triggered
   transactional emails that do exist are the password reset (`POST
   /ghost/api/admin/authentication/password_reset`) and the staff 2FA/verification email; the
   smoke test uses those plus the staff invite and the member magic link.
6. **Why the shim is safe and loud:** Ghost's SMTP transport surfaces the server's SMTP error text
   in `err.message`, and `GhostMailer.sendMail()` wraps it as `EmailError('Failed to send email.
   Reason: <that text>')` **(verified, `ghost-mailer.js` L177–201)**. The shim answers a Graph
   failure with `554 5.0.0 Missivus: <redacted Microsoft error>` — so the AADSTS/Graph error text
   lands verbatim in Ghost's own log. Loud, never silent, with no Ghost code touched.
7. **Rejected: a sendmail-binary shim** (`mail.transport: "sendmail"`, `options.path` pointing at
   our executable). It would be single-process, but Nodemailer's sendmail transport reports only
   the exit code — the Microsoft error would never reach Ghost's log, failing the brief's loudness
   requirement. Rejected on that evidence.
8. **Rejected: overriding `@tryghost/nodemailer` inside Ghost's `node_modules`** — that is
   patching the installed tree; it dies on every Ghost upgrade. The brief forbids it.

**The STOP clause:** not triggered — the shim is the brief's own sanctioned option 2, works
cleanly on the current major, and survives upgrades because it rides Ghost's stable public SMTP
config surface. Recorded here per brief; no STOP.

## 4. Architecture

### 4.1 `packages/graph-transport` — the portable core

Zero runtime dependencies. TypeScript strict, `d.ts` shipped, ESM. No Node API in the core
modules; `fetch` and the token cache are injectable, the clock is injectable for tests.

| Module | Responsibility |
|---|---|
| `redactor.ts` | the two-layer redaction pass, ported 1:1 from the PHP `Redactor` (same `MASK`, same `SECRET_PARAMS`, same six shape patterns, ≥ 8-char literal rule, fail-closed, `redactBody` 2000-byte truncation) |
| `endpoint.ts` | base-URL vetting ported 1:1 (`normalise`/`describe`; refuses non-https, userinfo, query, fragment; never echoes what it refuses — the issue-#1 lesson) |
| `credentials.ts` | tenant/client/method value object; `secretLiterals()`; `toString`/`toJSON`/inspect overridden so no dump spills a secret |
| `client-assertion.ts` | PS256 (default, `x5t#S256` header) / RS256 (escape hatch, `x5t`) client-assertion JWT via **WebCrypto** (`crypto.subtle.sign` RSA-PSS saltLength 32 / RSASSA-PKCS1-v1_5); 300 s lifetime; `aud` pinned to `login.microsoftonline.com` (family decision); `jti` via `crypto.randomUUID()` |
| `token-provider.ts` | client-credentials token, cache key `missivus.token.<sha256(tenant\|client\|method)>`, TTL = `expires_in − 300` (not cached when ≤ 0), `invalidate()` after a 401 |
| `message.ts` | transport-neutral message + attachment values; `toGraphMessage()` identical mapping to the PHP class |
| `graph-mailer.ts` | `send()` (JSON path), `sendMime()` (raw-MIME path for the shim, incl. forced-From header surgery), draft → uploadSession → send above the ceiling; 401 invalidate-and-retry once; no `Authorization` on chunk PUTs; orphan-draft named in the log, never silently deleted |
| `nodemailer.ts` | the Nodemailer transport adapter (`{name, version, send(mail, done)}`), exported as `@missivus/graph-transport/nodemailer`; no runtime dependency on nodemailer — it implements the transport contract structurally |
| `node.ts` | Node-only helpers: `loadCertificate(path, passphrase)` → decrypted PKCS#8 + certificate PEM via `node:crypto` (WebCrypto cannot import encrypted or PKCS#1 keys; the conversion happens here so the core stays Workers-clean) |

Constants carried from the family, all pinned by tests:
`LARGE_ATTACHMENT_THRESHOLD = 3145728` (a single fileAttachment must stay under 3 MB — verified
against the Graph reference: JSON `sendMail` bounds the request at 4 MB, and the family budget is
deliberately the conservative 3 MB), `TOTAL_INLINE_BUDGET = 3145728` (total-aware, `>=` on both
comparisons), `UPLOAD_CHUNK_BYTES = 3276800` (10 × 320 KiB, under 4 MB as Microsoft advises),
`API_VERSION = 'v1.0'`, `EXPIRY_MARGIN_SECONDS = 300`, `ASSERTION_LIFETIME_SECONDS = 300`.

The MIME path **(verified against the Graph v1.0 `user: sendMail` reference)**: `POST
/users/{sender}/sendMail` with `Content-Type: text/plain` and the base64-encoded MIME as the
body; success is 202. The MIME path shares the JSON path's request ceiling, so `sendMime` refuses
messages whose encoded size exceeds the inline budget with an error naming the limit — Ghost's
transactional mail carries no attachments, so this is a guard rail, not a working path.

### 4.2 `packages/ghost` — the shim

| Module | Responsibility |
|---|---|
| `smtp-server.ts` | minimal ESMTP listener (`node:net`): EHLO/HELO, SIZE, AUTH accepted unseen (the shim trusts its bind interface; credentials are never parsed or logged), MAIL/RCPT/DATA with dot-unstuffing, 554 with the redacted Graph error on failure |
| `smtp-client.ts` | minimal SMTP client for the optional fallback passthrough (default OFF): connect, EHLO, optional STARTTLS/implicit TLS, AUTH PLAIN, dot-stuffing |
| `config.ts` | resolves the Missivus options from (highest first) `MISSIVUS_*` env vars → Ghost Docker-style `mail__options__*` env vars → a Ghost `config.*.json` file passed as `--ghost-config` |
| `deliver.ts` | envelope + MIME → forced-From surgery → `GraphMailer.sendMime`; fallback passthrough when configured ON; every failure logged and rethrown — nothing swallowed |
| `cli.ts` | `missivus-ghost` bin: parse config, start the listener, structured logs to stdout |

Zero runtime dependencies beyond `@missivus/graph-transport`.

## 5. Config model **(the brief's decided shape)**

Everything rides Ghost's own `mail` section of `config.*.json`, and therefore Ghost's Docker env
var convention `mail__options__*` (double-underscore nesting). Ghost itself only consumes `host`,
`port`, `secure` and `auth` from `mail.options`; Nodemailer ignores unknown keys **(verified:
extra SMTP options pass through `createTransport` harmlessly)** — so the Missivus keys live in
the same object and the shim reads them from the same source Ghost does.

```json
"mail": {
  "from": "Example Ltd <noreply@example.com>",
  "transport": "SMTP",
  "options": {
    "host": "127.0.0.1",
    "port": 2525,
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "clientId": "00000000-0000-0000-0000-000000000000",
    "clientSecret": "…",
    "certificate": {"path": "/etc/missivus/missivus.pem", "passphrase": ""},
    "sender": "noreply@example.com",
    "saveToSentItems": false,
    "fallback": {"host": "", "port": 587, "secure": false, "user": "", "pass": ""}
  }
}
```

| Key | Default | Env var (Docker) |
|---|---|---|
| `tenantId` | — | `mail__options__tenantId` |
| `clientId` | — | `mail__options__clientId` |
| `clientSecret` | — | `mail__options__clientSecret` |
| `certificate.path` / `.passphrase` | — | `mail__options__certificate__path` / `__passphrase` |
| `sender` | — | `mail__options__sender` |
| `saveToSentItems` | `false` | `mail__options__saveToSentItems` |
| `fallback.*` | off (empty host) | `mail__options__fallback__host` … |
| `listen.host` / `listen.port` | `127.0.0.1` / `2525` | `MISSIVUS_LISTEN_HOST` / `MISSIVUS_LISTEN_PORT` (shim-side; Ghost's `host`/`port` must point at the same place) |
| `graphBaseUrl` / `loginBaseUrl` | Microsoft defaults | `MISSIVUS_GRAPH_BASE_URL` / `MISSIVUS_LOGIN_BASE_URL` (escape hatches, no Ghost-side key) |
| `certificateAlgorithm` | `PS256` | `MISSIVUS_CERTIFICATE_ALGORITHM` (`RS256` escape hatch) |

`MISSIVUS_*` equivalents exist for every key (`MISSIVUS_TENANT_ID`, `MISSIVUS_CLIENT_ID`,
`MISSIVUS_CLIENT_SECRET`, `MISSIVUS_CERTIFICATE_PATH`, `MISSIVUS_CERTIFICATE_PASSPHRASE`,
`MISSIVUS_SENDER_MAILBOX`, …) and win over the Ghost-shaped sources, for a shim running as a
sidecar that never sees Ghost's config. Auth method is inferred: a certificate path selects
certificate auth, otherwise secret — matching the sibling default of `secret`. Secrets are never
logged; every string leaving the shim passes the Redactor.

## 6. Forced From and failure policy (family rules, not re-opened)

- Forced From = configured `sender`. The shim rewrites the MIME `From:` header to the sender
  (keeping the display name), demotes a differing requested address to `Reply-To` **only when no
  Reply-To exists**, compares case-insensitively, stays silent on match or empty, and warns:
  `Missivus: forcing From to <sender>; Ghost asked for <requested>. Set mail.from to the shared
  mailbox to silence this.` Docs tell the operator to set `mail.from` accordingly.
- No fallback by default: a Graph failure is logged at error level by the shim AND returned as the
  SMTP 554 text, so it lands in Ghost's log too. With `fallback.host` configured, the shim relays
  the unmodified MIME to that SMTP server — and still logs the Graph failure at error level first.
- The transport core never falls back and never returns false quietly; every failure is a
  `GraphError` carrying status and a redacted body.

## 7. Attachment strategy **(same as siblings — decided)**

JSON path inline below 3 MB per file and in total; draft → per-attachment
`createUploadSession` → chunked PUTs (no bearer on the pre-authenticated `uploadUrl`) → send,
above. Draft-creation failure names `Mail.ReadWrite` verbatim. A failed upload names the orphaned
draft id in an error log line rather than deleting it. Ghost's own transactional mail is
attachment-free; the paths exist because the transport is the family's reusable one.

## 8. Redaction design

Ported 1:1 from missivus-matomo v0.1.4 (which includes the issue-#1 endpoint-redaction fix):
literal layer (≥ 8 chars) + shape layer (JSON secret keys incl. `uploadUrl`, URL userinfo,
`SECRET_PARAMS` name=value, URL fragments, `Bearer` tokens, bare JWTs), fail-closed to the mask,
`redactedWith` never chains the original error as `cause`, `Endpoint.describe()` as the single
chokepoint so a refused URL's userinfo/query/fragment are never assembled into any message. One
redaction pass over every logged or returned string, in the transport and again at the shim edge.

## 9. Test strategy

- `node:test` (zero new dev framework; Node's native type stripping runs the `.ts` suites
  directly), mocked Graph at the injectable-`fetch` boundary: a scripted queue that records every
  request and **throws on an unscripted call**. Cases required by the brief, all covered: token
  acquisition, cache TTL = expires_in − 300 (3600 → 3300, short-lived tokens used-not-cached),
  refresh after 401 exactly once, secret AND certificate auth (PS256 assertion verified with
  `node:crypto`'s independent `verify`, `x5t#S256` = SHA-256 of the DER; RS256 escape hatch),
  send happy path incl. the exact ordered URL list, header/recipient fidelity (from-name,
  Reply-To, To/Cc/Bcc, HTML+text), `saveToSentItems`, inline + large attachments (chunk ranges,
  no Authorization on PUTs, total-budget path), forced-From (warn + Reply-To demotion + explicit
  Reply-To never clobbered + case-insensitive match silent), MIME path (base64 body, forced-From
  surgery), fallback OFF (554 + error log) / ON (relayed, still logged), redaction incl. poisoned
  `graphBaseUrl`/`loginBaseUrl` whose embedded credentials must reach neither log nor error, the
  SMTP server protocol (dot-unstuffing, SIZE, 554 text), and the config resolution precedence.
- ESLint (typescript-eslint strict-type-checked) clean; `tsc` strict with declarations.
- **Workers compatibility check**: `wrangler dev` with a 10-line worker importing the built
  transport, token call answered by an injected fake `fetch`; asserted over HTTP.
- **Smoke (real)**: official `ghost:latest` Docker image + the shim, wired via
  `mail__transport=SMTP` + `mail__options__*` env vars with placeholder credentials; trigger a
  staff invite, a member magic link and an admin-triggered transactional email; show the Missivus
  log lines and the loud AADSTS failure in Ghost's own log — never silent. No live server.

## 10. Ghost internals depended on **(the coupling table)**

| # | Internal | Used for | Breaks if |
|---|---|---|---|
| 1 | `mail.transport: "SMTP"` + `mail.options.{host,port}` resolved through `@tryghost/nodemailer` → `nodemailer.createTransport` | the seam | Ghost drops SMTP transport support (unthinkable while Mailgun stays bulk-only) |
| 2 | Nodemailer tolerating unknown keys in SMTP options | single-source config in `mail.options` | Nodemailer starts validating options strictly — mitigation: move Missivus keys to `MISSIVus_*` env vars, already supported |
| 3 | `GhostMailer.sendMail` surfacing the SMTP error text as `Failed to send email. Reason: …` | loud failures in Ghost's log | Ghost swallows transport errors (would contradict its own error design) |
| 4 | Ghost Docker `mail__options__*` env nesting | Docker config path | Ghost changes its nconf `__` separator |
| 5 | Members/invites/password-reset mail funnelling through `GhostMailer` | coverage claim | Ghost splits members mail onto a separate provider (re-verify per major) |

Upgrade checklist per new Ghost major: re-read `ghost-mailer.js` and the `@tryghost/nodemailer`
pin, re-run the smoke test, re-verify item 5.

## 11. Security

`docs/SECURITY.md` mirrors the siblings (inheriting missivus-matomo findings 1–3a and 12) plus a
Node/Ghost section: config-file permissions, env-var exposure in `docker inspect`/`/proc`, the
shim's trust-the-bind-interface model (bind `127.0.0.1` by default; a Docker network is the
operator's trust boundary and is documented), log redaction at both layers. Privacy disclosure:
talks to `login.microsoftonline.com` and `graph.microsoft.com`, nothing else — README and docs.

## 12. Docs / build / release

README (root, mark + family sentence + newsletter scope boundary in the first screen), per-package
READMEs, `docs/INSTALL.md` (Parts 1–5 identical to the siblings incl. PowerShell blocks verbatim;
Parts 6–8 Ghost-specific: config.production.json, Docker env vars, docker-compose example),
`docs/faq.md`, `docs/SECURITY.md`, `CONTRIBUTING.md`, GPLv3 `LICENSE`, `CHANGELOG.md` (Keep a
Changelog, em-dash dates), `.github/mark.svg` + `.github/social-preview.png` (sibling style, "for
Ghost"). Version 0.1.0 both packages. `npm pack` tarballs attached to the GitHub Release; npm
publication is the owner's (documented, not performed). Repo description, topics and homepage set
via `gh`. Vault log line at the end.

## 13. Self-review against the brief (line by line)

| Brief line | Where satisfied |
|---|---|
| read siblings end to end | §0/§4/§8 carry their formats and constants; PowerShell blocks reproduced verbatim in INSTALL |
| due diligence npm/GitHub/forum, STOP if duplicate | §0 — no duplicate; competitors recorded |
| two deliverables, monorepo, npm workspaces | §1, repo layout |
| `@missivus/graph-transport` dependency-free, Node ≥ 20 + Workers | §4.1, §2 |
| token cache + safety margin, secret AND certificate auth | §4.1 (`token-provider`, `client-assertion`) |
| sendMail, large-attachment draft path, verify ~3 MB | §7 — verified: 4 MB request bound, 3 MB family ceiling kept |
| forced-From with warning | §6 |
| full fidelity (HTML+text, From name, Reply-To, To/Cc/Bcc, attachments, saveToSentItems) | §4.1 `message.ts`, tests §9 |
| injectable fetch and cache | §4.1 |
| Nodemailer adapter exported separately | §4.1 `nodemailer.ts`, subpath export |
| redaction discipline, described-not-echoed URLs | §8 |
| `missivus-ghost` in `packages/ghost` as `@missivus/ghost` | decided: the npm scope `@missivus` is used for both; recorded here |
| repo create, remote, includeIf identity | done first (repo `Solvetus/missivus-ghost`, first commit under the Solvetus includeIf identity) |
| read Ghost mail internals first | §2/§3, all cited |
| seam order 1 → 2 → STOP | §3: option 1 impossible (evidence), option 2 chosen, STOP not triggered |
| prove invite/magic-link/password-reset/test-email | §3.4/§3.5, smoke in §9 — with the mail-route-removed caveat recorded |
| design goals: auth, forced-From, no fallback by default, config via `mail.options` + env, zero deps, SECURITY.md, privacy disclosure | §5, §6, §11 |
| tests incl. poisoned base URLs, ESLint, strict TS, d.ts | §9 |
| smoke on official ghost Docker image, loud AADSTS failure | §9 |
| Workers check via wrangler | §9 |
| docs list + social preview | §12 |
| 0.1.0, Release with tarballs, no npm publish, no live server | §12 |
| house rules: no secrets, small commits, Solvetus line, vault log | throughout, §12 |

Contradictions found and resolved: (a) the brief's seam option 1 assumes a hook Ghost 6 does not
have — resolved by the brief's own ordering: evidence recorded, option 2 shipped, documented as
second-class; (b) "Ghost admin send test email" no longer has a route on the current major —
resolved by proving the surviving admin-triggered transactional mails (password reset, 2FA code)
plus invite and magic link, caveat recorded in §3.5; (c) the Ghost adapter "may depend only on
what Ghost already ships (Nodemailer)" vs the shim running outside Ghost's process where
Nodemailer is absent — resolved by depending on nothing at all (`node:net` only), which satisfies
the constraint a fortiori; (d) `aud` pinned to the public login host vs `loginBaseUrl` overrides
for sovereign clouds — family decision kept 1:1 (the PHP transport does the same); noted as a
family-wide open item for the owner, not diverged from here.
