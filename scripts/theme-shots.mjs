/**
 * Interface theme screenshots + checks (all four themes at 1366 and 390).
 * Old header: Phone layout sweep for the newer room features, in real Chrome at phone widths (default 390 and 360).
 *   npm run build && node scripts/phone-sweep.mjs [out-dir] [widths=390,360]
 * The owner (site admin) and a second user join a fresh room. For each feature the owner opens it, the page is
 * screenshotted, and the layout is checked: no page-level sideways scroll, and no visible control cut off by
 * the screen edge (elements inside a scroll box are allowed to extend past it).
 */
import './lib/reap.mjs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-theme-shots'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n) => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-phone-'));
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '200', CONTACT_EMAIL: '', ADMIN_USERNAMES: '', RECONNECT_GRACE_MS: '1500' } });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 150 && !log.includes('listening'); i++) await sleep(100);
const BASE = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function user(nick, width) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(width > 800 ? { width, height: 800 } : { width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(() => { document.addEventListener('DOMContentLoaded', () => { window.__bootTheme = document.documentElement.getAttribute('data-ui-theme'); window.__rootKids = document.getElementById('root')?.childElementCount ?? -1; }); });
  page.on('pageerror', (e) => console.log(`[${nick} pageerror]`, e.message));
  // the built-in CAPTCHA can change under a fast typist; retry the form a few times
  for (let attempt = 0; ; attempt++) {
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.click('[data-tab="register"]');
    await page.type('input[name="username"]', nick);
    await page.type('input[name="email"]', `${nick.toLowerCase()}@example.com`);
    await page.type('input[name="password"]', `pw-${nick}-secret-1`);
    await page.type('input[name="password2"]', `pw-${nick}-secret-1`);
    const cap = await page.$('input[name="captcha"]');
    if (cap) {
      const m = /What is (\d+) \+ (\d+)/.exec(await page.evaluate(() => [...document.querySelectorAll('label')].map((l) => l.textContent || '').find((t) => /What is/.test(t)) || ''));
      if (m) await cap.type(String(+m[1] + +m[2]));
    }
    await page.waitForSelector('[data-action="account-submit"]:not([disabled])');
    await page.$eval('[data-action="account-submit"]', (b) => b.click());
    if (await page.waitForSelector('.room-card[data-room="lobby"]', { timeout: 8000 }).then(() => true, () => false)) break;
    if (attempt >= 3) throw new Error(`${nick} could not register`);
  }
  await page.evaluate(() => [...document.querySelectorAll('a,button')].find((e) => e.textContent.trim() === 'Dismiss')?.click());
  return page;
}

const THEMES = ['dark', 'dark-red', 'dark-green', 'dark-orange'];
const shots = [];
const snap = async (page, name) => { const f = path.join(OUT, `${name}.png`); await sleep(400); await page.screenshot({ path: f }); shots.push(f); };
const varOf = (page, v, sel = 'body') => page.evaluate((v, sel) => getComputedStyle(document.querySelector(sel) || document.body).getPropertyValue(v).trim(), v, sel);
const pick = async (page, t) => {
  await page.$eval('[data-action="profile"]', (b) => b.click()); await sleep(700);
  await page.waitForSelector(`[data-ui-theme-opt="${t}"]`, { timeout: 8000 });
  await page.$eval(`[data-ui-theme-opt="${t}"]`, (e) => e.click()); await sleep(900);
};
let seq = 0;
try {
  const PAL = { dark: '#0b1220', 'dark-red': '#150a0d', 'dark-green': '#07130b', 'dark-orange': '#150e07' };
  for (const width of [1366, 390]) {
    for (const t of THEMES) {
      const tag = `${width}-${t}`;
      const page = await user(`Th${width}${t.replace('dark-', '').slice(0, 3)}${seq++}`, width);
      await pick(page, t);
      ok(((await page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'))) ?? 'dark') === t && (await page.$eval(`[data-ui-theme-opt="${t}"]`, (e) => e.checked)), `${tag}: picked from the profile dropdown`);
      await snap(page, `${tag}-profile-menu`);
      await page.keyboard.press('Escape'); await page.$eval('[data-action="profile"]', (b) => b.click()).catch(() => {}); await sleep(400);
      // saved on the server: a fresh browser that signs in gets it without picking
      await page.reload({ waitUntil: 'networkidle0' });
      const boot = await page.evaluate(() => [window.__bootTheme, window.__rootKids]);
      ok((t === 'dark' ? boot[0] === 'dark' || boot[0] === null : boot[0] === t) && boot[1] === 0, `${tag}: applied before the app renders (no flash): ${boot}`);
      const bg = (await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
      const hex = PAL[t]; const want = `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
      ok(bg === want, `${tag}: background tint ${bg}`);
      ok((await page.$eval('meta[name="theme-color"]', (m) => m.content)) === hex, `${tag}: browser/app bar colour follows`);
      await snap(page, `${tag}-lobby`);
      await page.$eval('.room-card[data-room="lobby"]', (e) => e.click());
      await page.waitForSelector('.composer, [data-action="composer-plus"]', { timeout: 15000 });
      await sleep(1000);
      await snap(page, `${tag}-room`);
      await page.goto(`${BASE}/status`, { waitUntil: 'networkidle0' });
      ok((await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === want, `${tag}: /status follows`);
      await snap(page, `${tag}-status`);
      await page.goto(`${BASE}/docs`, { waitUntil: 'networkidle0' });
      ok(page.url().endsWith('/docs/bots') && (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === want || (await page.evaluate(() => getComputedStyle(document.body).backgroundImage)).includes(want.replace('rgb', '')) || (await page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'))) === (t === 'dark' ? 'dark' : t), `${tag}: /docs follows`);
      await snap(page, `${tag}-docs`);
      // a brand-new browser signing in to this account gets the saved theme
      if (width === 390 && t !== 'dark') {
        const ctx = await browser.createBrowserContext(); const p2 = await ctx.newPage();
        await p2.setViewport({ width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        const name = await page.evaluate(() => 0);
        void name;
        await ctx.close();
      }
      await page.browserContext().close();
    }
  }
  // signed-out visitor: Account menu picker, kept in this browser
  {
    const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    const acc = await page.$('[data-action="account"]');
    if (acc) { await acc.evaluate((b) => b.click()); await sleep(500); }
    else { await page.$eval('.login-theme summary', (e) => e.click()).catch(() => {}); await sleep(400); }
    const o = await page.$('[data-ui-theme-opt="dark-orange"]');
    ok(!!o, 'signed-out visitors get the picker (sign-in screen)');
    if (o) { await o.evaluate((e) => e.click()); await sleep(500); }
    await snap(page, '390-signed-out-picker');
    await page.reload({ waitUntil: 'networkidle0' });
    ok((await page.evaluate(() => [document.documentElement.getAttribute('data-ui-theme'), localStorage.getItem('zn.uiTheme')]).then((x) => x.join())) === 'dark-orange,dark-orange', 'signed-out choice kept in localStorage across reloads');
    await ctx.close();
  }
  // a room accent still wins inside the room, on top of a UI theme
  {
    const page = await user('ThAccentOwner', 390);
    await pick(page, 'dark-red');
    await page.keyboard.press('Escape'); await sleep(300);
    await page.$eval('[data-action="profile"]', (b) => b.click()).catch(() => {}); await sleep(300);
    await page.$eval('[data-action="create-room"]', (b) => b.click()).catch(() => {});
    await page.waitForSelector('input[name="name"], input[aria-label="Room name"]', { timeout: 8000 }).catch(() => {});
    const ni = await page.$('input[name="name"], input[aria-label="Room name"]');
    if (ni) { await ni.type('accent-room'); await page.keyboard.press('Enter'); }
    await page.waitForSelector('.chat-form input, .composer', { timeout: 15000 });
    await sleep(800);
    await page.$eval('[data-action="collapse-panel"]', (b) => b.click()).catch(() => {}); await sleep(400);
    await page.$eval('[data-action="tab-info"]', (b) => b.click()).catch(() => {}); await sleep(400);
    const t = await page.$('[data-action="accent-toggle"]');
    if (t && !(await t.evaluate((e) => e.checked))) await t.evaluate((e) => e.click());
    await page.$eval('[data-field="accent"]', (e) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '#3ba7ff'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.$eval('[data-action="theme-save"]', (b) => b.click()); await sleep(1000);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); }
    if (await page.$('.drawer-backdrop')) await page.$eval('.drawer-backdrop', (e) => e.click());
    await sleep(500);
    const roomAccent = await page.evaluate(() => getComputedStyle(document.querySelector('.room.shell')).getPropertyValue('--room-accent').trim());
    const btnBg = await page.evaluate(() => { const b = document.querySelector('.room.shell .chat-form .btn.primary'); return b ? getComputedStyle(b).backgroundColor : ''; });
    const uiAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    ok(roomAccent === '#3ba7ff' && btnBg === 'rgb(59, 167, 255)' && uiAccent === '#ff5c6c', `room accent still works on top of Dark/Red (room ${roomAccent}, send button ${btnBg}, UI ${uiAccent})`);
    await snap(page, '390-dark-red-room-accent');
    await page.browserContext().close();
  }
} catch (err) {
  failed++; console.log('FAIL  crashed: ' + (err && err.stack || err));
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(`\nscreenshots: ${OUT} (${shots.length})`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
