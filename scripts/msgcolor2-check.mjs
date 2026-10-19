/**
 * Batch MC2: composer message colour picker, gradient message colours, person menu portal/flip + phone sheet.
 *   node scripts/msgcolor2-check.mjs [shots]
 */
import './lib/reap.mjs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');
const { io: ioClient } = require('socket.io-client');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-mc2'));
fs.mkdirSync(OUT, { recursive: true });
import crypto from 'node:crypto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// a local receiver for outgoing deliveries (the only loopback host:port the server may call)
const recvHits = []; let recvMode = 'ok';
const recv = http.createServer((req, res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => {
  recvHits.push({ path: req.url, headers: req.headers, body: Buffer.concat(ch).toString('utf8'), at: Date.now() });
  if (recvMode === 'slow') return void setTimeout(() => { res.writeHead(200); res.end('late'); }, 8000);
  res.writeHead(recvMode === 'fail' ? 500 : 200); res.end('ok'); }); });
await new Promise((r) => recv.listen(0, '127.0.0.1', r));
const RECV_PORT = recv.address().port;
const RECV = `http://127.0.0.1:${RECV_PORT}`;
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-people-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'PpAdmin', OUTBOUND_TEST_ALLOW: `127.0.0.1:${RECV_PORT}`, WEBHOOK_RETRY_SCALE: '0.002', PUBLIC_URL: '', RECORDING_MAX_BYTES: '400000', RECORDING_SWEEP_MS: '1500', ONBOARDING_SINCE: '0', RECORDING_IDLE_MS: '6000', RECONNECT_GRACE_MS: '800',
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
const dismiss = async (page) => { await page.evaluate(() => [...document.querySelectorAll('a,button')].filter((e) => /^(Skip tour|Dismiss)$/.test(e.textContent.trim())).forEach((e) => e.click())); await sleep(300); };

const waitFor = async (fn, ms = 4000) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); } return !!fn(); };
const events = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
const R = crypto.randomBytes(2).toString('hex');
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const cm = (page, sel) => page.evaluate((s) => { const e = [...document.querySelectorAll(s)].find((x) => x.getClientRects().length); if (!e) return false; e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true; }, sel);
const openPeople = async (page, phone) => { if (phone) { await page.evaluate(() => document.querySelector('[data-action="more"]')?.click()); await sleep(250); await page.evaluate(() => document.querySelector('[data-action="people"]')?.click()); await sleep(450); } };
const vis = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((x) => x.getClientRects().length), sel);
const lineInfo = (page, scope, t) => page.evaluate((scope, t) => {
  const el = [...document.querySelectorAll(`${scope} .md`)].find((e) => e.textContent.includes(t));
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { attr: el.dataset.msgColor ?? null, grad: el.classList.contains('msg-grad'), clip: cs.webkitBackgroundClip || cs.backgroundClip, fill: cs.webkitTextFillColor, color: cs.color, bg: cs.backgroundImage, anim: cs.animationName, inline: el.style.color };
}, scope, t);
const rgb = (h) => `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ')})`;
try {
  const S = await nodeUser('PpAdmin'), D = await nodeUser(`McD${R}`), E = await nodeUser(`McE${R}`);
  sockets.push(S.s, D.s, E.s);
  const rc = await emit(D.s, 'room:create', { name: `grad ${R}`, topic: 't', category: 'gaming' });
  const ROOM = rc.roomId;
  for (const u of [D, E, S]) await emit(u.s, 'room:join', { roomId: ROOM });
  // ---------------- API ----------------
  const { UI_PALETTES } = await import(pathToFileURL(path.join(ROOT, 'dist/server/shared/uiTheme.js')).href);
  const { MSG_GRADIENTS } = await import(pathToFileURL(path.join(ROOT, 'dist/server/shared/msgColor.js')).href);
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const worstOf = (hexes) => Math.min(...Object.values(UI_PALETTES).flatMap((p) => [p.bg, p.bg2, p.panel, p.panel2, p.primaryBg].flatMap((b) => hexes.map((h) => cr(h, b)))));
  ok(MSG_GRADIENTS.length >= 4 && MSG_GRADIENTS.every((g) => g.stops.length >= 2 && g.stops.length <= 3 && worstOf(g.stops) >= 4.5), `G: ${MSG_GRADIENTS.length} preset gradients, every stop 4.5:1 on all four themes (worst ${worstOf(MSG_GRADIENTS.flatMap((g) => g.stops)).toFixed(2)})`);
  const p2 = await D.j.req('/api/me/msg-color', { gradient: ['#ffd166', '#ff9fb2'] }, 'PATCH');
  ok(p2.ok && p2.msgColor === 'g:#ffd166,#ff9fb2' && p2.adjusted === false, 'G: a readable 2-stop gradient is saved as is', JSON.stringify(p2));
  const p3 = await D.j.req('/api/me/msg-color', { gradient: ['#202020', '#9fd8ff', '#330000'] }, 'PATCH');
  const st3 = (p3.msgColor || '').slice(2).split(',');
  ok(p3.ok && p3.adjusted === true && st3.length === 3 && st3[1] === '#9fd8ff' && worstOf(st3) >= 4.5, `G: dark stops of a 3-stop gradient are lightened (${p3.msgColor}), all stops 4.5:1 (worst ${worstOf(st3).toFixed(2)})`);
  for (const [body, why] of [[{ gradient: ['#ffd166'] }, '1 stop'], [{ gradient: ['#ffd166', '#ff9fb2', '#9fd8ff', '#d7b8ff'] }, '4 stops'], [{ gradient: ['#ffd166', 'red; background:url(x)'] }, 'a non-colour stop'], [{ color: 'g:#ffd166' }, 'a broken g: string'], [{ color: 'linear-gradient(red, blue)' }, 'raw CSS']]) {
    const r = await D.j.req('/api/me/msg-color', body, 'PATCH');
    ok(r.status === 400, `G: refused: ${why}`);
  }
  const ps = await D.j.req('/api/me/msg-color', { color: 'g:#9fd8ff,#d7b8ff' }, 'PATCH');
  ok(ps.ok && ps.msgColor === 'g:#9fd8ff,#d7b8ff', 'G: the stored g: form is accepted too');
  const GR = 'g:#ffd166,#ff9fb2';
  await D.j.req('/api/me/msg-color', { gradient: ['#ffd166', '#ff9fb2'] }, 'PATCH');
  const eMsg = events(E.s, 'chat:message');
  await emit(D.s, 'chat:send', { text: `gradient line ${R}` });
  ok(await waitFor(() => eMsg.some((m) => m.text === `gradient line ${R}` && m.msgColor === GR)), 'G: live room lines carry the gradient');
  await emit(D.s, 'chat:send', { text: `@${E.nick} gradient mention ${R}` });
  await sleep(300);
  const parent = (await emit(D.s, 'room:join', { roomId: ROOM })).room.history.filter((m) => m.text === `gradient line ${R}`).pop();
  const tr = await emit(D.s, 'chat:send', { text: `thread gradient ${R}`, parentId: parent?.id });
  ok(tr.ok !== false, `G: thread reply sent ${tr.error || ''}`);
  await emit(D.s, 'friends:request', { username: E.nick }); await emit(E.s, 'friends:respond', { userId: D.id, accept: true });
  const dm = await emit(D.s, 'dm:start', { usernames: [E.nick] });
  await emit(D.s, 'dm:send', { convoId: dm.convo?.id, text: `dm gradient ${R}` });
  ok(dm.ok && dm.convo.members.some((m) => m.userId === D.id && m.msgColor === GR), 'G: whisper members carry the gradient');
  // ---------------- browser ----------------
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--lang=en-US'] });
  for (const width of [1366, 390]) {
    const { ctx, page } = await pageFor(E, width);
    await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-log', { timeout: 15000 }).catch(async (e) => { await shot(page, 'debug-fail'); throw e; }); await dismiss(page); await sleep(800);
    const li = await lineInfo(page, '.chat-log', `gradient line ${R}`);
    ok(li?.grad && li.attr === GR && /linear-gradient/.test(li.bg) && li.clip === 'text' && li.fill === 'rgba(0, 0, 0, 0)', `G ${width}: room line painted with the gradient (background-clip:text)`, JSON.stringify(li));
    ok(li?.inline === rgb('#ffd166') && li.color === rgb('#ffd166'), `G ${width}: solid fallback colour (first stop) is set for browsers without background-clip:text`);
    ok(li?.anim === 'none', `G ${width}: the gradient is not animated`);
    await shot(page, `x-mc2-room-${width}`);
    if (width === 1366) for (const theme of ['dark-red', 'dark-green', 'dark-orange']) {
      await page.evaluate((th) => document.documentElement.setAttribute('data-ui-theme', th), theme); await sleep(150);
      const l2 = await lineInfo(page, '.chat-log', `gradient line ${R}`);
      ok(l2?.grad && /linear-gradient/.test(l2.bg), `G ${width}: gradient shown on ${theme}`);
      await shot(page, `x-mc2-${theme}-${width}`);
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-ui-theme'));
    // mention highlight stays solid and readable
    const mi = await page.evaluate((t) => { const el = [...document.querySelectorAll('.chat-log .msg.mentioned .md')].find((e) => e.textContent.includes(t)); if (!el) return null; const cs = getComputedStyle(el); return { fill: cs.webkitTextFillColor, bg: cs.backgroundImage }; }, `gradient mention ${R}`);
    ok(mi && mi.fill !== 'rgba(0, 0, 0, 0)' && mi.bg === 'none', `G ${width}: a highlighted (mentioning) line falls back to the solid colour`, JSON.stringify(mi));
    // selection stays readable
    const sel = await page.evaluate((t) => { const el = [...document.querySelectorAll('.chat-log .md')].find((e) => e.textContent.includes(t)); const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); const p = el.querySelector('p') || el; return getComputedStyle(p, '::selection').webkitTextFillColor; }, `gradient line ${R}`);
    ok(sel && sel !== 'rgba(0, 0, 0, 0)', `G ${width}: selected gradient text is drawn solid (${sel})`);
    await shot(page, `x-mc2-selected-${width}`);
    await page.evaluate(() => getSelection().removeAllRanges());
    // reduced motion
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await sleep(100);
    const rm = await lineInfo(page, '.chat-log', `gradient line ${R}`);
    ok(rm?.anim === 'none' && rm.grad, `G ${width}: reduced motion: still a static gradient, no animation`);
    await page.emulateMediaFeatures([]);
    // thread
    await page.evaluate(() => document.querySelector('[data-action="open-thread"]')?.click()); await sleep(800);
    const ti = await lineInfo(page, '.thread-panel', `thread gradient ${R}`);
    ok(ti?.grad && ti.attr === GR, `G ${width}: thread replies use the gradient`, JSON.stringify(ti));
    if (ti) await shot(page, `x-mc2-thread-${width}`);
    await page.keyboard.press('Escape'); await sleep(300);
    // viewer opt-out covers gradients
    await page.evaluate(() => localStorage.setItem('zn.ignoreMsgColors', '1')); await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
    const ig = await lineInfo(page, '.chat-log', `gradient line ${R}`);
    ok(ig && !ig.grad && ig.attr === null && ig.fill !== 'rgba(0, 0, 0, 0)', `G ${width}: "ignore custom colours" also turns gradients off`, JSON.stringify(ig));
    await page.evaluate(() => localStorage.removeItem('zn.ignoreMsgColors'));
    // whispers
    await page.goto(`${BASE}/?whispers=${encodeURIComponent(D.nick)}`, { waitUntil: 'domcontentloaded' }); await sleep(1200); await dismiss(page);
    await page.waitForFunction((t) => [...document.querySelectorAll('[data-testid="dm-log"] .md')].some((e) => e.textContent.includes(t)), { timeout: 8000 }, `dm gradient ${R}`).catch(() => {});
    const wi = await lineInfo(page, '[data-testid="dm-log"]', `dm gradient ${R}`);
    ok(wi?.grad && wi.attr === GR && wi.clip === 'text', `G ${width}: whispers use the gradient`, JSON.stringify(wi));
    await shot(page, `x-mc2-whisper-${width}`);
    await ctx.close();
  }
  // ---------------- composer picker (D, the sender) ----------------
  for (const width of [1366, 390]) {
    const { ctx, page } = await pageFor(D, width);
    await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(600);
    // Profile dialog no longer has it
    await page.$eval('[data-action="profile"]', (b) => b.click()); await sleep(400);
    await page.waitForSelector('[data-action="open-profile"]', { timeout: 6000 }); await page.$eval('[data-action="open-profile"]', (b) => b.click()); await sleep(700);
    ok(!(await page.$('[data-section="msg-color"]')), `P ${width}: the Profile dialog no longer has the message colour section`);
    await page.keyboard.press('Escape'); await sleep(300); await page.keyboard.press('Escape'); await sleep(300);
    await page.$eval('[data-action="composer-plus"]', (b) => b.click()); await sleep(300);
    const both = await page.evaluate(() => { const a = document.querySelector('.plus-menu [data-action="name-style"]'), b = document.querySelector('.plus-menu [data-action="msg-style"]'); return !!a && !!b && a.className === b.className && a.closest('.plus-menu') === b.closest('.plus-menu'); });
    ok(both, `P ${width}: the message colour control sits in the chat bar's + menu next to the name colour control, same style`);
    await page.$eval('[data-action="msg-style"]', (b) => b.click()); await sleep(300);
    const fit = await page.evaluate(() => { const p = document.querySelector('.msg-style-pop').getBoundingClientRect(); return p.left >= 0 && p.right <= innerWidth + 1 && p.top >= 0; });
    ok(fit, `P ${width}: the picker fits on screen`);
    const nGrad = await page.$$eval('[data-msg-gradient]', (x) => x.length);
    ok(nGrad >= 4, `P ${width}: ${nGrad} preset gradients offered`);
    await page.$eval('[data-msg-gradient="g:#b9f6ca,#9fd8ff"]', (b) => b.click()); await sleep(600);
    const me = await D.j.req('/api/me');
    ok(me.account?.msgColor === 'g:#b9f6ca,#9fd8ff', `P ${width}: picking a preset gradient saves it (${me.account?.msgColor})`);
    await page.$eval('[data-action="msg-mode-gradient"]', (b) => b.click()); await sleep(150);
    if (await page.$('[data-action="msg-stop-add"]')) { await page.$eval('[data-action="msg-stop-add"]', (b) => b.click()); await sleep(150); }
    await page.$eval('[data-field="msg-stop-0"]', (i) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '#222222'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(200);
    ok(!!(await page.$('[data-testid="msg-color-adjusted"]')), `P ${width}: a custom gradient with a dark stop warns before saving`);
    ok((await page.$$('[data-field^="msg-stop-"]')).length === 3, `P ${width}: custom gradients take up to 3 colours`);
    const prev = await page.$$eval('.msg-color-preview .msg-grad', (x) => x.length);
    ok(prev === 4, `P ${width}: the custom gradient is previewed on all four themes`);
    await shot(page, `x-mc2-picker-${width}`);
    await page.$eval('[data-action="msg-color-save"]', (b) => b.click()); await sleep(600);
    const me2 = await D.j.req('/api/me');
    const s2 = (me2.account?.msgColor || '').slice(2).split(',');
    ok(/^g:/.test(me2.account?.msgColor || '') && s2.length === 3 && worstOf(s2) >= 4.5, `P ${width}: custom 3-stop gradient saved, lightened to stay readable (${me2.account?.msgColor})`);
    await ctx.close();
  }
  await D.j.req('/api/me/msg-color', { gradient: ['#ffd166', '#ff9fb2'] }, 'PATCH');
  // ---------------- person menu: portal + flip (desktop), sheet (phones) ----------------
  await fresh0(E); await emit(E.s, 'room:join', { roomId: ROOM }); await sleep(300);
  for (const width of [1366, 390, 360]) {
    const phone = width < 800;
    const { ctx, page } = await pageFor(S, width);
    await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(600);
    await openPeople(page, phone);
    await page.waitForFunction((n) => [...document.querySelectorAll(`.user-row[data-nick="${n}"]`)].some((x) => x.getClientRects().length), { timeout: 8000 }, E.nick).catch(async () => { await shot(page, `debug-menu-${width}`); });
    const pt = phone ? null : await page.evaluate(() => ({ x: innerWidth - 6, y: innerHeight - 6 }));
    await page.evaluate((n, pt) => { const e = [...document.querySelectorAll(`.user-row[data-nick="${n}"]`)].find((x) => x.getClientRects().length); const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: pt ? pt.x : r.left + 10, clientY: pt ? pt.y : r.top + 10 })); }, E.nick, pt);
    await sleep(400);
    const m = await page.evaluate(() => {
      const el = document.querySelector('.menu.person-menu'); if (!el) return null;
      const r = el.getBoundingClientRect();
      const btns = [...el.querySelectorAll('button')];
      const hit = btns.every((b) => { const q = b.getBoundingClientRect(); const h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return q.top >= r.top - 1 && q.bottom <= r.bottom + 1 && h && (h === b || b.contains(h)); });
      const callbar = document.querySelector('.call-bar, .media-bar, [data-testid="call-bar"]')?.getBoundingClientRect();
      return { parent: el.parentElement === document.body, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5, noScroll: el.scrollHeight <= el.clientHeight + 1, hit, n: btns.length, actions: btns.map((b) => b.dataset.action).filter(Boolean), flipX: el.dataset.flipX, flipY: el.dataset.flipY, overCallbar: callbar ? r.bottom > callbar.top + 1 : false };
    });
    ok(m?.parent, `M ${width}: the person menu is rendered in a portal (outside the people list)`);
    ok(m?.inView, `M ${width}: the menu is fully on screen`, JSON.stringify(m));
    ok(['kick', 'room-ban', 'site-ban', 'mute', 'block', 'report-user'].every((a) => m?.actions.includes(a)), `M ${width}: staff sees the mod actions`, JSON.stringify(m?.actions));
    ok(m?.hit, `M ${width}: every action (${m?.n}) can be clicked where it is shown`);
    if (!phone) ok(m?.flipX === 'true' && m?.flipY === 'true', `M ${width}: opened at the bottom-right corner, the menu flips left and up`);
    if (phone) ok(m?.noScroll && !m.overCallbar, `M ${width}: the sheet shows every action, mod ones included, without scrolling and above the call bar`, JSON.stringify(m));
    await shot(page, `x-mc2-menu-${width}`);
    if (!phone) {
      // keyboard (Shift+F10): placed under the row, inside the viewport, focus inside
      await page.keyboard.press('Escape'); await sleep(200);
      await page.focus(`.user-row[data-nick="${E.nick}"]`); await page.keyboard.down('Shift'); await page.keyboard.press('F10'); await page.keyboard.up('Shift'); await sleep(400);
      const k = await page.evaluate(() => { const el = document.querySelector('.menu.person-menu'); const r = el?.getBoundingClientRect(); return el ? { inView: r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5, focus: el.contains(document.activeElement) } : null; });
      ok(k?.inView && k.focus, `M ${width}: Shift+F10 opens it on screen with focus inside`);
      await page.keyboard.press('Escape'); await sleep(200);
      ok(!(await page.$('.menu.person-menu')), `M ${width}: Escape closes it`);
      // a click inside still works (portal keeps React handlers)
      await page.evaluate((n) => { const e = document.querySelector(`.user-row[data-nick="${n}"]`); const r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 })); }, E.nick); await sleep(300);
      await page.$eval('.person-menu [data-action="mention"]', (b) => b.click()); await sleep(300);
      ok((await page.$eval('input[aria-label="Chat message"]', (i) => i.value)).trim() === `@${E.nick}`, `M ${width}: menu actions still work from the portal`);
    }
    await ctx.close();
  }
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  server.kill('SIGTERM'); recv.close();
}
if (failed && process.env.SHOWLOG) console.log(log.slice(-3000));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
