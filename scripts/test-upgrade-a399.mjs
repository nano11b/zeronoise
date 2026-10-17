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

let ROOT = process.env.BASE_ROOT;
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
  CAMCHAT_SECRET_KEY: "upgrade-test-secret-key-0123456789abcdef",
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

const BASE_ROOT = process.env.BASE_ROOT, NEW_ROOT = process.env.NEW_ROOT;
const { DatabaseSync } = await import('node:sqlite');
const dbPath = path.join(DATA, 'camchat.db');
const snapshot = () => { const d = new DatabaseSync(dbPath, { readOnly: true }); try {
  const v = d.prepare('PRAGMA user_version').get().user_version;
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all().map((r) => r.name);
  const rows = {}; const cols = {};
  for (const t of tables) {
    const all = d.prepare(`SELECT * FROM "${t}"`).all(); rows[t] = createHash('sha256').update(JSON.stringify(all)).digest('hex').slice(0, 16) + ':' + all.length;
    cols[t] = d.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name);
  }
  return { v, rows, cols };
} finally { d.close(); } };
const sql = (s, ...a) => { const d = new DatabaseSync(dbPath); try { return d.prepare(s).all(...a); } finally { d.close(); } };
const history = async (s, rid) => { const j = await emit(s, 'room:join', { roomId: rid }); return j.ok ? j.room.history.map((m) => m.text) : []; };
const login = async (b) => { const s = track(await b.connect()); await emit(s, 'login', {}); return s; };
const b32d = (str) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out = []; for (const c of str.replace(/[^A-Z2-7]/g, '')) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const totpAt = (secret, step) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(step)); const hh = createHmac('sha1', b32d(secret)).update(m).digest(); const o = hh[hh.length - 1] & 15; return String((((hh[o] & 127) << 24) | (hh[o + 1] << 16) | (hh[o + 2] << 8) | hh[o + 3]) % 1e6).padStart(6, '0'); };
let lastStep = 0;
const freshCode = async (secret) => { while (Math.floor(Date.now() / 30000) <= lastStep) await sleep(1000); lastStep = Math.floor(Date.now() / 30000); return totpAt(secret, lastStep); };
// Upgrade test: live build a399785 (batch E+F, DB v44) -> batch G+H build (adds migration 45), plus both rollbacks.
//   BASE_ROOT=<a399785 build> NEW_ROOT=<new build> node scripts/test-upgrade-a399.mjs
const signIn = async (user, pw) => { const b = browser(); await b.boot(); const r = await b.req('/api/auth/login', { username: user, password: pw }); return { b, r: r.json }; };
const signedInAs = async (b) => (await b.req('/api/me')).json.account?.username ?? null;
delete env.ONBOARDING_SINCE; // real first-visit rule: accounts made before the upgrade never see the tour
try {
  ROOT = BASE_ROOT; await startServer();
  const owner = browser(); await owner.boot();
  ok((await register(owner, 'Up_Owner', 'up-owner-password')).json.ok, '[a399] owner registered');
  const pal = browser(); await pal.boot();
  ok((await register(pal, 'Up_Pal', 'up-pal-password')).json.ok, '[a399] second account registered');
  const palId = (await pal.req('/api/me')).json.account?.id;
  let so = await login(owner);
  const rid = (await emit(so, 'room:create', { name: 'upgrade hall', topic: 't', category: 'gaming' })).roomId;
  await emit(so, 'room:join', { roomId: rid });
  for (let i = 0; i < 4; i++) { await emit(so, 'chat:send', { text: `old line ${i}` }); await sleep(300); }
  sockets.forEach((s) => s.close()); await sleep(200); await stopServer();
  const before = snapshot();
  ok(before.v === 44, `[a399] database at user_version ${before.v}`);
  { const d = new DatabaseSync(dbPath); d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); d.close(); }
  fs.copyFileSync(dbPath, path.join(DATA, 'camchat.db.pre-test'));
  // ---- upgrade ----
  ROOT = NEW_ROOT; serverLog = ''; await startServer();
  ok((await fetch(BASE + '/api/health').then((r) => r.json())).db, '[new] boots on the a399 database');
  ok(/applied migration 45/.test(serverLog), '[new] applies migration 45');
  so = await login(owner);
  ok((await history(so, rid)).filter((t) => /^old line/.test(t)).length === 4, '[new] old history intact');
  ok((await emit(so, 'room:template:apply', { template: 'study' })).ok, '[new] G3: template applies to an old room');
  const role = await emit(so, 'roles:save', { name: 'Helper', color: '#3fa7ff', perms: ['pin', 'messages'] });
  ok(role.ok && role.role?.id, `[new] G4: owner creates a custom role on an old room ${role.error || ''}`);
  const sp = await login(pal); await emit(sp, 'room:join', { roomId: rid });
  ok((await emit(so, 'roles:assign', { accountId: palId, roleId: role.role?.id })).ok, '[new] G4: role assigned to an old account');
  ok((await emit(sp, 'whisper:receipts', {})).on === true, '[new] G5: old accounts default to read receipts on');
  const ob = (await pal.req('/api/me/onboarding')).json;
  ok(ob.ok && ob.needed === false, '[new] H6: an account made before the upgrade skips the first-visit tour');
  const fresh = browser(); await fresh.boot();
  ok((await register(fresh, 'Up_Fresh', 'up-fresh-password')).json.ok && (await fresh.req('/api/me/onboarding')).json.needed === true, '[new] H6: a new account gets the tour');
  ok((await fetch(BASE + '/api/translate/config').then((r) => r.json())).ok, '[new] G1: translate config endpoint');
  ok((await emit(so, 'chat:send', { text: 'new line after upgrade' })).ok, '[new] chat works');
  sockets.forEach((s) => s.close()); await sleep(200); await stopServer();
  const after = snapshot();
  ok(after.v === 45, `[new] user_version ${after.v}`);
  ok(Object.keys(before.rows).every((t) => t in after.rows), '[new] every a399 table kept');
  ok(Object.keys(before.cols).every((t) => before.cols[t].every((c) => after.cols[t].includes(c))), '[new] every a399 column kept (migrations only add)');
  const added = Object.keys(after.rows).filter((t) => !(t in before.rows));
  ok(['room_clips', 'room_roles', 'room_role_members'].every((t) => added.includes(t)), `[new] added tables: ${added.join(', ')}`);
  ok(['whisper_receipts', 'onboarded_at', 'interests'].every((c) => after.cols.users.includes(c)) && after.cols.rooms.includes('template'), '[new] added columns users.whisper_receipts/onboarded_at/interests, rooms.template');
  // ---- rollback --keep-db ----
  ROOT = BASE_ROOT; serverLog = ''; await startServer();
  ok((await fetch(BASE + '/api/health').then((r) => r.json())).db, '[rollback --keep-db] a399 boots on the v45 database');
  ok(!/Error|error:/.test(serverLog.replace(/ExperimentalWarning[^\n]*/g, '')), '[rollback --keep-db] no errors at start');
  so = await login(owner);
  const hk = await history(so, rid);
  ok(hk.includes('new line after upgrade') && hk.filter((t) => /^old line/.test(t)).length === 4, '[rollback --keep-db] old + new history readable');
  ok((await emit(so, 'chat:send', { text: 'on a399 again' })).ok, '[rollback --keep-db] chat works');
  const rp = await signIn('Up_Pal', 'up-pal-password');
  ok(rp.r.ok && await signedInAs(rp.b) === 'Up_Pal', '[rollback --keep-db] sign-in works');
  sockets.forEach((s) => s.close()); await sleep(200); await stopServer();
  ok(snapshot().v === 45, '[rollback --keep-db] the old build leaves user_version 45 alone');
  // ---- re-upgrade after keep-db ----
  ROOT = NEW_ROOT; serverLog = ''; await startServer();
  ok(!/applied migration/.test(serverLog), '[re-upgrade after keep-db] nothing to migrate');
  so = await login(owner); await emit(so, 'room:join', { roomId: rid });
  const rg = await emit(so, 'roles:get', {});
  ok(rg.ok && rg.roles?.some((r) => r.name === 'Helper') && rg.members?.[palId] != null, '[re-upgrade after keep-db] custom role and holder still there');
  sockets.forEach((s) => s.close()); await sleep(200); await stopServer();
  // ---- full rollback ----
  for (const f of ['camchat.db', 'camchat.db-wal', 'camchat.db-shm']) if (fs.existsSync(path.join(DATA, f))) fs.renameSync(path.join(DATA, f), path.join(DATA, f + '.rolledback'));
  fs.copyFileSync(path.join(DATA, 'camchat.db.pre-test'), dbPath);
  ROOT = BASE_ROOT; serverLog = ''; await startServer();
  so = await login(owner);
  const hr = await history(so, rid);
  ok(snapshot().v === 44 && hr.filter((t) => /^old line/.test(t)).length === 4 && !hr.includes('new line after upgrade'), '[rollback] a399 on the restored pre-upgrade DB (v44)');
  ok(fs.existsSync(path.join(DATA, 'camchat.db.rolledback')), '[rollback] the upgraded DB is kept aside, not deleted');
  sockets.forEach((s) => s.close()); await sleep(200); await stopServer();
  // ---- forward again ----
  ROOT = NEW_ROOT; serverLog = ''; await startServer();
  ok((await fetch(BASE + '/api/health')).status === 200 && /applied migration 45/.test(serverLog), '[re-upgrade] boots on the restored DB and migrates to 45');
  await stopServer(); serverLog = ''; await startServer();
  ok(!/applied migration/.test(serverLog), '[re-upgrade] idempotent: nothing to migrate on restart');
} catch (err) {
  failed++; console.log('FAIL  crashed: ' + (err && err.stack || err));
} finally {
  sockets.forEach((s) => { try { s.close(); } catch {} });
  await stopServer();
  fixture.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
