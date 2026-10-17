# Outside uptime monitoring (batch F9)

The server emails admins (through the existing Resend setup on mail.nano11bravo.com) when errors spike, after a
crash restart and when the daily backup restore check fails. **It cannot email anyone while it is down**, so add a
free outside pinger as well.

## Endpoint

`GET` or `HEAD` `https://<your-domain>/api/uptime`, no login, never cached:

- `200` with body `OK` when the app and database answer
- `503` with body `DOWN database` when the database does not answer
- no answer / timeout when the process or the machine is down

(`/api/status` gives the same as JSON with backup and restore-check details; `/status` is the human page.)

## UptimeRobot (free plan)

1. Sign up at uptimerobot.com, then **+ New monitor**.
2. Monitor type: **Keyword**. URL: `https://<your-domain>/api/uptime`. Keyword: `OK`, alert when the keyword is **not present**.
3. Interval: 5 minutes. Timeout: 30 s.
4. Alert contacts: your email (and the mobile app for push, if you like). Optionally add a second contact.
5. Save. Use **Test notification** once to confirm the email arrives.

Other services work the same way (Better Stack, Healthchecks.io HTTP checks, Uptime Kuma on another machine):
probe `/api/uptime` and expect `200` + `OK`.

## Settings (optional, /etc/camchat.env)

- `ALERT_EMAILS=a@example.com,b@example.com` extra recipients (admins with a verified email always get alerts)
- `ALERT_ERRORS_THRESHOLD=25` and `ALERT_ERRORS_WINDOW_MS=300000` error-spike trigger (25 errors in 5 minutes)
- `ALERT_COOLDOWN_MS=1800000` at most one email per kind per 30 minutes
- `RESTORE_CHECK_DISABLED=1` turns the daily restore check off (it runs 30 minutes after the nightly backup)

Restart after editing: `sudo systemctl restart camchat`.
