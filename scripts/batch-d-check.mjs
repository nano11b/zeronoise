/**
 * Batch D checks: XP and levels, ban appeals, two-factor sign-in (TOTP, recovery codes), data export, game bridge kit.
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
import crypto from 'node:crypto';
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

  // ---------- 7. ban appeals ----------
  const banU = await nodeUser('DdBanned'); sockets.push(banU.s);
  ok((await banU.j.req('/api/appeal')).banned === false, 'not banned: appeal status says so');
  ok((await banU.j.req('/api/appeal', { text: 'please let me back in, I did nothing wrong' })).status === 400, 'cannot appeal without a ban');
  const bn = await admin.j.req('/api/admin/bans', { kind: 'account', value: 'DdBanned', reason: 'spam test', minutes: 60 });
  ok(bn.ok, 'admin bans DdBanned', JSON.stringify(bn));
  await sleep(300);
  const bst = await banU.j.req('/api/appeal');
  ok(bst.banned && bst.ban.id === bn.id && bst.appeal === null && bst.ban.reason === 'spam test', 'banned user sees their ban and no appeal yet', JSON.stringify(bst));
  ok((await banU.j.req('/api/appeal', { text: 'too short' })).status === 400, 'appeal text needs a minimum length');
  const ap = await banU.j.req('/api/appeal', { text: 'I was testing a bot by mistake, sorry, it will not happen again.' });
  ok(ap.ok && ap.appeal.status === 'open', 'banned user submits an appeal', JSON.stringify(ap));
  ok((await banU.j.req('/api/appeal', { text: 'second try at an appeal for the same ban here' })).status === 409, 'only one appeal per ban');
  ok((await banU.j.req('/api/appeal')).appeal?.id === ap.appeal.id, 'status shows the pending appeal');
  ok((await mem.j.req('/api/admin/appeals')).status === 403, 'non-staff cannot list appeals');
  const q1 = await admin.j.req('/api/admin/reports?view=queue&status=open');
  ok(q1.items?.some((i) => i.key === `appeal:${ap.appeal.id}`), 'appeal shows up in the site mod queue');
  const al = await admin.j.req('/api/admin/appeals');
  ok(al.appeals?.some((a) => a.id === ap.appeal.id && a.reason === 'spam test'), 'staff appeal list includes the ban reason');
  ok((await admin.j.req(`/api/admin/appeals/${ap.appeal.id}`, { decision: 'maybe' })).status === 400, 'decision must be approve or deny');
  const dec = await admin.j.req(`/api/admin/appeals/${ap.appeal.id}`, { decision: 'deny', note: 'repeat offender' });
  ok(dec.ok && dec.decision === 'denied', 'admin denies the appeal');
  ok((await admin.j.req(`/api/admin/appeals/${ap.appeal.id}`, { decision: 'approve' })).status === 409, 'a decided appeal cannot be decided again');
  const st2 = await banU.j.req('/api/appeal');
  ok(st2.banned && st2.appeal.status === 'denied' && st2.appeal.note === 'repeat offender', 'denied: ban stays, user sees the decision');
  const lg = await admin.j.req('/api/admin/log');
  ok(lg.log?.some((l) => l.action === 'appeal-deny') && lg.log?.some((l) => l.action === 'appeal'), 'appeal and denial are in the action log');
  const q2 = await admin.j.req('/api/admin/reports?view=queue&status=open');
  ok(!q2.items?.some((i) => i.key === `appeal:${ap.appeal.id}`), 'decided appeal leaves the open queue');
  // second ban -> new appeal allowed -> approve lifts it
  await admin.j.req(`/api/admin/bans/${bn.id}/lift`, {});
  const bn2 = await admin.j.req('/api/admin/bans', { kind: 'account', value: 'DdBanned', reason: 'second ban', minutes: 60 });
  const ap2 = await banU.j.req('/api/appeal', { text: 'This second ban was a mix-up, please review my history.' });
  ok(ap2.ok && ap2.appeal.banId === bn2.id, 'a new ban gets its own appeal');
  const dec2 = await admin.j.req(`/api/admin/appeals/${ap2.appeal.id}`, { decision: 'approve' });
  ok(dec2.ok && (await banU.j.req('/api/appeal')).banned === false, 'approving lifts the ban');
  ok((await admin.j.req('/api/admin/log')).log?.some((l) => l.action === 'appeal-approve'), 'approval is logged');

  // ---------- 8. two-factor ----------
  ok((await mem.j.req('/api/me/2fa')).enabled === false, 'two-factor is off by default');
  ok((await (await login('DdMember')).r).account?.username === 'DdMember', 'password login without 2FA signs straight in');
  const su = await mem.j.req('/api/me/2fa/setup', {});
  ok(su.ok && /^[A-Z2-7]{32}$/.test(su.secret) && su.otpauthUrl.startsWith('otpauth://totp/'), 'setup returns a base32 secret and otpauth link');
  ok((await mem.j.req('/api/me/2fa/enable', { code: '000000' })).status === 400, 'wrong code does not enable');
  ok(!(await mem.j.req('/api/me/2fa')).enabled, 'still off after a wrong code');
  const en = await mem.j.req('/api/me/2fa/enable', { code: totpAt(su.secret, stepNow()) });
  ok(en.ok && en.enabled && en.recoveryCodes?.length === 10 && en.recoveryLeft === 10, 'right code enables, 10 recovery codes shown once', JSON.stringify(en).slice(0, 200));
  ok((await mem.j.req('/api/me')).account?.username === 'DdMember', 'the current session stays signed in after enabling');
  ok((await mem.j.req('/api/me/2fa/setup', {})).status === 409, 'setup cannot replace an enabled secret');
  // sign in again -> pending
  let L = await login('DdMember');
  ok(L.r.ok && L.r.twoFactor === true && L.r.account === null, 'password login now asks for the code');
  let me2 = await L.j.req('/api/me');
  ok(me2.account === null && me2.twoFactorPending === true, 'pending session is not signed in (/api/me)');
  ok((await L.j.req('/api/me/xp')).status === 401, 'pending session cannot use account APIs');
  const ps = ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: L.j.header() }, auth: { deviceId: me2.deviceId } });
  await new Promise((res) => { ps.once('connect', res); ps.once('connect_error', res); }); sockets.push(ps);
  const pl = await emit(ps, 'login', {});
  ok(!pl?.account || pl.account.username !== 'DdMember', 'pending session socket is not the account', JSON.stringify(pl).slice(0, 120));
  ok((await L.j.req('/api/auth/2fa', { code: '123456' })).status === 401, 'wrong code refused');
  const used = totpAt(su.secret, stepNow() + 1); // the enrol code used this step already (replay guard)
  const v1 = await L.j.req('/api/auth/2fa', { code: used });
  ok(v1.ok && v1.account?.username === 'DdMember', 'TOTP code completes sign-in');
  ok((await L.j.req('/api/me')).account?.username === 'DdMember', 'session is signed in after the code');
  L = await login('DdMember');
  ok((await L.j.req('/api/auth/2fa', { code: used })).status === 401, 'a code cannot be replayed');
  const rc = en.recoveryCodes[0];
  const v2 = await L.j.req('/api/auth/2fa', { code: rc.toUpperCase() });
  ok(v2.ok && v2.recoveryLeft === 9, 'a recovery code works once (case-insensitive)');
  L = await login('DdMember');
  ok((await L.j.req('/api/auth/2fa', { code: rc })).status === 401, 'a used recovery code is refused');
  await L.j.req('/api/auth/2fa/cancel', {});
  ok((await L.j.req('/api/me')).twoFactorPending === undefined, 'cancel signs the pending session out');
  // brute-force cap
  L = await login('DdMember');
  let capped = false;
  for (let i = 0; i < 10; i++) { const r = await L.j.req('/api/auth/2fa', { code: String(100000 + i) }); if (r.status === 429) { capped = true; break; } }
  ok(capped, 'code guessing is rate limited');
  // reset link must not skip 2FA: covered by the same startSession path; turn off as a non-admin
  await sleep(31000);
  const dis = await mem.j.req('/api/me/2fa/disable', { code: totpAt(su.secret, stepNow() + 1) });
  ok(dis.ok && dis.enabled === false, 'a regular user can turn 2FA off with a code', JSON.stringify(dis));
  L = await login('DdMember');
  ok(L.r.account?.username === 'DdMember', 'after turning off, password login is direct again');
  // admin: optional until enrolled, then required and cannot be turned off
  L = await login('DdAdmin');
  ok(L.r.account?.role === 'admin', 'admin without 2FA still signs in normally (no lockout)');
  const asu = await admin.j.req('/api/me/2fa/setup', {});
  const aen = await admin.j.req('/api/me/2fa/enable', { code: totpAt(asu.secret, stepNow()) });
  ok(aen.ok && aen.required === true && aen.canDisable === false, 'admin enrols; 2FA is then required');
  ok((await admin.j.req('/api/me/2fa/disable', { code: aen.recoveryCodes[0] })).status === 403, 'admins cannot turn 2FA off from the site');
  L = await login('DdAdmin');
  ok(L.r.twoFactor === true && (await L.j.req('/api/admin/bans')).status === 401, 'admin login needs the code before the mod panel works');
  const av = await L.j.req('/api/auth/2fa', { code: aen.recoveryCodes[1] });
  ok(av.ok && (await L.j.req('/api/admin/bans')).ok, 'admin finishes with a recovery code and the panel works');
  const lg2 = (await admin.j.req('/api/admin/log')).log || [];
  ok(['2fa-enable', '2fa-login', '2fa-login-recovery', '2fa-disable'].every((a) => lg2.some((l) => l.action === a)), '2FA events are in the action log');
  // owner escape hatch
  const rs = spawn(process.execPath, ['scripts/reset-2fa.mjs', 'DdAdmin'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA } });
  let rsOut = ''; rs.stdout.on('data', (d) => { rsOut += d; }); rs.stderr.on('data', (d) => { rsOut += d; });
  await new Promise((r) => rs.on('close', r));
  L = await login('DdAdmin');
  ok(/turned off/.test(rsOut) && L.r.account?.role === 'admin', 'server owner can reset an admin\'s 2FA with scripts/reset-2fa.mjs', rsOut);
  // re-enrol the admin for the UI shots of the gate
  const asu2 = await admin.j.req('/api/me/2fa/setup', {});
  await sleep(31000);
  const aen2 = await admin.j.req('/api/me/2fa/enable', { code: totpAt(asu2.secret, stepNow()) });
  globalThis.__adminCodes = aen2.recoveryCodes || [];

  // ---------- 9. data export ----------
  const exRoom = (await emit(mem.s, 'room:join', { roomId: room })).room;
  await emit(mem.s, 'chat:send', { text: 'export me please, a line for the archive' });
  const brn = await emit(mem.s, 'chat:send', { text: 'this one burns', burnTtl: 30 });
  const ownerSid = exRoom.users.find((u) => u.nick === 'DdOwner')?.id;
  const wst = await emit(mem.s, 'whisper:start', { userIds: [ownerSid] });
  const wsn = wst.ok ? await emit(mem.s, 'whisper:send', { whisperId: wst.whisper.id, text: 'psst a secret whisper for export' }) : wst;
  ok(brn.ok && wsn.ok, 'setup: a burn line and a whisper were sent', JSON.stringify({ brn, wsn }).slice(0, 200));
  await sleep(400);
  const exRaw = await fetch(BASE + '/api/me/export', { method: 'POST', headers: { 'x-csrf': '1', cookie: mem.j.header(), 'content-type': 'application/json' }, body: '{}' });
  const zipBuf = Buffer.from(await exRaw.arrayBuffer());
  ok(exRaw.status === 200 && exRaw.headers.get('content-type').includes('zip') && /attachment; filename=".+\.zip"/.test(exRaw.headers.get('content-disposition')), 'export downloads a ZIP');
  const zdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-exp-'));
  fs.writeFileSync(path.join(zdir, 'x.zip'), zipBuf);
  const unz = await new Promise((r) => { const p = spawn('python3', ['-c', 'import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n: json.loads(z.read(n)) if n.endswith(".json") else z.read(n).decode() for n in z.namelist()}))', path.join(zdir, 'x.zip')]); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; }); p.on('close', () => r(o)); });
  let Z = null; try { Z = JSON.parse(unz); } catch { /* */ }
  ok(Z && ['README.txt', 'export.json', 'profile.json', 'settings.json', 'messages.json', 'whispers.json'].every((n) => n in Z), 'ZIP is valid (CRC ok) with profile/settings/messages/whispers', unz.slice(0, 200));
  ok(Z?.['profile.json'].username === 'DdMember' && Z['profile.json'].links !== undefined && 'twoFactor' in Z['profile.json'].signIn, 'profile.json has the profile');
  ok(Z?.['messages.json'].some((m) => m.text === 'export me please, a line for the archive'), 'messages.json has my room messages');
  ok(!Z?.['messages.json'].some((m) => m.text === 'this one burns'), 'burn messages are not exported');
  ok(!Z?.['messages.json'].some((m) => m.nick && m.nick !== 'DdMember'), 'only my own messages');
  ok(Z?.['whispers.json'].some((w) => w.text === 'psst a secret whisper for export' && w.sentByYou === 1) && Array.isArray(Z?.['settings.json'].roomNotifications), 'whispers and settings are present');
  ok(!/password_hash|\$argon|\$scrypt|secret"|code_hash|127\.0\.0\.1/.test(unz), 'no password hash, 2FA secret, recovery codes or IPs in the export');
  const ex2 = await mem.j.req('/api/me/export', { format: 'json' });
  ok(ex2.status === 429, 'second export within the hour is rate limited');
  const exJ = await fetch(BASE + '/api/me/export', { method: 'POST', headers: { 'x-csrf': '1', cookie: other.j.header(), 'content-type': 'application/json' }, body: '{"format":"json"}' });
  const J = await exJ.json().catch(() => null);
  ok(exJ.status === 200 && J?.format === 'zeronoise-export/1' && J.profile.username === 'DdOther', 'JSON format works');
  ok((await jar().req('/api/me/export', {})).status === 401, 'export needs sign-in');
  ok((await fetch(BASE + '/api/me/export', { method: 'POST', headers: { cookie: other.j.header() } })).status === 403, 'export needs the CSRF header');
  // ---------- 10. game bridge kit ----------
  const kz = await fetch(BASE + '/docs/bots/bridge-kit.zip');
  const kbuf = Buffer.from(await kz.arrayBuffer());
  const kdir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-kit-'));
  fs.writeFileSync(path.join(kdir, 'kit.zip'), kbuf);
  const kls = await new Promise((r) => { const p = spawn('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2]); print(" ".join(sorted(z.namelist())))', path.join(kdir, 'kit.zip'), kdir]); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; }); p.on('close', () => r(o.trim())); });
  ok(kz.status === 200 && kls === 'zeronoise-bridge-kit/README.md zeronoise-bridge-kit/bridge.mjs zeronoise-bridge-kit/config.example.json', 'bridge kit ZIP downloads with README, script and example config', kls);
  const docsMd = await (await fetch(BASE + '/docs/bots.md')).text();
  const docsHtml = await (await fetch(BASE + '/docs/bots')).text();
  const llms = await (await fetch(BASE + '/llms.txt')).text();
  ok(docsMd.includes('/docs/bots/bridge-kit.zip') && /href="\/docs\/bots\/bridge-kit\.zip"/.test(docsHtml), '/docs/bots links the kit');
  ok(llms.includes('/docs/bots/bridge-kit.zip') && llms.includes('bridge-kit/README.md'), 'llms.txt links the kit');
  ok((await fetch(BASE + '/docs/bots/bridge-kit/README.md')).headers.get('content-type').includes('markdown'), 'README is served as markdown');
  const KIT = path.join(kdir, 'zeronoise-bridge-kit');
  const runKit = (argv, extraEnv, ms = 15000) => new Promise((r) => { const p = spawn(process.execPath, ['bridge.mjs', ...argv], { cwd: KIT, env: { PATH: process.env.PATH, ZN_BASE_URL: BASE, ...extraEnv } }); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; }); const t = setTimeout(() => p.kill(), ms); p.on('close', (code) => { clearTimeout(t); r({ code, o }); }); globalThis.__kitProc = p; });
  fs.writeFileSync(path.join(KIT, 'bad.json'), JSON.stringify({ room, token: 'bot_x' }));
  ok((await runKit(['bad.json'], { ZN_BOT_TOKEN: 'bot_x' })).code === 2, 'kit refuses a token in the config file');
  const madeBot = await owner.j.req('/api/bots', { name: 'DdBridge' });
  await fresh0(owner); await emit(owner.s, 'room:join', { roomId: room });
  const allowB = await emit(owner.s, 'room:bot-allow', { name: 'DdBridge' });
  ok(!!madeBot.token && allowB.ok, 'setup: bot created and allowed', JSON.stringify({ madeBot: !!madeBot.token, allowB }));
  const once = await runKit(['none.json', '--once'], { ZN_BOT_TOKEN: madeBot.token, ZN_ROOM: room });
  await sleep(400);
  const h1 = (await emit(owner.s, 'room:join', { roomId: room })).room.history;
  ok(once.code === 0 && h1.some((m) => m.text === 'bridge self-test ✔'), 'kit --once posts the self-test line into the room', once.o.slice(-300));
  const logf = path.join(KIT, 'Server.log'); fs.writeFileSync(logf, 'boot\n');
  fs.writeFileSync(path.join(KIT, 'config.json'), JSON.stringify({ room, sendEveryMs: 800, readEveryMs: 1000, mergeWithinMs: 600, sources: [{ type: 'logtail', preset: 'beammp', file: logf, everyMs: 300 }], chatToGame: { mode: 'file', file: path.join(KIT, 'inbox.txt') } }));
  const live = runKit(['config.json'], { ZN_BOT_TOKEN: madeBot.token }, 14000);
  await sleep(2500);
  fs.appendFileSync(logf, '[03/10/26 21:00:00] [INFO] Racer42 is now synced!\n');
  await sleep(300);
  await fresh0(other); await emit(other.s, 'room:join', { roomId: room });
  await emit(other.s, 'chat:send', { text: 'hello from the website to the game' });
  await sleep(5000);
  try { globalThis.__kitProc.kill(); } catch { /* */ }
  const lr = await live;
  const h2 = (await emit(owner.s, 'room:join', { roomId: room })).room.history;
  ok(h2.some((m) => m.text === '🚗 Racer42 joined'), 'kit tails a BeamMP log and posts the join', lr.o.slice(-400));
  const inbox = fs.existsSync(path.join(KIT, 'inbox.txt')) ? fs.readFileSync(path.join(KIT, 'inbox.txt'), 'utf8') : '';
  ok(inbox.includes('[chat] DdOther: hello from the website to the game'), 'kit delivers room chat to the game (file mode)', inbox + lr.o.slice(-300));
  ok(!inbox.includes('Racer42') && !inbox.includes('self-test'), 'kit never echoes bot lines back to the game');
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
    // 7. appeal form on the blocked screen + queue entry
    {
      const bu = await nodeUser(`DdBan${width}`); try { bu.s.disconnect(); } catch { /* */ }
      const b = await admin.j.req('/api/admin/bans', { kind: 'account', value: `DdBan${width}`, reason: 'ui test ban', minutes: 30 });
      const p = await pageFor(bu, width);
      await p.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      const form = await p.page.waitForSelector('[data-testid="appeal-form"]', { timeout: 15000 }).catch(() => null);
      ok(!!form, `${width}: blocked screen offers the appeal form`);
      if (form) {
        await p.page.type('[data-testid="appeal-text"]', 'I think this was a mistake; I only shared a game link once.');
        await shot(p.page, `d7-appeal-form-${width}`);
        await p.page.$eval('[data-action="appeal-submit"]', (x) => x.click());
        const sent = await p.page.waitForSelector('[data-testid="appeal-status"][data-status="open"]', { timeout: 6000 }).catch(() => null);
        const nss = await noSideScroll(p.page); ok(!!sent && nss, `${width}: appeal sent, status shown, no sideways scroll`, JSON.stringify({ sent: !!sent, nss, w: await p.page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]) }));
        await shot(p.page, `d7-appeal-sent-${width}`);
      }
      await p.ctx.close();
      const a = await pageFor(admin, width);
      await a.page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
      await a.page.waitForSelector('.admin-tabs [data-tab="reports"]', { timeout: 15000 });
      const act = await a.page.waitForSelector('[data-testid="appeal-actions"]', { timeout: 8000 }).catch(() => null);
      ok(!!act, `${width}: appeal appears in the site queue with approve/deny`);
      if (act) { await act.evaluate((e) => e.scrollIntoView({ block: 'center' })); await shot(a.page, `d7-appeal-queue-${width}`); }
      await a.ctx.close();
      await fresh(admin);
      void b;
    }
    // 8. two-factor: Profile setup, admin Security tab, sign-in code step
    {
      const m = await pageFor(mem, width);
      await m.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await m.page.waitForSelector('[data-action="profile"]', { timeout: 15000 });
      await m.page.$eval('[data-action="profile"]', (b) => b.click()); await sleep(400);
      await m.page.evaluate(() => [...document.querySelectorAll('[role="menu"] button, .profile-actions button')].find((b) => /^\s*Profile\s*$/.test(b.textContent))?.click());
      const sec = await m.page.waitForSelector('[data-section="security"] [data-action="tfa-setup"]', { timeout: 8000 }).catch(() => null);
      ok(!!sec, `${width}: Profile dialog has the two-factor setup`);
      if (sec) {
        await sec.click();
        const sc = await m.page.waitForSelector('[data-testid="tfa-secret"]', { timeout: 5000 }).catch(() => null);
        ok(!!sc, `${width}: setup shows the key and the otpauth link`);
        if (sc) { await sc.evaluate((e) => e.closest('.profile-section').scrollIntoView({ block: 'start' })); await shot(m.page, `d8-2fa-setup-${width}`); }
        await m.page.evaluate(() => [...document.querySelectorAll('.tfa button')].find((b) => b.textContent === 'Cancel')?.click());
      }
      await m.ctx.close();
      const a = await pageFor({ j: (await (async () => { const L2 = await login('DdAdmin'); await L2.j.req('/api/auth/2fa', { code: globalThis.__adminCodes.shift() }).catch(() => null); return L2.j; })()) }, width);
      await a.page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
      await a.page.waitForSelector('.admin-tabs [data-tab="security"]', { timeout: 15000 }).catch(() => null);
      await a.page.evaluate(() => document.querySelector('.admin-tabs [data-tab="security"]')?.click());
      const asec = await a.page.waitForSelector('[data-testid="admin-security"] [data-testid="tfa-section"][data-enabled="1"]', { timeout: 6000 }).catch(() => null);
      ok(!!asec, `${width}: admin Security tab shows 2FA on (required)`);
      await shot(a.page, `d8-2fa-admin-${width}`);
      await a.ctx.close();
      const L3 = await login('DdAdmin');
      const g = await pageFor({ j: L3.j }, width);
      await g.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      const gate = await g.page.waitForSelector('[data-testid="tfa-gate"]', { timeout: 10000 }).catch(() => null);
      ok(!!gate && await noSideScroll(g.page), `${width}: sign-in shows the code step`);
      await shot(g.page, `d8-2fa-gate-${width}`);
      await g.ctx.close();
      await fresh(mem); await emit(mem.s, 'room:join', { roomId: room });
    }
    // 9. data export in the Profile dialog
    {
      const m = await pageFor(owner, width);
      await m.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await m.page.waitForSelector('[data-action="profile"]', { timeout: 15000 });
      await m.page.$eval('[data-action="profile"]', (b) => b.click()); await sleep(400);
      await m.page.evaluate(() => [...document.querySelectorAll('[role="menu"] button, .profile-actions button')].find((b) => /^\s*Profile\s*$/.test(b.textContent))?.click());
      const sec = await m.page.waitForSelector('[data-section="export"] [data-action="export-zip"]', { timeout: 8000 }).catch(() => null);
      ok(!!sec, `${width}: Profile dialog has Download ZIP`);
      if (sec) {
        await sec.evaluate((e) => e.closest('.profile-section').scrollIntoView({ block: 'center' }));
        await sec.click();
        const msg = await m.page.waitForSelector('[data-testid="export-msg"]', { timeout: 8000 }).catch(() => null);
        const t = msg ? await msg.evaluate((e) => e.textContent) : '';
        ok(width === 1366 ? /Downloaded .+\.zip/.test(t) : /once|hour|Downloaded/i.test(t), `${width}: download runs (second time: rate-limit message)`, t);
        await shot(m.page, `d9-export-${width}`);
      }
      await m.ctx.close();
      await fresh(owner); await emit(owner.s, 'room:join', { roomId: room });
    }
    // 10. bridge kit on /docs/bots
    {
      const { ctx, page } = await pageFor({ j: jar() }, width);
      await page.goto(BASE + '/docs/bots', { waitUntil: 'domcontentloaded' });
      const a = await page.$('a[href="/docs/bots/bridge-kit.zip"]');
      ok(!!a && await noSideScroll(page), `${width}: docs page shows the bridge kit link`);
      if (a) { await a.evaluate((e) => e.scrollIntoView({ block: 'center' })); await shot(page, `d10-bridge-kit-docs-${width}`); }
      await ctx.close();
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
