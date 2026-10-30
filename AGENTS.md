# AGENTS.md: guide for AI coding agents working on zeronoise

This repo is shared by several AI coding agents (OpenAI Codex, the Grok Bot agent) and one human owner.
Read this first. If something here conflicts with a request, ask the owner in your PR description.

## What this is

- **zeronoise** (formerly CamChat) is the live chat site at https://chat.nano11bravo.com:
  room-based webcam, voice and text chat. The npm package is still named `camchat`.
- **Client:** React 18 + Vite (`src/`, `index.html`, `public/`).
- **Server:** Node 22.13+ + Express + Socket.IO (`server/`). Media is a WebRTC mesh; the server
  only relays signaling. In production one process on port 3000 serves the API, WebSocket and built SPA.
- **Database:** SQLite through `node:sqlite` (`server/db.ts`), file `camchat.db` in `DATA_DIR` (`./data` locally).
- **Native shells** load the live site; they contain no chat code. App id `com.nano11bravo.camchat`
  (`native/config.json`). See `NATIVE_APPS.md`.
  - `native/mobile`: Capacitor (iOS + Android).
  - `native/desktop`: Electron (Windows).

## Repo layout

| Path | What lives there |
|---|---|
| `src/` | React client (`App.tsx`, `components/`, `rtc.ts`, `socket.ts`, `styles.css`, ...) |
| `server/` | Express + Socket.IO server, entry `server/index.ts`; DB and migrations in `server/db.ts` |
| `shared/` | Types and logic used by both client and server; `shared/changelog.json` feeds `/updates` |
| `scripts/` | Test suites (`test-*.mjs`, `*-check.mjs`), `run-all.sh`, `make-release.sh`, admin CLIs |
| `deploy/` | Production upgrade script, signing docs, Caddyfile, coturn and env helper scripts |
| `native/` | Capacitor mobile and Electron desktop shells |
| `docs/` | Bot moderation API (`bot-moderation-api.md`), load test notes |
| `bridge-kit/` | Example bot/webhook bridge (`bridge.mjs`, `webhook-verify.lua`) |
| `downloads/` | Public download page assets (binaries here are git-ignored) |

## Install, run, build, test

```bash
npm install
npm run dev          # server on :3000 (tsx watch) + Vite on :5173 with proxy -> http://localhost:5173
npm run build        # typecheck client + Vite build (dist/client) + server compile (dist/server)
npm run typecheck
npm start            # production mode on http://localhost:3000, database in ./data
```

Individual suites (see `package.json` and README "Tests"; run `npm run build` first):

```bash
npm run test:api                                # starts its own server + temp DATA_DIR
npm run test:signaling -- http://localhost:3000 # needs a running server
npm run test:browser -- http://localhost:3000   # puppeteer; set CHROME_PATH if needed
npm run test:markdown
npm run test:ui
npm run test:pwa
```

**Full suite:** `scripts/run-all.sh <log dir>` runs build, typecheck and every suite in parallel
lanes and writes `<log dir>/summary.txt`. It takes about 8-9 minutes and needs Chrome for the
browser suites. It exits non-zero if any suite fails. Run it before asking for a release.
Note: the `sig-rollback` lane needs `ssh-keygen`; without it that one test fails/skips.

## Database migrations

- Migrations are the append-only `MIGRATIONS` array in `server/db.ts`; `PRAGMA user_version` tracks progress.
- The latest is **53** (recurring room events). Each entry has a `// NN ...` comment.
- **Add new numbered migrations at the end only. Never edit, reorder or delete a shipped migration.**
- Migrations from 16 on run idempotently (the live DB may already have some objects), so write
  them as `CREATE TABLE IF NOT EXISTS` / safe `ALTER`s.
- If two branches both add migration 54, the second one to merge must renumber. Say so in the PR.

## Changelog (/updates)

- Every user-facing release adds one entry at the **top** of `shared/changelog.json` (newest first).
- Fields: `id` (unique), `date` (YYYY-MM-DD, Eastern time), `title`, optional `period`, and
  `sections` of short items. The `about` field in the file is the source of truth for the format.
- Plain, user-facing language. No secrets, server names, addresses, file paths or signing details.
- Docs-only or internal changes do not get an entry.

## Collaboration rules

- **`main` always equals what is live in production.** It only moves when a release is deployed.
- Work on your own branch. Codex: use the prefix `codex/` (e.g. `codex/room-search`).
- Small, focused commits with clear messages. Open a pull request to `main`.
- Do not push directly to `main`. Do not force-push. Do not rewrite published history.
- Do not edit another agent's branch. `cursor/*` branches belong to the Grok Bot agent.
- Coordinate in the PR description: what changed, migrations added (numbers), tests run and results,
  anything that needs the owner. Check open PRs/branches first so two agents don't build the same thing.
- One feature per PR where possible; rebase/merge `main` into your branch rather than the reverse.

## Release process (for awareness: agents do not do this)

1. A tested commit is packed with `scripts/make-release.sh` into `camchat.tar.gz` plus `.sha256`.
2. The **owner** signs it on their PC with the release key (`deploy/sign-release.ps1`,
   `deploy/RELEASE-SIGNING.md`), producing `.sig`.
3. The owner copies the files to the server and runs `deploy/camchat-upgrade.sh` as root.
   Rollback: `--rollback` (restores code and database) or `--rollback --keep-db` (code only).
4. `/api/health` and `/status` then report the live package and commit.

Before any release: the full suite passes, an upgrade test from the currently live version
passes with both rollback modes, and visual checks pass at 1366, 390 and 360 px widths.

**Agents never deploy, never run sudo, never connect to or change the production server.**

## Hard rules

- Never commit secrets: `.env` files, tokens, API keys, passwords, keystores (`*.jks`, `*.keystore`,
  `*.p12`), signing keys or release keys.
- Never commit build output or binaries: APK, AAB, zip, exe, `tar.gz`, `dist/`, `node_modules/`.
- Native app versions stay at **1.2.1** (`native/mobile`, `native/desktop`) for site-only changes.
  Don't bump them unless the owner asks.
- Don't change `deploy/camchat-upgrade.sh`, release signing or signature verification without the
  owner's explicit sign-off.
- Keep the bot API (`docs/bot-moderation-api.md`) and room webhook payload formats backward
  compatible; existing bots and bridges must keep working. Add fields, don't rename or remove them.

## Known caveats

- Mesh video gets heavy at about 6-8 broadcasters per room (`LIMITS.maxBroadcastersPerRoom`).
- Live presence is in memory: after a restart users reconnect automatically but must restart their cam.
  Cam blocks from "Turn cam off" also reset on restart; mutes and bans persist.
- Google sign-in is implemented but untested with real credentials.
- The iOS project has not been compiled and the native apps have not been tested on real devices
  (see "What was not verified here" in `NATIVE_APPS.md`).
