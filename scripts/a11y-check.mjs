/**
 * Batch H8 accessibility: axe-core (WCAG 2.1 A/AA) on the main pages and dialogs at 1366 and 390, keyboard-only menus and dialogs, visible focus, reduced motion, polite announcements. axe-core is loaded from AXE_PATH (default /workspace/zn-test/axe/node_modules/axe-core/axe.min.js) so it is not a runtime dependency.
 *
 * Screenshots at 1366 and 390.   npm run build && node scripts/a11y-check.mjs [shots-dir]
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
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');
const { io: ioClient } = require('socket.io-client');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-a11y'));
fs.mkdirSync(OUT, { recursive: true });
import crypto from 'node:crypto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-a11y-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'AxAdmin', RECORDING_MAX_BYTES: '400000', RECORDING_SWEEP_MS: '1500', ONBOARDING_SINCE: '0', RECORDING_IDLE_MS: '6000', RECONNECT_GRACE_MS: '800',
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
const SHOT_DIR = process.env.A11Y_SHOTS || OUT; fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = async (page, name) => { await sleep(450); await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) }); };

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
const AXE = process.env.AXE_PATH || '/workspace/zn-test/axe/node_modules/axe-core/axe.min.js';
const axeSrc = fs.existsSync(AXE) ? fs.readFileSync(AXE, 'utf8') : null;
const findings = {};
async function audit(page, name, include) {
  if (!axeSrc) { ok(false, `axe-core not found at ${AXE}`); return []; }
  await page.evaluate(axeSrc);
  const r = await page.evaluate(async (include) => {
    const res = await window.axe.run(include ? { include: [[include]] } : document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 2).join('')) }));
  }, include || null);
  findings[name] = r;
  ok(r.length === 0, `axe: ${name}`, r.map((v) => `${v.id}(${v.impact}) x${v.nodes}: ${v.sample.join(' | ')}`).join(' ;; ').slice(0, 1500));
  return r;
}
const focusVisible = (page) => page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return 'none'; const s = getComputedStyle(e); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1) || s.boxShadow !== 'none' ? 'ok' : `${e.tagName}.${e.className}:${s.outlineStyle}/${s.outlineWidth}/${s.boxShadow}`; });
try {
  const owner = await nodeUser('AxOwner'); const mem = await nodeUser('AxMember'); const admin = await nodeUser('AxAdmin'); const other = await nodeUser('AxOther');
  sockets.push(owner.s, mem.s, admin.s, other.s);
  const vr = await emit(owner.s, 'room:create', { name: 'ax-room', category: 'talk' });
  const room = vr.roomId;
  for (const u of [owner, other]) await emit(u.s, 'room:join', { roomId: room });
  await emit(owner.s, 'chat:send', { text: 'welcome to the accessibility check https://example.com' });
  await emit(other.s, 'chat:send', { text: 'hi @AxMember 👋' });
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--lang=en-US'] });
  const fresh = async (u) => { try { u.s.disconnect(); } catch { /* */ } u.s = await sock(u.j); sockets.push(u.s); return u.s; };
  for (const width of [1366, 390]) {
    // signed-out landing
    {
      const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
      await page.setViewport(width < 800 ? { width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width, height: 800 });
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await sleep(1500);
      await audit(page, `${width} signed-out landing`);
      await ctx.close();
    }
    // lobby + onboarding dialog
    {
      const u = await nodeUser(`AxNew${width}`); sockets.push(u.s); u.s.disconnect();
      const a = await pageFor(u, width);
      await a.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await a.page.waitForSelector('[data-testid="onboarding"]', { timeout: 15000 }).catch(() => null);
      await sleep(500);
      await audit(a.page, `${width} onboarding dialog`);
      // keyboard: Tab stays inside the dialog
      const inside = [];
      for (let i = 0; i < 6; i++) { await a.page.keyboard.press('Tab'); inside.push(await a.page.evaluate(() => !!document.activeElement?.closest('[data-testid="onboarding"]'))); }
      ok(inside.every(Boolean), `${width}: keyboard: Tab is trapped inside the onboarding dialog`);
      ok(await focusVisible(a.page) === 'ok', `${width}: visible focus in dialogs`, await focusVisible(a.page));
      await shot(a.page, `h8-focus-dialog-${width}`);
      await a.page.keyboard.press('Escape'); await sleep(500);
      await audit(a.page, `${width} lobby`);
      await a.ctx.close();
    }
    // room
    {
      await fresh(mem);
      const a = await pageFor(mem, width);
      await enterRoom(a.page, room);
      await sleep(600);
      await audit(a.page, `${width} room`);
      // polite announcement of a new message from someone else
      await emit(other.s, 'chat:send', { text: 'announce me please' });
      const ann = await a.page.waitForFunction(() => /AxOther: announce me please/.test(document.querySelector('[data-testid="sr-announcer"]')?.textContent || ''), { timeout: 4000 }).catch(() => null);
      ok(!!ann && await a.page.$eval('[data-testid="sr-announcer"]', (e) => e.getAttribute('aria-live') === 'polite' && e.getBoundingClientRect().width <= 1), `${width}: new messages are announced politely (screen-reader only)`);
      // keyboard-only: reach the composer, send a message, open a user menu
      await a.page.evaluate(() => document.activeElement?.blur());
      let reached = false;
      for (let i = 0; i < 80 && !reached; i++) { await a.page.keyboard.press('Tab'); reached = await a.page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Chat message'); }
      ok(reached, `${width}: keyboard: Tab reaches the composer`);
      if (reached) { ok(await focusVisible(a.page) === 'ok', `${width}: visible focus on the composer`, await focusVisible(a.page)); await a.page.keyboard.type('typed by keyboard'); await a.page.keyboard.press('Enter'); }
      const sent = await a.page.waitForFunction(() => [...document.querySelectorAll('.chat-log .msg')].some((e) => /typed by keyboard/.test(e.textContent)), { timeout: 4000 }).catch(() => null);
      ok(!!sent, `${width}: keyboard: send a message without the mouse`);
      // settings / info panel
      if (width < 800) { await a.page.$eval('[data-action="collapse-panel"]', (b) => b.click()).catch(() => {}); await sleep(400); }
      await a.page.$eval('[data-action="tab-info"]', (b) => b.click()).catch(() => {}); await sleep(600);
      await audit(a.page, `${width} room info panel`);
      if (width < 800) { await a.page.keyboard.press('Escape'); await sleep(300); }
      // A/V dialog via keyboard: focus the button and press Enter; Escape closes and returns focus
      const opened = await a.page.evaluate(() => { const b = document.querySelector('[data-action="av-settings"]'); if (!b) return false; b.focus(); return document.activeElement === b; });
      if (opened) { await a.page.keyboard.press('Enter'); }
      const dlg = await a.page.waitForSelector('.av-modal[role="dialog"]', { timeout: 5000 }).catch(() => null);
      ok(!!dlg, `${width}: keyboard: Enter opens Audio & video settings`);
      if (dlg) {
        await sleep(400);
        await audit(a.page, `${width} audio & video dialog`, '.av-modal');
        await a.page.keyboard.press('Escape');
        const back = await a.page.waitForFunction(() => !document.querySelector('.av-modal') && document.activeElement?.getAttribute('data-action') === 'av-settings', { timeout: 3000 }).catch(() => null);
        ok(!!back, `${width}: keyboard: Escape closes the dialog and returns focus`);
      }
      // user menu by keyboard
      if (width < 800) { await a.page.evaluate(() => document.querySelector('[data-action="people"], [data-action="toggle-people"]')?.click()); await sleep(400); }
      const rowFocused = await a.page.evaluate(() => { const r = [...document.querySelectorAll('.users .user-row, .users li button')].find((e) => e.textContent.includes('AxOther')); if (!r) return false; const f = r.matches('button,[tabindex]') ? r : r.querySelector('button,[tabindex]'); f?.focus(); return !!f && document.activeElement === f; });
      ok(rowFocused, `${width}: keyboard: people list rows are focusable`);
      if (rowFocused) {
        await a.page.keyboard.down('Shift'); await a.page.keyboard.press('F10'); await a.page.keyboard.up('Shift'); await sleep(400); // batch X: Enter whispers; Shift+F10 opens the menu
        const menu = await a.page.evaluate(() => { const m = document.querySelector('.users .menu[role="group"]'); return m && m.contains(document.activeElement) ? [...m.querySelectorAll('button')].length : 0; });
        ok(menu > 2, `${width}: keyboard: Shift+F10 opens the user menu with focus on its first item`, String(menu));
        await shot(a.page, `h8-keyboard-user-menu-${width}`);
        await audit(a.page, `${width} user menu`);
        await a.page.keyboard.press('Escape'); await sleep(300);
        ok(await a.page.evaluate(() => !document.querySelector('.users .menu[role="group"]') && document.activeElement?.classList.contains('user-row')), `${width}: keyboard: Escape closes the user menu and returns focus`);
      }
      await a.ctx.close(); await fresh(mem);
    }
    // reduced motion
    {
      const a = await pageFor(mem, width);
      await a.page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await enterRoom(a.page, room);
      const anim = await a.page.evaluate(() => { const probe = document.createElement('div'); probe.style.animation = 'spin 2s linear infinite'; probe.style.transition = 'opacity 1s'; document.body.appendChild(probe); const s = getComputedStyle(probe); const r = [s.animationDuration, s.transitionDuration]; probe.remove(); return r; });
      ok(parseFloat(anim[0]) < 0.05 && parseFloat(anim[1]) < 0.05, `${width}: prefers-reduced-motion turns animations and transitions off`, JSON.stringify(anim));
      await a.ctx.close(); await fresh(mem);
    }
    // admin
    {
      const a = await pageFor(admin, width);
      await a.page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
      await a.page.waitForSelector('.admin-tabs [data-tab="security"]', { timeout: 15000 }).catch(() => null); await sleep(500);
      await audit(a.page, `${width} admin reports`);
      await a.page.evaluate(() => document.querySelector('.admin-tabs [data-tab="security"]')?.click()); await sleep(800);
      await audit(a.page, `${width} admin security`);
      await a.page.evaluate(() => document.querySelector('.admin-tabs [data-tab="log"]')?.click()); await sleep(800);
      await audit(a.page, `${width} admin log`);
      await a.ctx.close();
    }
  }
  void fresh;
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
fs.writeFileSync(path.join(OUT, 'a11y-findings.json'), JSON.stringify(findings, null, 1));
if (failed && process.env.SHOWLOG) console.log(log.slice(-3000));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
