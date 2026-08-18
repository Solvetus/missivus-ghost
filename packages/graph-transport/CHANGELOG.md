# Changelog

All notable changes to Missivus for Ghost. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Both packages
(`@missivus/graph-transport`, `@missivus/ghost`) version together.

## [0.1.0] — 2026-08-18

First release. The fourth Missivus platform, after
[Matomo](https://github.com/Solvetus/missivus-matomo),
[WordPress](https://github.com/Solvetus/missivus-wordpress) and
[Nextcloud](https://github.com/Solvetus/missivus-nextcloud) — and the first JavaScript member of
the family: the Graph transport here is a TypeScript port of the family's PHP class (from
missivus-matomo v0.1.4, including the endpoint-URL redaction fix from its issue #1), reusable on
Node ≥ 20 and Cloudflare Workers.

### Added

- **`@missivus/graph-transport`** — dependency-free Graph mail transport: client-credentials
  tokens cached with the family's 300-second safety margin; client-secret and certificate auth
  (PS256 client assertions with `x5t#S256` via WebCrypto, RS256 escape hatch with `x5t`);
  `sendMail` with full fidelity (HTML+text, From name, Reply-To, To/Cc/Bcc, attachments,
  `saveToSentItems`); automatic draft → upload-session → send above the 3 MB ceiling, chunks of
  3,276,800 bytes, no bearer token on the pre-authenticated upload URL; a raw-MIME send path with
  forced-From header surgery; injectable `fetch`, token cache and clock; a Nodemailer adapter
  exported as `@missivus/graph-transport/nodemailer` with no nodemailer dependency of its own;
  Node-only certificate loading (encrypted/PKCS#1 PEMs) behind `@missivus/graph-transport/node`.
- **`@missivus/ghost`** — the `missivus-ghost` SMTP-to-Graph shim: Ghost 6 has no custom mail
  transport hook (PLAN.md §3, with evidence), so the shim rides Ghost's own supported SMTP
  config. Configuration comes from Ghost's `mail.options` (file or Docker `mail__options__*` env
  vars) with `MISSIVUS_*` overrides; a Graph failure is logged at error level and answered as
  `554 Missivus: <redacted Microsoft error>`, which Ghost writes into its own log — never
  silent. Optional SMTP fallback, off by default.

### Security

- The family's two-layer `Redactor` (secret literals + shape matching for tokens, JWTs, URL
  userinfo, secret-named parameters, `uploadUrl`) runs over every logged or returned string, in
  the transport and again at the shim edge; base-URL overrides are vetted and refused values are
  described, never echoed. Standing review in `docs/SECURITY.md`.

### Tests

- 84 `node:test` tests (65 transport, 19 shim) against a scripted Graph endpoint, all passing;
  PS256/RS256 assertions verified against `node:crypto` as an independent implementation; ESLint
  (typescript-eslint strict-type-checked) clean; TypeScript strict with shipped declarations.
- Workers compatibility: `wrangler dev` (workerd) serving a worker that imports the built
  transport and completes a mocked token + sendMail round trip.
- Real smoke on the official `ghost:6.58.0` Docker image, transport configured purely via env
  vars with placeholder credentials: member magic link, admin password reset, staff invite and
  the setup welcome email all routed through the shim, each failing loudly with the real
  Microsoft `AADSTS` error in Ghost's own log.

[0.1.0]: https://github.com/Solvetus/missivus-ghost/releases/tag/v0.1.0
