/**
 * Batch E checks: passkeys + TOTP QR, room-ban appeals, encrypted TOTP secrets, draft sync, offline outbox.
 *
 * Screenshots at 1366 and 390.   npm run build && node scripts/batch-e-check.mjs [shots-dir]
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
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-batch-e'));
fs.mkdirSync(OUT, { recursive: true });
import crypto from 'node:crypto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-batch-e-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'EeAdmin', RECONNECT_GRACE_MS: '800',
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

const LBASE = `http://localhost:${port}`; // WebAuthn needs a domain RP ID (not an IP); localhost is a secure context
async function lpageFor(u, width) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.setViewport(width < 800 ? { width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width, height: 800 });
  if (u) await page.setCookie(...u.j.header().split('; ').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: LBASE }; }));
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { ctx, page, cdp, authenticatorId };
}
async function openProfile(page) {
  await page.waitForSelector('[data-action="profile"]', { timeout: 15000 });
  await page.$eval('[data-action="profile"]', (b) => b.click()); await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('[role="menu"] button, .profile-actions button')].find((b) => /^\s*Profile\s*$/.test(b.textContent))?.click());
}
const jsqrPath = process.env.JSQR || '/workspace/zn-test/qrtest/node_modules/jsqr/dist/jsQR.js';
const jsQR = fs.existsSync(jsqrPath) ? (await import(jsqrPath)).default : null;

try {
  const owner = await nodeUser('EeOwner'); const mem = await nodeUser('EeMember'); const admin = await nodeUser('EeAdmin'); const other = await nodeUser('EeOther');
  sockets.push(owner.s, mem.s, admin.s, other.s);
  const cr = await emit(owner.s, 'room:create', { name: 'ee-hall', category: 'talk' });
  const room = cr.roomId;
  await emit(owner.s, 'room:join', { roomId: room });

  // ---------- 1. passkeys + QR (API negatives) ----------
  ok((await jar().req('/api/auth/passkey', { ticket: 'nope', credential: {} })).status === 400, 'passwordless sign-in with an unknown ticket is refused');
  const po = await jar().req('/api/auth/passkey/options', {});
  ok(po.ok && po.options.userVerification === 'required' && po.options.allowCredentials.length === 0, 'passwordless options ask for a discoverable passkey with user verification');
  ok((await jar().req('/api/auth/passkey', { ticket: po.ticket, credential: { id: 'AAAA', response: {} } })).status === 400, 'a bogus credential is refused');
  ok((await jar().req('/api/auth/passkey', { ticket: po.ticket, credential: {} })).status === 400, 'a ticket works only once');
  ok((await mem.j.req('/api/me/passkeys/options', {})).options?.authenticatorSelection?.residentKey === 'required', 'registration options request a resident key');
  ok((await jar().req('/api/me/passkeys/options', {})).status === 401, 'registration needs sign-in');
  // @@API-END

  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const fresh = async (u) => { try { u.s.disconnect(); } catch { /* */ } u.s = await sock(u.j); sockets.push(u.s); return u.s; };
  // 1. passkeys end to end (virtual authenticator), once
  {
    const { ctx, page, cdp, authenticatorId } = await lpageFor(mem, 1366);
    await page.goto(LBASE + '/', { waitUntil: 'domcontentloaded' });
    await openProfile(page);
    await page.waitForSelector('[data-action="passkey-add"]', { timeout: 8000 });
    await page.type('[data-testid="passkey-name"]', 'Test laptop');
    await page.$eval('[data-action="passkey-add"]', (b) => b.click());
    const added = await page.waitForSelector('[data-testid="passkeys"][data-count="1"]', { timeout: 10000 }).catch(() => null);
    ok(!!added, 'passkey registered from the Profile dialog', await page.evaluate(() => document.querySelector('.tfa .form-error')?.textContent || ''));
    ok(!!(await page.$('[data-testid="tfa-recovery"]')), 'first passkey shows recovery codes');
    const st = await mem.j.req('/api/me/2fa');
    ok(st.passkeys?.length === 1 && st.passkeys[0].name === 'Test laptop' && st.recoveryLeft === 10, 'server lists the passkey; 10 recovery codes', JSON.stringify(st));
    // passwordless: drop cookies, sign in with the passkey
    await cdp.send('Network.clearBrowserCookies');
    await page.goto(LBASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-action="passkey-login"]', { timeout: 10000 });
    await page.$eval('[data-action="passkey-login"]', (b) => b.click());
    const lobby = await page.waitForSelector('.room-card[data-room="lobby"]', { timeout: 10000 }).catch(() => null);
    ok(!!lobby, 'passwordless sign-in with the passkey');
    ok(await page.evaluate(async () => (await (await fetch('/api/me')).json()).account?.username) === 'EeMember', 'session belongs to the passkey owner');
    // password login now needs a second step; the passkey satisfies it
    await cdp.send('Network.clearBrowserCookies');
    await page.goto(LBASE + '/', { waitUntil: 'domcontentloaded' });
    const lr = await page.evaluate(async () => { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': '1' }, body: JSON.stringify({ username: 'EeMember', password: 'pw-EeMember-secret-1' }) }); return r.json(); });
    ok(lr.twoFactor === true, 'password login asks for the second step when only a passkey is set');
    await page.goto(LBASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-action="tfa-passkey"]', { timeout: 10000 });
    await shot(page, 'e1-passkey-gate-1366');
    await page.$eval('[data-action="tfa-passkey"]', (b) => b.click());
    ok(!!(await page.waitForSelector('.room-card[data-room="lobby"]', { timeout: 10000 }).catch(() => null)), 'passkey completes the second step');
    // counter / clone check: authenticator reports counter; re-using an old assertion is not possible here, check server refuses removal for nothing
    const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    ok(creds.credentials.length === 1 && creds.credentials[0].isResidentCredential, 'the passkey is discoverable (resident)');
    await ctx.close();
  }
  for (const width of [1366, 390]) {
    const phone = width < 800;
    // 1. QR code for TOTP + passkey list
    {
      const { ctx, page } = await lpageFor(other, width);
      await page.goto(LBASE + '/', { waitUntil: 'domcontentloaded' });
      await openProfile(page);
      await page.waitForSelector('[data-action="tfa-setup"]', { timeout: 8000 });
      await page.$eval('[data-action="tfa-setup"]', (b) => b.click());
      const qr = await page.waitForSelector('[data-testid="tfa-qr"] svg', { timeout: 6000 }).catch(() => null);
      ok(!!qr, `${width}: TOTP setup shows a QR code`);
      if (qr) {
        await qr.evaluate((e) => e.closest('.profile-section').scrollIntoView({ block: 'start' }));
        await shot(page, `e1-totp-qr-${width}`);
        const href = await page.$eval('[data-testid="tfa-otpauth"]', (a) => a.getAttribute('href'));
        if (jsQR) {
          const png = await qr.screenshot();
          const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          const res = jsQR(new Uint8ClampedArray(data), info.width, info.height);
          ok(res?.data === href, `${width}: the QR decodes to the otpauth link`, res?.data);
        } else console.log('note  jsQR not installed; QR decode skipped');
        await page.evaluate(() => [...document.querySelectorAll('.tfa button')].find((b) => b.textContent === 'Cancel')?.click());
      }
      await sleep(300);
      const pk = await page.$('[data-testid="passkeys"]');
      if (pk) { await pk.evaluate((e) => e.scrollIntoView({ block: 'center' })); await shot(page, `e1-passkeys-${width}`); }
      ok(!!pk && await noSideScroll(page), `${width}: passkey section shown, no sideways scroll`);
      await ctx.close();
      void phone;
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
