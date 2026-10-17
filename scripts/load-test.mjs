/**
 * Batch H7 load test: N socket clients (default 200) against a local server, with SQL profiling.
 *   npm run build && node scripts/load-test.mjs [--clients 200] [--seed 30000] [--out report.json]
 * Phases: register + connect + login, join rooms (latency + join payload size), chat burst (ack + fan-out latency),
 * HTTP/admin/search/analytics endpoints under the connected load. Prints p50/p95/max and the slowest SQL statements.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { io: ioClient } = require('socket.io-client');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const CLIENTS = Number(arg('clients', 200));
const SEED = Number(arg('seed', 30000));
const ROOMS = 10;
const OUT = arg('out', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-load-'));
const BASE = `http://127.0.0.1:${port}`;
const PROFILE = path.join(DATA, 'sql-profile.json');
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', BACKUP_DISABLED: '1',
    REGISTRATIONS_PER_IP_PER_HOUR: '100000', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'load_admin', SQL_PROFILE: PROFILE, ONBOARDING_SINCE: '4102444800000' } });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 300 && !log.includes('listening'); i++) await sleep(100);

const stats = {};
const rec = (k, ms) => (stats[k] ??= []).push(ms);
const sizes = {};
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] : 0; };
const time = async (k, fn) => { const t = performance.now(); try { return await fn(); } finally { rec(k, performance.now() - t); } };
let ipN = 0;
function jar() {
  const xff = `10.${50 + ((++ipN >> 16) & 63)}.${(ipN >> 8) & 255}.${ipN & 255 || 1}`;
  const m = new Map();
  const header = () => [...m].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = (r) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); m.set(kv.slice(0, i), kv.slice(i + 1)); } };
  return { xff, header, async req(p, body) {
    const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'x-csrf': '1', 'x-forwarded-for': xff, cookie: header(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    take(r); const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch { /* */ } j.status = r.status; j.bytes = text.length; return j;
  } };
}
const emit = (s, ev, ...a) => new Promise((res) => { const t = setTimeout(() => res({ ok: false, error: `timeout ${ev}` }), 20000); s.emit(ev, ...a, (r) => { clearTimeout(t); res(r); }); });
async function register(nick) {
  const j = jar(); await j.req('/api/me');
  const cap = await j.req('/api/auth/captcha');
  const m = /What is (\d+) \+ (\d+)/.exec(cap.question || '');
  const r = await time('http register', () => j.req('/api/auth/register', { username: nick, password: `pw-${nick}-secret-1`, email: `${nick.toLowerCase()}@example.com`, ...(m ? { captchaId: cap.id, captchaAnswer: String(+m[1] + +m[2]) } : { captchaToken: 'test' }) }));
  if (!r.ok) throw new Error(`register ${nick}: ${r.error}`);
  return { j, nick, id: r.account.id };
}
async function connect(u) {
  const me = await u.j.req('/api/me');
  const t = performance.now();
  const s = ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: u.j.header(), 'x-forwarded-for': u.j.xff }, auth: { deviceId: me.deviceId } });
  await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
  const l = await emit(s, 'login', {});
  rec('socket connect+login', performance.now() - t);
  if (!l.ok) throw new Error(`login ${u.nick}: ${l.error}`);
  u.s = s; return u;
}
const pool = async (items, n, fn) => { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; };

const report = { clients: CLIENTS, seedMessages: SEED, rooms: ROOMS, at: new Date().toISOString() };
try {
  const t0 = performance.now();
  const users = await pool(Array.from({ length: CLIENTS }, (_, i) => `load_u${i}`), 16, (n) => register(n));
  const admin = await register('load_admin');
  report.registerSec = Math.round((performance.now() - t0) / 100) / 10;
  await pool(users, 25, connect); await connect(admin);
  // rooms owned by the first ROOMS users
  const roomIds = [];
  for (let i = 0; i < ROOMS; i++) { const r = await emit(users[i].s, 'room:create', { name: `load-room-${i}`, category: 'talk' }); if (!r.ok) throw new Error(r.error); roomIds.push(r.roomId); }
  // seed history: SEED messages spread over the rooms (most in room 0), plus older days of visitors
  {
    const db = new DatabaseSync(path.join(DATA, 'camchat.db'));
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO messages (id, room_id, ts, user_id, nick, role, text) VALUES (?,?,?,?,?,?,?)');
    const words = ['hello', 'music', 'game', 'tonight', 'stream', 'voice', 'camera', 'study', 'coffee', 'weekend', 'zeronoise', 'room'];
    const now = Date.now();
    for (let i = 0; i < SEED; i++) {
      const u = users[i % users.length]; const room = i % 2 ? roomIds[0] : roomIds[i % ROOMS];
      ins.run(crypto.randomUUID(), room, now - (SEED - i) * 20_000, u.id, u.nick, 'user', `${words[i % words.length]} ${words[(i * 7) % words.length]} message ${i}`);
    }
    const vis = db.prepare('INSERT OR IGNORE INTO room_visitors (room_id, day, user_id, messages) VALUES (?,?,?,?)');
    const today = Math.floor(now / 86400000);
    for (let d = 0; d < 30; d++) for (const u of users) vis.run(roomIds[u.id % ROOMS], today - d, u.id, 3);
    db.exec('COMMIT'); db.close();
  }
  // join: 20 per room
  const memoryBefore = process.memoryUsage().rss;
  void memoryBefore;
  await pool(users, 25, async (u, i) => {
    const r = await time('room:join', () => emit(u.s, 'room:join', { roomId: roomIds[i % ROOMS] }));
    if (!r.ok) throw new Error(`join: ${r.error}`);
    (sizes['room:join payload KB'] ??= []).push(JSON.stringify(r).length / 1024);
    u.room = roomIds[i % ROOMS];
  });
  // chat burst: each client sends 5 lines with jitter over ~15 s; measure ack + fan-out to the room
  const sentAt = new Map();
  for (const u of users) u.s.on('chat:message', (m) => { const t = sentAt.get(m.text); if (t) rec('chat fan-out (send→receive)', performance.now() - t); });
  await Promise.all(users.map(async (u, i) => {
    for (let k = 0; k < 5; k++) {
      await sleep(1500 + Math.random() * 1500);
      const text = `load ${i}-${k} ${crypto.randomBytes(3).toString('hex')}`;
      sentAt.set(text, performance.now());
      const r = await time('chat:send ack', () => emit(u.s, 'chat:send', { text }));
      if (!r.ok) rec('chat:send refused', 1);
    }
  }));
  await sleep(1000);
  // endpoints under load
  const owner = users[0];
  await emit(admin.s, 'room:join', { roomId: roomIds[0] });
  for (let i = 0; i < 20; i++) {
    await Promise.all([
      time('GET /api/me', () => users[i].j.req('/api/me')),
      time('GET /api/status', () => users[i].j.req('/api/status')),
      time('GET /api/admin/users?q=load', async () => { const r = await admin.j.req('/api/admin/users?q=load'); (sizes['admin users KB'] ??= []).push(r.bytes / 1024); }),
      time('GET /api/admin/log', async () => { const r = await admin.j.req('/api/admin/log'); (sizes['admin log KB'] ??= []).push(r.bytes / 1024); }),
      time('GET /api/admin/stats', () => admin.j.req('/api/admin/stats')),
      time('GET /api/admin/reports', () => admin.j.req('/api/admin/reports')),
      time('GET /api/me/rooms/analytics', () => owner.j.req('/api/me/rooms/analytics')),
      time('stats:analytics', () => emit(owner.s, 'stats:analytics')),
      time('rooms:list', async () => { const r = await emit(users[50 + i].s, 'rooms:list'); (sizes['rooms:list KB'] ??= []).push(JSON.stringify(r).length / 1024); }),
      time('chat:search', () => emit(users[20 + i * 2].s, 'chat:search', { q: ['music', 'coffee game', 'weekend'][i % 3] })),
    ]);
    await sleep(120);
  }
  // reconnect storm: 50 clients drop and come back
  await pool(users.slice(100, 150), 50, async (u) => { u.s.disconnect(); await connect(u); await time('rejoin after reconnect', () => emit(u.s, 'room:join', { roomId: u.room })); });
  report.ops = Object.fromEntries(Object.entries(stats).map(([k, a]) => [k, { n: a.length, p50: Math.round(pct(a, 50) * 10) / 10, p95: Math.round(pct(a, 95) * 10) / 10, max: Math.round(Math.max(...a) * 10) / 10 }]));
  report.sizes = Object.fromEntries(Object.entries(sizes).map(([k, a]) => [k, { p50: Math.round(pct(a, 50) * 10) / 10, max: Math.round(Math.max(...a) * 10) / 10 }]));
  for (const u of [...users, admin]) try { u.s.disconnect(); } catch { /* */ }
} catch (e) {
  report.error = e.stack || e.message;
  console.log('ERROR', e.message);
} finally {
  server.kill('SIGTERM');
  for (let i = 0; i < 50 && server.exitCode == null; i++) await sleep(100);
}
try { report.sqlTop = JSON.parse(fs.readFileSync(PROFILE, 'utf8')).slice(0, 15); } catch { report.sqlTop = []; }
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nLoad test: ${CLIENTS} clients, ${ROOMS} rooms, ${SEED} seeded messages (register ${report.registerSec}s)`);
console.log(pad('operation', 34), pad('n', 6), pad('p50 ms', 9), pad('p95 ms', 9), 'max ms');
for (const [k, v] of Object.entries(report.ops ?? {})) console.log(pad(k, 34), pad(v.n, 6), pad(v.p50, 9), pad(v.p95, 9), v.max);
for (const [k, v] of Object.entries(report.sizes ?? {})) console.log(pad(k, 34), 'p50', v.p50, 'max', v.max);
console.log('\nslowest SQL (total ms / calls / max ms):');
for (const r of report.sqlTop.slice(0, 10)) console.log(`${pad(r.ms, 9)} ${pad(r.n, 7)} ${pad(r.max, 8)} ${r.sql.slice(0, 150)}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
process.exit(report.error ? 1 : 0);
