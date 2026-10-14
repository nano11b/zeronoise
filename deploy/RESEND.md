# Resend for zeronoise

Mail is sent through the Resend HTTP API when `RESEND_API_KEY` and `MAIL_FROM` are both set. The from address is `zeronoise <no-reply@mail.nano11bravo.com>`. SMTP remains a fallback. `deploy/mail-env.sh` writes the three variables into `/etc/camchat.env` and restarts `camchat`.

## Domain

1. In Resend, add the domain `mail.nano11bravo.com`.
2. Resend shows the records for that send subdomain. Add them in Cloudflare as **DNS only** (grey cloud, not proxied):
   - DKIM: the TXT record Resend shows
   - SPF: the MX and TXT records Resend shows on the send subdomain
3. Add a DMARC TXT on `_dmarc.nano11bravo.com`:

   ```
   v=DMARC1; p=none
   ```

   `p=none` only collects reports. Tighten it after mail is flowing.
4. Wait until Resend marks the domain verified, then run `sudo bash deploy/mail-env.sh`. `/api/health` should report `"mail": true` and must not include the API key.
5. Leave `EMAIL_VERIFY_REQUIRED` off until a real confirmation arrives in an inbox. Then set it to `1` with the same script. Admins are not blocked either way.

## Free tier

The free plan is 100 emails per UTC day and 3,000 emails per month (sent and received both count; each To, Cc, or Bcc recipient counts separately). The dashboard shows the live quota. Confirmation and password-reset mail share that quota with anything else the key sends.
