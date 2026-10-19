/**
 * Batch X people list: mod bot hidden (still moderates), click = whisper (self = profile),
 * context menu by right-click / long-press / Shift+F10 / Menu key, message colours.   node scripts/people-check.mjs [shots]
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
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-people'));
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
try {
  const S = await nodeUser('PpAdmin'), A = await nodeUser(`PpA${R}`), B = await nodeUser(`PpB${R}`);
  sockets.push(S.s, A.s, B.s);
  const rc = await emit(A.s, 'room:create', { name: `people ${R}`, topic: 't', category: 'gaming' });
  const ROOM = rc.roomId;
  for (const u of [A, B]) await emit(u.s, 'room:join', { roomId: ROOM });
  // @@A1 mod bot
  const bot = await S.j.req('/api/bots', { name: `Meowington${R}` });
  const setm = await S.j.req('/api/admin/moderator-bot', { botId: bot.bot?.id });
  const BH = { authorization: `Bearer ${bot.token}`, 'content-type': 'application/json' };
  const me = await fetch(BASE + '/api/bots/me', { headers: BH });
  ok(bot.ok && setm.ok && me.status === 200, 'A1: a moderator bot is set and online', bot.error || setm.error);
  const st = await emit(B.s, 'room:join', { roomId: ROOM });
  void st;
  await sleep(500);
  // @@A1-UI and A2/A3 in the browser
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--lang=en-US'] });
  fs.mkdirSync(OUT, { recursive: true });
  for (const width of [1366, 390]) {
    const phone = width < 800;
    const { ctx, page } = await pageFor(A, width);
    await page.goto(`${BASE}/?room=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(600);
    // the bot is "seen" again so presence is fresh while the page is open
    await fetch(BASE + '/api/bots/me', { headers: BH }); await sleep(400);
    await openPeople(page, phone);
    const list = await page.evaluate((n) => ({ rows: [...document.querySelectorAll('.users .user-row')].map((r) => r.dataset.nick), bot: !!document.querySelector('[data-modbot], .role-modbot'), online: document.querySelector('[data-online]')?.dataset.online, hasBotText: document.querySelector('.users')?.textContent.includes(n) }), `Meowington${R}`);
    ok(!list.bot && !list.hasBotText && !list.rows.includes(`Meowington${R}`), `A1 ${width}: the mod bot is not in the people list`, JSON.stringify(list.rows));
    ok(list.rows.includes(B.nick) && list.rows.includes(A.nick), `A1 ${width}: people are listed (${list.online} online)`);
    await shot(page, `x-people-${width}`);
    // A3: right-click / long-press (contextmenu) opens the menu
    ok(await cm(page, `.user-row[data-nick="${B.nick}"]`), `A3 ${width}: row found`);
    await sleep(350);
    const items = await page.evaluate(() => [...document.querySelectorAll('.person-menu [data-action]')].map((b) => b.dataset.action));
    ok(['view-profile', 'dm-whisper', 'dm-call', 'add-friend', 'mention', 'block', 'report-user'].every((a) => items.includes(a)), `A3 ${width}: context menu has profile, whisper, call, add friend, mention, block, report`, JSON.stringify(items));
    ok(items.includes('kick') && items.includes('room-ban'), `A3 ${width}: the room owner also gets the mod actions they are allowed`);
    const focusIn = await page.evaluate(() => document.querySelector('.person-menu')?.contains(document.activeElement));
    ok(focusIn, `A3 ${width}: focus moves into the menu`);
    await shot(page, `x-context-menu-${width}`);
    // mention
    await page.$eval('.person-menu [data-action="mention"]', (b) => b.click()); await sleep(300);
    const val = await page.$eval('.chat-form input, input[aria-label="Chat message"]', (i) => i.value);
    ok(val.trim() === `@${B.nick}`, `A3 ${width}: Mention puts @name in the message box (${val})`);
    await page.evaluate(() => { const i = document.querySelector('input[aria-label="Chat message"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); });
    // keyboard: Shift+F10 and the Menu key
    await openPeople(page, phone);
    await page.evaluate((n) => [...document.querySelectorAll(`.user-row[data-nick="${n}"]`)].find((x) => x.getClientRects().length)?.focus(), B.nick);
    await page.keyboard.down('Shift'); await page.keyboard.press('F10'); await page.keyboard.up('Shift'); await sleep(300);
    ok(await page.evaluate(() => !!document.querySelector('.person-menu')), `A3 ${width}: Shift+F10 opens the menu`);
    await page.keyboard.press('Escape'); await sleep(250);
    ok(await page.evaluate(() => !document.querySelector('.person-menu')), `A3 ${width}: Escape closes it`);
    await page.evaluate((n) => [...document.querySelectorAll(`.user-row[data-nick="${n}"]`)].find((x) => x.getClientRects().length)?.focus(), B.nick);
    await page.keyboard.press('ContextMenu'); await sleep(300);
    ok(await page.evaluate(() => !!document.querySelector('.person-menu')), `A3 ${width}: the Menu key opens the menu`);
    await page.keyboard.press('Escape'); await sleep(250);
    // touch long-press (iOS has no contextmenu event): hold 600 ms
    if (phone) {
      const box = await page.evaluate((n) => { const r = [...document.querySelectorAll(`.user-row[data-nick="${n}"]`)].find((x) => x.getClientRects().length)?.getBoundingClientRect(); return r && { x: r.x + 20, y: r.y + r.height / 2 }; }, B.nick);
      const cdp = await page.createCDPSession();
      await page.evaluate(() => document.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true, once: false }));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
      await sleep(700);
      const during = await page.evaluate(() => !!document.querySelector('.person-menu'));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(400);
      const after = await page.evaluate(() => ({ menu: !!document.querySelector('.person-menu'), dm: !!document.querySelector('.dm-panel, [data-testid="dm-panel"]') }));
      ok(during && after.menu && !after.dm, `A3 ${width}: a long-press opens the menu (and does not also open a whisper)`, JSON.stringify({ during, ...after }));
      await shot(page, `x-long-press-${width}`);
      await page.keyboard.press('Escape'); await sleep(250);
    }
    // A2: click = whisper in the inbox
    await openPeople(page, phone);
    await page.evaluate((n) => [...document.querySelectorAll(`.user-row[data-nick="${n}"]`)].find((x) => x.getClientRects().length)?.click(), B.nick);
    const dm = await page.waitForFunction((n) => { return !!document.querySelector(`[placeholder="Whisper ${n}"]`); }, { timeout: 8000 }, B.nick).then(() => true, () => false);
    ok(dm, `A2 ${width}: clicking a person opens a whisper with them in the Whispers inbox`);
    await shot(page, `x-click-whisper-${width}`);
    await page.keyboard.press('Escape'); await sleep(400);
    // self = profile
    await openPeople(page, phone);
    await page.evaluate((n) => [...document.querySelectorAll(`.user-row[data-nick="${n}"]`)].find((x) => x.getClientRects().length)?.click(), A.nick);
    const prof = await page.waitForSelector(`[data-profile="${A.nick}"]`, { timeout: 6000 }).then(() => true, () => false);
    ok(prof, `A2 ${width}: clicking yourself opens your profile`);
    await page.keyboard.press('Escape'); await sleep(300);
    await ctx.close();
  }
  // A2: requests and blocks still apply (server side)
  {
    const C = await nodeUser(`PpC${R}`); sockets.push(C.s);
    await emit(C.s, 'room:join', { roomId: ROOM });
    const blk = await emit(B.s, 'dm:block', { userId: C.id });
    const st2 = await emit(C.s, 'dm:start', { usernames: [B.nick] });
    let sent = st2.ok ? await emit(C.s, 'dm:send', { convoId: st2.convo.id, text: 'hi?' }) : st2;
    ok(!sent.ok || sent.blocked || sent.request, `A2: a blocked person still cannot whisper you (${blk.error || 'blocked'}: ${sent.error || JSON.stringify(sent).slice(0, 80)})`);
  }
  // A1: the bot still moderates
  {
    const k = await fetch(BASE + '/api/bots/moderation/kick', { method: 'POST', headers: BH, body: JSON.stringify({ roomId: ROOM, username: B.nick, reason: 'test' }) });
    const kj = await k.json();
    ok(k.status === 200 && kj.ok, `A1: the hidden mod bot can still kick (${k.status} ${kj.error || ''})`);
  }
  // @@A4 message colour
  {
    const D = await nodeUser(`PpD${R}`), E = await nodeUser(`PpE${R}`); sockets.push(D.s, E.s);
    const rc2 = await emit(D.s, 'room:create', { name: `colours ${R}`, topic: 't', category: 'gaming' });
    const CR = rc2.roomId;
    for (const u of [D, E]) await emit(u.s, 'room:join', { roomId: CR });
    const dark = await D.j.req('/api/me/msg-color', { color: '#101010' }, 'PATCH');
    ok(dark.ok && dark.adjusted === true && dark.msgColor !== '#101010', `A4: an unreadable colour is lightened (#101010 -> ${dark.msgColor})`);
    const bad = await D.j.req('/api/me/msg-color', { color: 'url(javascript:1)' }, 'PATCH');
    ok(bad.status === 400, 'A4: anything that is not a #rrggbb colour is refused');
    const g = await D.j.req('/api/me/msg-color', { color: '#ffd166' }, 'PATCH');
    ok(g.ok && g.msgColor === '#ffd166' && g.adjusted === false, 'A4: a readable colour is kept as is');
    // contrast on all four themes (independent check)
    const { UI_PALETTES } = await import(pathToFileURL(path.join(ROOT, 'dist/server/shared/uiTheme.js')).href).catch(() => ({}));
    if (UI_PALETTES) {
      const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
      const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      const worst = Math.min(...Object.values(UI_PALETTES).flatMap((p) => [p.bg, p.bg2, p.panel, p.panel2, p.primaryBg].map((b) => Math.min(cr(dark.msgColor, b), cr('#ffd166', b)))));
      ok(worst >= 4.5, `A4: saved colours keep 4.5:1 on all four themes (worst ${worst.toFixed(2)})`);
    }
    const eMsg = events(E.s, 'chat:message');
    await emit(D.s, 'chat:send', { text: `coloured ${R}` });
    ok(await waitFor(() => eMsg.some((m) => m.text === `coloured ${R}` && m.msgColor === '#ffd166')), 'A4: live room lines carry the colour');
    const hist = (await emit(E.s, 'room:join', { roomId: CR })).room?.history ?? [];
    void hist;
    // whisper (DM) between D and E
    await emit(D.s, 'friends:request', { username: E.nick }); await emit(E.s, 'friends:respond', { userId: D.id, accept: true });
    const st = await emit(D.s, 'dm:start', { usernames: [E.nick] });
    await emit(D.s, 'dm:send', { convoId: st.convo?.id, text: `dm coloured ${R}` });
    ok(st.ok && st.convo.members.some((m) => m.userId === D.id && m.msgColor === '#ffd166'), 'A4: whisper members carry the colour');
    for (const width of [1366, 390]) {
      const phone = width < 800;
      const { ctx, page } = await pageFor(E, width);
      await page.goto(`${BASE}/?room=${encodeURIComponent(CR)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.chat-log', { timeout: 15000 }); await dismiss(page); await sleep(700);
      const col = await page.evaluate((t) => { const el = [...document.querySelectorAll('.chat-log .md')].find((e) => e.textContent.includes(t)); return el ? { attr: el.dataset.msgColor, color: getComputedStyle(el.querySelector('p') || el).color } : null; }, `coloured ${R}`);
      ok(col?.attr === '#ffd166' && col.color === 'rgb(255, 209, 102)', `A4 ${width}: the room line is shown in the sender's colour`, JSON.stringify(col));
      await shot(page, `x-msg-color-room-${width}`);
      // every theme
      for (const theme of ['dark-red', 'dark-green', 'dark-orange']) {
        await page.evaluate((th) => document.documentElement.setAttribute('data-ui-theme', th), theme); await sleep(150);
        const c2 = await page.evaluate((t) => getComputedStyle([...document.querySelectorAll('.chat-log .md')].find((e) => e.textContent.includes(t))).color, `coloured ${R}`);
        ok(c2 === 'rgb(255, 209, 102)', `A4 ${width}: colour holds on ${theme}`);
        if (width === 1366) await shot(page, `x-msg-color-${theme}-${width}`);
      }
      await page.evaluate(() => document.documentElement.removeAttribute('data-ui-theme'));
      // MC2: the picker lives in the chat bar (composer + menu, next to the name colour control) + viewer opt-out
      await page.$eval('[data-action="composer-plus"]', (b) => b.click()); await sleep(300);
      await page.$eval('[data-action="msg-style"]', (b) => b.click());
      await page.waitForSelector('[data-section="msg-color"]', { timeout: 6000 });
      // type an unreadable custom colour: the dialog warns it will be lightened
      await page.$eval('[data-field="msg-color"]', (i) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '#202020'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
      await sleep(200);
      ok(!!(await page.$('[data-testid="msg-color-adjusted"]')), `A4 ${width}: the picker warns before saving a colour that would be lightened`);
      const ov = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      ok(!ov, `A4 ${width}: the colour picker fits`);
      await shot(page, `x-msg-color-composer-${width}`);
      await page.$eval('[data-action="ignore-msg-colors"]', (c) => c.click()); await sleep(200);
      await page.keyboard.press('Escape'); await sleep(200); await page.keyboard.press('Escape'); await sleep(300);
      const after = await page.evaluate((t) => { const el = [...document.querySelectorAll('.chat-log .md')].find((e) => e.textContent.includes(t)); return el?.dataset.msgColor ?? null; }, `coloured ${R}`);
      ok(after === null, `A4 ${width}: "ignore custom message colours" shows the line in the normal colour`);
      await page.evaluate(() => localStorage.removeItem('zn.ignoreMsgColors'));
      // whispers
      await page.goto(`${BASE}/?whispers=${encodeURIComponent(D.nick)}`, { waitUntil: 'domcontentloaded' }); await sleep(1200); await dismiss(page);
      const dmc = await page.waitForFunction((t) => { const el = [...document.querySelectorAll('[data-testid="dm-log"] .md')].find((e) => e.textContent.includes(t)); return el && el.dataset.msgColor; }, { timeout: 8000 }, `dm coloured ${R}`).then((h) => h.jsonValue(), () => null);
      ok(dmc === '#ffd166', `A4 ${width}: whispers show the sender's colour (${dmc})`);
      await shot(page, `x-msg-color-whisper-${width}`);
      void phone;
      await ctx.close();
    }
  }
  // @@UPDATES
  {
    const res = await fetch(BASE + '/updates'); const html = await res.text();
    const cl = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/changelog.json'), 'utf8')).entries;
    const order = cl.map((e) => html.indexOf(`id="${e.id}"`));
    ok(res.status === 200 && order.every((x) => x > 0), 'U: /updates lists every release');
    ok(order.every((x, i) => i === 0 || x > order[i - 1]) && cl.every((e, i) => i === 0 || e.date <= cl[i - 1].date), 'U: newest first');
    ok(/Room webhooks/.test(html) && /people list/i.test(html) && /Message colours/.test(html) && /CamChat/.test(html), 'U: covers this batch and the CamChat beginnings');
    const banned = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\/home\/|\/etc\/|\/var\/|\/opt\/|CAMCHAT_|SECRET_KEY|keystore|\.jks|\.pem|ssh|signing key|password hash|manager@/i;
    ok(!banned.test(html) && !banned.test(JSON.stringify(cl)), 'U: no internal details (addresses, paths, key names, keystore)');
    const js = await fetch(BASE + '/updates.json'); ok(js.status === 200 && (await js.json()).entries.length === cl.length, 'U: /updates.json for tools');
    for (const width of [1366, 390]) {
      const { ctx, page } = await pageFor(A, width);
      await page.goto(BASE + '/updates', { waitUntil: 'domcontentloaded' }); await sleep(300);
      const st = await page.evaluate(() => ({ open: [...document.querySelectorAll('details.rel')].map((d) => d.open), ov: document.documentElement.scrollWidth > window.innerWidth + 1 }));
      ok(st.open[0] === true && st.open.slice(1).every((o) => !o), `U ${width}: newest release open, older ones collapsed`);
      ok(!st.ov, `U ${width}: fits without sideways scroll`);
      await shot(page, `x-updates-${width}`);
      await page.click('#all-open'); await sleep(150);
      ok(await page.evaluate(() => [...document.querySelectorAll('details.rel')].every((d) => d.open)), `U ${width}: Expand all`);
      await page.evaluate(() => { localStorage.setItem('zn.uiTheme', 'dark-orange'); }); await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(300);
      const th = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-ui-theme'), bg: getComputedStyle(document.body).backgroundColor }));
      ok(th.attr === 'dark-orange', `U ${width}: follows the chosen theme (${th.attr})`);
      await shot(page, `x-updates-dark-orange-${width}`);
      await page.goto(`${BASE}/updates#2026-10-17-whispers`, { waitUntil: 'domcontentloaded' }); await sleep(300);
      ok(await page.evaluate(() => document.getElementById('2026-10-17-whispers').open), `U ${width}: #release links open that release`);
      // What's new notice for a returning visitor (has an older seen id)
      await page.evaluate(() => { localStorage.setItem('zn.seenUpdate', '2026-10-17-whispers'); localStorage.removeItem('zn.uiTheme'); });
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      const note = await page.waitForSelector('[data-testid="whats-new"]', { timeout: 8000 }).then(() => true, () => false);
      ok(note, `U ${width}: a short What's new note appears after an update`);
      const href = await page.$eval('[data-action="whats-new-open"]', (a) => a.getAttribute('href')).catch(() => '');
      ok(href === `/updates#${cl[0].id}`, `U ${width}: it links to the newest entry`);
      await shot(page, `x-whats-new-note-${width}`);
      await page.$eval('[data-action="whats-new-dismiss"]', (b) => b.click()); await sleep(200);
      await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(1200);
      ok(!(await page.$('[data-testid="whats-new"]')), `U ${width}: dismissed notes stay gone`);
      // profile menu link
      await page.$eval('[data-action="profile"]', (b) => b.click()).catch(() => {}); await sleep(500);
      ok(!!(await page.$('[data-action="whats-new-menu"][href="/updates"]')), `U ${width}: What's new is in the Your profile menu`);
      await ctx.close();
      // brand-new visitor: no note; login footer link
      const ctx2 = await browser.createBrowserContext(); const p2 = await ctx2.newPage();
      await p2.setViewport(width < 800 ? { width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width, height: 800 });
      await p2.goto(BASE + '/', { waitUntil: 'networkidle0' }); await sleep(800);
      ok(!(await p2.$('[data-testid="whats-new"]')), `U ${width}: first-time visitors are not shown the note`);
      ok(!!(await p2.$('[data-action="whats-new-footer"][href="/updates"]')), `U ${width}: footer links to What's new`);
      await ctx2.close();
    }
    const dl = await (await fetch(BASE + '/download')).text();
    ok(dl.includes('href="/updates"'), 'U: the Get the app page links to What\'s new');
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
