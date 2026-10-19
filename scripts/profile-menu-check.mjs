/**
 * Profile menu + dialogs: screenshots and checks at 1366, 390 and 360 (order, fit, full-screen sheets, Esc/close/Back, focus trap).
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
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-profile-menu'));
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

const shots = [];
const snap = async (page, name) => { const f = path.join(OUT, `${name}.png`); await sleep(400); await page.screenshot({ path: f }); shots.push(f); };
const openMenu = async (page) => {
  if (!(await page.$('.me-pop-panel:not([hidden]) .profile-menu'))) await page.$eval('[data-action="profile"]', (b) => b.click());
  await page.waitForSelector('.me-pop-panel:not([hidden]) .profile-menu [data-action="sign-out"]', { timeout: 8000 });
  await sleep(400);
};
const sheetOpen = (page, name) => page.$(`[data-sheet="${name}"]`).then(Boolean);
const fitsScreen = (page, sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return 'missing'; const r = e.getBoundingClientRect(); const W = innerWidth, H = innerHeight; return r.left >= -1 && r.right <= W + 1 && r.top >= -1 && r.bottom <= H + 1 ? 'ok' : `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right)}x${Math.round(r.bottom)} vs ${W}x${H}`; }, sel);
let seq = 0;
try {
  for (const width of [1366, 390, 360]) {
    const phone = width < 800;
    const page = await user(`Pm${width}u${seq++}`, width);
    const pal = await user(`Pm${width}p${seq++}`, width);
    // pal sends a friend request so the dot/badge shows
    await pal.evaluate(() => 0);
    await openMenu(pal); await pal.$eval('[data-action="open-friends"]', (b) => b.click());
    await pal.waitForSelector('[data-sheet="friends"] input[aria-label="Friend username"]');
    await pal.type('[data-sheet="friends"] input[aria-label="Friend username"]', `Pm${width}u${seq - 2}`);
    await pal.keyboard.press('Enter'); await sleep(900);
    await page.waitForSelector('[data-testid="friend-request-dot"]', { timeout: 5000 }).catch(() => {});
    ok(!!(await page.$('[data-testid="friend-request-dot"]')), `${width}: a friend request shows a dot on the profile chip`);
    // menu
    await openMenu(page);
    const order = await page.evaluate(() => {
      const m = document.querySelector('.me-pop-panel .profile-menu');
      const items = [...m.querySelectorAll('.profile-actions > button, .profile-actions > a, .ui-theme-picker, hr.menu-divider')].map((e) => e.getAttribute('data-action') || (e.matches('hr') ? 'divider' : e.matches('fieldset') ? 'theme' : e.tagName));
      const last = [...m.querySelectorAll('button, a, fieldset, hr')].filter((e) => e.getClientRects().length).pop();
      return { items, last: last?.getAttribute('data-action'), hasBio: !!m.querySelector('textarea, [data-action="bot-name"], .profile-preview') };
    });
    const want = ['open-profile', 'open-mentions', 'open-friends', 'open-start-room', 'open-bots', 'profile-av', 'open-notifications', 'get-app-menu', 'whats-new-menu', 'theme', 'divider', 'sign-out'];
    ok(JSON.stringify(order.items.filter((x) => x !== 'install-app')) === JSON.stringify(want), `${width}: menu order ${order.items.join(' > ')}`);
    ok(order.last === 'sign-out' && !order.hasBio, `${width}: Sign out is last; no profile/bot content left in the menu`);
    ok((await fitsScreen(page, '.me-pop-panel')) === 'ok', `${width}: menu fits the screen (${await fitsScreen(page, '.me-pop-panel')})`);
    ok(await page.$eval('.me-pop-panel .ui-theme-picker', (e) => e.querySelectorAll('[data-ui-theme-opt]').length === 4), `${width}: theme selector unchanged (4 themes)`);
    ok(!!(await page.$('[data-action="open-friends"] [data-friend-requests="1"]')), `${width}: Friends item shows the request count`);
    await snap(page, `${width}-menu`);
    // each dialog
    for (const [act, name] of [['open-profile', 'profile'], ['open-mentions', 'mentions'], ['open-bots', 'bots'], ['open-notifications', 'notifications'], ['open-friends', 'friends'], ['open-start-room', 'create']]) {
      await openMenu(page);
      await page.$eval(`[data-action="${act}"]`, (b) => b.click());
      await page.waitForSelector(`[data-sheet="${name}"]`, { timeout: 8000 });
      await sleep(700);
      ok(!(await page.$('.me-pop-panel:not([hidden]) .profile-menu')), `${width} ${name}: menu closes when the dialog opens`);
      const rect = await page.$eval(`[data-sheet="${name}"]`, (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height, innerWidth, innerHeight].map(Math.round); });
      if (phone) ok(rect[0] === 0 && rect[1] === 0 && rect[2] === rect[4] && rect[3] === rect[5], `${width} ${name}: full-screen sheet (${rect})`);
      else ok((await fitsScreen(page, `[data-sheet="${name}"]`)) === 'ok' && rect[2] < rect[4], `${width} ${name}: centred dialog fits (${rect})`);
      const sideways = await page.evaluate(() => document.scrollingElement.scrollWidth > innerWidth + 1);
      ok(!sideways, `${width} ${name}: no sideways scroll`);
      const inside = await page.evaluate((n) => document.querySelector(`[data-sheet="${n}"]`).contains(document.activeElement), name);
      let trapped = inside;
      for (let i = 0; i < 25 && trapped; i++) { await page.keyboard.press('Tab'); trapped = await page.evaluate((n) => document.querySelector(`[data-sheet="${n}"]`).contains(document.activeElement), name); }
      ok(trapped, `${width} ${name}: focus starts inside and Tab stays inside`);
      if (name === 'friends') {
        ok(!!(await page.$(`[data-sheet="friends"] .friend-list button.primary`)), `${width} friends: incoming request listed with Accept`);
        await page.$eval('[data-sheet="friends"] .friend-list button.primary', (b) => b.click()); await sleep(800);
      }
      if (name === 'bots') {
        await page.type('[data-sheet="bots"] [data-action="bot-name"]', `Bot${width}`);
        await page.$eval('[data-sheet="bots"] [data-action="create-bot"]', (b) => b.click()); await sleep(1000);
        ok(!!(await page.$('[data-sheet="bots"] [data-action="copy-bot-token"]')), `${width} bots: create shows the one-time token`);
      }
      await snap(page, `${width}-dialog-${name}`);
      // close three ways, rotating
      const how = ['esc', 'button', 'back'][(['profile', 'bots', 'notifications', 'friends', 'create'].indexOf(name)) % 3];
      const url0 = page.url();
      if (how === 'esc') await page.keyboard.press('Escape');
      else if (how === 'button') await page.$eval(`[data-sheet="${name}"] [data-action="sheet-close"]`, (b) => b.click());
      else await page.goBack();
      await sleep(600);
      ok(!(await sheetOpen(page, name)) && page.url() === url0 && !!(await page.$('.room-grid, .composer')), `${width} ${name}: closes with ${how}, page stays put`);
    }
    // Back after closing with the button does not leave the app
    // Start a room from the lobby button, and from inside a room
    await page.$eval('[data-action="create-room"]', (b) => b.click());
    await page.waitForSelector('[data-sheet="create"] input[aria-label="Room name"]');
    await page.type('[data-sheet="create"] input[aria-label="Room name"]', `pm-${width}`);
    await page.keyboard.press('Enter');
    const inRoom = await page.waitForSelector('.composer, [data-action="composer-plus"]', { timeout: 15000 }).then(() => true, () => false);
    ok(inRoom, `${width}: Start a room button by the room list creates and joins`);
    await snap(page, `${width}-room-menu-closed`);
    await openMenu(page);
    await snap(page, `${width}-room-menu`);
    await page.$eval('[data-action="open-start-room"]', (b) => b.click());
    ok(await page.waitForSelector('[data-sheet="create"]', { timeout: 10000 }).then(() => true, () => false), `${width}: Start a room from inside a room opens the dialog in the lobby`);
    await page.keyboard.press('Escape'); await sleep(400);
    await page.browserContext().close(); await pal.browserContext().close();
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
