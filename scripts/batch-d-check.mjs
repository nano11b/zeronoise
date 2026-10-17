/**
 * Batch D checks: XP and levels, ban appeals, two-factor sign-in (TOTP, recovery codes, passkeys), data export, game bridge kit.
 *
 * Screenshots at 1366 and 390.   npm run build && node scripts/batch-d-check.mjs [shots-dir]
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');
const { io: ioClient } = require('socket.io-client');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-batch-d'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-batch-d-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'DdAdmin', RECONNECT_GRACE_MS: '800',
    SCHEDULE_TICK_MS: '300', EVENT_TICK_MS: '300', STATS_SAMPLE_MS: '500', XP_COOLDOWN_MS: '1200' } });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 200 && !log.includes('listening'); i++) await sleep(100);
for (let i = 0; i < 200 && !log.includes('listening'); i++) await sleep(100);

function jar() {
  const m = new Map();
  const header = () => [...m].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = (r) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); m.set(kv.slice(0, i), kv.slice(i + 1)); } };
  return { header, async req(p, body, method) {
    const r = await fetch(BASE + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'x-csrf': '1', cookie: header(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
  const owner = await nodeUser('DdOwner'); const mem = await nodeUser('DdMember'); const admin = await nodeUser('DdAdmin'); const other = await nodeUser('DdOther');
  sockets.push(owner.s, mem.s, admin.s, other.s);
  const cr = await emit(owner.s, 'room:create', { name: 'dd-hall', category: 'talk' });
  const room = cr.roomId;
  await emit(owner.s, 'room:join', { roomId: room });

  // ---------- 6. XP and levels ----------
  const xpOf = async (u) => (await u.j.req('/api/me/xp'));
  await emit(mem.s, 'room:join', { roomId: room });
  // alone? owner is in the room, so mem is not alone. First: talking alone earns nothing
  const solo = await emit(other.s, 'room:create', { name: 'dd-solo' });
  await emit(other.s, 'room:join', { roomId: solo.roomId });
  await emit(other.s, 'chat:send', { text: 'hello is anyone here' }); await sleep(300);
  ok((await xpOf(other)).xp === 0, 'talking alone in a room earns no XP');
  await emit(mem.s, 'chat:send', { text: 'first real message here' }); await sleep(300);
  let x = await xpOf(mem);
  ok(x.xp === 5 && x.level === 1, 'a chat line with someone else in the room earns 5 XP', JSON.stringify(x));
  await emit(mem.s, 'chat:send', { text: 'second message right away' }); await sleep(300);
  ok((await xpOf(mem)).xp === 5, 'cooldown: no XP for a line right after the last one');
  await sleep(1300);
  await emit(mem.s, 'chat:send', { text: 'FIRST real message here!!!' }); await sleep(300);
  ok((await xpOf(mem)).xp === 5, 'duplicate check: same line with case/punctuation changes earns nothing');
  await emit(mem.s, 'chat:send', { text: 'ok' }); await sleep(300);
  ok((await xpOf(mem)).xp === 5, 'very short lines earn nothing');
  await emit(mem.s, 'chat:send', { text: 'a genuinely different line' }); await sleep(300);
  ok((await xpOf(mem)).xp === 10, 'a new line after the cooldown earns XP');
  // level up toast + badge
  const lvEv = new Promise((res) => { const t = setTimeout(() => res(null), 30000); mem.s.once('xp:levelup', (p) => { clearTimeout(t); res(p); }); });
  for (let i = 0; i < 9; i++) { await sleep(1300); await emit(mem.s, 'chat:send', { text: `unique line number ${i} about ${'abcdefghij'[i]} things` }); }
  const lv = await lvEv;
  x = await xpOf(mem);
  ok(lv?.level === 2 && x.level === 2 && x.xp >= 50, 'reaching 50 XP is level 2 (level-up event)', JSON.stringify({ lv, x }));
  const hist = (await emit(other.s, 'room:join', { roomId: room })).room;
  ok(hist.users.find((u) => u.nick === 'DdMember')?.level === 2, 'people list shows the level');
  ok(hist.history.filter((m) => m.from === 'DdMember').pop()?.level === 2, 'chat lines carry the level');
  ok((await other.j.req('/api/users/DdMember/profile')).profile.level === 2, 'profile card shows the level');
  // opt out
  const upd = ev(other.s, 'user:updated');
  ok((await mem.j.req('/api/me/xp', { hidden: true }, 'PATCH')).ok, 'member hides their level');
  const uu = await upd;
  ok(uu && uu.nick === 'DdMember' && uu.level === undefined, 'room is told the level is hidden');
  ok((await other.j.req('/api/users/DdMember/profile')).profile.level === null, 'hidden level not on the profile');
  await sleep(1300); await emit(mem.s, 'chat:send', { text: 'still earning while hidden' }); await sleep(300);
  const hx = await xpOf(mem);
  ok(hx.hidden && hx.xp > x.xp, 'XP still counts while hidden (display only)');
  const hist2 = (await emit(other.s, 'room:join', { roomId: room })).room;
  ok(hist2.history.filter((m) => m.from === 'DdMember').every((m) => m.level === undefined), 'hidden level not on chat lines');
  await mem.j.req('/api/me/xp', { hidden: false }, 'PATCH');
  ok(!(await mem.j.req('/api/me/xp', { hidden: 'yes' }, 'PATCH')).ok, 'opt-out takes a boolean');
  // @@API-END

  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  for (const width of [1366, 390]) {
    const phone = width < 800;
    const fresh = async (u) => { try { u.s.disconnect(); } catch { /* */ } u.s = await sock(u.j); sockets.push(u.s); return u.s; };
    // 6. level badges in chat + Level section
    {
      const o = await pageFor(other, width);
      await enterRoom(o.page, room);
      ok(!!(await o.page.$('.chat-log [data-level="2"]')), `${width}: level badge next to names in chat`);
      await shot(o.page, `d6-level-badges-${width}`);
      await o.ctx.close();
      const m = await pageFor(mem, width);
      await m.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await m.page.waitForSelector('[data-action="profile"]', { timeout: 15000 });
      await m.page.$eval('[data-action="profile"]', (b) => b.click()); await sleep(400);
      await m.page.evaluate(() => [...document.querySelectorAll('[role="menu"] button, .profile-actions button')].find((b) => /^\s*Profile\s*$/.test(b.textContent))?.click());
      const sec = await m.page.waitForSelector('[data-section="level"]', { timeout: 6000 }).catch(() => null);
      ok(!!sec && !!(await m.page.$('[data-action="xp-hide"]')), `${width}: Profile dialog shows level, progress and the hide option`);
      if (sec) await sec.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await shot(m.page, `d6-level-profile-${width}`);
      await m.ctx.close();
      await fresh(other); await fresh(mem);
      await emit(other.s, 'room:join', { roomId: room }); await emit(mem.s, 'room:join', { roomId: room });
    }
    // @@UI-END
  }
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
