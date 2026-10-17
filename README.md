# zeronoise

**v3** adds friends & 1:1 calls, screen share, signup CAPTCHA, password reset, stronger room moderation (lock / slow mode / purge), and audio playback hardening.

Room-based webcam, voice and text chat. Browse public rooms with live user counts, chat, and
broadcast camera/mic to everyone in the room over WebRTC. An account with an email is required.
Moderators get in-room tools and a mod panel.

- **Server:** Node 22 + Express + Socket.IO (TypeScript) - rooms, chat, presence, WebRTC signaling,
  accounts, moderation; SQLite via the built-in `node:sqlite` (no native modules to compile)
- **Client:** React + Vite (TypeScript) - lobby, room UI, WebRTC full mesh (perfect negotiation), mod panel
- **Production:** one process, one port (3000) serving the API/WebSocket and the built SPA

## Features

**Chat & video** - nickname validation (2-20 chars, letters/digits/`_`/`-`); rooms with live user and
broadcaster counts; create rooms; text chat with timestamps and join/leave notices; the last 100
messages per room are stored and shown on join; **markdown** in chat/PMs (bold, italic, code, strike,
links, lists, quotes) sanitized client-side (no raw HTML); emoji picker + optional `:shortcode:`
expansion; GIF search (Tenor/Giphy, server proxy) when an API key is set; emoji reactions on messages; image uploads (JPEG/PNG/WebP/GIF, max 2 MB) stored in `DATA_DIR/uploads`; user list with cam/mic/owner/role badges; independent camera and mic toggles; video grid,
click to enlarge, per-user local mute; private 1:1 messages; client-side ignore; registered users pick a **chat name color** (curated palette) and optional **avatar** (128×128 WebP under `DATA_DIR/avatars/`).

**Accounts** - register / sign in with username, email and password (bcrypt, cost 11). Sessions are
random 256-bit tokens in an `HttpOnly; SameSite=Lax` cookie (`Secure` automatically over HTTPS); only an
HMAC of the token is stored. Names like `admin`, `moderator` and `system` are reserved. Accounts can
go on cam and create persistent rooms (max 3 each; staff unlimited). Optional Google sign-in stores
Google's email and marks it verified only when Google says `email_verified`. Discord stays on the
`identify` scope, so those accounts add an email by hand. The address is visible only to the account
and to moderators on the Users tab.

**Email confirmation** - registration stores a trimmed address (`email_lower` is the unique key) and
mails a 60-minute link plus a 6-digit code. `EMAIL_VERIFY_REQUIRED=1` (and a configured sender) blocks
non-admins from rooms until the address is confirmed. With the switch off, or with no sender, the
address is still required and a dismissible banner asks them to confirm. Admins are never blocked.
A missing email always blocks a non-admin. The device cookie `camchat_did` is only for bans and rate limits.

**Moderation** - roles `admin` > `moderator` > `user` > `guest`:
- Site-wide bans by **account**, **IP** and **device** (random id kept in localStorage *and* an
  httpOnly cookie - either one matches), timed or permanent, with reason and who banned. Checked on
  socket connect, login and register; live sockets of a newly banned user are disconnected at once.
  Staff accounts are exempt from IP/device bans (not account bans) so a shared IP can't lock mods out.
- Room owners and mods: kick (10-minute block), room ban (timed or until lifted), set the room topic,
  delete non-built-in rooms. Owners can't act on mods; mods can't act on other mods or admins.
- Mods: force a user's cam off (blocks restarting it for 5 min), delete messages, mute in chat
  (5/15/60 min presets, up to 7 days via API), site ban.
- Report button on users (user list menu) and messages (hover ⚑). Reports store the reporter, target
  account/IP/device, the message and the last 10 messages of the room as context.
- Mod panel at **`/admin`**: open/resolved/dismissed reports (resolve, dismiss, reopen, *ban user*
  from a report), active bans (add by username/IP/device, unban), user search, role changes (admins
  only; can't change your own role or remove the last admin), and the moderation action log.
- Word filter (masks listed words: `shit` -> `s***`) for chat, PMs, topics; blocks filtered words in
  nicknames and room names. Configure with `WORD_FILTER` / `WORD_FILTER_FILE` or `shared/config.ts`.
- Rate limits: per socket *and* per client IP (chat, actions, signaling), connection cap per IP
  (`MAX_CONN_PER_IP`, default 10) and 30 new connections/min per IP, login/register attempts per IP
  (20 / 10 min) and per username (10 / 15 min), 5 new accounts per IP per hour, 5 reports per 10 min.

**Security** - CSRF: state-changing API calls require same-origin JSON plus an `X-CSRF: 1` header and an
allowed `Origin`; the Socket.IO handshake rejects foreign Origins (cross-site WebSocket hijacking).
Client IP: `CF-Connecting-IP` is used only when the TCP peer is a trusted proxy (`TRUST_PROXY`);
otherwise `X-Forwarded-For` is walked through trusted hops only, falling back to the socket address.
Chat markdown is rendered only after DOMPurify sanitization (no scripts/`javascript:` links); system
messages stay plain text. Control/bidi characters stripped, 64 KB socket
payload cap, `X-Frame-Options: DENY`, signaling relayed only between members of the same room.

Native iPhone, iPad, Android, and Windows apps live in `native/` and are documented in [NATIVE_APPS.md](NATIVE_APPS.md). They load this site; they are not a second copy of the client. A public download page at `/download` serves the Android APK and Windows zip from `DATA_DIR/downloads` (on the Debian box, `/var/lib/camchat/downloads`). That directory is outside the app tree, so upgrades do not delete the binaries.

## Project layout

```
shared/config.ts     <- app name, tagline, all limits, guest policy, word list, reserved names, default rooms
shared/colors.ts     <- curated chat nick color palette + avatar size limits
shared/types.ts      <- typed Socket.IO protocol + admin API types shared by client and server
server/index.ts      <- Socket.IO: rooms, chat, presence, signaling, moderation events
server/http.ts       <- Express: /api/me, /api/ice (TURN creds), auth, Google OAuth, /api/admin/*
server/db.ts         <- SQLite connection + migrations;  server/repo.ts <- all queries
server/env.ts        <- environment variables;  server/net.ts <- client IP, cookies, Origin checks
src/                 <- React client (rtc.ts = WebRTC mesh, components/AdminPanel.tsx = mod panel)
scripts/             <- test-api, test-signaling, browser-test, make-admin, dev-turn
deploy/              <- turnserver.conf (coturn, use-auth-secret), camchat-upgrade.sh, Caddyfile
native/              <- iOS, Android, and Windows shells (see NATIVE_APPS.md)
```

## Run locally

Requires **Node 22.13+** (for `node:sqlite`).

```bash
npm install
npm run dev          # server on :3000 (tsx watch) + Vite on :5173 with proxy -> open http://localhost:5173
```

Production build:

```bash
npm ci && npm run build   # typecheck + Vite build (dist/client) + server compile (dist/server)
npm start                 # http://localhost:3000, database in ./data
```

### Environment variables

The app reads the process environment (it does not load `.env` itself; docker compose does, systemd
uses `/etc/camchat.env`). See `.env.example`.

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / all | listen address |
| `DATA_DIR` | `./data` | SQLite database (`camchat.db` + WAL files) - **back this up** |
| `SESSION_SECRET` | generated | HMAC key for session tokens. If unset, a random one is created in `DATA_DIR/.session_secret` |
| `PUBLIC_URL` | - | e.g. `https://chat.nano11bravo.com`; allowed Origin + Google redirect base |
| `TRUST_PROXY` | `loopback` | proxies whose `CF-Connecting-IP` / `X-Forwarded-*` are believed (Express syntax, e.g. `loopback,uniquelocal`) |
| `COOKIE_SECURE` | auto | `true`/`false` to force the cookie `Secure` flag (auto = when the request came over HTTPS) |
| `ADMIN_USERNAMES` | - | comma list; these accounts become admin at register/login/startup |
| `GUEST_CAM_AFTER_MINUTES` | `-1` | `-1` guests can't cam, `0` can, `N` after N minutes |
| `REGISTRATION` | open | `closed` disables new accounts |
| `MAX_CONN_PER_IP` | `10` | simultaneous sockets per IP |
| `REGISTRATIONS_PER_IP_PER_HOUR` | `5` | new accounts per IP per hour |
| `SESSION_DAYS` | `30` | session lifetime |
| `WORD_FILTER` / `WORD_FILTER_FILE` | built-in list | comma list (empty = off) / file with one word per line |
| `TURN_URLS` | - | comma list, e.g. `turn:turn.nano11bravo.com:3478,turn:turn.nano11bravo.com:3478?transport=tcp,turns:turn.nano11bravo.com:5349` (`TURN_URL` still accepted) |
| `TURN_SECRET` | - | coturn `static-auth-secret`; enables time-limited credentials |
| `TURN_TTL` | `21600` | credential lifetime in seconds (6 h) |
| `TURN_USER` / `TURN_PASS` | - | static TURN credentials, used only when `TURN_SECRET` is not set |
| `STUN_URLS` | Google STUN | comma list; empty string disables STUN |
| `RTMP_PUBLIC_HOST` | `rtmp.nano11bravo.com` | hostname Meld uses for Custom RTMP (`rtmp://HOST:PORT/live`). Not the Cloudflare web tunnel. |
| `RTMP_PORT` | `1935` | RTMP listen port, bound on all interfaces. Forward TCP here yourself; the app does not open firewall ports. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | - | enable "Continue with Google" |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | - | enable "Continue with Discord" |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | - | enable "Sign in with TikTok". Redirect URI is `PUBLIC_URL` + `/auth/tiktok/callback`. See [deploy/TIKTOK.md](deploy/TIKTOK.md). |
| `CONTACT_EMAIL` | - | address shown on `/terms` and `/privacy`. Unset: those pages say to contact a moderator in the app. |
| `TENOR_API_KEY` | - | GIF search via [Tenor](https://developers.google.com/tenor) (preferred). Key stays on the server. |
| `GIPHY_API_KEY` | - | GIF search via [Giphy](https://developers.giphy.com) if Tenor is unset (or as fallback). |
| `CORS_ORIGIN` | same-origin | extra allowed origins |
| `NATIVE_AUTH_SCHEME` | `camchat` | custom URL scheme the native apps use to finish Google/Discord sign-in. See [NATIVE_APPS.md](NATIVE_APPS.md). |

`localhost` counts as a secure context, so camera/mic work locally over plain HTTP. Anywhere else
**browsers only allow camera/mic on HTTPS**.

### Tests

```bash
npm run build
npm run test:api                                    # 93 checks; starts its own server + temp DATA_DIR, restarts it once
npm run test:signaling -- http://localhost:3000     # 33 protocol checks against a running server
CHROME_PATH=/usr/bin/google-chrome npm run test:markdown   # safe markdown / sanitize contract
npm run test:browser -- http://localhost:3000 shot.png admin.png
```

- **test:api** covers CSRF/Origin checks, register/login/logout, email confirmation and password reset,
  reserved names, rate limits, word filter, message history, room persistence and
  100-message pruning across a restart, reports with context, mod actions (force cam off + block,
  delete message, mute, topic), room kick/ban, role checks (non-mods rejected, mods can't touch
  admins, only admins change roles), bans by account / IP / device (connect, login, register refused;
  live socket ended; unban), the per-IP connection cap, `/api/ice` HMAC credentials, the make-admin
  CLI and client-IP resolution.
- **test:signaling** registers one throwaway account per run (so it can cam; it stays in the DB), deletes its test room at the end, and uses a random
  `CF-Connecting-IP`, so the server must trust the loopback proxy (the default).
- **test:browser** registers Alice, Bob and Carol through the UI and verifies real video/audio, mute/enlarge/cam toggles, XSS escaping, and the
  report button. With `ADMIN_USERNAME=<name in the server's ADMIN_USERNAMES>` it also forces Bob's cam
  off from the user menu and screenshots `/admin`. `FORCE_RELAY=1` makes the browsers use TURN relay
  candidates only. To test TURN locally with time-limited credentials:

  ```bash
  npm i --no-save node-turn
  TURN_SECRET=dev-secret node scripts/dev-turn.mjs 3478 &
  TURN_SECRET=dev-secret TURN_URLS=turn:127.0.0.1:3478 ADMIN_USERNAMES=Boss_Admin npm start &
  ADMIN_USERNAME=Boss_Admin FORCE_RELAY=1 npm run test:markdown   # safe markdown / sanitize contract
npm run test:browser -- http://localhost:3000
  ```

## Admins and moderators

1. Register your account on the site.
2. Make it admin, either way:
   - add it to `ADMIN_USERNAMES` (comma list) and restart - it is (re)promoted at every login/startup; or
   - run the CLI against the data directory (as the service user on the server):
     ```bash
     npm run make-admin -- <username>                       # local, DATA_DIR=./data
     sudo -u camchat env DATA_DIR=/var/lib/camchat node /opt/camchat/scripts/make-admin.mjs <username>
     node scripts/make-admin.mjs <username> --role moderator   # or --role user to demote
     # Two-factor (TOTP) is opt-in for everyone and required for an admin once that admin turns it on.
     # Lost phone and no recovery codes: the server owner turns it off from the shell:
     sudo -u camchat env DATA_DIR=/var/lib/camchat node /opt/camchat/scripts/reset-2fa.mjs <username>
     ```
   Reload the page afterwards (roles are read when the socket connects).
3. Promote moderators from the mod panel (`/admin` -> Users -> role). Changes apply live.

Accounts in `ADMIN_USERNAMES` get admin back at their next login even if demoted in the panel; remove
them from the list to demote permanently.

### Moderation guide

- **In a room**, click a name: *Report…*, and (owner/mod) *Kick* (10 min), *Ban from room…*;
  (mods) *Turn cam off* (5-minute cam block), *Mute in chat…*, *Site ban…*. Hover a message for
  ⚑ report and (mods) 🗑 delete. Owners and mods can click ✎ next to the topic, and delete user rooms.
- **Site ban** from a room bans the account (if registered), current IP and device. Prefer timed bans
  for IPs: mobile carriers and CGNAT share addresses. Device bans stop most casual ban evasion but a
  determined user can clear storage and switch networks.
- **Mod panel** `/admin`: work through *Reports* (open the chat context, then Resolve, Dismiss, or
  Ban user… which bans account/IP/device captured at report time and resolves the report). *Active
  bans* lists and lifts bans and can add bans by username / IP / device id. *Users* searches accounts
  (admins change roles there). *Action log* records every mod action (kept 1 year).
- **Bot API** for game servers and scripts (no login): HTML at `/docs/bots`, the same page as Markdown at `/docs/bots.md`. Create the bot under Your profile → Chat bots. The room creator allows it from the room's three-lines menu → Bots. `/llms.txt` points at the Markdown.
- **Moderator bot**: admins pick one existing chat bot (or None) under *Moderator bot* on `/admin`.
  That bot can kick, room-ban, site-ban, and unban in every room. Every other bot can send
  messages, and can read rooms it has been allowed in. The bot cannot act on an admin or on itself. The same action log records each action.
  Set it from the shell after deploy (the bot must already exist in that database):
  ```bash
  sudo -u camchat env DATA_DIR=/var/lib/camchat node /opt/camchat/dist/server/set-moderator-bot.js Meowington
  ```
  See [docs/bot-moderation-api.md](docs/bot-moderation-api.md) for the bearer API.
- Muted users can still watch and use cam/mic; they can't chat or PM.
- Force cam off relies on the user's browser honouring it (media is peer-to-peer). Everyone else's
  client hides the video immediately because the server marks the user's cam off; for a tampered
  client, follow up with a kick or ban.



## v3 features

### Friends & 1:1 calls
Signed-in users can add friends by username (request / accept / decline). Online friends show a **Call** button that opens a private room (hidden from the lobby). Accept/decline via the incoming-call banner.

### Screen share
In a room, **Share** uses `getDisplayMedia` and `replaceTrack` on the existing sendonly video transceiver (same glare-safe path as the camera). Stop sharing restores the previous camera track when it was on.

### Signup CAPTCHA
`GET /api/auth/captcha` issues a built-in math challenge (or Turnstile/hCaptcha when env keys are set). Registration requires a valid answer/token.

### Password reset
- User: **Forgot password?** accepts a username or email and returns a generic reply.
- If that account has a verified email, the 60-minute link is mailed there.
- Mod/admin: Users tab → **Issue reset** still copies a one-time link.
- Link: `/reset?token=…` → set a new password.
- Resend (`RESEND_API_KEY` + `MAIL_FROM`) is the primary sender. SMTP (`SMTP_HOST`, `SMTP_PORT` 587 with STARTTLS or 465 with implicit TLS, `SMTP_FROM`) is the fallback. `SMTP_NOTIFY_EMAIL` still gets an operator copy when SMTP is configured.
- See `deploy/RESEND.md` and `deploy/mail-env.sh`.

### Stronger moderation
Room owner/mod: **Lock**, **Slow mode** (cycles presets), **Purge** (soft-delete recent messages). Timed mutes and the moderation audit log remain. IP/device bans stay visible in `/admin` → Bans (kind + value).

### Delete test accounts
```bash
npm run delete-test-users -- 'zz_test_%' --yes
# server:
sudo -u camchat env DATA_DIR=/var/lib/camchat CONFIRM=1 node /opt/camchat/scripts/delete-test-users.mjs 'zz_test_%' --yes
```

### Audio notes (v3)
- Remote tiles re-`play()` on `MediaStream` `addtrack` / track `unmute` (helps after renegotiation).
- First pointer gesture resumes `AudioContext` and plays videos (`unlockAudio`).
- Mic capture keeps `echoCancellation` / `noiseSuppression` / `autoGainControl`.
- Screen share does not open a new m-line (avoids glare regressions on audio/video).

## Deploy

### Current setup (Debian 13, systemd, Cloudflare Tunnel)

The app runs as `camchat.service` (user `camchat`, code in `/opt/camchat`, env in `/etc/camchat.env`,
data in `/var/lib/camchat`) behind a Cloudflare Tunnel for `https://chat.nano11bravo.com`. The unit
uses `ProtectSystem=strict`, so the data directory must be allowed with a drop-in:

```ini
# /etc/systemd/system/camchat.service.d/10-camchat-data.conf
[Service]
ReadWritePaths=/var/lib/camchat
```

`deploy/camchat-upgrade.sh` does a whole upgrade as root: builds the new version in `/opt/camchat.new`
as `camchat` (`npm ci && npm run build`), creates `/var/lib/camchat`, adds `DATA_DIR`,
`SESSION_SECRET` (random) and `PUBLIC_URL` to `/etc/camchat.env` if missing, installs the drop-in,
swaps directories (old one kept as `/opt/camchat.bak-<timestamp>`), restarts and health-checks
(`/api/health` with DB, `/api/me`, Socket.IO handshake with the public Origin). If the health check
fails it rolls back automatically.

```bash
scp camchat.tar.gz deploy/camchat-upgrade.sh manager@10.0.10.55:
ssh -t manager@10.0.10.55 'sudo bash /home/manager/camchat-upgrade.sh'
```

Keep `TRUST_PROXY=loopback,uniquelocal` (set in the unit) so `CF-Connecting-IP` from cloudflared is
believed. If cloudflared runs somewhere other than this host or the LAN, add its address.

### Other hosts (Caddy / Docker)

- **Docker:** `docker compose up -d --build` (data in the `camchat-data` volume, binds `127.0.0.1:3000`).
- **Caddy:** copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, set the domain, `systemctl reload caddy`.
  Caddy sets `X-Forwarded-For` from loopback, which the default `TRUST_PROXY=loopback` trusts.

### Backups of DATA_DIR

Everything durable (accounts, sessions, rooms, messages, bans, reports, mod log) is in
`DATA_DIR/camchat.db` (+ `-wal`/`-shm` files while running) and `DATA_DIR/.session_secret` if you didn't
set `SESSION_SECRET`. Take a consistent online copy with SQLite's backup (safe while running):

```bash
sudo -u camchat node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/var/lib/camchat/camchat.db');d.exec(\"VACUUM INTO '/var/lib/camchat/backup-\"+new Date().toISOString().slice(0,10)+\".db'\")"
```

or stop the service and copy the directory (`systemctl stop camchat; tar czf camchat-data.tgz -C /var/lib camchat; systemctl start camchat`).
A daily cron/systemd timer with `VACUUM INTO` plus copying the file off the machine is plenty. To
restore: stop the service, replace `camchat.db` (delete stale `-wal`/`-shm`), `chown camchat:`, start.
Pruning runs every 10 minutes (100 messages per room, expired sessions/mutes/room bans, mod log > 1 year).

## TURN relay (coturn) - needed for real-world users

STUN alone works when both peers have friendly NATs. Users on mobile networks, corporate networks or
symmetric NAT see *connecting…* forever without a TURN relay.

**Cloudflare can't carry TURN.** The tunnel/proxy only handles HTTP(S)/WebSocket, not TURN's UDP/TCP
on 3478/5349 and the relay port range. TURN needs its own **DNS-only (grey cloud)** record pointing
at your public IP, and router port forwards to the server.

### Time-limited credentials

With `TURN_SECRET` + `TURN_URLS` set, `GET /api/ice` returns coturn REST-API credentials:
`username = "<unix expiry>:<id>"` (id = `u<account id>` or `g<hash of device id>`), `credential =
base64(HMAC-SHA1(TURN_SECRET, username))`, valid for `TURN_TTL` (6 h). The browser refreshes them at
half the TTL. Nothing long-lived reaches the browser, and credentials are only issued to browsers with
a device cookie or session that aren't banned (30 requests/min per IP). Without `TURN_SECRET`, the static
`TURN_USER`/`TURN_PASS` pair is used (visible to every visitor - avoid in production).

### coturn on the Debian server (10.0.10.55)

1. **DNS** (Cloudflare dashboard): `A turn.nano11bravo.com -> <your public IP>`, **proxy status: DNS only
   (grey cloud)**. If your home IP is dynamic, keep it updated with a DDNS client (e.g. `ddclient` with
   the Cloudflare API) and update `external-ip` when it changes.
2. **Router port forwarding** to `10.0.10.55`:
   - `3478` UDP **and** TCP (TURN)
   - `5349` TCP (TURN over TLS, `turns:`) - optional but helps on networks that block UDP
   - `49160-49200` UDP (relay range; widen it in both places for more simultaneous relayed streams)
   If the server runs a host firewall, open the same ports there.
3. **Install and configure** (not done automatically):
   ```bash
   sudo apt install coturn
   SECRET=$(openssl rand -hex 32)
   sudo cp /opt/camchat/deploy/turnserver.conf /etc/turnserver.conf
   sudo sed -i "s/^static-auth-secret=.*/static-auth-secret=$SECRET/; s#^external-ip=.*#external-ip=$(curl -s https://api.ipify.org)/10.0.10.55#" /etc/turnserver.conf
   sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
   sudo systemctl enable coturn && sudo systemctl restart coturn   # restart: apt already started it with the stock config
   printf 'TURN_SECRET=%s\nTURN_URLS=turn:turn.nano11bravo.com:3478,turn:turn.nano11bravo.com:3478?transport=tcp\n' "$SECRET" | sudo tee -a /etc/camchat.env >/dev/null
   sudo systemctl restart camchat
   ```
   `external-ip=PUBLIC/PRIVATE` is essential behind NAT: coturn must advertise the public address in
   relay candidates while binding the LAN one.
4. **TLS (optional, `turns:` on 5349):** get a real certificate for `turn.nano11bravo.com` (e.g. certbot
   with the Cloudflare DNS-01 plugin, since the name is grey-clouded you can also use HTTP-01 if port 80
   is forwarded), set `cert=`/`pkey=` in `/etc/turnserver.conf`, make the files readable by the
   `turnserver` user, restart coturn, and add `turns:turn.nano11bravo.com:5349` to `TURN_URLS`.
5. **Test:** open https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ , add
   `turn:turn.nano11bravo.com:3478` with a username/credential from `https://chat.nano11bravo.com/api/ice`
   (open it in a browser that has visited the site) and click *Gather candidates* - you should see
   `relay` candidates with your public IP. In the app, `localStorage.setItem('camchat.relay','1')` in
   the browser console forces relay-only connections (remove it afterwards).

The relay config denies private/loopback peers so the TURN server can't be used to reach your LAN.
Relay bandwidth: each relayed stream is ~0.5-1.5 Mbps through your home upload.

## Limits of the mesh design

Every broadcaster sends a separate copy of their stream to every other participant. With N people
in a room and B broadcasters, each broadcaster uploads (N-1) streams and each viewer downloads B.
At ~500 kbps per 640×480 stream this gets uncomfortable at **~6-8 broadcasters** (the default cap,
`LIMITS.maxBroadcastersPerRoom`), and upload bandwidth of the broadcasters is the bottleneck, not
the server. The server only relays signaling, so it is cheap to run.

### Upgrade path: SFU

For bigger rooms, replace the mesh with a Selective Forwarding Unit so each broadcaster uploads
once and the server fans out:

- **LiveKit** (Go, self-host or cloud): easiest. Keep this app for lobby/chat/presence, mint a
  LiveKit access token per user on `room:join`, and swap `src/rtc.ts` for `livekit-client`.
  You get simulcast, adaptive bitrate, built-in TURN, and recording.
- **mediasoup** (Node, lower-level): runs inside this Node server; you manage routers, transports,
  producers/consumers yourself and reuse Socket.IO for its signaling. More control, more work.

## Scaling Socket.IO horizontally

All room state is in memory in one process. To run several instances:

1. Add `@socket.io/redis-adapter` + `redis` and `io.adapter(createAdapter(pub, sub))` so
   `io.to(room).emit` reaches sockets on every node.
2. Move live presence (room members, nick registry, per-IP counters, cam blocks) from the in-memory
   `Map`s in `server/index.ts` to Redis, use `io.in(room).fetchSockets()` for presence, and move the
   SQLite database to Postgres (or keep SQLite on one node and route writes there).
3. Enable sticky sessions at the load balancer (needed for the HTTP long-polling fallback), or
   force `transports: ['websocket']` in `src/socket.ts`.

A single Node process comfortably handles thousands of idle chat sockets; the mesh video limit
above will bite long before the signaling server does.

## Renaming

The visible brand is `BRAND_NAME` in `shared/config.ts` (`zeronoise`). It flows into the page
title, the web app manifest, meta/og tags (via a Vite HTML transform), password-reset email, and
`/api/health`'s `app` field. The lockup is `public/logo-lockup.png`, the header wordmark is `public/logo-wordmark.png`, and the icon is `public/favicon.png`.
`APP_NAME` stays `CamChat` on purpose: it keys localStorage and the `camchat_sid` / `camchat_did`
cookies. Changing it would sign everyone out and drop saved device settings. `zeronoise` and `camchat`
are both reserved nicknames.
Change colors in the `:root` variables at the top of `src/styles.css`.
The npm package name stays `camchat`, and `realm=` in `deploy/turnserver.conf` stays `turn.nano11bravo.com`.

## Known limitations

- Mesh video: ~6-8 broadcasters per room (see above).
- One process: live presence is in memory; after a restart everyone reconnects automatically (accounts
  are signed back in by cookie) but broadcasters must restart
  their cam. Rooms, history, accounts, bans and reports persist.
- Force-cam-off, mutes and room bans can't stop a modified client from sending peer-to-peer media to
  someone who accepts it; honest clients hide it and a site ban removes the user.
- Cam blocks (from *Turn cam off*) are in memory and reset on restart; mutes and bans persist.
- IP bans can hit innocent users behind CGNAT/mobile carriers; device bans are evadable by clearing
  storage. There is no CAPTCHA; add Cloudflare Turnstile/WAF rules if bots show up.
- Password reset to an inbox needs `RESEND_API_KEY` and `MAIL_FROM`, or SMTP. Until a sender is configured, moderators still use **Issue reset**.
- Google sign-in is implemented but untested against real Google credentials; create an OAuth client
  with redirect URI `https://chat.nano11bravo.com/api/auth/google/callback` to enable it.

### Discord sign-in

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications) → **OAuth2**.
2. Add redirect URI: `https://chat.nano11bravo.com/api/auth/discord/callback` (plus `http://localhost:3000/api/auth/discord/callback` for local).
3. Copy **Client ID** and **Client Secret** into `/etc/camchat.env`:
   ```bash
   DISCORD_CLIENT_ID=your_client_id
   DISCORD_CLIENT_SECRET=your_client_secret
   ```
4. Restart the service: `sudo systemctl restart camchat`. The login page shows **Continue with Discord** when both are set. Scope used: `identify`. Discord does not share an email, so those accounts add one on the next screen. New users get a nick derived from their Discord username/`global_name`.

### TikTok sign-in

TikTok Login Kit (Web) uses the same pattern. The button appears only when `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` are set. TikTok does not share an email, so those accounts land on the same confirm-email screen as Discord. Setup, URL verification, and sandbox users are in [deploy/TIKTOK.md](deploy/TIKTOK.md). `deploy/tiktok-env.sh` writes the two variables on the server.
- `node:sqlite` is flagged experimental in Node 22 (the warning is suppressed); it has been stable
  for this workload. Node 22.13+ is required.
- The age/rules checkbox is informational only.
