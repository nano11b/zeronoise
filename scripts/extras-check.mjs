/**
 * Batch MC2 extras: name gradients, profile effects, chat commands, stickers, games, music queue, recurring events, saved messages, shortcuts.
 *   node scripts/extras-check.mjs [shots]
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
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-extras'));
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
const { UI_PALETTES } = await import(pathToFileURL(path.join(ROOT, 'dist/server/shared/uiTheme.js')).href);
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const worstOf = (hexes) => Math.min(...Object.values(UI_PALETTES).flatMap((p) => [p.bg, p.bg2, p.panel, p.panel2, p.primaryBg].flatMap((b) => hexes.map((h) => cr(h, b)))));
const setVal = (page, sel, v) => page.$eval(sel, (i, v) => { const proto = i instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }, v);
/** room settings (Info tab) -> a details section, opened and scrolled to */
const openSettings = async (page, width, section) => {
  if (width < 800) { await page.$eval('[data-action="collapse-panel"]', (b) => b.click()).catch(() => {}); await sleep(400); }
  await page.$eval('[data-action="tab-info"]', (b) => b.click()).catch(() => {}); await sleep(400);
  const ok2 = await page.waitForSelector(`details[data-section="${section}"]`, { timeout: 6000 }).then(() => true, () => false);
  if (ok2) await page.$eval(`details[data-section="${section}"]`, (d) => { d.open = true; d.scrollIntoView({ block: 'start' }); });
  await sleep(500);
  return ok2;
};
try {
  const S = await nodeUser('PpAdmin'), D = await nodeUser(`XD${R}`), E = await nodeUser(`XE${R}`);
  sockets.push(S.s, D.s, E.s);
  const ROOM = (await emit(D.s, 'room:create', { name: `extras ${R}`, topic: 't', category: 'gaming' })).roomId;
  for (const u of [D, E, S]) await emit(u.s, 'room:join', { roomId: ROOM });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--lang=en-US'] });
  const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
  const want = (k) => !ONLY.length || ONLY.includes(k);
  // @@X1 name gradients
  if (want('X1')) {
    const g = await D.j.req('/api/me/color', { gradient: ['#9fd8ff', '#d7b8ff'] }, 'PATCH');
    ok(g.ok && g.chatColor === 'g:#9fd8ff,#d7b8ff', 'X1: a name gradient is saved', JSON.stringify(g));
    const dk = await E.j.req('/api/me/color', { gradient: ['#111111', '#ffd166', '#300000'] }, 'PATCH');
    const st = (dk.chatColor || '').slice(2).split(',');
    ok(dk.ok && dk.adjusted && st.length === 3 && worstOf(st) >= 4.5, `X1: dark name-gradient stops are lightened (${dk.chatColor})`);
    for (const b of [{ gradient: ['#ffd166'] }, { gradient: ['#ffd166', 'red;x'] }, { color: 'g:#zzz' }]) ok((await E.j.req('/api/me/color', b, 'PATCH')).status === 400, `X1: refused ${JSON.stringify(b)}`);
    ok((await E.j.req('/api/me/color', { color: 'teal' }, 'PATCH')).chatColor === 'teal', 'X1: palette name colours still work');
    await emit(D.s, 'chat:send', { text: `named ${R}` }); await sleep(300);
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(D, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(700);
      const n = await page.evaluate((nick) => { const el = [...document.querySelectorAll('.chat-log .nick-label.from')].find((e) => e.textContent === nick); if (!el) return null; const cs = getComputedStyle(el); return { cls: el.className, bg: cs.backgroundImage, fill: cs.webkitTextFillColor, color: cs.color, anim: cs.animationName }; }, D.nick);
      ok(n && /nick-grad/.test(n.cls) && /linear-gradient/.test(n.bg) && n.fill === 'rgba(0, 0, 0, 0)' && n.color === 'rgb(159, 216, 255)', `X1 ${width}: names render with the gradient (solid fallback = first stop)`, JSON.stringify(n));
      ok(n?.anim === 'none', `X1 ${width}: not animated`);
      await page.$eval('[data-action="composer-plus"]', (b) => b.click()); await sleep(250);
      await page.$eval('[data-action="name-style"]', (b) => b.click()); await sleep(300);
      const sw = await page.$$eval('[data-name-gradient]', (x) => x.length);
      const same = await page.evaluate(() => { const a = document.querySelector('[data-name-gradient]'), b = document.querySelector('.name-style-pop .color-swatch:not(.reset)'); return !!a && a.classList.contains('color-swatch') && !!b; });
      ok(sw >= 4 && same, `X1 ${width}: the name picker in the chat bar offers the same gradients, same swatch style`);
      await page.$eval('[data-field="name-stop-0"]', (i) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '#151515'); i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(150);
      ok(!!(await page.$('[data-testid="name-grad-adjusted"]')), `X1 ${width}: a dark custom stop is flagged before saving`);
      const fit = await page.evaluate(() => { const r = document.querySelector('.name-style-pop').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0; });
      ok(fit, `X1 ${width}: the name picker fits`);
      await shot(page, `x-name-gradient-${width}`);
      await ctx.close();
    }
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM });
  }
  // @@X2 profile effects (avatar frames / glows)
  if (want('X2')) {
    const r = await D.j.req('/api/me/avatar-fx', { fx: 'breathe' }, 'PATCH');
    ok(r.ok && r.avatarFx === 'breathe', 'X2: a profile effect is saved');
    ok((await D.j.req('/api/me/avatar-fx', { fx: 'url(x)' }, 'PATCH')).status === 400, 'X2: unknown effects are refused');
    const me = await D.j.req('/api/me');
    ok(me.account?.avatarFx === 'breathe', 'X2: /api/me carries it');
    const ev = events(E.s, 'chat:message');
    await emit(D.s, 'chat:send', { text: `framed ${R}` });
    ok(await waitFor(() => ev.some((m) => m.text === `framed ${R}` && m.avatarFx === 'breathe')), 'X2: chat lines carry the effect');
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(E, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      const av = (p) => p.evaluate((t) => { const line = [...document.querySelectorAll('.chat-log .msg')].find((e) => e.textContent.includes(t)); const a = line?.querySelector('.user-avatar'); if (!a) return null; const cs = getComputedStyle(a); return { cls: a.className, shadow: cs.boxShadow, anim: cs.animationName }; }, `framed ${R}`);
      const a1 = await av(page);
      ok(a1 && /avatar-fx-breathe/.test(a1.cls) && a1.shadow !== 'none' && a1.anim === 'avatar-breathe', `X2 ${width}: the sender's avatar shows the glow`, JSON.stringify(a1));
      await shot(page, `x-avatar-fx-room-${width}`);
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await sleep(150);
      const a2 = await av(page);
      ok(a2 && a2.anim === 'none' && a2.shadow !== 'none', `X2 ${width}: reduced motion keeps the frame but stops the animation`);
      await page.emulateMediaFeatures([]);
      // viewer toggle in the Profile dialog
      await page.$eval('[data-action="profile"]', (b) => b.click()); await sleep(400);
      await page.waitForSelector('[data-action="open-profile"]', { timeout: 6000 }); await page.$eval('[data-action="open-profile"]', (b) => b.click());
      await page.waitForSelector('[data-section="avatar-fx"]', { timeout: 6000 });
      ok((await page.$$('[data-section="avatar-fx"] [data-avatar-fx]')).length >= 6, `X2 ${width}: the Profile dialog offers the effects`);
      await page.$eval('[data-section="avatar-fx"]', (d) => d.scrollIntoView({ block: 'start' })); await sleep(200);
      ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), `X2 ${width}: the section fits`);
      await shot(page, `x-avatar-fx-profile-${width}`);
      await page.$eval('[data-action="hide-avatar-fx"]', (c) => c.click()); await sleep(200);
      await page.keyboard.press('Escape'); await sleep(300);
      const a3 = await av(page);
      ok(a3 && a3.shadow === 'none' && a3.anim === 'none', `X2 ${width}: "hide profile effects" turns them off for this viewer`);
      ok(await page.evaluate(() => localStorage.getItem('zn.hideAvatarFx') === '1'), `X2 ${width}: the setting is remembered on this device`);
      await ctx.close();
    }
    await fresh0(E); await emit(E.s, 'room:join', { roomId: ROOM });
  }
  // @@X3 chat commands
  if (want('X3')) {
    const ev = events(E.s, 'chat:message');
    const last = () => ev[ev.length - 1]?.text ?? '';
    const say = async (t) => { await sleep(700); const n = ev.length; const r = await emit(D.s, 'chat:send', { text: t }); if (r.ok === false) console.log('[say]', t, r.error); await waitFor(() => ev.length > n, 2000); return r; };
    await say('/me waves *hi*');
    ok(last() === `_${D.nick} waves \\*hi\\*_`, `X3: /me posts an action line (${last()})`);
    await say('/shrug ok');
    ok(last() === 'ok ¯\\\\\\_(ツ)\\_/¯', `X3: /shrug (${last()})`);
    await say('/roll 3d6');
    const m = /^🎲 rolled 3d6: (\d+) \+ (\d+) \+ (\d+) = \*\*(\d+)\*\*$/.exec(last());
    ok(m && [1, 2, 3].every((i) => +m[i] >= 1 && +m[i] <= 6) && +m[4] === +m[1] + +m[2] + +m[3], `X3: /roll 3d6 (${last()})`);
    await say('/roll'); ok(/^🎲 rolled 1d6: \*\*[1-6]\*\*$/.test(last()), 'X3: /roll defaults to 1d6');
    for (const bad of ['/roll 50d6', '/roll 2d1', '/roll 2d99999', '/roll abc', '/me']) ok((await emit(D.s, 'chat:send', { text: bad })).ok === false, `X3: refused: ${bad}`);
    await sleep(3000); const flips = new Set(); for (let i = 0; i < 14; i++) { const r = await say('/flip'); if (r.ok !== false) flips.add(last()); await sleep(900); if (flips.size === 2) break; }
    ok([...flips].every((t) => /^🪙 flipped a coin: \*\*(heads|tails)\*\*$/.test(t)) && flips.size === 2, 'X3: /flip gives heads or tails');
    await say('/notacommand hello'); ok(last() === '/notacommand hello', 'X3: unknown /words are posted as typed');
    // custom commands
    const base = `/api/rooms/${encodeURIComponent(ROOM)}/commands`;
    ok((await E.j.req(`${base}/rules`, { response: 'x' }, 'PUT')).status === 403, 'X3: only the owner can add commands');
    const c1 = await D.j.req(`${base}/rules`, { response: 'Be kind <script>alert(1)</script> @everyone' }, 'PUT');
    const saved = c1.commands?.find((c) => c.name === 'rules')?.response ?? '';
    ok(c1.ok && !/[<>]/.test(saved) && !/@everyone\b/.test(saved) && saved.includes('＠everyone'), `X3: replies are sanitized (${saved})`);
    for (const [n, body, why] of [['roll', { response: 'x' }, 'reserved name'], ['a', { response: 'x' }, 'too short name'], ['bad name', { response: 'x' }, 'bad name'], ['long', { response: 'x'.repeat(301) }, 'too long reply'], ['empty', { response: '   ' }, 'empty reply']])
      ok((await D.j.req(`${base}/${encodeURIComponent(n)}`, body, 'PUT')).status === 400, `X3: refused: ${why}`);
    for (let i = 0; i < 19; i++) await D.j.req(`${base}/c${i}x`, { response: `r${i}` }, 'PUT');
    ok((await D.j.req(`${base}/onemore`, { response: 'x' }, 'PUT')).status === 400, 'X3: at most 20 commands per room');
    await D.j.req(`${base}/c18x`, undefined, 'DELETE');
    ok(!(await E.j.req(base)).commands.some((c) => c.name === 'c18x'), 'X3: owner removes a command');
    await say('/rules'); ok(last() === saved, 'X3: typing /rules posts the reply');
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(D, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      await page.focus('input[aria-label="Chat message"]'); await page.keyboard.type('/r');
      await page.waitForSelector('[data-testid="cmd-hints"]', { timeout: 4000 }).catch(() => {});
      const hints = await page.$$eval('[data-testid="cmd-hints"] [data-cmd]', (x) => x.map((b) => b.dataset.cmd));
      ok(hints.includes('roll') && hints.includes('rules'), `X3 ${width}: typing "/" suggests built-in and room commands (${hints})`);
      await shot(page, `x-commands-hints-${width}`);
      await page.$eval('[data-cmd="roll"]', (b) => b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))); await sleep(150);
      await page.keyboard.type('2d20'); await page.keyboard.press('Enter'); await sleep(700);
      ok(await page.evaluate(() => [...document.querySelectorAll('.chat-log .md')].some((e) => /🎲 rolled 2d20/.test(e.textContent))), `X3 ${width}: /roll from the message box posts the result`);
      await shot(page, `x-commands-chat-${width}`);
      const has = await openSettings(page, width, 'commands');
      if (has) { await page.waitForSelector('[data-panel="commands"] [data-command="rules"]', { timeout: 5000 }).catch(() => {}); }
      ok(has && !!(await page.$('[data-panel="commands"] [data-command="rules"]')), `X3 ${width}: room settings list the commands`);
      if (has) await shot(page, `x-commands-settings-${width}`);
      await ctx.close();
    }
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM });
  }
  // @@X4 sticker packs
  if (want('X4')) {
    const base = `/api/rooms/${encodeURIComponent(ROOM)}`;
    ok((await E.j.req(`${base}/sticker-packs`, { name: 'nope' })).status === 403, 'X4: only the owner or staff create packs');
    const p1 = await D.j.req(`${base}/sticker-packs`, { name: 'Cats' });
    const pack = p1.packs?.find((p) => p.name === 'Cats');
    ok(p1.ok && pack, 'X4: owner creates a pack');
    const up = async (u, name, buf, type = 'image/png', pk = pack.id) => { const fd = new FormData(); fd.append('name', name); fd.append('sticker', new Blob([buf], { type }), `${name}.png`); return u.j.form(`${base}/sticker-packs/${pk}/stickers`, fd); };
    const u1 = await up(D, 'happy', await png('#ffcc00', 300));
    ok(u1.ok && u1.sticker.status === 'pending', `X4: owner upload waits for staff review (${u1.sticker?.status})`);
    ok((await up(D, 'big', Buffer.alloc(1_100_000, 1))).status === 400, 'X4: files over 1 MB are refused');
    ok((await up(D, 'txt', Buffer.from('hello world'), 'text/plain')).status === 400, 'X4: non-images are refused');
    ok((await up(D, 'Bad Name', await png('#00ff00'))).status === 400, 'X4: bad sticker names are refused');
    ok((await up(E, 'sneaky', await png('#00ff00'))).status === 403, 'X4: members cannot upload');
    const meta = await sharp(Buffer.from(await (await fetch(`${BASE}${u1.sticker.url}`, { headers: { cookie: D.j.header() } })).arrayBuffer())).metadata();
    ok(meta.format === 'webp' && meta.width <= 256 && meta.height <= 256, `X4: stored as WebP at most 256px (${meta.format} ${meta.width})`);
    ok((await fetch(`${BASE}${u1.sticker.url}`, { headers: { cookie: E.j.header() } })).status === 404, 'X4: pending stickers are hidden from members');
    ok(!(await E.j.req(`${base}/stickers`)).packs.some((p) => p.stickers.length), 'X4: members only see approved stickers');
    ok((await emit(E.s, 'chat:send', { text: '', sticker: u1.sticker.id })).ok === false, 'X4: a pending sticker cannot be sent');
    ok((await E.j.req(`/api/admin/stickers?status=pending`)).status === 403, 'X4: review queue is staff-only');
    const q = await S.j.req('/api/admin/stickers?status=pending');
    ok(q.stickers?.some((s) => s.id === u1.sticker.id), 'X4: staff see the sticker in the review queue');
    const u2 = await up(D, 'grumpy', await png('#3366ff', 128));
    // admin UI review (approve one, reject the other)
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(S, width);
      await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-tab="stickers"]', { timeout: 15000 }); await dismiss(page);
      await page.$eval('[data-tab="stickers"]', (b) => b.click());
      await page.waitForSelector('[data-admin-sticker]', { timeout: 6000 }).catch(() => {});
      if (width < 800) { await page.$eval('[data-action="stickers-approved"]', (b) => b.click()); await page.waitForSelector('[data-admin-sticker="happy"]', { timeout: 5000 }).catch(() => {}); }
      ok(await page.$(`[data-admin-sticker="happy"]`), `X4 ${width}: admin Stickers tab lists ${width < 800 ? 'approved' : 'pending'} stickers`);
      await shot(page, `x-stickers-admin-${width}`);
      if (width === 1366) {
        await page.$eval('[data-admin-sticker="happy"] [data-action="sticker-approve"]', (b) => b.click()); await sleep(800);
        page.once('dialog', (d) => d.accept('Too blurry'));
        await page.$eval('[data-admin-sticker="grumpy"] [data-action="sticker-reject"]', (b) => b.click()); await sleep(800);
      }
      await ctx.close();
    }
    const after = (await D.j.req(`${base}/stickers`)).packs.flatMap((p) => p.stickers);
    ok(after.find((s) => s.id === u1.sticker.id)?.status === 'approved' && after.find((s) => s.id === u2.sticker.id)?.status === 'rejected' && after.find((s) => s.id === u2.sticker.id)?.note === 'Too blurry', 'X4: approve and reject (with note) from the admin tab');
    const ev = events(D.s, 'chat:message');
    await sleep(800);
    const sent = await emit(E.s, 'chat:send', { text: '', sticker: u1.sticker.id });
    await waitFor(() => ev.some((m) => /\[\[sticker:/.test(m.text)), 3000);
    ok(sent.ok !== false && ev.some((m) => m.text === `[[sticker:${u1.sticker.id}]]`), 'X4: members send an approved sticker');
    ok((await emit(E.s, 'chat:send', { text: '', sticker: u2.sticker.id })).ok === false, 'X4: a rejected sticker cannot be sent');
    ok((await emit(E.s, 'chat:send', { text: '', sticker: 'f'.repeat(32) })).ok === false, 'X4: unknown sticker ids are refused');
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(D, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(800);
      const shown = await page.waitForFunction(() => { const i = document.querySelector('.chat-log img.sticker'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 6000 }).then(() => true, () => false);
      ok(shown, `X4 ${width}: stickers render in chat`);
      await page.$eval('[data-action="stickers"]', (b) => b.click()).catch(() => {});
      await page.waitForSelector('[data-sticker="happy"]', { timeout: 5000 }).catch(() => {});
      const opts = await page.$$eval('[data-testid="sticker-pop"] [data-sticker]', (x) => x.map((b) => b.dataset.sticker));
      ok(opts.includes('happy') && !opts.includes('grumpy'), `X4 ${width}: the sticker picker shows approved stickers only (${opts})`);
      const fits = await page.$eval('[data-testid="sticker-pop"]', (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; }).catch(() => false);
      ok(fits, `X4 ${width}: the picker fits on screen`);
      await shot(page, `x-stickers-picker-${width}`);
      if (width === 1366) {
        const n = await page.$$eval('.chat-log img.sticker', (x) => x.length);
        await page.$eval('[data-sticker="happy"]', (b) => b.click());
        ok(await page.waitForFunction((n) => document.querySelectorAll('.chat-log img.sticker').length > n, { timeout: 5000 }, n).then(() => true, () => false), 'X4: sending from the picker posts the sticker');
      }
      const has = await openSettings(page, width, 'stickers');
      if (has) await page.waitForSelector('[data-panel="stickers"] [data-pack="Cats"]', { timeout: 5000 }).catch(() => {});
      ok(has && !!(await page.$('[data-pack="Cats"] [data-sticker-status="rejected"]')), `X4 ${width}: room settings show packs with review status`);
      if (has) await shot(page, `x-stickers-settings-${width}`);
      await ctx.close();
    }
    for (let i = 0; i < 2; i++) await D.j.req(`${base}/sticker-packs`, { name: `P${i}` });
    ok((await D.j.req(`${base}/sticker-packs`, { name: 'P9' })).status === 409, 'X4: at most 3 packs per room');
    await fresh0(D); await emit(D.s, 'room:join', { roomId: ROOM }); await fresh0(E); await emit(E.s, 'room:join', { roomId: ROOM }); await fresh0(S); await emit(S.s, 'room:join', { roomId: ROOM });
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
