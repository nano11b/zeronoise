/**
 * Batch E checks: passkeys + TOTP QR, room-ban appeals, encrypted TOTP secrets, draft sync, offline outbox.
 *
 * Screenshots at 1366 and 390.   npm run build && node scripts/batch-e-check.mjs [shots-dir]
 */
import './lib/reap.mjs';
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
  // ---------- 2. room-ban appeals ----------
  const memId = async () => (await emit(owner.s, 'room:join', { roomId: room })).room.users.find((u) => u.nick === 'EeMember')?.id;
  await emit(mem.s, 'room:join', { roomId: room });
  ok((await emit(owner.s, 'room:ban', { userId: await memId(), minutes: 60, reason: 'flooding' })).ok, 'owner bans the member from the room');
  await sleep(300); await fresh0(mem);
  const bj = await emit(mem.s, 'room:join', { roomId: room });
  ok(!bj.ok && /banned from this room/.test(bj.error), 'banned member cannot join', bj.error);
  const rs1 = await emit(mem.s, 'roomappeal:status', { roomId: room });
  ok(rs1.ok && rs1.banned && rs1.canAppeal && rs1.appeal === null && rs1.ban.reason === 'flooding', 'status shows the room ban and no appeal yet', JSON.stringify(rs1));
  ok(!(await emit(mem.s, 'roomappeal:submit', { roomId: room, text: 'short' })).ok, 'appeal text needs a minimum length');
  const ra = await emit(mem.s, 'roomappeal:submit', { roomId: room, text: 'Sorry for the flood, my macro key got stuck. It will not happen again.' });
  ok(ra.ok && ra.appeal.status === 'open', 'member appeals the room ban');
  ok(!(await emit(mem.s, 'roomappeal:submit', { roomId: room, text: 'Trying again with a second appeal for the same ban.' })).ok, 'only one appeal per room ban');
  ok(!(await emit(other.s, 'roomappeal:submit', { roomId: room, text: 'I am not banned but want to appeal anyway, please.' })).ok, 'cannot appeal without a room ban');
  const rq = await emit(owner.s, 'modq:room:list', { status: 'open', sort: 'count' });
  ok(rq.ok && rq.items.some((i) => i.key === `rappeal:${ra.appeal.id}`), 'appeal shows up in the room\'s mod queue', JSON.stringify(rq).slice(0, 200));
  ok((await admin.j.req('/api/admin/reports?view=queue&status=open')).items?.some((i) => i.key === `rappeal:${ra.appeal.id}`), 'site staff see it too');
  ok(!(await emit(other.s, 'roomappeal:decide', { appealId: ra.appeal.id, decision: 'approve' })).ok, 'a non-manager cannot decide');
  const rd = await emit(owner.s, 'roomappeal:decide', { appealId: ra.appeal.id, decision: 'deny', note: 'two strikes' });
  ok(rd.ok && rd.decision === 'denied', 'owner denies');
  ok(!(await emit(owner.s, 'roomappeal:decide', { appealId: ra.appeal.id, decision: 'approve' })).ok, 'a decided appeal stays decided');
  const rs2 = await emit(mem.s, 'roomappeal:status', { roomId: room });
  ok(rs2.banned && rs2.appeal.status === 'denied' && rs2.appeal.note === 'two strikes', 'denied: ban stays, member sees the note');
  ok(!(await emit(mem.s, 'room:join', { roomId: room })).ok, 'still banned after denial');
  ok(!(await emit(owner.s, 'modq:room:list', { status: 'open', sort: 'count' })).items.some((i) => i.key === `rappeal:${ra.appeal.id}`), 'decided appeal leaves the open queue');
  const lgE = (await admin.j.req('/api/admin/log')).log || [];
  ok(['room-appeal', 'room-appeal-deny'].every((a) => lgE.some((l) => l.action === a)), 'appeal + denial logged');
  // E3: no key in this run: admin status says so, members can't read it
  { const st = await admin.j.req('/api/admin/security-status'); ok(st.ok && st.keySet === false && typeof st.plaintext === 'number', 'E3: admin security status reports the missing key', JSON.stringify(st));
    ok((await mem.j.req('/api/admin/security-status')).status >= 401, 'E3: security status is admin-only'); }
  // E4: draft sync API
  {
    const s2 = await sock(mem.j); sockets.push(s2);
    await emit(mem.s, 'draft:get', { roomId: room }); await emit(s2, 'draft:get', { roomId: room });
    const got = new Promise((r) => { const t = setTimeout(() => r(null), 4000); s2.once('draft:sync', (p) => { clearTimeout(t); r(p); }); });
    const sv = await emit(mem.s, 'draft:save', { roomId: room, threadId: '', text: 'half a thought', at: Date.now() });
    const p = await got;
    ok(sv.ok && p?.text === 'half a thought' && p.threadId === '', 'E4: a saved draft reaches the account\'s other device live', JSON.stringify({ sv, p }));
    const old = await emit(mem.s, 'draft:save', { roomId: room, threadId: '', text: 'stale', at: Date.now() - 60_000 });
    ok(old.ok && old.updatedAt == null, 'E4: an older edit never overwrites a newer draft');
    await emit(mem.s, 'draft:save', { roomId: room, threadId: 'thread-x', text: 'reply draft', at: Date.now() });
    const g = await emit(s2, 'draft:get', { roomId: room });
    ok(g.drafts?.find((d) => d.threadId === '')?.text === 'half a thought' && g.drafts?.find((d) => d.threadId === 'thread-x')?.text === 'reply draft', 'E4: drafts are kept per room and per thread', JSON.stringify(g));
    const og = await emit(other.s, 'draft:get', { roomId: room });
    ok(og.ok && og.drafts.length === 0, 'E4: drafts are private to the account');
    await emit(mem.s, 'draft:save', { roomId: room, threadId: '', text: '', at: Date.now() });
    await emit(mem.s, 'draft:save', { roomId: room, threadId: 'thread-x', text: '', at: Date.now() });
    ok(((await emit(s2, 'draft:get', { roomId: room })).drafts || []).length === 0, 'E4: clearing (sending) removes the draft everywhere');
    s2.disconnect();
  }
  // E5: dedup by clientId
  {
    const got = []; const on = (m) => { if (m.kind === 'chat' && /^outbox-dedup/.test(m.text)) got.push(m.id); }; other.s.on('chat:message', on);
    await emit(other.s, 'room:join', { roomId: room });
    const a1 = await emit(owner.s, 'chat:send', { text: 'outbox-dedup once', clientId: 'cid-dedup-0001' });
    const a2 = await emit(owner.s, 'chat:send', { text: 'outbox-dedup once', clientId: 'cid-dedup-0001' });
    await sleep(500); other.s.off('chat:message', on);
    ok(a1.ok && a2.ok && a2.duplicate && a2.id === a1.id && got.length === 1, 'E5: a resent line with the same clientId is posted once', JSON.stringify({ a1, a2, got }));
  }
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
    // 2. room-ban appeal form in the lobby, and the queue entry for the room owner
    {
      const nick = `EeBan${width}`;
      const bu = await nodeUser(nick); sockets.push(bu.s);
      await emit(bu.s, 'room:join', { roomId: room });
      const uid = (await emit(owner.s, 'room:join', { roomId: room })).room.users.find((u) => u.nick === nick)?.id;
      await emit(owner.s, 'room:ban', { userId: uid, minutes: 30, reason: 'ui test' });
      try { bu.s.disconnect(); } catch { /* */ }
      const p = await pageFor(bu, width);
      await p.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await p.page.waitForSelector(`.room-card[data-room="${room}"]`, { timeout: 15000 });
      await p.page.$eval(`.room-card[data-room="${room}"]`, (c) => c.click());
      const f = await p.page.waitForSelector('[data-testid="room-appeal"] [data-testid="room-appeal-text"]', { timeout: 8000 }).catch(() => null);
      ok(!!f, `${width}: banned member gets the room appeal form`);
      if (f) {
        await f.type('My cat walked on the keyboard, sorry about the spam.');
        await shot(p.page, `e2-room-appeal-form-${width}`);
        await p.page.$eval('[data-action="room-appeal-submit"]', (b) => b.click());
        ok(!!(await p.page.waitForSelector('[data-testid="room-appeal"][data-status="open"]', { timeout: 6000 }).catch(() => null)) && await noSideScroll(p.page), `${width}: appeal sent, status shown`);
      }
      await p.ctx.close();
      const o = await pageFor(owner, width);
      await enterRoom(o.page, room);
      await openSettings(o.page, phone, 'reports');
      const act = await o.page.waitForSelector('[data-testid="appeal-actions"]', { timeout: 8000 }).catch(() => null);
      ok(!!act, `${width}: room owner sees the appeal with approve/deny`);
      if (act) { await act.evaluate((e) => e.scrollIntoView({ block: 'center' })); await shot(o.page, `e2-room-appeal-queue-${width}`); }
      if (act && width === 390) {
        await o.page.evaluate((n) => [...document.querySelectorAll('.queue-item')].find((q) => q.textContent.includes(n))?.querySelector('[data-action="appeal-approve"]')?.click(), nick); await sleep(800);
        const j = await emit(await fresh0(bu), 'room:join', { roomId: room });
        ok(j.ok, 'approving from the queue lifts the room ban', j.error);
      }
      await o.ctx.close();
      await fresh(owner); await emit(owner.s, 'room:join', { roomId: room });
    }
    // E3: missing-key warning in the admin panel
    {
      const a = await pageFor(admin, width);
      await a.page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
      const ban = await a.page.waitForSelector('[data-testid="secret-key-banner"]', { timeout: 15000 }).catch(() => null);
      ok(!!ban, `${width}: admin panel warns that the secret key is missing`);
      await a.page.waitForSelector('.admin-tabs [data-tab="security"]', { timeout: 15000 }).catch(() => null); await sleep(300);
      await a.page.evaluate(() => document.querySelector('.admin-tabs [data-tab="security"]')?.click());
      const st = await a.page.waitForSelector('[data-testid="secret-key-status"][data-keyset="0"]', { timeout: 6000 }).catch(() => null);
      { const nss = await noSideScroll(a.page); ok(!!st && nss, `${width}: Security tab shows the key status and the setup command`, JSON.stringify({ st: !!st, nss, w: await a.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 4).map((e) => e.tagName + "." + e.className + ":" + Math.round(e.getBoundingClientRect().right))]) })); }
      if (st) { await st.evaluate((e) => e.scrollIntoView({ block: 'start' })); await shot(a.page, `e3-secret-key-warning-${width}`); }
      await a.ctx.close();
    }
    // E4: type on the laptop, pick it up on the phone (one chat session per account, so devices take turns)
    {
      const msg = `draft from the laptop ${width}`;
      const A = await pageFor(other, 1366);
      await enterRoom(A.page, room);
      await A.page.type('input[aria-label="Chat message"]', msg); await sleep(1500);
      await A.ctx.close();
      const B = await pageFor(other, width);
      await enterRoom(B.page, room);
      const seen = await B.page.waitForFunction((m) => document.querySelector('input[aria-label="Chat message"]')?.value === m, { timeout: 8000 }, msg).catch(() => null);
      ok(!!seen, `${width}: draft typed on one device is there on the other`);
      await shot(B.page, `e4-draft-synced-${width}`);
      await B.page.focus('input[aria-label="Chat message"]'); await B.page.keyboard.press('Enter'); await sleep(800);
      await B.ctx.close();
      const C = await pageFor(other, 1366);
      await enterRoom(C.page, room); await sleep(1200);
      ok(await C.page.$eval('input[aria-label="Chat message"]', (i) => i.value) === '', `${width}: once sent, the draft is gone on the first device too`);
      await C.ctx.close();
      await fresh0(other);
    }
    // E5: offline outbox: queue while offline, pending shown, in order on reconnect
    {
      const o = await pageFor(owner, width);
      await enterRoom(o.page, room);
      const seen = []; const on = (m) => { if (m.kind === 'chat' && m.text.startsWith(`queued ${width}`)) seen.push(m.text); };
      other.s.on('chat:message', on); await emit(other.s, 'room:join', { roomId: room });
      const cdp = await o.page.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await o.page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await sleep(2500);
      for (const n of [1, 2, 3]) { await o.page.type('input[aria-label="Chat message"]', `queued ${width} #${n}`); await o.page.keyboard.press('Enter'); await sleep(250); }
      const pend = await o.page.$$eval('[data-testid="outbox-item"]', (els) => els.map((e) => e.dataset.state));
      ok(pend.length === 3 && pend.every((x) => x === 'pending' || x === 'sending'), `${width}: offline lines wait in the outbox with a pending marker`, JSON.stringify(pend));
      await o.page.$eval('[data-testid="outbox-item"]', (e) => e.scrollIntoView({ block: 'center' })).catch(() => null);
      await shot(o.page, `e5-outbox-pending-${width}`);
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await o.page.evaluate(() => window.dispatchEvent(new Event('online')));
      const gone = await o.page.waitForFunction(() => document.querySelectorAll('[data-testid="outbox-item"]').length === 0, { timeout: 25000 }).catch(() => null);
      await sleep(800); other.s.off('chat:message', on);
      ok(!!gone && seen.join('|') === [1, 2, 3].map((n) => `queued ${width} #${n}`).join('|'), `${width}: on reconnect they go out once each, in order`, JSON.stringify({ gone: !!gone, seen }));
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
