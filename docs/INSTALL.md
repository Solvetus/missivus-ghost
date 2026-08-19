# Installing Missivus

This guide assumes you have **never used Microsoft Entra before**. Every click is spelled out.

You will need:

- An account in your Microsoft 365 tenant that can create app registrations and grant admin consent
  — in practice, a **Global Administrator** or an **Application Administrator** who is also an
  **Exchange Administrator**.
- Administrator access to your Ghost install, including a shell on the machine (or Docker host)
  that runs it.

Set aside about an hour. Nothing here is reversible-by-accident; every step can be undone.

Throughout, replace `example.com` with your own domain and `noreply@example.com` with whatever
address you want Ghost's email to come from.

> **Scope:** Missivus carries Ghost's *transactional* email (magic links, staff invites, password
> resets, notifications). Ghost's newsletter / bulk sending is Mailgun-only by design and is not
> covered.

---

## Part 1 — Create the app registration

This is the identity Ghost's mail will use. It is not a user and has no password anyone types.

1. Go to <https://entra.microsoft.com> and sign in.
2. In the left-hand menu choose **Applications → App registrations**.
3. Click **+ New registration**.
4. Fill in the form:
   - **Name**: `missivus-ghost-<your site's hostname>` — for example
     `missivus-ghost-blog.example.com`. Only administrators see this, and naming it after the
     tool and the host keeps it straight once your tenant holds several registrations.
   - **Supported account types**: **Accounts in this organizational directory only (Single tenant)**
   - **Redirect URI**: leave completely empty. Missivus never redirects a browser anywhere, and an
     empty value here is part of why this setup cannot be hijacked.
5. Click **Register**.

You now land on the app's **Overview** page. Two values on it go into the Missivus configuration.
Copy them somewhere safe — they are identifiers, not secrets, so a note is fine:

| On the Overview page | Goes into the configuration as |
| --- | --- |
| **Application (client) ID** | `clientId` |
| **Directory (tenant) ID** | `tenantId` |

---

## Part 2 — Grant the permission to send mail

1. Still inside your app registration, choose **API permissions** in the left-hand menu.
2. Click **+ Add a permission**.
3. Choose **Microsoft Graph**.
4. Choose **Application permissions**. This is the important choice — *not* "Delegated permissions".
   Application permissions belong to the app itself, which is why no human ever has to sign in.
5. In the search box type `Mail.Send`. Tick **Mail.Send**.
6. Ghost's transactional email never carries attachments, so `Mail.Send` alone is enough here.
   (If you reuse this transport elsewhere and send attachments larger than 3 MB, also add
   `Mail.ReadWrite`: sending a big file means creating a draft first, and `Mail.Send` alone does
   not allow that.)
7. Click **Add permissions**.
8. Back on the API permissions page you will see your permission with a warning triangle and the
   status **Not granted for &lt;your organisation&gt;**. Click
   **✓ Grant admin consent for &lt;your organisation&gt;**, then **Yes**.
9. Confirm the Status column now reads **Granted for &lt;your organisation&gt;** with a green tick.

> If the "Grant admin consent" button is greyed out, your account cannot consent. Ask a Global
> Administrator to click it. Nothing else in this guide requires their involvement.

You may also see **User.Read** listed as a delegated permission. Azure adds it automatically to new
registrations. Missivus does not use it and you can safely remove it.

---

## Part 3 — Give the app a credential

Pick **one** of these. If you are not sure, pick the client secret: it is two clicks, it is what the
rest of this guide assumes, and you can move to a certificate later without reinstalling anything.

### Option A — Client secret (start here)

1. In your app registration choose **Certificates & secrets**.
2. On the **Client secrets** tab click **+ New client secret**.
3. Give it a description following the pattern `missivus-ghost-<your site's hostname>` —
   for example `missivus-ghost-blog.example.com` — then choose an expiry and click
   **Add**. A tenant accumulates app registrations and secrets quickly, and a name that says
   which tool and which host it belongs to is the difference between confidently rotating a
   secret and being afraid to touch it.
4. Copy the **Value** column immediately. **It is shown once and never again.** The *Secret ID*
   column is not the secret and is not what you need — this trips almost everyone up the first
   time.
5. Put the expiry date in a calendar. Mail stops on that day if the secret is not replaced.

That is the credential. Skip to Part 4.

### Option B — Certificate (optional hardening)

A certificate is more secure than a secret: it never travels in a request body, and it can be given
a longer life without the same exposure. It is worth doing if you are comfortable with `openssl` and
managing a key file on the server — but nothing in Missivus needs it, and a secret is not a second-
class option.

Run this on your server, or anywhere with `openssl` installed:

```bash
openssl req -x509 -newkey rsa:2048 -keyout missivus.key -out missivus.crt \
  -days 730 -nodes -subj "/CN=missivus-ghost"

# Missivus wants one file containing both parts:
cat missivus.key missivus.crt > missivus.pem
```

- `missivus.pem` is the file the shim reads. **It is a credential — treat it like a password.**
- `missivus.crt` is the public half, the only part you upload to Microsoft.

Upload the public half:

1. In your app registration choose **Certificates & secrets**.
2. Select the **Certificates** tab, click **Upload certificate**.
3. Choose `missivus.crt`, add a description, click **Add**.
4. A thumbprint and an expiry date appear. **Put the expiry date in a calendar** — mail stops on
   that day if the certificate is not replaced.

Put the PEM somewhere outside any web root, readable by the user the shim runs as:

```bash
sudo mkdir -p /etc/missivus
sudo mv missivus.pem /etc/missivus/missivus.pem
sudo chown root:missivus /etc/missivus/missivus.pem
sudo chmod 640 /etc/missivus/missivus.pem
rm missivus.key missivus.crt      # no longer needed on this machine
```

Use whichever group the shim's service user belongs to.

If you choose this option, set `certificate.path` in Part 7 instead of a client secret.

---

## Part 4 — Create the shared mailbox

A shared mailbox needs no licence, which is the point: Ghost gets a real, monitorable mailbox
for free.

Make it a **company-wide no-reply address rather than a Ghost-specific one** —
`noreply@example.com` with the display name set to your company name, not `ghost@` or the name
of your server. Recipients see the display name, and "Example Ltd" reads better in an inbox than
the name of your blog server. It also means the next tool that needs to send email can reuse this
same mailbox: each tool gets **its own Entra app registration**, scoped to this mailbox by the same
kind of application access policy, so their credentials stay completely separate while the address
your users see stays consistent.

1. Go to <https://admin.microsoft.com>.
2. Choose **Teams & groups → Shared mailboxes**.
3. Click **+ Add a shared mailbox**.
4. Set the name to your company name — for example `Example Ltd` — with the address
   `noreply@example.com`.
5. Click **Save changes**. Give it a few minutes to appear everywhere.

Do not add any members. Nobody needs to sign into it.

Two optional bits of hardening while you are here. Both are worth doing and **neither changes
anything for Missivus**, which talks to Graph and needs none of these protocols:

- **Mailbox → Email apps**: switch off Outlook desktop (MAPI), Exchange web services, ActiveSync,
  IMAP, POP3 and Outlook on the web. That closes every sign-in route into the mailbox.
- **Mailbox → General → Hide from address list**: turn it on, so a no-reply address does not clutter
  colleagues' address pickers or invite replies.

---

## Part 5 — Lock the app to that one mailbox

**Do not skip this.** Until you do, the `Mail.Send` permission you granted in Part 2 lets the app
send as *anyone* in your tenant. An application access policy narrows it to the single shared
mailbox, and it is what makes this whole model safe.

**How it works, in one paragraph.** Exchange cannot point a policy at a single mailbox — it can
only point one at a *group*. So you create a security group whose only member is the shared
mailbox from Part 4, then tell Exchange "this app may only touch mailboxes in that group". The
group gets an email address of its own (`noreply-apps@yourcompany.onmicrosoft.com` below), but nobody ever sends
to it or from it; it exists purely so the policy has something to point at. Your shared mailbox
stays exactly as you created it.

You need PowerShell with the Exchange Online module. Windows has PowerShell built in; on macOS run
`brew install --cask powershell` and then `pwsh`; on Linux see Microsoft's install page. Everything
below is typed into that PowerShell window, one command at a time.

**Before you start, have two values ready:**

- the value shown in the **Application (client) ID** field on your app's Overview page (Part 1) —
  a long identifier like `1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d`. Below it is written as
  `PASTE-APPLICATION-CLIENT-ID`.
- the address you sign in to <https://admin.microsoft.com> with. This is often **not** your normal
  email — many tenants use a separate admin account such as `admin@yourcompany.onmicrosoft.com`.
  Use that one; below it is written as `admin@yourcompany.onmicrosoft.com`.

**How to fill in the commands.** Wherever you see `PASTE-APPLICATION-CLIENT-ID`, replace *only
those words* with the Application (client) ID and **keep the quotation marks around it** — so
`-AppId "PASTE-APPLICATION-CLIENT-ID"` becomes
`-AppId "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"`. Same for `example.com` and the admin address.
Change nothing else on the line.

**Step 1 — install the module and sign in** (a browser window opens; sign in with the admin
account):

```powershell
Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser
Connect-ExchangeOnline -UserPrincipalName admin@yourcompany.onmicrosoft.com
```

**Step 2 — create the group.** One line. Its only member is your shared mailbox:

```powershell
New-DistributionGroup -Name "NoReply Apps" -Alias noreply-apps -Type Security -Members "noreply@example.com"
```

PowerShell prints the group it created. Note the **PrimarySmtpAddress** it shows. It is usually
**not** on your normal domain but on your tenant's built-in one —
`noreply-apps@yourcompany.onmicrosoft.com`. If you are unsure, run
`Get-DistributionGroup -Identity noreply-apps | Format-List PrimarySmtpAddress` and copy the value.
That exact address is what goes in the next command; using the wrong domain gives
`The identity of the policy scope could not be resolved`.

**Step 3 — lock the app to the group.** One line. Paste the Application (client) ID and the group
address from Step 2 inside the quotes:

```powershell
New-ApplicationAccessPolicy -AppId "PASTE-APPLICATION-CLIENT-ID" -PolicyScopeGroupId "noreply-apps@yourcompany.onmicrosoft.com" -AccessRight RestrictAccess -Description "Missivus (Ghost) may only send as noreply@example.com"
```

**Step 4 — wait 5–10 minutes**, then check it took effect. Two commands; paste the same
Application (client) ID in both. In the second, use any *other* mailbox in your tenant — your own
email address is fine:

```powershell
Test-ApplicationAccessPolicy -Identity "noreply@example.com" -AppId "PASTE-APPLICATION-CLIENT-ID"
Test-ApplicationAccessPolicy -Identity "you@example.com" -AppId "PASTE-APPLICATION-CLIENT-ID"
```

The first must show `AccessCheckResult : Granted`. The second must show
`AccessCheckResult : Denied`. If the second still says **Granted**, the policy has not propagated
yet: wait and run it again. Do not go further until it says Denied.

**Step 5 — pre-flight: send one real email from PowerShell.** Optional but strongly
recommended: it proves tenant, app, secret and policy end to end before Ghost is involved, so
any later failure is the shim's, not Microsoft's. Fill in the three values (keep the quotes):
your **Directory (tenant) ID** and **Application (client) ID** from Part 1, and the secret
**Value** from Part 3. Replace `you@example.com` with your own inbox.

```powershell
$TenantId = "PASTE-DIRECTORY-TENANT-ID"
$ClientId = "PASTE-APPLICATION-CLIENT-ID"
$Secret   = "PASTE-SECRET-VALUE"

$tok = Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" -Body @{ client_id=$ClientId; client_secret=$Secret; scope="https://graph.microsoft.com/.default"; grant_type="client_credentials" }
$tok.access_token.Substring(0,20)
```

If that prints 20 characters, authentication works. If it errors, the tenant ID or the secret is
wrong — most often the *Secret ID* was copied instead of the *Value*. Then send:

```powershell
$body = '{"message":{"subject":"Missivus pre-flight","body":{"contentType":"Text","content":"Graph app-only send OK"},"toRecipients":[{"emailAddress":{"address":"you@example.com"}}]},"saveToSentItems":false}'
Invoke-WebRequest -Method Post -Uri "https://graph.microsoft.com/v1.0/users/noreply@example.com/sendMail" -Headers @{ Authorization = "Bearer $($tok.access_token)" } -ContentType "application/json" -Body $body | Select-Object StatusCode
```

`StatusCode 202` and an email in your inbox from your company name = the Microsoft side is
done. `403` = the policy is still propagating or admin consent is missing; `404` = the mailbox
has not finished provisioning — wait and retry.

**Step 6 — clean up and sign out.** The secret was typed into this window, so clear it:

```powershell
Remove-Variable Secret,tok,body
Disconnect-ExchangeOnline
```

Then close the PowerShell window.

**Adding another tool later** (Uptime Kuma, a CRM, anything that sends as `noreply@`): give it its
own app registration (Parts 1–3), then run only Step 3 again with that app's Application (client)
ID. The group from Step 2 is reused; you never create a second one.

---

## Part 6 — Run the shim

Ghost has no way to load a custom mail transport ([PLAN.md](../PLAN.md) §3 records the evidence),
so Missivus runs as a tiny local SMTP service that Ghost's own supported SMTP configuration points
at. It needs Node 20 or newer.

**On the Ghost host (ghost-cli / systemd installs):**

```bash
npm install -g @missivus/ghost      # or: npm install -g ./missivus-ghost-<version>.tgz
missivus-ghost --ghost-config /var/www/ghost/config.production.json
```

For real use, run it under systemd so it starts with the machine:

```ini
# /etc/systemd/system/missivus-ghost.service
[Unit]
Description=Missivus for Ghost - SMTP-to-Graph shim
After=network-online.target

[Service]
ExecStart=/usr/bin/missivus-ghost --ghost-config /var/www/ghost/config.production.json
Restart=on-failure
User=ghost
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now missivus-ghost
```

**With Docker (compose):** run the shim as a sidecar on the same network. The Missivus values ride
in the same `mail__options__*` namespace Ghost uses, so both containers can share one env block:

```yaml
services:
  ghost:
    image: ghost:6
    environment:
      url: https://blog.example.com
      mail__transport: "SMTP"
      mail__from: "Example Ltd <noreply@example.com>"
      mail__options__host: missivus
      mail__options__port: 2525
      mail__options__tenantId: "PASTE-DIRECTORY-TENANT-ID"
      mail__options__clientId: "PASTE-APPLICATION-CLIENT-ID"
      mail__options__clientSecret: "PASTE-SECRET-VALUE"
      mail__options__sender: "noreply@example.com"
    # ... your database and volumes as usual
  missivus:
    image: node:22-alpine
    command: sh -c "npm install -g @missivus/ghost && missivus-ghost"
    environment:
      MISSIVUS_LISTEN_HOST: 0.0.0.0
      mail__options__tenantId: "PASTE-DIRECTORY-TENANT-ID"
      mail__options__clientId: "PASTE-APPLICATION-CLIENT-ID"
      mail__options__clientSecret: "PASTE-SECRET-VALUE"
      mail__options__sender: "noreply@example.com"
```

(Use Docker secrets or an env file for the secret rather than committing a compose file with it.)

---

## Part 7 — Configure Ghost

Everything lives in Ghost's own `mail` section — one source of truth for Ghost and the shim.
In `config.production.json`:

```json
"mail": {
  "from": "Example Ltd <noreply@example.com>",
  "transport": "SMTP",
  "options": {
    "host": "127.0.0.1",
    "port": 2525,
    "tenantId": "PASTE-DIRECTORY-TENANT-ID",
    "clientId": "PASTE-APPLICATION-CLIENT-ID",
    "clientSecret": "PASTE-SECRET-VALUE",
    "sender": "noreply@example.com"
  }
}
```

Ghost reads `host` and `port` (its SMTP settings, pointing at the shim); the shim reads the rest
from the same file via `--ghost-config`. Ghost itself ignores the extra keys. For a certificate
instead of a secret, replace the `clientSecret` line with:

```json
    "certificate": {"path": "/etc/missivus/missivus.pem", "passphrase": ""},
```

Restart Ghost after editing the config.

**The From address.** Application-only sending can only send as the shared mailbox, so Missivus
forces that From address regardless of what Ghost asked for — the requested address is preserved
as Reply-To, and a warning naming both addresses goes to the shim's log. Set `mail.from` to the
shared mailbox, as above, and the warning stays quiet.

**Every key, as a Docker env var:** `mail__options__tenantId`, `mail__options__clientId`,
`mail__options__clientSecret`, `mail__options__certificate__path`,
`mail__options__certificate__passphrase`, `mail__options__sender`,
`mail__options__saveToSentItems`, and `mail__options__fallback__host` / `__port` / `__secure` /
`__user` / `__pass` for the optional fallback. `MISSIVUS_*` equivalents
(`MISSIVUS_TENANT_ID`, `MISSIVUS_CLIENT_ID`, `MISSIVUS_CLIENT_SECRET`,
`MISSIVUS_CERTIFICATE_PATH`, `MISSIVUS_CERTIFICATE_PASSPHRASE`, `MISSIVUS_SENDER_MAILBOX`,
`MISSIVUS_LISTEN_HOST`, `MISSIVUS_LISTEN_PORT`) win over everything — useful for a sidecar that
never sees Ghost's config file.

---

## Part 8 — Test it

Ghost 6 removed the old "send test email" endpoint, so use the real thing. From your site's login
page, use **Forgot password?** — that sends a genuine password-reset email through the entire
chain. Or subscribe to your own site with your email address (a member magic link).

- **Success** — the email arrives within a minute, from your company name. Microsoft accepting
  the message is not quite the same as delivering it, so do check it actually arrives.
- **Failure** — Ghost's log (`ghost log`, or `docker logs <container>`) shows
  `Failed to send email. Reason: Message failed: 554 5.0.0 Missivus: …` with the exact Microsoft
  error, and the shim's own log carries the same line. See the table below.

---

## When it does not work

| What you see | What it means | Fix |
| --- | --- | --- |
| `AADSTS7000215: Invalid client secret provided` | The secret is wrong, or you copied the Secret ID instead of the Value | Create a new secret and copy the **Value** column |
| `AADSTS700027` or `invalid_client` with a certificate | The certificate the shim is using is not the one uploaded to Entra | Re-upload `missivus.crt`; check `certificate.path` points at the PEM holding **both** the key and the certificate |
| `AADSTS90002: Tenant … not found` / `AADSTS900023` | Wrong tenant ID | Recopy **Directory (tenant) ID** from the Overview page |
| `AADSTS700038: … not a valid application identifier` | Wrong client ID | Recopy **Application (client) ID** from the Overview page |
| `ErrorAccessDenied` / `Access is denied` on send | The application access policy does not cover this mailbox, or admin consent was never granted | Re-run `Test-ApplicationAccessPolicy` from Part 5; re-check the green tick in Part 2 |
| `MailboxNotEnabledForRESTAPI` | The sender address is not a real Exchange Online mailbox | Check the shared mailbox exists and the address is spelled right |
| `The mailbox is either inactive, soft-deleted, or is hosted on-premise` | The mailbox has not finished provisioning | Wait fifteen minutes and try again |
| `certificate file is not readable at …` | File permissions | `chown` and `chmod 640` the PEM for the shim's user, and check the path |
| `the private key … could not be loaded` | Wrong passphrase, or the PEM has no `PRIVATE KEY` block | Rebuild the PEM: `cat missivus.key missivus.crt > missivus.pem` |
| `ECONNREFUSED 127.0.0.1:2525` in Ghost's log | Ghost cannot reach the shim | Start the shim; check host/port match on both sides (and the Docker network) |
| `Missivus is not configured: missing …` | The shim started without its settings | The message names the missing part; set it and restart the shim |
| Emails arrive from the old route, no error | Ghost's `mail.transport` still points at your previous SMTP | Point `mail.options.host`/`port` at the shim and restart Ghost |

The shim writes every failure to its stderr as `[missivus] ERROR …` and answers Ghost with the
same text, so the Microsoft error appears in **both** logs. Secrets are redacted before anything
is logged anywhere.

If Entra rejects the certificate assertion with a signature error and you have checked everything
above, set `MISSIVUS_CERTIFICATE_ALGORITHM=RS256` in the shim's environment. Missivus signs with
PS256 by default, which is what Microsoft's current documentation specifies; RS256 is the older
algorithm that Entra also accepts. This should not be necessary — please open an issue if it is.

---

## Keeping it working

- **Diary the credential expiry.** A certificate or secret that expires stops mail dead. Replace it
  a week early: upload the new certificate, change the path, test, then delete the old one from
  Entra.
- **After a Ghost upgrade**, send yourself one password-reset email. `PLAN.md` lists exactly which
  Ghost behaviours the shim depends on if something does break — the wiring is Ghost's own SMTP
  config, which is as stable as Ghost surfaces get.
- **To turn it off**, point Ghost's `mail` config back at your previous SMTP settings and restart
  Ghost. The shim holds no state; stop the process and it is gone.

---

## Getting help

Open an issue at
<https://github.com/Solvetus/missivus-ghost/issues>. Never paste a client secret,
a certificate, or a PEM file into an issue.

If you would rather have this set up for you, [Solvetus](https://solvetus.com) does paid
installation and support.
