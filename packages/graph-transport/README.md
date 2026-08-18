# @missivus/graph-transport

**Send email through Microsoft Graph with application permissions and a shared mailbox. No SMTP,
no user login. Free, GPLv3.**

The reusable JavaScript/TypeScript member of the [Missivus](https://missivus.com) family — the
same transport design as the PHP class the Matomo, WordPress and Nextcloud plugins vendor, ported
to run on **Node ≥ 20 and Cloudflare Workers** (WinterCG APIs only: `fetch`, WebCrypto). Zero
runtime dependencies. TypeScript strict, declarations shipped.

```js
import {createGraphTransport, Message} from '@missivus/graph-transport';

const mailer = createGraphTransport({
    tenantId: '…', clientId: '…', clientSecret: '…',
    sender: 'noreply@example.com'
});

await mailer.send(new Message({
    to: [{address: 'user@example.com'}],
    subject: 'Hello',
    html: '<p>Sent app-only through Graph.</p>'
}));
```

- **Auth**: OAuth2 client credentials — client secret, or a certificate (PS256 client assertion
  with `x5t#S256`, signed with WebCrypto; `RS256` escape hatch). Tokens cached with a
  five-minute safety margin; pluggable cache; one automatic refresh-and-retry on a 401.
- **Fidelity**: HTML+text bodies, From display name, Reply-To, To/Cc/Bcc, inline (CID) and file
  attachments, `saveToSentItems`.
- **Large attachments**: automatic draft → upload session → send above Graph's 3 MB ceiling
  (needs the `Mail.ReadWrite` application permission).
- **Forced From**: app-only sending can only send as the configured mailbox; a differing
  requested From is demoted to Reply-To with a warning.
- **Redaction**: every logged or returned string passes a two-layer redaction pass (known
  literals + credential shapes); overridden base URLs are vetted and refused values are
  described, never echoed.
- **Raw MIME**: `mailer.sendMime(bytes)` posts an RFC 5322 message verbatim (used by the Ghost
  shim).
- **Injectable everything**: `fetch`, token cache, logger, clock — tests run against a scripted
  Graph with zero network.

Nodemailer users:

```js
import nodemailer from 'nodemailer';
import {createNodemailerTransport} from '@missivus/graph-transport/nodemailer';

const transporter = nodemailer.createTransport(createNodemailerTransport({
    tenantId: '…', clientId: '…', clientSecret: '…', sender: 'noreply@example.com'
}));
```

The adapter implements Nodemailer's transport contract structurally — this package does not
depend on nodemailer.

Certificate files (as produced by the install guide, key + certificate in one PEM, optionally
encrypted) load through the Node-only helper:

```js
import {loadCertificate} from '@missivus/graph-transport/node';

const mailer = createGraphTransport({
    tenantId: '…', clientId: '…', sender: 'noreply@example.com',
    certificate: loadCertificate('/etc/missivus/missivus.pem', 'passphrase-if-any')
});
```

The Microsoft side — app registration, `Mail.Send` application permission, shared mailbox, and
the Exchange application access policy that locks the credential to that one mailbox — is spelled
out click by click in
[docs/INSTALL.md](https://github.com/Solvetus/missivus-ghost/blob/main/docs/INSTALL.md).

When configured, this library connects to `login.microsoftonline.com` and `graph.microsoft.com`.
No other external service is contacted.

Part of [Solvetus/missivus-ghost](https://github.com/Solvetus/missivus-ghost). Security review:
[docs/SECURITY.md](https://github.com/Solvetus/missivus-ghost/blob/main/docs/SECURITY.md);
vulnerabilities to `security@missivus.com`.

> Missivus is free and open source (GPLv3). If you would rather not do the Entra and Exchange
> setup yourself, [Solvetus](https://solvetus.com) offers paid installation and support.
