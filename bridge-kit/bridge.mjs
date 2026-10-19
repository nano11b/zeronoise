#!/usr/bin/env node
// zeronoise game bridge: relays a game server (FiveM, BeamMP, anything with a log or HTTP hook) to a zeronoise room.
// No dependencies. Node 18+.  Usage:  ZN_BOT_TOKEN=bot_xxx node bridge.mjs [config.json] [--dry-run] [--once]
//   or, with a room webhook instead of a bot:  ZN_WEBHOOK_URL=https://…/api/webhooks/<id>/<token> node bridge.mjs
// See README.md. The token is read from the environment only; never put it in the config file.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONCE = args.includes('--once');
const cfgPath = args.find((a) => !a.startsWith('--')) || 'config.json';
const fileCfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const env = process.env;
const cfg = {
  baseUrl: 'https://chat.nano11bravo.com', room: '', sendEveryMs: 1500, readEveryMs: 2000, mergeWithinMs: 3000, prefix: '',
  sources: [], chatToGame: { mode: 'off' }, ...fileCfg,
};
if (env.ZN_BASE_URL) cfg.baseUrl = env.ZN_BASE_URL;
if (env.ZN_ROOM) cfg.room = env.ZN_ROOM;
const TOKEN = env.ZN_BOT_TOKEN || '';
/** room webhook URL (Room settings → Webhooks → Incoming). Posting then needs no bot token. Secret: environment only. */
const HOOK_URL = env.ZN_WEBHOOK_URL || '';
if ('webhookUrl' in fileCfg) { console.error('Refusing: put the webhook URL in ZN_WEBHOOK_URL, not in the config file (it is a secret).'); process.exit(2); }
if ('token' in fileCfg) { console.error('Refusing: put the bot token in ZN_BOT_TOKEN, not in the config file.'); process.exit(2); }
if (!cfg.room && !HOOK_URL) { console.error('Set "room" in the config (the room id from GET /api/rooms) or ZN_ROOM.'); process.exit(2); }
if (!TOKEN && !HOOK_URL && !DRY) { console.error('Set ZN_BOT_TOKEN (create a bot under Your profile -> Chat bots) or ZN_WEBHOOK_URL (Room settings -> Webhooks).'); process.exit(2); }
cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'user-agent': 'zeronoise-bridge-kit/1' };
const api = (p, init = {}) => fetch(`${cfg.baseUrl}/api/bots/rooms/${encodeURIComponent(cfg.room)}${p}`, { ...init, headers: H });

// ---------------- game -> chat: queue, merge bursts, respect limits ----------------
const queue = []; // { text, at }
export function say(text) {
  const t = `${cfg.prefix}${String(text)}`.replace(/\s+/g, ' ').trim();
  if (!t) return;
  const last = queue[queue.length - 1];
  // merge bursts (many joins at once) into one line, up to the 500 character cap
  if (last && Date.now() - last.at < cfg.mergeWithinMs && (last.text + ' · ' + t).length <= 500) last.text += ' · ' + t;
  else queue.push({ text: t.slice(0, 500), at: Date.now() });
}
async function join() {
  if (DRY || !TOKEN) return true;
  const r = await api('/join', { method: 'POST' }).catch((e) => ({ ok: false, status: 0, statusText: e.message }));
  if (!r.ok) log('join failed', r.status, await r.text?.().catch(() => '') ?? r.statusText);
  return r.ok;
}
let waitUntil = 0;
/** Try to post the oldest queued line. */
async function sendOne() {
  const item = queue[0];
  if (!item) return;
  if (DRY) { log('[dry-run] would post:', item.text); queue.shift(); return; }
  if (HOOK_URL) return void await sendHook(item);
  try {
    let r = await api('/chat', { method: 'POST', body: JSON.stringify({ text: item.text }) });
    if (r.status === 403) { await join(); r = await api('/chat', { method: 'POST', body: JSON.stringify({ text: item.text }) }); }
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      const m = /wait (\d+)s/.exec(j.error || '');
      waitUntil = Date.now() + (m ? Number(m[1]) * 1000 : 5000);
      return; // keep the line, try again later
    }
    queue.shift();
    if (!r.ok) log('post failed', r.status, (await r.json().catch(() => ({}))).error);
    else log('posted:', item.text);
  } catch (e) { log('post error', e.message); waitUntil = Date.now() + 5000; }
}
/** Post through a room webhook (Discord-style). 2000 characters, 5 per 2 s per hook. */
async function sendHook(item) {
  try {
    const r = await fetch(HOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'zeronoise-bridge-kit/1' }, body: JSON.stringify({ content: item.text, ...(cfg.webhookName ? { username: cfg.webhookName } : {}) }) });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); waitUntil = Date.now() + Math.ceil((j.retry_after || 2) * 1000); return; }
    queue.shift();
    if (!r.ok) log('webhook post failed', r.status, (await r.json().catch(() => ({}))).message);
    else log('posted (webhook):', item.text);
  } catch (e) { log('webhook post error', e.message); waitUntil = Date.now() + 5000; }
}
async function sendLoop() {
  for (;;) { await sleep(Math.max(cfg.sendEveryMs, waitUntil - Date.now())); await sendOne(); }
}

// ---------------- sources ----------------
/** FiveM: poll http://<server>:30120/players.json and announce joins / leaves. */
async function fivemPlayers(src) {
  const url = src.url || 'http://127.0.0.1:30120/players.json';
  let known = null;
  for (;;) {
    try {
      const list = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
      const now = new Map(list.map((p) => [String(p.id), p.name]));
      if (known) {
        const joined = [...now].filter(([id]) => !known.has(id)).map(([, n]) => n);
        const left = [...known].filter(([id]) => !now.has(id)).map(([, n]) => n);
        if (joined.length) say((src.joinText || '➕ {names} joined ({count} online)').replace('{names}', joined.join(', ')).replace('{count}', now.size));
        if (left.length) say((src.leaveText || '➖ {names} left ({count} online)').replace('{names}', left.join(', ')).replace('{count}', now.size));
      }
      known = now;
    } catch (e) { if (src.verbose) log('fivem poll', e.message); }
    if (ONCE) return;
    await sleep(src.everyMs || 5000);
  }
}
/** Tail a log file and turn matching lines into chat lines (BeamMP Server.log, Assetto, anything). */
const PRESETS = {
  beammp: [
    { match: "\\[INFO\\] (?:Identification success|.*?) ?(\\S+) is now synced!", say: '🚗 $1 joined' },
    { match: '\\[INFO\\] (\\S+) Connection Terminated', say: '👋 $1 left' },
    { match: '\\[CHAT\\] \\(\\d+\\) <([^>]+)> (.+)', say: '💬 $1: $2' },
  ],
};
async function logTail(src) {
  const file = path.resolve(src.file);
  const rules = (src.rules || PRESETS[src.preset] || []).map((r) => ({ re: new RegExp(r.match), say: r.say }));
  let pos = fs.existsSync(file) ? fs.statSync(file).size : 0; // start at the end, no replay
  let rest = '';
  for (;;) {
    try {
      const st = fs.statSync(file);
      if (st.size < pos) pos = 0; // rotated
      if (st.size > pos) {
        const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(Math.min(st.size - pos, 1 << 20));
        fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos += buf.length;
        const lines = (rest + buf.toString('utf8')).split(/\r?\n/); rest = lines.pop();
        for (const line of lines) for (const r of rules) { const m = r.re.exec(line); if (m) { say(r.say.replace(/\$(\d)/g, (_, i) => m[+i] ?? '')); break; } }
      }
    } catch (e) { if (src.verbose) log('tail', e.message); }
    if (ONCE) return;
    await sleep(src.everyMs || 1000);
  }
}
/** Local HTTP hook: a game resource POSTs {"text": "..."} to http://127.0.0.1:<port>/say with header x-bridge-secret. */
function webhook(src) {
  const secret = env.BRIDGE_SECRET || '';
  if (!secret) { log('webhook source needs BRIDGE_SECRET in the environment; skipped'); return; }
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/say' || req.headers['x-bridge-secret'] !== secret) { res.writeHead(404).end(); return; }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => { try { say(JSON.parse(body).text); res.writeHead(204).end(); } catch { res.writeHead(400).end(); } });
  });
  srv.listen(src.port || 30121, src.host || '127.0.0.1', () => log(`webhook listening on ${src.host || '127.0.0.1'}:${src.port || 30121}/say`));
}

/**
 * Receiver for the room's outgoing webhooks (Room settings -> Webhooks -> Outgoing, target https://your-host/zn).
 * Checks x-zn-signature = sha256=HMAC(ZN_WEBHOOK_SECRET, timestamp + "." + body), drops stale (>5 min) or replayed deliveries,
 * then hands the event to the chat -> game output ({author}, {text}, {event}).
 */
export function verifyZn(secret, ts, body, sig) {
  if (!secret || !ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const want = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'));
  const got = Buffer.from(String(sig));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function znEvents(src) {
  const secret = env.ZN_WEBHOOK_SECRET || '';
  if (!secret) { log('zn-events source needs ZN_WEBHOOK_SECRET in the environment; skipped'); return; }
  const seen = new Map();
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== (src.path || '/zn')) { res.writeHead(404).end(); return; }
    let body = ''; req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      if (!verifyZn(secret, req.headers['x-zn-timestamp'], body, req.headers['x-zn-signature'])) { res.writeHead(401).end(); return; }
      const id = String(req.headers['x-zn-delivery'] || '');
      if (seen.has(id)) { res.writeHead(200).end(); return; } // a retry we already handled
      seen.set(id, Date.now()); for (const [k, t] of seen) if (Date.now() - t > 600_000) seen.delete(k);
      res.writeHead(200).end();
      try {
        const e = JSON.parse(body);
        if (src.events && !src.events.includes(e.event)) return;
        const d = e.data || {};
        const author = d.user?.nick || d.actor || 'zeronoise';
        const text = e.event === 'message' ? d.text : e.event === 'join' ? 'joined' : e.event === 'leave' ? 'left' : e.event === 'voice' ? 'went live' : e.event === 'poll' ? `poll ${d.action}: ${d.poll?.question}` : e.event === 'mod' ? `${d.action} ${d.target || ''}`.trim() : 'test';
        deliverToGame({ author, text, event: e.event });
      } catch (err) { log('zn-events bad body', err.message); }
    });
  });
  srv.listen(src.port || 30123, src.host || '127.0.0.1', () => log(`zn-events listening on ${src.host || '127.0.0.1'}:${src.port || 30123}${src.path || '/zn'}`));
}
async function deliverToGame(m) {
  const out = cfg.chatToGame || { mode: 'off' };
  const line = (out.format || '[chat] {author}: {text}').replace('{author}', m.author).replace('{text}', m.text).replace('{event}', m.event || 'message');
  if (out.mode === 'off' || out.mode === 'stdout') console.log(line);
  else if (out.mode === 'file') fs.appendFileSync(out.file, line + '\n');
  else if (out.mode === 'http') await fetch(out.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-secret': env.BRIDGE_SECRET || '' }, body: JSON.stringify({ author: m.author, text: m.text, event: m.event, line }) }).catch((e) => log('deliver', e.message));
}

// ---------------- chat -> game ----------------
async function readLoop() {
  const out = cfg.chatToGame || { mode: 'off' };
  if (out.mode === 'off' || DRY || !TOKEN || cfg.sources.some((x) => x.type === 'zn-events')) return; // with zn-events, outgoing webhooks feed the game instead of polling
  let cursor = null;
  for (;;) {
    try {
      const r = await api(cursor ? `/messages?after=${encodeURIComponent(cursor)}` : '/messages');
      if (r.status === 400) cursor = null; // Unknown cursor: start over
      else if (r.ok) {
        const j = await r.json();
        cursor = j.cursor ?? cursor;
        for (const m of j.messages || []) {
          if (m.isBot) continue; // never echo bots, including ourselves
          const line = (out.format || '[chat] {author}: {text}').replace('{author}', m.author).replace('{text}', m.text);
          if (out.mode === 'stdout') console.log(line);
          else if (out.mode === 'file') fs.appendFileSync(out.file, line + '\n');
          else if (out.mode === 'http') await fetch(out.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-secret': env.BRIDGE_SECRET || '' }, body: JSON.stringify({ author: m.author, text: m.text, line }) }).catch((e) => log('deliver', e.message));
        }
      }
    } catch (e) { log('read error', e.message); }
    await sleep(Math.max(1000, cfg.readEveryMs));
  }
}

// ---------------- main ----------------
log(HOOK_URL ? `bridge -> room webhook${DRY ? ' (dry run)' : ''}` : `bridge -> ${cfg.baseUrl} room "${cfg.room}"${DRY ? ' (dry run)' : ''}`);
if (!(await join()) && !DRY) log('could not join yet; will retry on the first post');
for (const s of ONCE ? [] : cfg.sources) {
  if (s.type === 'fivem-players') void fivemPlayers(s);
  else if (s.type === 'logtail') void logTail(s);
  else if (s.type === 'webhook') webhook(s);
  else if (s.type === 'zn-events') znEvents(s);
  else log('unknown source type', s.type);
}
if (ONCE) { say('bridge self-test ✔'); await sendOne(); process.exit(queue.length ? 1 : 0); }
void sendLoop();
void readLoop();
