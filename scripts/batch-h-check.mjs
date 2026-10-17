/**
 * Batch H checks: onboarding, load test smoke, accessibility (axe), test reliability, text-to-speech.
 *
 * Screenshots at 1366 and 390.   npm run build && node scripts/batch-h-check.mjs [shots-dir]
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
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-batch-h'));
fs.mkdirSync(OUT, { recursive: true });
import crypto from 'node:crypto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-batch-h-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'HhAdmin', RECORDING_MAX_BYTES: '400000', RECORDING_SWEEP_MS: '1500', ONBOARDING_SINCE: '0', RECORDING_IDLE_MS: '6000', RECONNECT_GRACE_MS: '800',
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
let sockN = 0; // node sockets get their own client IPs so the browser pages (127.0.0.1) never share their action budget
async function sock(j) {
  const me = await j.req('/api/me');
  const s = ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: j.header(), 'x-forwarded-for': `10.88.${(++sockN >> 8) & 255}.${sockN & 255 || 1}` }, auth: { deviceId: me.deviceId } });
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
  await page.waitForSelector('.chat-log', { timeout: 15000 }).catch(async (e) => { await page.screenshot({ path: path.join(os.tmpdir(), 'g-enter-fail.png') }); console.log('[enter-fail]', page.url(), (await page.evaluate(() => document.body.innerText)).slice(0, 300)); throw e; });
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
  const owner = await nodeUser('HhOwner'); const mem = await nodeUser('HhMember'); const admin = await nodeUser('HhAdmin'); const other = await nodeUser('HhOther');
  sockets.push(owner.s, mem.s, admin.s, other.s);
  const mr = await emit(owner.s, 'room:create', { name: 'hh-music', category: 'music', template: 'music' });
  const tr = await emit(other.s, 'room:create', { name: 'hh-tech', category: 'tech' });
  const room = mr.roomId;
  await emit(owner.s, 'room:join', { roomId: room }); await emit(other.s, 'room:join', { roomId: tr.roomId });
  ok(mr.ok && tr.ok, 'rooms created');
  // ---------- H6 onboarding API ----------
  {
    const st = await mem.j.req('/api/me/onboarding');
    ok(st.ok && st.needed === true && st.interests.length === 0, 'H6: a new account needs onboarding', JSON.stringify(st));
    const db = new DatabaseSync(path.join(DATA, 'camchat.db'));
    db.prepare('UPDATE users SET created_at = created_at - 86400000 * 400 WHERE id = ?').run(admin.id);
    db.close();
    ok((await admin.j.req('/api/me/onboarding')).needed === false, 'H6: accounts from before this version never get the tour');
    const p = await mem.j.req('/api/me/onboarding', { interests: ['music', 'bogus', 'gaming', 'music'] });
    ok(p.ok && p.interests.join() === 'music,gaming' && p.needed === true, 'H6: interests saved (unknown dropped, deduped)', JSON.stringify(p));
    const d = await mem.j.req('/api/me/onboarding', { done: true });
    ok(d.needed === false && d.interests.join() === 'music,gaming', 'H6: finishing marks it done and keeps interests');
    ok((await jar().req('/api/me/onboarding')).needed === false, 'H6: guests are not onboarded');
  }
  // @@API-END

  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--lang=en-US'] });
  const fresh = async (u) => { try { u.s.disconnect(); } catch { /* */ } u.s = await sock(u.j); sockets.push(u.s); return u.s; };
  let n = 0;
  for (const width of [1366, 390]) {
    // H6 UI: tour -> interests -> suggested rooms -> join; and skip
    {
      const u = await nodeUser(`HhNew${++n}`); sockets.push(u.s); u.s.disconnect();
      const a = await pageFor(u, width);
      await a.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      const modal = await a.page.waitForSelector('[data-testid="onboarding"][data-step="0"]', { timeout: 15000 }).catch(() => null);
      ok(!!modal, `${width}: H6: first visit opens the tour`);
      ok(await a.page.evaluate(() => document.activeElement?.id === 'onb-title'), `${width}: H6: focus moves into the dialog`);
      await shot(a.page, `h6-tour-${width}`);
      for (let i = 0; i < 3; i++) { await a.page.$eval('[data-action="onb-next"]', (b) => b.click()); await sleep(150); }
      await a.page.waitForSelector('[data-testid="onboarding"][data-step="3"]');
      await a.page.$eval('[data-interest="music"]', (b) => b.click());
      ok(await a.page.$eval('[data-interest="music"]', (b) => b.getAttribute('aria-pressed') === 'true'), `${width}: H6: interest chips toggle (aria-pressed)`);
      ok(await noSideScroll(a.page), `${width}: H6: no sideways scroll`);
      await shot(a.page, `h6-interests-${width}`);
      await a.page.$eval('[data-action="onb-next"]', (b) => b.click());
      const list = await a.page.waitForSelector('[data-testid="onb-suggested"] li[data-room]', { timeout: 4000 }).catch(() => null);
      const first = await a.page.evaluate(() => { const li = document.querySelector('[data-testid="onb-suggested"] li[data-room]'); return li && [li.dataset.room, li.dataset.match]; });
      ok(!!list && first?.[0] === 'hh-music' && first[1] === '1', `${width}: H6: suggested rooms match the picked interests first`, JSON.stringify(first));
      await shot(a.page, `h6-suggested-${width}`);
      await a.page.$eval('[data-testid="onb-suggested"] li[data-room="hh-music"] [data-action="onb-join"]', (b) => b.click());
      const joined = await a.page.waitForSelector('.chat-log', { timeout: 10000 }).catch(() => null);
      ok(!!joined && !(await a.page.$('[data-testid="onboarding"]')), `${width}: H6: Join takes you into the room`);
      await sleep(400);
      const st = await u.j.req('/api/me/onboarding');
      ok(st.needed === false && st.interests.join() === 'music', `${width}: H6: done and interests saved`, JSON.stringify(st));
      await a.ctx.close();
      // skip with Escape
      const v = await nodeUser(`HhNew${++n}`); sockets.push(v.s); v.s.disconnect();
      const b = await pageFor(v, width);
      await b.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await b.page.waitForSelector('[data-testid="onboarding"]', { timeout: 15000 });
      await b.page.keyboard.press('Escape');
      const gone = await b.page.waitForFunction(() => !document.querySelector('[data-testid="onboarding"]'), { timeout: 4000 }).catch(() => null);
      await sleep(300);
      ok(!!gone && (await v.j.req('/api/me/onboarding')).needed === false, `${width}: H6: Escape / Skip ends the tour for good`);
      await b.page.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500);
      ok(!(await b.page.$('[data-testid="onboarding"]')), `${width}: H6: it doesn't come back`);
      await b.ctx.close();
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
if (failed && process.env.SHOWLOG) console.log(log.slice(-3000));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
