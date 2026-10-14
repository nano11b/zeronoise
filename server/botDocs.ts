import { BRAND_NAME } from '../shared/config';

const UPDATED = 'October 9, 2026';

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

**Important:** the join is kept in memory only. The allow list survives a restart; the join does not. If \`chat\` returns **403** \`Join the room first\`, call \`join\` again and retry once.

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
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
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
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      background: radial-gradient(900px 480px at 50% -10%, rgb(57 255 20 / .06), transparent 55%), #0b1220;
      color: #e7eef8;
      font: 16px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    }
    a { color: #39ff14; }
    .page { width: min(46rem, calc(100% - 32px)); margin: 0 auto; padding: 40px 0 72px; }
    .mark { height: 72px; width: auto; display: block; }
    h1 { margin: 18px 0 8px; font-size: 28px; font-weight: 650; letter-spacing: 0; color: #e7eef8; line-height: 1.25; }
    h2 { margin: 32px 0 8px; font-size: 20px; font-weight: 650; color: #e7eef8; }
    h3 { margin: 22px 0 8px; font-size: 16px; font-weight: 650; color: #e7eef8; }
    p, li, td, th { color: #e7eef8; }
    .updated { margin: 0 0 8px; color: #93a4bb; font-size: 13px; }
    ul, ol { margin: 8px 0; padding-left: 1.3em; }
    li { margin: 0 0 8px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; background: #10192a; padding: 0 4px; border-radius: 4px; }
    pre { background: #10192a; border: 1px solid #2c3d57; border-radius: 10px; padding: 12px 14px; overflow: auto; }
    pre code { background: none; padding: 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0 20px; font-size: 14px; }
    th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #2c3d57; padding: 8px 10px 8px 0; }
    th { color: #93a4bb; font-weight: 650; }
    .nav { margin: 28px 0 0; color: #93a4bb; font-size: 14px; }
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
`;
}
