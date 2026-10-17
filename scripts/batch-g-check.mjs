/**
 * Batch G checks: translate, clips, room templates, custom room roles, whisper read receipts.
 *
 * Screenshots at 1366 and 390.   npm run build && node scripts/batch-g-check.mjs [shots-dir]
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
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-batch-g'));
fs.mkdirSync(OUT, { recursive: true });
import crypto from 'node:crypto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-batch-g-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'GgAdmin', RECORDING_MAX_BYTES: '65536', RECORDING_IDLE_MS: '6000', RECONNECT_GRACE_MS: '800',
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
const libreHits = [];
const libre = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { const j = JSON.parse(b || '{}'); libreHits.push(j); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ translatedText: `[${j.target}] ${j.q}`, detectedLanguage: { language: 'es', confidence: 90 } })); }); });
await new Promise((r) => libre.listen(0, '127.0.0.1', r));
const LIBRE = `http://127.0.0.1:${libre.address().port}`;
const fakeTranslator = () => {
  window.LanguageDetector = { create: async () => ({ detect: async () => [{ detectedLanguage: 'es', confidence: 0.9 }] }) };
  window.Translator = { availability: async () => 'available', create: async (o) => ({ translate: async (t) => `(${o.sourceLanguage}→${o.targetLanguage}) ${t.replace('hola amigos', 'hello friends')}` }) };
};
try {
  const owner = await nodeUser('GgOwner'); const mem = await nodeUser('GgMember'); const admin = await nodeUser('GgAdmin'); const other = await nodeUser('GgOther');
  sockets.push(owner.s, mem.s, admin.s, other.s);
  const vr = await emit(owner.s, 'room:create', { name: 'gg-voice', voice: true, category: 'talk' });
  const room = vr.roomId;
  ok(vr.ok, 'voice room created');
  for (const u of [owner, mem, other]) await emit(u.s, 'room:join', { roomId: room });
  // ---------- G1 translate API ----------
  {
    ok((await mem.j.req('/api/translate/config')).server === false, 'G1: no translation server by default');
    ok((await mem.j.req('/api/translate', { text: 'hola', target: 'en' })).status === 404, 'G1: server translate refuses when not set up');
    ok((await mem.j.req('/api/admin/settings/translate', { url: LIBRE })).status === 403, 'G1: members cannot set the translation server');
    ok((await admin.j.req('/api/admin/settings/translate', { url: 'javascript:alert(1)' })).status === 400, 'G1: bad URL refused');
    const set = await admin.j.req('/api/admin/settings/translate', { url: LIBRE + '/' });
    ok(set.ok && set.url === LIBRE, 'G1: admin sets a LibreTranslate URL (trailing slash trimmed)', JSON.stringify(set));
    ok((await mem.j.req('/api/translate/config')).server === true, 'G1: clients see that a server is available');
    const tr = await mem.j.req('/api/translate', { text: 'hola amigos', target: 'en-US' });
    ok(tr.ok && tr.text === '[en] hola amigos' && tr.from === 'es' && libreHits.at(-1)?.source === 'auto', 'G1: server translation goes through LibreTranslate', JSON.stringify(tr));
    ok((await mem.j.req('/api/translate', { text: '', target: 'en' })).status === 400, 'G1: empty text refused');
    await emit(owner.s, 'chat:send', { text: 'hola amigos' });
  }
  // @@API-END

  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--lang=en-US'] });
  const fresh = async (u) => { try { u.s.disconnect(); } catch { /* */ } u.s = await sock(u.j); sockets.push(u.s); return u.s; };
  const clickMsgAction = (page, text, action) => page.evaluate((text, action) => { const li = [...document.querySelectorAll('.chat-log .msg')].reverse().find((e) => e.textContent.includes(text)); const b = li?.querySelector(`[data-action="${action}"]`); b?.scrollIntoView({ block: 'center' }); b?.click(); return !!b; }, text, action);
  for (const width of [1366, 390]) {
    // G1 UI: browser on-device translation, server fallback, and the clear note when neither exists
    {
      const a = await pageFor(mem, width);
      await a.page.evaluateOnNewDocument(fakeTranslator);
      await enterRoom(a.page, room);
      await a.page.evaluate(() => document.querySelector('[data-action="rec-ok"]')?.click());
      ok(await clickMsgAction(a.page, 'hola amigos', 'translate-msg'), `${width}: G1: messages have a Translate button`);
      const t = await a.page.waitForSelector('.msg-translation[data-translation="browser"]', { timeout: 6000 }).catch(() => null);
      ok(!!t && /hello friends/.test(await t.evaluate((e) => e.textContent)), `${width}: G1: on-device browser translation shows under the message`);
      await t?.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      ok(await noSideScroll(a.page), `${width}: G1: no sideways scroll`);
      await shot(a.page, `g1-translate-browser-${width}`);
      await a.ctx.close(); await fresh(mem); await emit(mem.s, 'room:join', { roomId: room });
      const b = await pageFor(mem, width);
      await b.page.evaluateOnNewDocument(() => { delete window.Translator; delete window.LanguageDetector; });
      await enterRoom(b.page, room);
      await clickMsgAction(b.page, 'hola amigos', 'translate-msg');
      const s = await b.page.waitForSelector('.msg-translation[data-translation="server"]', { timeout: 6000 }).catch(() => null);
      ok(!!s && /\[en\] hola amigos/.test(await s.evaluate((e) => e.textContent)), `${width}: G1: without on-device translation, the admin's LibreTranslate is used`);
      await shot(b.page, `g1-translate-server-${width}`);
      await b.ctx.close(); await fresh(mem); await emit(mem.s, 'room:join', { roomId: room });
      await admin.j.req('/api/admin/settings/translate', { url: '' });
      const c = await pageFor(mem, width);
      await c.page.evaluateOnNewDocument(() => { delete window.Translator; delete window.LanguageDetector; });
      await enterRoom(c.page, room);
      await clickMsgAction(c.page, 'hola amigos', 'translate-msg');
      const n = await c.page.waitForSelector('.msg-translation[data-translation="unavailable"]', { timeout: 6000 }).catch(() => null);
      ok(!!n && /isn't available/.test(await n.evaluate((e) => e.textContent)), `${width}: G1: a clear note where neither is available`);
      await shot(c.page, `g1-translate-unavailable-${width}`);
      await c.ctx.close(); await fresh(mem); await emit(mem.s, 'room:join', { roomId: room });
      const ad = await pageFor(admin, width);
      await ad.page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
      await ad.page.waitForSelector('.admin-tabs [data-tab="security"]', { timeout: 15000 }).catch(() => null); await sleep(300);
      await ad.page.evaluate(() => document.querySelector('.admin-tabs [data-tab="security"]')?.click());
      const ts = await ad.page.waitForSelector('[data-testid="translate-settings"]', { timeout: 6000 }).catch(() => null);
      if (ts) { await ad.page.type('[data-testid="libre-url"]', LIBRE); await ad.page.$eval('[data-action="save-translate"]', (x) => x.click()); }
      const saved = await ad.page.waitForFunction(() => /Saved/.test(document.querySelector('[data-testid="translate-settings"]')?.textContent || ''), { timeout: 6000 }).catch(() => null);
      ok(!!saved && (await admin.j.req('/api/admin/settings/translate')).url === LIBRE, `${width}: G1: admin sets LibreTranslate in the admin panel`);
      await ts?.evaluate((e) => e.scrollIntoView({ block: 'start' }));
      ok(await noSideScroll(ad.page), `${width}: G1: admin panel: no sideways scroll`);
      await shot(ad.page, `g1-admin-translate-${width}`);
      await ad.ctx.close();
    }
    // @@UI-END
  }
  void fresh;
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  server.kill('SIGTERM'); libre.close();
}
if (failed && process.env.SHOWLOG) console.log(log.slice(-3000));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
