// Self-contained test for accounts, persistence, moderation, bans, reports and TURN credentials.
// (helpers copied from test-api.mjs) Starts its own server (dist build) on a free port with a throwaway DATA_DIR, restarts it once.
//   npm run build && npm run test:api
import './lib/reap.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, createHmac, createECDH, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { io } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-test-'));
const TURN_SECRET = 'test-turn-secret';
const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://127.0.0.1:${port}`;
// ---- batch 2 fixture: a local "website" and a fake push service. Only this exact host:port is allowlisted
// (OUTBOUND_TEST_ALLOW); every other private / loopback address stays blocked. ----
const pushHits = [];
const fixHits = [];
let fixPng = null;
// batch 3: fake AzuraCast now-playing upstream
const radioFix = { mode: 'ok', title: 'Fixture Song', artist: 'Fixture Artist', art: '/radio/art.jpg', listeners: 42 };
let radioArtJpg = null;
const fixture = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  fixHits.push(u.pathname);
  const html = (body, extra = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra }); res.end(body); };
  const go = (loc) => { res.writeHead(302, { location: loc }); res.end(); };
  switch (u.pathname) {
    case '/page': return html('<html><head><title>Fallback</title><meta property="og:title" content="Fixture &amp; Page"><meta name="description" content="A test page"><meta property="og:image" content="/img.png"><meta property="og:site_name" content="FixtureSite"></head><body>hi</body></html>');
    case '/page2': return html('<html><head><title>Second page</title></head></html>');
    case '/r0': return go('/r1');
    case '/r1': return go('/r2');
    case '/r2': return go('/r3');
    case '/r3': return go('/page2');
    case '/to-meta': return go('http://169.254.169.254/latest/meta-data/');
    case '/to-local': return go(`http://127.0.0.1:${port}/api/health`);
    case '/to-v6': return go('http://[::1]/');
    case '/json': res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"title":"nope"}');
    case '/slow': return void setTimeout(() => html('<title>Too slow</title>'), 4000);
    case '/big': return html('<html><head>' + '<!-- pad -->'.repeat(60_000) + '<title>Late title</title></head></html>');
    case '/img.png': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fixPng);
    case '/radio/np': {
      if (radioFix.mode === '500') { res.writeHead(500); return res.end('down'); }
      if (radioFix.mode === 'bad') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"now_playing": nope'); }
      const art = radioFix.art.startsWith('/') ? `http://127.0.0.1:${fixture.address().port}${radioFix.art}` : radioFix.art;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        station: { name: '7LFM', shortcode: 'labsfm' }, listeners: { total: radioFix.listeners, unique: 3, current: radioFix.listeners },
        live: { is_live: false, streamer_name: '' },
        now_playing: { played_at: Math.floor(Date.now() / 1000) - 30, duration: 200, elapsed: 30, remaining: 170, song: { title: radioFix.title, artist: radioFix.artist, album: 'Fixture Album', art } },
      }));
    }
    case '/radio/art.jpg': res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(radioArtJpg);
    case '/push/ok': case '/push/gone': {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        pushHits.push({ path: u.pathname + u.search, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(u.pathname === '/push/ok' ? 201 : 410); res.end();
      });
      return;
    }
    default: res.writeHead(404); res.end();
  }
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const FIX = `http://127.0.0.1:${fixture.address().port}`;
const env = {
  ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback',
  ADMIN_USERNAMES: 'Root_Admin', TURN_SECRET, TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:5349', TURN_TTL: '21600',
  MAX_CONN_PER_IP: '6', WORD_FILTER: 'badword,frick', GUEST_CAM_AFTER_MINUTES: '-1',
  RECONNECT_GRACE_MS: '2000',
  MOD_BOT_PRESENCE_MS: '800',
  BOT_ROOM_READS_PER_MIN: '8',
  MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'),
  TIKTOK_CLIENT_KEY: '', TIKTOK_CLIENT_SECRET: '',
  TIKTOK_AUTHORIZE_URL: '', TIKTOK_TOKEN_URL: '', TIKTOK_USERINFO_URL: '',
  CONTACT_EMAIL: '',
  TRIVIA_QUESTION_MS: '3000', TRIVIA_PAUSE_MS: '300',
  BURN_TTL_SCALE: '0.1', BURN_HARD_MS: '4000',
  BADGE_THRESHOLD_DIV: '100', BADGE_AIR_FLUSH_MS: '500',
  CAMCHAT_TEST_CRASH_HOOKS: '1',
  // batch 2 test knobs
  OUTBOUND_TEST_ALLOW: `127.0.0.1:${fixture.address().port}`, LINK_PREVIEW_TIMEOUT_MS: '1500',
  EVENT_REMIND_LEAD_MS: '2500', EVENT_TICK_MS: '250', POLL_MINUTE_MS: '1000',
  // batch 3 test knobs (RADIO_NOWPLAYING_URL is test-only; it also unlocks a poll interval under 15 s)
  RADIO_NOWPLAYING_URL: `http://127.0.0.1:${fixture.address().port}/radio/np`, RADIO_POLL_MS: '300', RADIO_TIMEOUT_MS: '800',
  SCHEDULE_TICK_MS: '200', SCHEDULE_DAY_MS: '1500',
  // backup test knobs (all test-only): fake free space via a file, short manual-run gap, a slow run to observe the guard
  BACKUP_TEST_FREE_FILE: path.join(DATA, 'fake-free-bytes'), BACKUP_TEST_NOW_GAP_MS: '2500', BACKUP_TEST_SLOW_MS: '600',
};

// SKEW_DB=1: start from a database whose user_version came from another branch's numbering (past ours)
// with none of our feature tables, like the live server. The server must still create what it needs.
if (process.env.SKEW_DB) {
  execFileSync(process.execPath, ['-e', `const m = require('./dist/server/server/db.js'); m.migrate(15); m.db.exec('PRAGMA user_version = 21');`],
    { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, NODE_ENV: 'development' }, stdio: 'ignore' });
}

let passed = 0, failed = 0;
const ok = (cond, name) => { cond ? passed++ : failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;
let serverLog = '';
async function startServer() {
  server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = '';
  const take = (d) => { const s = String(d); boot += s; serverLog += s; };
  server.stdout.on('data', (d) => take(d));
  server.stderr.on('data', (d) => { take(d); process.stderr.write(d); });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (boot.includes('listening')) return;
    if (server.exitCode !== null) throw new Error(`server exited: ${boot}`);
  }
  throw new Error(`server did not start: ${boot}`);
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await done;
}

// ---- a fake "browser": cookie jar + fixed client IP (sent as CF-Connecting-IP from a trusted loopback proxy) ----
let ipSeq = 10;
function browser(ip = `198.51.100.${ipSeq++}`) {
  const jar = new Map();
  const b = {
    ip, jar, deviceId: null,
    cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    async req(pathname, body, method) {
      const headers = { 'cf-connecting-ip': b.ip, 'x-csrf': '1', cookie: b.cookieHeader() };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(BASE + pathname, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of r.headers.getSetCookie()) {
        const [kv] = c.split(';'); const i = kv.indexOf('=');
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
      }
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, json: json ?? {} };
    },
    async boot() { const r = await b.req('/api/me'); b.deviceId = r.json.deviceId; return r.json; },
    connect(extra = {}) {
      return new Promise((res, rej) => {
        const s = io(BASE, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: b.cookieHeader(), 'cf-connecting-ip': b.ip, ...(extra.headers || {}) }, auth: { deviceId: extra.deviceId ?? b.deviceId } });
        s.once('connect', () => res(s));
        s.once('connect_error', (e) => { s.close(); rej(e); });
      });
    },
  };
  return b;
}
const emit = (s, ev, ...args) => new Promise((res) => s.emit(ev, ...args, res));
const once = (s, ev, pred = () => true, ms = 3000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout waiting for ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const rejects = (p) => p.then((s) => { s.close(); return null; }, (e) => e.message);
const sockets = [];
const track = (s) => { sockets.push(s); return s; };


async function captchaFor(b) {
  const r = await b.req('/api/auth/captcha');
  if (r.json.mode === 'builtin') {
    // solve "What is A + B?"
    const m = /What is (\d+) \+ (\d+)/.exec(r.json.question || '');
    if (!m) throw new Error('bad captcha question: ' + JSON.stringify(r.json));
    return { captchaId: r.json.id, captchaAnswer: String(+m[1] + +m[2]) };
  }
  return { captchaToken: 'test' };
}
async function register(b, username, password = 'password123', email) {
  const cap = await captchaFor(b);
  const addr = email === undefined ? `${username.toLowerCase()}@example.com` : email;
  return b.req('/api/auth/register', { username, password, email: addr, ...cap });
}
function readMail() {
  const file = path.join(DATA, 'mail.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}


// ---------- bot room joins survive a restart (migration 36) ----------
const botReq = async (p, token, body) => {
  const r = await fetch(BASE + p, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {}; try { json = await r.json(); } catch {}
  return { status: r.status, json };
};
const dbq = async (sql, ...a) => { const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(path.join(DATA, 'camchat.db'), { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
try {
  await startServer();
  const h0 = await fetch(BASE + '/api/health').then((r) => r.json());
  ok('package' in h0 && 'commit' in h0 && h0.release && typeof h0.build === 'string', '/api/health reports package + commit fields (null in a dev checkout)');
  { const uv = (await dbq('PRAGMA user_version'))[0].user_version; ok(uv >= 38, `fresh database is migrated (user_version ${uv})`); }
  const owner = browser(); await owner.boot();
  ok((await register(owner, 'Join_Owner', 'join-owner-password')).json.ok, 'owner registered');
  const so = track(await owner.connect());
  ok((await emit(so, 'login', {})).ok, 'owner logs in');
  const made = await owner.req('/api/bots', { name: 'DriftZone' });
  const token = made.json.token;
  const second = await owner.req('/api/bots', { name: 'BeamBridge' });
  const token2 = second.json.token;
  ok(!!token && !!token2, 'two bots created');
  const created = await emit(so, 'room:create', { name: 'driftzone', topic: 'fivem' });
  const rid = created.roomId;
  ok(created.ok && rid === 'driftzone', 'room id is the slug of the name');
  ok((await emit(so, 'room:join', { roomId: rid })).ok, 'owner joins');
  ok((await emit(so, 'room:bot-allow', { name: 'DriftZone' })).ok && (await emit(so, 'room:bot-allow', { name: 'BeamBridge' })).ok, 'owner allows both bots');
  ok((await botReq(`/api/bots/rooms/${rid}/join`, token, {})).status === 200, 'DriftZone joins');
  ok((await botReq(`/api/bots/rooms/${rid}/join`, token2, {})).status === 200, 'BeamBridge joins');
  ok((await botReq(`/api/bots/rooms/${rid}/chat`, token, { text: 'before restart' })).status === 200, 'chat before restart');
  ok((await dbq('SELECT COUNT(*) AS n FROM bot_room_joins')).at(0).n === 2, 'both joins are saved in the DB');
  // owner removes BeamBridge: its saved join must go too
  const bb = (await emit(so, 'room:bots')).bots.find((b) => b.name === 'BeamBridge');
  ok((await emit(so, 'room:bot-remove', { botId: bb.id })).ok, 'owner removes BeamBridge');
  ok((await dbq('SELECT COUNT(*) AS n FROM bot_room_joins')).at(0).n === 1, 'removing a bot forgets its saved join');
  ok((await emit(so, 'room:bot-allow', { name: 'BeamBridge' })).ok, 'owner re-allows BeamBridge (but it has not re-joined)');
  sockets.forEach((s) => s.close());
  await sleep(200);
  await stopServer();
  await startServer();
  ok(/restored 1 of 1 bot room join/.test(serverLog), 'startup restores the saved join');
  const so2 = track(await owner.connect());
  ok((await emit(so2, 'login', {})).ok, 'owner back after restart');
  const sysLines = []; so2.on('chat:message', (m) => { if (m.kind === 'system') sysLines.push(m.text); });
  const j = await emit(so2, 'room:join', { roomId: rid });
  ok(j.ok && (j.users ?? j.room?.users ?? []).some?.((u) => u.nick === 'DriftZone') !== false, 'room join after restart');
  const heard = once(so2, 'chat:message', (m) => m.kind === 'chat' && m.text === 'after restart');
  const post = await botReq(`/api/bots/rooms/${rid}/chat`, token, { text: 'after restart' });
  ok(post.status === 200, 'DriftZone chats after a restart without calling join (no 403)');
  ok(!!(await heard.catch(() => null)), 'people in the room see the post');
  ok((await botReq(`/api/bots/rooms/${rid}/chat`, token2, { text: 'nope' })).status === 403 , 'a bot that never re-joined still gets 403 Join the room first');
  ok((await botReq(`/api/bots/rooms/${rid}/join`, token, {})).status === 200, 'an extra join after restart is harmless (old bridges keep working)');
  await sleep(300);
  ok(!sysLines.some((t) => /DriftZone joined/.test(t)), 'no duplicate "joined" line after the restart or the extra join');
  const read = await botReq(`/api/bots/rooms/${rid}/messages?limit=5`, token);
  ok(read.status === 200 && read.json.messages.some((m) => m.text === 'after restart'), 'the read endpoint still works (BeamMP bridge path)');
  // rotating keeps the join (same as before); revoking ends it
  const rot = await owner.req(`/api/bots/${made.json.bot.id}/token`, {});
  ok(rot.json.ok && (await botReq(`/api/bots/rooms/${rid}/chat`, rot.json.token, { text: 'rotated' })).status === 200, 'a rotated token keeps the join, as before');
  ok((await owner.req(`/api/bots/${made.json.bot.id}/revoke`, {})).json.ok, 'owner revokes the bot');
  ok((await dbq('SELECT COUNT(*) AS n FROM bot_room_joins WHERE bot_id = ?', made.json.bot.id)).at(0).n === 0, 'revoking forgets the saved join');
  ok(!(await dbq('SELECT COUNT(*) AS n FROM bot_room_joins')).at(0).n, 'no saved joins left');
} catch (err) {
  failed++; console.log('FAIL  crashed: ' + (err && err.stack || err));
} finally {
  sockets.forEach((s) => { try { s.close(); } catch {} });
  await stopServer();
  fixture.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
