import { uiThemeCss } from '../shared/uiTheme';
import { BRAND_NAME } from '../shared/config';

const UPDATED = 'October 16, 2026';

/**
 * Public regular-bot API. One string feeds /docs/bots and /docs/bots.md.
 * No moderator CLI, server paths, secrets, or internal hosts.
 */
export const BOT_API_MARKDOWN = `# zeronoise Bot API (for game servers, scripts, and AI agents)

Base URL: \`https://chat.nano11bravo.com\`

Machine-readable copy of this page: [/docs/bots.md](/docs/bots.md)

Bots use plain HTTPS and JSON. No Socket.IO, no cookies, no CSRF header. This page is for a normal chat bot. The site may designate one separate moderator bot; that bot is not documented here.

## 1. Get a token

1. Sign in on zeronoise, click your name chip (that opens **Your profile**), and under **Chat bots** create a bot (for example \`DriftZone\`).
2. A bot name is 2–20 characters, starts with a letter, and uses only letters, numbers, \`_\`, or \`-\`. An account can have up to 20 bots.
3. The \`bot_…\` token is shown **once**. Store it as a secret (env var or file), never in code or chat. Rotate or revoke it from the same **Chat bots** section. Rotating replaces the old token immediately.
4. The **room creator** must allow the bot. In that room, open the three-lines **More** menu, choose **Bots**, type the bot's display name (any capitalization), and click **Allow**. A revoked bot cannot be allowed. Built-in rooms such as Lobby have no creator, so create your own room. The allow list is saved. A private call has no Bots menu.

## 2. Authenticate

Send the token on every request:

\`\`\`
Authorization: Bearer bot_xxxxxxxxxxxxxxxx
\`\`\`

Check it works:

\`\`\`bash
curl -sS -H "Authorization: Bearer $BOT_TOKEN" https://chat.nano11bravo.com/api/bots/me
# {"ok":true,"id":12,"name":"DriftZone","owner":"Dreamer"}
\`\`\`

\`owner\` is the account username, or \`null\` if that account is gone. A missing header is **401** \`Missing bot token\`. An unknown token is **401** \`Unknown bot token\`. Too many unknown tokens from one IP is **429** \`Too many attempts. Try again later.\`

## 3. Room ID

The id is chosen when the room is created:

- Lowercase the name.
- Turn each run of characters that are not letters or digits into a single \`-\`.
- Remove a \`-\` at the start or end.
- If nothing is left, the id is \`room\`.
- If that id is already taken, or it would be \`lobby\`, the site appends \`-\` and four characters.

A room named \`driftzone\` has the id \`driftzone\`. \`Late Night\` becomes \`late-night\`. The built-in Lobby is \`lobby\`.

Do not guess when a suffix may have been added. \`GET /api/rooms\` needs no token and returns \`{"rooms":[{"id":"driftzone","name":"driftzone", ...}]}\`. Private calls are not in that list. Use \`id\`, not the display name, in the paths below.

## 4. Join, then send

\`\`\`
POST /api/bots/rooms/:roomId/join
POST /api/bots/rooms/:roomId/chat     body: {"text": "..."}
\`\`\`

\`\`\`bash
curl -sS -X POST -H "Authorization: Bearer $BOT_TOKEN" \\
  https://chat.nano11bravo.com/api/bots/rooms/driftzone/join

curl -sS -X POST -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"text":"🏁 Drift event started on Tsukuba"}' \\
  https://chat.nano11bravo.com/api/bots/rooms/driftzone/chat
\`\`\`

Success is \`{"ok":true}\` for both.

The bot can be in more than one room it is allowed in. Chat, GIFs, and reads use the room id in the path. Calling \`join\` when the bot is already in that room is harmless: it returns \`{"ok":true}\` and does not post another join line.

The join is saved on the server, so it survives a site restart or upgrade: the bot is back in the room after a restart without calling \`join\` again, and no new \`joined\` line is posted. The join ends when the room owner removes the bot from the room's Bots list, the room is deleted, or the bot's token is revoked or the bot is deleted. Regenerating the token keeps the join. If \`chat\` ever returns **403** \`Join the room first\` (for example after one of those), call \`join\` again and retry once. Bots that already re-join on every start keep working; the extra \`join\` is harmless.

### Message rules

- Plain text. The server stores at most **500 characters**. A body longer than 550 characters is rejected with **400** \`Max 500 characters\`. Empty or whitespace-only text is **400** \`Empty message\`.
- People in the room see a safe subset of markdown (\`**bold**\`, italic, code, links). Raw HTML is not rendered. Banned words are masked before the line is stored. \`GET .../messages\` returns that stored text, not HTML.
- The bot posts under its own display name. It has no cam, mic, screen share, or private messages.
- Rate limits on chat and GIF posts: **5 per 5 seconds per bot**, and **30 per minute per IP**. Over either limit the response is **429** \`Slow down\`. If the room has slow mode, the bot waits like everyone else: **429** \`Slow mode: wait Ns.\` (the \`N\` is whole seconds, rounded up, and the period is part of the string).
- Queue messages on your side, send at most about one every 1 to 2 seconds, and merge bursts (like many joins at once) into one line.

## 5. Send a GIF

\`\`\`
POST /api/bots/rooms/:roomId/gif     body: {"id":"<gif id>"}
\`\`\`

The id is 1–80 characters: letters, digits, \`_\`, or \`-\`. It is the id from GIF search, not a page URL. Search needs no bot token:

\`\`\`bash
curl -sS "https://chat.nano11bravo.com/api/gifs/search?q=cat"
# {"ok":true,"gifs":[{"id":"...","previewUrl":"...","url":"...","width":220,"height":140}]}
\`\`\`

Then post \`id\` with the bot token. The room shows the image. Join, slow mode, and the chat rate limits apply. **400** or **404** \`Unknown GIF\` means the id is not usable. **502** \`GIF search failed\` means the search provider failed. **503** \`GIF search is not configured\` means this site has no GIF provider.

## 6. Read messages (optional, for two-way chat)

\`\`\`
GET /api/bots/rooms/:roomId/messages?after=<message id>&limit=<1-100>
\`\`\`

- First call without \`after\` and without \`limit\`: returns \`messages: []\` and \`cursor\` set to the newest message id (or \`null\` when the room has no messages), so old history is not replayed. A deleted message can still be that cursor.
- Then poll every 1 to 2 seconds with \`after=<previous cursor>\`. Messages come oldest first. Each page is at most \`limit\` lines (default **50** when \`after\` is set). Save the new \`cursor\` each time. If the page is empty, \`cursor\` stays the \`after\` you sent.
- With no \`after\` and an explicit \`limit\`, the response is the last N non-deleted messages, oldest first.
- If the first cursor is \`null\`, keep calling with no \`after\` until a cursor shows up.
- Each message is \`{ id, ts, author, username, isBot, bot, text }\`. \`author\` is the name shown in the room. \`username\` is the account name, or \`null\` (bots have \`null\`). \`isBot\` is true when the site stored the line as a bot; \`bot\` is that bot's name, or \`null\`. **Skip lines where \`isBot\` is true** (including your own), or you will echo your own posts back into the game.
- **400** \`Unknown cursor\`: the id is not a message in that room, or it is longer than 80 characters. Drop the saved cursor and start over with a call that has no \`after\`. **400** \`Bad limit\`: \`limit\` is not an integer from 1 to 100.
- Limit: **120 reads per minute per bot**. That counts attempts after the token is accepted, including a 403. Reading does not need a join, only that the bot is allowed in the room.

## 7. Minimal Node example (FiveM server side)

\`\`\`javascript
const BASE = 'https://chat.nano11bravo.com';
const ROOM = 'driftzone';
const headers = { authorization: \`Bearer \${process.env.ZN_BOT_TOKEN}\`, 'content-type': 'application/json' };

async function join() {
  await fetch(\`\${BASE}/api/bots/rooms/\${ROOM}/join\`, { method: 'POST', headers });
}

const queue = [];
function say(text) { queue.push(String(text).slice(0, 500)); }

setInterval(async () => {
  const text = queue.shift();
  if (!text) return;
  let r = await fetch(\`\${BASE}/api/bots/rooms/\${ROOM}/chat\`, { method: 'POST', headers, body: JSON.stringify({ text }) });
  if (r.status === 403) { await join(); r = await fetch(\`\${BASE}/api/bots/rooms/\${ROOM}/chat\`, { method: 'POST', headers, body: JSON.stringify({ text }) }); }
  if (r.status === 429) queue.unshift(text); // try again next tick
}, 1500);

join();
// say(\`\${playerName} joined the server\`);
\`\`\`

### Game bridge kit

For a ready-made relay, download the **[game bridge kit](/docs/bots/bridge-kit.zip)** ([README](/docs/bots/bridge-kit/README.md) · [bridge.mjs](/docs/bots/bridge-kit/bridge.mjs) · [config.example.json](/docs/bots/bridge-kit/config.example.json)). It is one dependency-free Node script with a configurable poll/post loop: FiveM \`players.json\` joins and leaves, a log-file tail with a BeamMP preset, a local webhook for game resources, burst merging, 429/slow-mode backoff, re-join on 403, and optional chat-to-game delivery that skips bot lines. The token comes from \`ZN_BOT_TOKEN\` only.

## 8. Errors

The body is always \`{"ok": false, "error": "..."}\`.

| Status | error | What to do |
| --- | --- | --- |
| 401 | Missing bot token | Send \`Authorization: Bearer\` and the token |
| 401 | Unknown bot token | The token is wrong, rotated, or revoked |
| 403 | This bot is not allowed in that room | The room creator must allow the bot (More → Bots) |
| 403 | Join the room first | Call \`join\`, then retry |
| 403 | Bots cannot join a private call | Use a normal room |
| 403 | Room is full | Wait until someone leaves (50 people) |
| 404 | Room not found | Check the room id from \`GET /api/rooms\` |
| 409 | That name is in use | Someone connected is already using the bot's display name |
| 400 | Empty message | Send non-empty text |
| 400 | Max 500 characters | Shorten the text (bodies over 550 characters are rejected) |
| 400 | Bad limit | Use an integer from 1 to 100 |
| 400 | Unknown cursor | Drop \`after\` and start the read again |
| 400 | Unknown GIF | Use a search id of 1–80 letters, digits, \`_\`, or \`-\` |
| 404 | Unknown GIF | That id is not a GIF this site can send |
| 429 | Slow down | Back off. Chat/GIF: 5 per 5 seconds per bot, 30 per minute per IP. Reads: 120 per minute per bot |
| 429 | Slow mode: wait Ns. | Wait the stated seconds, then retry |
| 429 | Too many attempts. Try again later. | Too many unknown tokens from this IP |
| 502 | GIF search failed | Retry the GIF later |
| 503 | GIF search is not configured | This site cannot send GIFs |

## 9. What bots can't do

Regular bots can only join, send chat, send GIFs, and read rooms they are allowed in. They cannot kick, ban, mute, delete messages, or read other rooms. Only the site's one moderator bot has moderation access, and that API is not part of this page.

## 10. Room webhooks

Webhooks need no bot account. A room owner, or a member whose custom role includes **Manage webhooks**, creates them under **Room settings → Webhooks**. A room can have up to 10. Every change goes in the room's moderation log. Site staff can see and turn off any room's webhooks.

### Incoming: post into a room (Discord-compatible)

Creating an incoming webhook gives you a secret URL, shown **once**:

\`\`\`
https://chat.nano11bravo.com/api/webhooks/<id>/<token>
\`\`\`

Anyone who has the URL can post, so treat it like a password. **New URL** in the room settings replaces it, and the old one stops working at once. POST JSON to it:

\`\`\`bash
curl -sS -X POST "$ZN_WEBHOOK_URL" -H 'Content-Type: application/json' \\
  -d '{"content":"Server restarted ✅","username":"FiveM","avatar_url":"https://example.com/logo.png"}'
# 204 No Content
\`\`\`

| field | notes |
| --- | --- |
| \`content\` | Up to 2000 characters. Markdown is rendered by the chat's own sanitizer; HTML is shown as text. |
| \`username\` | Optional. Overrides the webhook's name for this line (80 characters). |
| \`avatar_url\` | Optional, https. Fetched once by the server and cached; viewers never load it from your host. |
| \`embeds\` | Optional, up to 10 (6000 characters in total): \`title\`, \`url\`, \`description\`, \`color\`, \`fields[{name,value,inline}]\`, \`author{name,url}\`, \`footer{text}\`, \`timestamp\`, \`image{url}\`/\`thumbnail{url}\` (shown as links). |
| \`?wait=true\` | Returns the created message as JSON (\`id\`, \`channel_id\`, \`webhook_id\`, \`content\`) instead of 204. |

Lines show the webhook's name and avatar with a **webhook** badge. \`@everyone\`, \`@here\` and other mass mentions are defused, and webhook lines never notify anyone. Discord markup such as \`<@123>\`, \`<:emoji:123>\` and \`<t:1700000000:F>\` is turned into plain text. \`multipart/form-data\` with \`payload_json\` works too (attached files are ignored), so most "Discord webhook" tools work if you paste this URL in, including FiveM resources and CI notifiers. A GET on the URL returns the webhook object, as Discord does.

Variants:

- \`…/slack\`: Slack-style \`{"text": "…"}\`, with \`<url|label>\` links converted.
- \`…/github\`: point a GitHub repository webhook here (content type \`application/json\`). It handles push, issues, pull requests, comments, releases, stars and ping.

Limits and errors (Discord-shaped JSON):

| status | when |
| --- | --- |
| 204 / 200 | Posted (200 with \`?wait=true\`) |
| 400 \`code 50006\` | Empty message |
| 400 \`code 50035\` | Too long or invalid fields |
| 403 | The webhook is turned off |
| 404 \`code 10015\` | Unknown webhook or wrong token |
| 429 | Over 5 posts per 2 seconds or 30 per minute per webhook, or 60 per minute per room. The body has \`retry_after\` (seconds), and the response also has a \`Retry-After\` header. |

FiveM (server-side Lua):

\`\`\`lua
local hook = GetConvar('zn_webhook', '') -- set zn_webhook "https://…/api/webhooks/<id>/<token>" in server.cfg
local function zn(text)
  PerformHttpRequest(hook, function(status) if status >= 400 then print('zeronoise webhook', status) end end, 'POST',
    json.encode({ content = text, username = GetConvar('sv_projectName', 'FiveM') }), { ['Content-Type'] = 'application/json' })
end
AddEventHandler('playerJoining', function() zn(('➕ %s joined'):format(GetPlayerName(source))) end)
\`\`\`

### Outgoing: receive room events

An outgoing webhook sends a signed \`POST\` to your **https** URL when the events you chose happen:

| event | when | \`data\` |
| --- | --- | --- |
| \`message\` | Someone posts in the room (not burn-after-reading lines, bots or other webhooks) | \`id\`, \`ts\`, \`text\`, \`parentId\`, \`user{nick,userId,role}\` |
| \`join\` / \`leave\` | Someone enters or leaves | \`user\`, \`reason\` (leave) |
| \`voice\` | Someone turns on mic, camera or screen share | \`user\`, \`mic\`, \`cam\`, \`screen\` |
| \`poll\` | A poll is created or closed | \`action\`, \`poll\`, \`winners\` (close) |
| \`mod\` | A moderation action in the room (kick, ban, mute, delete…) | \`action\`, \`actor\`, \`target\`, \`details\` |
| \`test\` | The **Test** button | \`message\`, \`by\` |

Body:

\`\`\`json
{ "id": "6d0c…", "event": "message", "ts": 1792300000000, "room": { "id": "…", "name": "driftzone" },
  "webhook": { "id": "…", "name": "Relay" }, "data": { "text": "hi", "user": { "nick": "Dreamer", "userId": 7, "role": "user" } } }
\`\`\`

Headers: \`x-zn-event\`, \`x-zn-delivery\` (same as \`id\`; retries reuse it), \`x-zn-webhook-id\`, \`x-zn-timestamp\` (Unix seconds) and \`x-zn-signature\`.

**Signature:** \`x-zn-signature\` = \`sha256=\` + hex HMAC-SHA256 of \`timestamp + "." + rawBody\`, keyed with the webhook's signing secret (\`whsec_…\`, shown once). Check it against the **raw** body before parsing, and refuse timestamps more than 5 minutes old.

Node:

\`\`\`js
import crypto from 'node:crypto';
import http from 'node:http';
const SECRET = process.env.ZN_WEBHOOK_SECRET;
function verify(ts, body, sig) {
  if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const want = Buffer.from('sha256=' + crypto.createHmac('sha256', SECRET).update(\`\${ts}.\${body}\`).digest('hex'));
  const got = Buffer.from(String(sig));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!verify(req.headers['x-zn-timestamp'], body, req.headers['x-zn-signature'])) return res.writeHead(401).end();
    const e = JSON.parse(body);
    console.log(e.event, e.data);
    res.writeHead(200).end();
  });
}).listen(8080);
\`\`\`

Lua 5.4 (FiveM \`SetHttpHandler\`, no libraries; the same file is \`webhook-verify.lua\` in the bridge kit):

\`\`\`lua
-- zeronoise outgoing webhook signature check for FiveM (Lua 5.4, no libraries).
-- x-zn-signature = "sha256=" .. hex(HMAC_SHA256(secret, timestamp .. "." .. rawBody))
local K = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 }
local M = 0xffffffff
local function rotr(x, n) return ((x >> n) | (x << (32 - n))) & M end
local function sha256(msg)
  local h = { 0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19 }
  local len = #msg
  msg = msg .. "\\128" .. string.rep("\\0", (55 - len) % 64) .. string.pack(">I8", len * 8)
  for c = 1, #msg, 64 do
    local w = {}
    for i = 0, 15 do w[i] = string.unpack(">I4", msg, c + i * 4) end
    for i = 16, 63 do
      local s0 = rotr(w[i-15], 7) ~ rotr(w[i-15], 18) ~ (w[i-15] >> 3)
      local s1 = rotr(w[i-2], 17) ~ rotr(w[i-2], 19) ~ (w[i-2] >> 10)
      w[i] = (w[i-16] + s0 + w[i-7] + s1) & M
    end
    local a, b, cc, d, e, f, g, hh = table.unpack(h)
    for i = 0, 63 do
      local S1 = rotr(e, 6) ~ rotr(e, 11) ~ rotr(e, 25)
      local ch = (e & f) ~ (~e & g)
      local t1 = (hh + S1 + ch + K[i + 1] + w[i]) & M
      local S0 = rotr(a, 2) ~ rotr(a, 13) ~ rotr(a, 22)
      local mj = (a & b) ~ (a & cc) ~ (b & cc)
      local t2 = (S0 + mj) & M
      hh, g, f, e, d, cc, b, a = g, f, e, (d + t1) & M, cc, b, a, (t1 + t2) & M
    end
    local v = { a, b, cc, d, e, f, g, hh }
    for i = 1, 8 do h[i] = (h[i] + v[i]) & M end
  end
  return string.pack(">I4I4I4I4I4I4I4I4", table.unpack(h))
end
local function hmac_sha256(key, msg)
  if #key > 64 then key = sha256(key) end
  key = key .. string.rep("\\0", 64 - #key)
  local ipad = key:gsub(".", function(ch) return string.char(ch:byte() ~ 0x36) end)
  local opad = key:gsub(".", function(ch) return string.char(ch:byte() ~ 0x5c) end)
  return sha256(opad .. sha256(ipad .. msg))
end
local function tohex(s) return (s:gsub(".", function(ch) return string.format("%02x", ch:byte()) end)) end

--- true when the delivery is genuine and fresh (timestamp in Unix seconds, within 5 minutes)
function VerifyZeronoise(secret, timestamp, rawBody, signature)
  if type(signature) ~= "string" or type(timestamp) ~= "string" then return false end
  local ts = tonumber(timestamp)
  if not ts or math.abs(os.time() - ts) > 300 then return false end
  local want = "sha256=" .. tohex(hmac_sha256(secret, timestamp .. "." .. rawBody))
  if #want ~= #signature then return false end
  local diff = 0
  for i = 1, #want do diff = diff | (want:byte(i) ~ signature:byte(i)) end
  return diff == 0
end


-- in a FiveM resource (expose it through your HTTPS proxy: https://your-host/<resource>/zn)
SetHttpHandler(function(req, res)
  if req.method ~= 'POST' then res.writeHead(404) return res.send('') end
  req.setDataHandler(function(body)
    local h = req.headers
    if not VerifyZeronoise(GetConvar('zn_webhook_secret', ''), h['x-zn-timestamp'] or h['X-Zn-Timestamp'], body, h['x-zn-signature'] or h['X-Zn-Signature']) then
      res.writeHead(401) return res.send('')
    end
    local e = json.decode(body)
    if e.event == 'message' then TriggerClientEvent('chat:addMessage', -1, { args = { e.data.user.nick, e.data.text } }) end
    res.writeHead(200) res.send('ok')
  end)
end)
\`\`\`

Test with curl, replacing the secret:

\`\`\`bash
TS=$(date +%s); BODY='{"event":"test"}'
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$ZN_WEBHOOK_SECRET" | sed 's/^.* //')"
curl -sS -X POST https://your-host/zn -H "x-zn-timestamp: $TS" -H "x-zn-signature: $SIG" -d "$BODY"
\`\`\`

**Delivery:** return any 2xx within 5 seconds. Redirects are not followed. On failure the delivery is retried after 10 s, 1 min and 5 min. After 10 deliveries fail in a row, the webhook turns itself off; the owner sees why and can turn it back on. Targets must be public https hosts: private, loopback and link-local addresses are refused, and so are URLs with a username or password. The room settings show the last 20 deliveries and requests, each with its status.
`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** https URLs and same-site paths only. The markdown is ours; this still refuses odd links. */
function safeHref(href: string): string | null {
  const h = href.trim();
  if (h.startsWith('/') && !h.startsWith('//') && !h.startsWith('/\\')) return h;
  if (/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s"'<>]*)?$/i.test(h)) return h;
  return null;
}

function inline(src: string): string {
  let i = 0;
  let out = '';
  while (i < src.length) {
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        out += `<code>${esc(src.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2);
      if (end > i) {
        out += `<strong>${inline(src.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (src[i] === '[') {
      const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(src.slice(i));
      if (link) {
        const href = safeHref(link[2]);
        out += href ? `<a href="${esc(href)}">${inline(link[1])}</a>` : esc(link[0]);
        i += link[0].length;
        continue;
      }
    }
    out += esc(src[i]);
    i++;
  }
  return out;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function renderTable(rows: string[]): string {
  if (rows.length < 2) return `<p>${inline(rows.join(' '))}</p>`;
  const head = splitRow(rows[0]);
  const body = rows.slice(2);
  const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
  const tr = body.map((r) => `<tr>${splitRow(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/** Small subset: headings, lists, fences, tables, paragraphs. Enough for this page. */
export function renderBotMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const special = /^(#{1,3} |```|\||---\s*$|[-*] |\d+\. )/;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const fence: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) fence.push(lines[i++]);
      if (i < lines.length) i++;
      out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      out.push(renderTable(rows));
      continue;
    }
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const slug = h[2].replace(/^\d+\.\s*/, '').toLowerCase().replace(/^room\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${level} id="${esc(slug)}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^---\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) items.push(lines[i++].replace(/^[-*] /, ''));
      out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) items.push(lines[i++].replace(/^\d+\. /, ''));
      out.push(`<ol>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</ol>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !special.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

function shell(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bot API · ${esc(BRAND_NAME)}</title>
  <meta name="description" content="Public HTTP API for zeronoise chat bots: token, join, chat, GIFs, and reading room messages.">
  <meta name="theme-color" content="#0b1220">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.png" type="image/png" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <script src="/theme-boot.js"></script>
  <style>
    ${uiThemeCss()}
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      background: radial-gradient(900px 480px at 50% -10%, rgb(var(--accent-rgb) / .06), transparent 55%), var(--bg);
      color: var(--text);
      font: 16px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    }
    a { color: var(--accent); }
    .page { width: min(46rem, calc(100% - 32px)); margin: 0 auto; padding: 40px 0 72px; }
    .mark { height: 72px; width: auto; display: block; }
    h1 { margin: 18px 0 8px; font-size: 28px; font-weight: 650; letter-spacing: 0; color: var(--text); line-height: 1.25; }
    h2 { margin: 32px 0 8px; font-size: 20px; font-weight: 650; color: var(--text); }
    h3 { margin: 22px 0 8px; font-size: 16px; font-weight: 650; color: var(--text); }
    p, li, td, th { color: var(--text); }
    .updated { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
    ul, ol { margin: 8px 0; padding-left: 1.3em; }
    li { margin: 0 0 8px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; background: var(--bg-2); padding: 0 4px; border-radius: 4px; }
    pre { background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; overflow: auto; }
    pre code { background: none; padding: 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0 20px; font-size: 14px; }
    th, td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); padding: 8px 10px 8px 0; }
    th { color: var(--muted); font-weight: 650; }
    .nav { margin: 28px 0 0; color: var(--muted); font-size: 14px; }
    @media (max-width: 640px) {
      .page { padding-top: 24px; }
      h1 { font-size: 24px; }
      table { font-size: 13px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <a href="/"><img class="mark" src="/logo-lockup.png" alt="${esc(BRAND_NAME)}"></a>
    <p class="updated">Last updated: ${UPDATED}</p>
    ${body}
    <p class="nav"><a href="/">Back to ${esc(BRAND_NAME)}</a> · <a href="/docs/bots.md">Markdown</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>
  </main>
</body>
</html>`;
}

export function botApiMarkdown(): string {
  return BOT_API_MARKDOWN;
}

export function botApiHtml(): string {
  return shell(renderBotMarkdown(BOT_API_MARKDOWN));
}

/** Absolute links only for a public https origin. Otherwise same-origin paths, so a local PUBLIC_URL is not published. */
function publicOrigin(publicUrl: string): string {
  try {
    const u = new URL(publicUrl);
    const host = u.hostname.toLowerCase();
    const internal = host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')
      || host.endsWith('.lan') || /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':');
    if (u.protocol === 'https:' && !internal) return u.origin;
  } catch { /* no absolute origin */ }
  return '';
}

/** Short index for agents. Absolute links when PUBLIC_URL is a public https origin. */
export function llmsTxt(publicUrl: string): string {
  const base = publicOrigin(publicUrl);
  const md = base ? `${base}/docs/bots.md` : '/docs/bots.md';
  const html = base ? `${base}/docs/bots` : '/docs/bots';
  return `# ${BRAND_NAME}

> Public chat-bot API for game servers and scripts. Bearer token, no cookies.

- [Bot API (Markdown)](${md}): token, allow a bot in a room, join, chat, GIFs, read messages, errors, and limits.
- [Bot API (HTML)](${html})
- [Room webhooks](${md}): Discord-compatible incoming URL (\`POST {content, username, avatar_url, embeds}\`), signed outgoing events (HMAC-SHA256 of \`timestamp.body\`), Node and Lua verification. Section 10.
- [Game bridge kit (ZIP)](${base}/docs/bots/bridge-kit.zip): Node script + README with a configurable poll/post loop for FiveM, BeamMP, log files and webhooks. [README](${base}/docs/bots/bridge-kit/README.md)

Joins are saved on the server and survive restarts. Join once; on 403 \`Join the room first\`, join again and retry once.
`;
}
