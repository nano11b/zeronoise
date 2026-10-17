/**
 * Batch F checks: voice recording, live captions, room analytics, uptime/error alerts, backup restore check.
 *
 * Screenshots at 1366 and 390.   npm run build && node scripts/batch-f-check.mjs [shots-dir]
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');
const { io: ioClient } = require('socket.io-client');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-batch-f'));
fs.mkdirSync(OUT, { recursive: true });
import crypto from 'node:crypto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-batch-f-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'FfAdmin', RECORDING_MAX_BYTES: '65536', RECORDING_IDLE_MS: '6000', RECONNECT_GRACE_MS: '800',
    SCHEDULE_TICK_MS: '300', EVENT_TICK_MS: '300', STATS_SAMPLE_MS: '500', XP_COOLDOWN_MS: '1200' } });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 200 && !log.includes('listening'); i++) await sleep(100);
for (let i = 0; i < 200 && !log.includes('listening'); i++) await sleep(100);

function jar(xff) {
  const m = new Map();
  const header = () => [...m].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = (r) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); m.set(kv.slice(0, i), kv.slice(i + 1)); } };
  return { header, async req(p, body, method) {
    const r = await fetch(BASE + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'x-csrf': '1', cookie: header(), ...(xff ? { 'x-forwarded-for': xff } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    take(r); const j = await r.json().catch(() => ({})); j.status = r.status; return j;
  }, async form(p, fd) {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'x-csrf': '1', cookie: header() }, body: fd });
    take(r); const j = await r.json().catch(() => ({})); j.status = r.status; return j;
  } };
}
const emit = (s, ev, ...a) => new Promise((res) => { const t = setTimeout(() => res({ ok: false, error: `timeout ${ev}` }), 8000); s.emit(ev, ...a, (r) => { clearTimeout(t); res(r); }); });
async function sock(j) {
  const me = await j.req('/api/me');
  const s = ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: j.header() }, auth: { deviceId: me.deviceId } });
  await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
  await emit(s, 'login', {});
  return s;
}
async function nodeUser(nick) {
  const j = jar();
  await j.req('/api/me');
  const cap = await j.req('/api/auth/captcha');
  const m = /What is (\d+) \+ (\d+)/.exec(cap.question || '');
  const r = await j.req('/api/auth/register', { username: nick, password: `pw-${nick}-secret-1`, email: `${nick.toLowerCase()}@example.com`, ...(m ? { captchaId: cap.id, captchaAnswer: String(+m[1] + +m[2]) } : { captchaToken: 'test' }) });
  if (!r.ok) throw new Error(`register ${nick}: ${r.error}`);
  return { j, nick, s: await sock(j), id: r.account?.id };
}
const png = (color, size = 64) => sharp({ create: { width: size, height: size, channels: 4, background: color } }).png().toBuffer();
async function uploadEmote(j, roomId, name, buf, type = 'image/png', file = 'e.png') {
  const fd = new FormData(); fd.append('name', name); fd.append('emote', new Blob([buf], { type }), file);
  return j.form(`/api/rooms/${encodeURIComponent(roomId)}/emotes`, fd);
}

const sockets = [];
let browser;
const shot = async (page, name) => { await sleep(450); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };

// RFC 6238 test helper (independent of server/totp.ts)
const b32d = (str) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out = []; for (const c of str.replace(/[^A-Z2-7]/g, '')) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const totpAt = (secret, step) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(step)); const h = crypto.createHmac('sha1', b32d(secret)).update(m).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0'); };
const stepNow = () => Math.floor(Date.now() / 30000);
async function fresh0(u) { try { u.s.disconnect(); } catch { /* */ } u.s = await sock(u.j); sockets.push(u.s); return u.s; }
let loginN = 0;
async function login(nick) {
  const j = jar(`10.77.${Math.floor(++loginN / 200)}.${loginN % 200 + 1}`); await j.req('/api/me');
  const r = await j.req('/api/auth/login', { username: nick, password: `pw-${nick}-secret-1` });
  return { j, r };
}
async function pageFor(u, width) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.setViewport(width < 800 ? { width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width, height: 800 });
  await page.setCookie(...u.j.header().split('; ').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE }; }));
  return { ctx, page };
}
async function enterRoom(page, roomId) {
  await page.goto(`${BASE}/?room=${encodeURIComponent(roomId)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chat-log', { timeout: 15000 });
  await page.evaluate(() => [...document.querySelectorAll('a,button')].find((e) => e.textContent.trim() === 'Dismiss')?.click());
  await sleep(500);
}
async function openSettings(page, phone, section) {
  if (phone) { await page.$eval('[data-action="collapse-panel"]', (b) => b.click()); await sleep(400); }
  await page.$eval('[data-action="tab-info"]', (b) => b.click()); await sleep(400);
  if (section) {
    await page.waitForSelector(`details[data-section="${section}"]`, { timeout: 6000 });
    await page.$eval(`details[data-section="${section}"]`, (d) => { d.open = true; d.scrollIntoView({ block: 'start' }); });
    await sleep(700);
  }
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

const ev = (s, name) => new Promise((res) => { const t = setTimeout(() => res(null), 4000); s.once(name, (p) => { clearTimeout(t); res(p); }); });
try {
  const owner = await nodeUser('FfOwner'); const mem = await nodeUser('FfMember'); const admin = await nodeUser('FfAdmin'); const other = await nodeUser('FfOther');
  sockets.push(owner.s, mem.s, admin.s, other.s);
  const vr = await emit(owner.s, 'room:create', { name: 'ff-voice', voice: true, category: 'talk' });
  const room = vr.roomId;
  ok(vr.ok, 'voice room created');
  await emit(owner.s, 'room:join', { roomId: room }); await emit(mem.s, 'room:join', { roomId: room });
  // ---------- 6. recording API ----------
  ok(!(await emit(mem.s, 'rec:start', {})).ok, 'F6: a member cannot start recording');
  const stP = ev(mem.s, 'rec:state');
  const st = await emit(owner.s, 'rec:start', {});
  const stE = await stP;
  ok(st.ok && stE?.rec?.id === st.rec.id && stE.rec.by === 'FfOwner', 'F6: owner starts; everyone in the room gets the red notice', JSON.stringify({ st, stE }));
  ok(!(await emit(owner.s, 'rec:start', {})).ok, 'F6: only one recording at a time');
  const late = await emit(other.s, 'room:join', { roomId: room });
  ok(late.room?.recording?.id === st.rec.id, 'F6: someone joining is told it is being recorded');
  const up = (id, buf, j = owner.j) => { const fd = new FormData(); fd.append('chunk', new Blob([buf]), 'c.webm'); return j.form(`/api/rooms/${encodeURIComponent(room)}/recordings/${id}/chunk`, fd); };
  ok((await up(st.rec.id, Buffer.alloc(1000, 1), mem.j)).status === 404, 'F6: only the recorder can upload');
  ok((await up(st.rec.id, Buffer.alloc(30_000, 2))).ok, 'F6: owner uploads a chunk');
  const endP = ev(mem.s, 'rec:state');
  const capR = await up(st.rec.id, Buffer.alloc(50_000, 3));
  const endE = await endP;
  ok(capR.stop && capR.reason === 'size' && endE?.rec === null, 'F6: the size cap ends the recording for everyone', JSON.stringify({ capR, endE }));
  const list = await owner.j.req(`/api/rooms/${encodeURIComponent(room)}/recordings`);
  ok(list.ok && list.recordings[0]?.bytes === 65536 && list.recordings[0].status === 'capped' && list.retentionDays === 30, 'F6: owner lists it (capped at the limit, default 30-day retention)', JSON.stringify(list.recordings?.[0]));
  ok((await mem.j.req(`/api/rooms/${encodeURIComponent(room)}/recordings`)).status === 403, 'F6: members cannot list recordings');
  const dl = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/recordings/${st.rec.id}/file`, { headers: { cookie: owner.j.header() } });
  ok(dl.status === 200 && /attachment/.test(dl.headers.get('content-disposition') || '') && (await dl.arrayBuffer()).byteLength === 65536, 'F6: owner downloads the file');
  ok((await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/recordings/${st.rec.id}/file`, { headers: { cookie: mem.j.header() } })).status === 403, 'F6: members cannot download');
  ok((await owner.j.req(`/api/rooms/${encodeURIComponent(room)}/recordings/settings`, { retentionDays: 7 })).retentionDays === 7, 'F6: owner sets retention');
  ok((await owner.j.req(`/api/rooms/${encodeURIComponent(room)}/recordings/settings`, { retentionDays: 5 })).status === 400, 'F6: retention must be one of the choices');
  const st2 = await emit(owner.s, 'rec:start', {});
  const idleE = await new Promise((res) => { const f = (p) => { if (p.rec === null) { clearTimeout(t); mem.s.off('rec:state', f); res(p); } }; const t = setTimeout(() => { mem.s.off('rec:state', f); res(null); }, 15000); mem.s.on('rec:state', f); });
  ok(st2.ok && idleE?.rec === null && idleE.reason === 'idle', 'F6: a recorder that goes quiet is stopped automatically', JSON.stringify(idleE));
  // ---------- 7. captions relay ----------
  {
    const capP = ev(mem.s, 'caption');
    const r = await emit(owner.s, 'caption:send', { text: '  hello   everyone  ', final: true });
    const c = await capP;
    ok(r.ok && c?.text === 'hello everyone' && c.nick === 'FfOwner' && c.final === true, 'F7: a shared caption line reaches the room as text', JSON.stringify(c));
    const long = await new Promise((res) => { mem.s.once('caption', res); emit(owner.s, 'caption:send', { text: 'x'.repeat(900), final: false }); });
    ok(long.text.length === 300 && long.final === false, 'F7: caption lines are capped at 300 characters');
    const plain = await emit(other.s, 'room:create', { name: 'ff-plain', category: 'talk' });
    await emit(other.s, 'room:join', { roomId: plain.roomId });
    ok(!(await emit(other.s, 'caption:send', { text: 'hi', final: true })).ok, 'F7: captions are only for voice rooms');
    let burst = 0; for (let i = 0; i < 12; i++) if ((await emit(owner.s, 'caption:send', { text: `b${i}`, final: false })).ok) burst++;
    ok(burst <= 8, 'F7: caption flood is limited', String(burst));
    await emit(other.s, 'room:join', { roomId: room });
  }
  // ---------- 8. room analytics ----------
  {
    const today = Math.floor(Date.now() / 86400000);
    const db = new DatabaseSync(path.join(DATA, 'camchat.db'));
    // two members active 10 days ago (one of them comes back today), plus an hourly peak record
    const ownerId = (await owner.j.req('/api/me')).account.id;
    db.prepare('INSERT OR IGNORE INTO room_visitors (room_id, day, user_id, messages) VALUES (?,?,?,0)').run(room, today - 10, ownerId);
    db.prepare('INSERT OR IGNORE INTO room_visitors (room_id, day, user_id, messages) VALUES (?,?,?,3)').run(room, today - 10, 999001);
    db.prepare('INSERT INTO room_stats_hourly (room_id, hour, messages, peak) VALUES (?,?,5,9) ON CONFLICT(room_id, hour) DO UPDATE SET peak = 9').run(room, (today - 2) * 24 + 15);
    db.close();
    const an = await emit(owner.s, 'stats:analytics');
    const t = an.analytics?.totals;
    ok(an.ok && t.active7 >= 3 && t.activePrev7 === 2 && t.growthPct === Math.round((t.active7 - 2) / 2 * 100), 'F8: active members this week vs last week, with growth %', JSON.stringify(t));
    ok(t.returning7 === 1 && t.members === t.active7 + 1 && t.new7 === t.active7 - 1, 'F8: new and returning members counted', JSON.stringify(t));
    ok(an.analytics.peakByHour[15][2] === 9 && an.analytics.days.length === 30 && t.peak30 >= 9, 'F8: peak times by hour of day');
    ok(!(await emit(mem.s, 'stats:analytics')).ok, 'F8: members cannot see analytics');
    await emit(owner.s, 'room:create', { name: 'ff-second', category: 'talk' });
    await emit(owner.s, 'room:join', { roomId: room });
    const mine = await owner.j.req('/api/me/rooms/analytics');
    ok(mine.ok && mine.rooms.length === 2 && mine.rooms.some((r) => r.id === room && r.active7 >= 3), 'F8: per-room summary for everything you own', JSON.stringify(mine.rooms));
  }
  // @@API-END

  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const fresh = async (u) => { try { u.s.disconnect(); } catch { /* */ } u.s = await sock(u.j); sockets.push(u.s); return u.s; };
  for (const width of [1366, 390]) {
    // F6 UI: owner records from the browser; a member sees the banner and the join notice
    {
      const o = await pageFor(owner, width);
      await enterRoom(o.page, room);
      const startBtn = await o.page.waitForSelector('[data-action="rec-start"]', { timeout: 8000 }).catch(() => null);
      ok(!!startBtn, `${width}: owner of a voice room sees Record`);
      await o.page.$eval('[data-action="rec-start"]', (b) => b.click());
      await o.page.waitForSelector('[data-testid="rec-confirm"]', { timeout: 4000 });
      await shot(o.page, `f6-rec-confirm-${width}`);
      await o.page.$eval('[data-action="rec-confirm"]', (b) => b.click());
      const ban = await o.page.waitForSelector('[data-testid="rec-banner"]', { timeout: 8000 }).catch(() => null);
      ok(!!ban, `${width}: red recording notice shows`);
      const m = await pageFor(other, width);
      await enterRoom(m.page, room);
      const jn = await m.page.waitForSelector('[data-testid="rec-join-notice"]', { timeout: 8000 }).catch(() => null);
      ok(!!jn && !!(await m.page.$('[data-testid="rec-banner"]')), `${width}: joining member gets the recording notice with Stay / Leave`);
      await shot(m.page, `f6-rec-join-notice-${width}`);
      await sleep(5000);
      await shot(o.page, `f6-rec-owner-${width}`);
      await o.page.$eval('[data-action="rec-stop"]', (b) => b.click());
      const gone = await m.page.waitForFunction(() => !document.querySelector('[data-testid="rec-banner"]'), { timeout: 10000 }).catch(() => null);
      ok(!!gone, `${width}: stopping removes the notice for everyone`);
      await o.page.$eval('[data-action="rec-list"]', (b) => b.click());
      const li = await o.page.waitForSelector('[data-testid="rec-item"][data-status="done"]', { timeout: 6000 }).catch(() => null);
      const rl = await owner.j.req(`/api/rooms/${encodeURIComponent(room)}/recordings`);
      const newest = rl.recordings[0];
      let webm = false;
      if (newest) { const b = Buffer.from(await (await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/recordings/${newest.id}/file`, { headers: { cookie: owner.j.header() } })).arrayBuffer()); webm = b.length > 1000 && b.readUInt32BE(0) === 0x1a45dfa3; }
      ok(!!li && webm, `${width}: browser recording uploaded as webm and listed with Download`, JSON.stringify({ li: !!li, newest }));
      await o.page.$eval('[data-testid="rec-list"]', (e) => e.scrollIntoView({ block: 'center' })).catch(() => null);
      ok(await noSideScroll(o.page), `${width}: no sideways scroll`);
      await shot(o.page, `f6-rec-list-${width}`);
      await o.ctx.close(); await m.ctx.close();
      await fresh(owner); await emit(owner.s, 'room:join', { roomId: room }); await fresh(other);
    }
    // F7 UI: a speaker shares captions (speech recognition mocked: headless Chrome has no speech service); a listener reads them
    {
      await sleep(1100);
      const sp = await pageFor(owner, 1366);
      await sp.page.evaluateOnNewDocument(() => {
        class FakeSR { constructor() { this.continuous = false; this.interimResults = false; this.lang = 'en'; this.onresult = null; this.onend = null; this.onerror = null; }
          start() { const mk = (t, f) => { const alt = [{ transcript: t }]; alt.isFinal = f; return alt; };
            setTimeout(() => this.onresult?.({ resultIndex: 0, results: [mk('testing live', false)] }), 300);
            setTimeout(() => this.onresult?.({ resultIndex: 0, results: [mk('testing live captions in the voice room', true)] }), 900); }
          stop() { this.onend = null; } abort() {} }
        window.SpeechRecognition = FakeSR;
      });
      await enterRoom(sp.page, room);
      const li = await pageFor(other, width);
      await li.page.evaluateOnNewDocument(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
      await enterRoom(li.page, room);
      await li.page.evaluate(() => document.querySelector('[data-action="rec-ok"]')?.click());
      const un = await li.page.waitForSelector('[data-testid="captions-unsupported"]', { timeout: 6000 }).catch(() => null);
      ok(!!un, `${width}: browsers without speech recognition get a clear note (and can still read)`);
      await sp.page.$eval('[data-action="captions-share"]', (b) => b.click());
      const got = await li.page.waitForFunction(() => /testing live captions in the voice room/.test(document.querySelector('[data-testid="captions"]')?.textContent || ''), { timeout: 8000 }).catch(() => null);
      ok(!!got, `${width}: listener sees the speaker's captions live`);
      await shot(li.page, `f7-captions-listener-${width}`);
      const spk = await pageFor(owner, width);
      void spk; await spk.ctx.close();
      if (width === 390) { await sp.page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await sleep(600); }
      await shot(sp.page, `f7-captions-speaker-${width}`);
      ok(await noSideScroll(li.page), `${width}: captions: no sideways scroll`);
      await sp.ctx.close(); await li.ctx.close();
      await fresh(owner); await emit(owner.s, 'room:join', { roomId: room }); await fresh(other);
    }
    // F8 UI: Stats tab shows members, growth and peak times
    {
      const o = await pageFor(owner, width);
      await enterRoom(o.page, room);
      if (width < 800) { await o.page.$eval('[data-action="collapse-panel"]', (b) => b.click()); await sleep(400); }
      await o.page.$eval('[data-action="tab-stats"]', (b) => b.click());
      const sec = await o.page.waitForSelector('[data-testid="room-analytics"] [data-stat="growth"]', { timeout: 8000 }).catch(() => null);
      ok(!!sec && !!(await o.page.$('[data-testid="peak-hours"]')) && !!(await o.page.$('[data-testid="rooms-growth"]')), `${width}: Stats shows active members, growth, peak times and all your rooms`);
      if (sec) { await sec.evaluate((e) => e.closest('.room-analytics').scrollIntoView({ block: 'start' })); }
      ok(await noSideScroll(o.page), `${width}: analytics: no sideways scroll`);
      await shot(o.page, `f8-analytics-${width}`);
      await o.ctx.close();
      await fresh(owner); await emit(owner.s, 'room:join', { roomId: room });
    }
    // @@UI-END
  }
  void fresh;
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
