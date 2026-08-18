# Security review — Missivus for Ghost

Standing review, last updated **2026-08-18** (v0.1.0). Scope: both packages in this repository and
their configuration surface. The transport is a TypeScript port of the family's PHP class; the
upstream review, [missivus-matomo `docs/SECURITY.md`](https://github.com/Solvetus/missivus-matomo/blob/main/docs/SECURITY.md),
applies in design terms — its findings 1–3a (endpoint vetting, token cache margin, layered
redaction) and 12 (the issue-#1 endpoint-URL lesson) are carried into this codebase 1:1 and
re-pinned by this repo's own tests.

Report vulnerabilities to `security@missivus.com`. Please do not open a public issue until a fix
is out.

| # | Finding | Status |
| --- | --- | --- |
| 1 | Credentials in requests to Microsoft only, always over https; base URLs vetted, refused values never echoed | Ported, verified by tests |
| 2 | Token cached with a 300 s expiry margin; never logged | Ported, verified by tests |
| 3 | Two-layer redaction (literals + shapes) over every logged/returned string, incl. poisoned base-URL values | Ported, verified by tests |
| 4 | The shim never parses or stores the SMTP AUTH credentials Ghost sends | Enforced |
| 5 | The shim binds to 127.0.0.1 by default | Enforced, documented |
| 6 | Secrets in env vars / Ghost's config file | Accepted, documented |
| 7 | No TLS between Ghost and the shim | Accepted, documented |
| 8 | Unauthenticated local SMTP endpoint can send as the shared mailbox | Accepted, documented |
| 9 | Token residency in shim process memory | Accepted |

## Enforced and verified

**1 — Endpoint vetting.** Both base URLs are overridable (sovereign clouds, tests), and both pass
`normaliseEndpoint()`, which refuses anything that is not a bare https origin — and never echoes
the refused value: messages are built from a single `describe()` chokepoint that emits scheme,
host, port and path only. Tests drive poisoned `graphBaseUrl`/`loginBaseUrl` values holding
credentials through the real failure path and assert they reach neither the error, nor the log,
nor the SMTP reply.

**2 — Token discipline.** Tokens are cached in memory for `expires_in − 300` seconds; a token
shorter-lived than the margin is used but never cached. After a 401 the cache entry is dropped and
the send retried exactly once. The cache key holds no secret.

**3 — Redaction.** Every string that can leave the process — shim log lines, the SMTP 554 reply
Ghost stores in its own log, transport errors — passes the `Redactor`: known literals (the client
secret, certificate passphrase, fallback SMTP password) plus shape matching for bearer tokens,
JWTs, `uploadUrl`, URL userinfo/fragments and secret-named parameters. The pass fails closed. The
`GraphError.redactedWith()` rebuild deliberately does not chain the original error as `cause`, so
printing an error chain cannot print what was removed.

**4 — Ghost's SMTP credentials are never read.** If Ghost is configured with SMTP `auth`, the
shim answers the AUTH exchange positively without decoding the credential lines: they are not
parsed, not compared, not logged. There is nothing to leak.

## Accepted risks, with reasons

**5/7/8 — The shim's trust model is its bind interface.** The shim speaks plaintext SMTP without
authentication and without TLS, and anyone who can reach its port can send email as the shared
mailbox. That is why it binds `127.0.0.1` by default and why the Docker guidance puts it on the
compose network only (never `-p`-published). An attacker who can reach localhost or the compose
network is already on the Ghost host, where Ghost's own config — holding the same credentials —
is readable. Adding SMTP AUTH + TLS between two processes on one machine would move the secret
into one more config file without adding a boundary. The Exchange application access policy is
what bounds the blast radius either way: full compromise of the credential only permits sending
as one shared mailbox.

**6 — Secrets at rest in env vars / config file.** `docker inspect`, `/proc/<pid>/environ` and
Ghost's `config.production.json` can reveal the client secret to root or the service user — the
same principals who could read any alternative store on the same machine. Operators who want
better use the certificate method: a root-owned PEM readable only by the shim's user, with the
key never leaving the machine. File permissions guidance is in INSTALL Part 3/6.

**9 — Token in process memory.** An attacker who can read the shim's memory can already read its
environment. Not worth a mitigation's complexity.

## The Ghost seam, from a security angle

Nothing in Ghost is patched or monkey-patched; the shim sits behind Ghost's own supported SMTP
transport, so the integration adds no code to Ghost's process and no parsing surface to Ghost.
Failure degrades loudly: if the shim is down, Ghost logs a connection error; if Graph refuses, the
Microsoft error text lands in both logs; nothing is ever silently dropped (the optional fallback
is off by default and logs the Graph failure before relaying).

## Not in scope

- Compromise of the Microsoft tenant or the Entra app registration itself.
- A hostile root user or Ghost administrator on the host: they can already read the config and
  send mail.
- The delivery fate of a message after Graph returns 202.
