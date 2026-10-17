// Installable-app (PWA) check in a real browser. Not part of test:api (needs Chrome).
//
//   npm run build && node scripts/pwa-check.mjs [--root <dir>] [--shots <dir>]
//
// Starts the built server on a temp data dir, registers an account, then checks:
//   - Chrome reports the app installable (manifest + service worker with a fetch handler; no installability errors)
//   - the service worker controls the page, and /sw.js is still the push worker's registration
//   - caches hold only hashed assets / icons / the offline page (never the HTML shell, /api or socket.io)
//   - the profile menu offers "Install app" (prompt) or the iOS Share hint, dismissible, hidden when standalone
//   - a notification link (/?room=<id>) opens that room and is stripped from the address bar
//   - an offline navigation shows the offline fallback page
// --shots <dir> writes pwa-menu-desktop.png, pwa-menu-phone.png, pwa-menu-ios.png, pwa-offline-phone.png there.
import './lib/reap.mjs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = path.resolve(opt('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SHOTS = opt('--shots');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-pwacheck-'));
const server = spawn(process.execPath, ['dist/server/server/index.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), CONTACT_EMAIL: '', BACKUP_DISABLED: '1' },
});
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 150 && !log.includes('listening'); i++) await sleep(100);
const URL = `http://127.0.0.1:${port}`;

let passed = 0;
const failures = [];
const ok = (cond, name) => { if (cond) { passed++; console.log(`PASS  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name}`); } };

async function register(page, nick) {
  await page.goto(URL, { waitUntil: 'networkidle0' });
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
  await page.waitForSelector('.room-card[data-room="lobby"]', { timeout: 15000 });
}
async function toLobby(page) {
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.room-card[data-room="lobby"]', { timeout: 15000 });
  await page.evaluate(() => { document.querySelectorAll('[data-testid="email-nag"] .link-btn').forEach((b) => { if (/Dismiss/.test(b.textContent || '')) b.click(); }); });
  await sleep(300);
}
// Headless Chrome does not show its install UI, so stand in for the browser's beforeinstallprompt.
const fakePrompt = (page) => page.evaluate(() => {
  window.__prompted = 0;
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = async () => { window.__prompted++; };
  e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
  window.dispatchEvent(e);
});
const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, name: el.getAttribute('aria-label') || el.textContent?.trim() || '' }; }).catch(() => null);
const openProfile = async (page) => { await page.click('[data-action="profile"]'); await sleep(400); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  // Default (non-incognito) context of a throwaway profile: Chrome never calls incognito pages installable.
  const ctx = browser.defaultBrowserContext();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
  await page.setViewport({ width: 1280, height: 800 });
  await register(page, 'Pwa_User');

  // ---- service worker + installability ----
  const reg = await page.evaluate(async () => {
    const r = await Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(() => res(null), 10000))]);
    return r ? { scope: r.scope, script: r.active?.scriptURL || '' } : null;
  });
  ok(!!reg && reg.scope === `${URL}/` && reg.script === `${URL}/sw.js`, 'service worker /sw.js registers on load with scope /');
  await toLobby(page);
  ok(await page.evaluate(() => !!navigator.serviceWorker.controller && new URL(navigator.serviceWorker.controller.scriptURL).pathname === '/sw.js'), 'after a reload the page is controlled by /sw.js (fetch handler active)');
  const cdp = await page.createCDPSession();
  const man = await cdp.send('Page.getAppManifest');
  ok(man.url === `${URL}/manifest.webmanifest` && (man.errors || []).length === 0, `manifest is linked and parses without errors${man.errors?.length ? `: ${JSON.stringify(man.errors)}` : ''}`);
  const inst = await cdp.send('Page.getInstallabilityErrors');
  ok((inst.installabilityErrors || []).length === 0, `Chrome reports the app installable${inst.installabilityErrors?.length ? `: ${JSON.stringify(inst.installabilityErrors)}` : ''}`);
  const push = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!r) return null;
    let perm = '';
    try { perm = await r.pushManager.permissionState({ userVisibleOnly: true, applicationServerKey: new Uint8Array(65).fill(4) }); } catch (e) { perm = `err:${e.name}`; }
    return { script: r.active?.scriptURL || '', hasPush: !!r.pushManager, perm, regs: (await navigator.serviceWorker.getRegistrations()).length };
  });
  ok(!!push && push.script.endsWith('/sw.js') && push.hasPush && push.regs === 1, `push worker still registers: getRegistration('/sw.js') has a pushManager, one registration total (${JSON.stringify(push)})`);
  const swSrc = await page.evaluate(async () => (await fetch('/sw.js')).text());
  ok(swSrc.includes("addEventListener('push'") && swSrc.includes("addEventListener('fetch'") && swSrc.includes("addEventListener('notificationclick'"), 'served worker has push, fetch and notificationclick handlers');
  const cached = await page.evaluate(async () => {
    const out = {};
    for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
  const build = await page.evaluate(async () => (await (await fetch('/api/build')).json()).build);
  const names = Object.keys(cached);
  const paths = Object.values(cached).flat();
  ok(names.length > 0 && names.every((n) => n.endsWith(`-${build}`)), `cache names carry the build id (${names.join(', ')})`);
  ok(paths.some((p) => p.startsWith('/assets/')) && paths.includes('/offline.html'), 'hashed assets and the offline page are cached');
  ok(!paths.some((p) => p === '/' || p === '/index.html' || p.startsWith('/api/') || p.startsWith('/socket.io') || p === '/lobby'), 'HTML shell, /api and socket.io are never cached');

  // ---- install item in the profile menu ----
  await fakePrompt(page);
  await openProfile(page);
  const item = await box(page, '[data-action="install-app"]');
  const dismiss = await box(page, '[data-action="install-dismiss"]');
  ok(!!item && item.name === 'Install app' && item.h >= 32, 'desktop profile menu shows "Install app"');
  ok(!!dismiss && dismiss.w >= 40 && dismiss.h >= 40 && /Hide/.test(dismiss.name), 'install item has a named 40px dismiss button');
  ok(!(await page.$('.install-banner, [data-testid="install-banner"]')), 'no install banner, only the menu item');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pwa-menu-desktop.png') });
  await page.click('[data-action="install-app"]');
  await sleep(300);
  ok(await page.evaluate(() => window.__prompted === 1), 'clicking "Install app" opens the browser install prompt');
  ok(!(await page.$('[data-action="install-app"]')), 'accepted install hides the item');
  await toLobby(page);
  await fakePrompt(page);
  await openProfile(page);
  await page.click('[data-action="install-dismiss"]');
  await sleep(200);
  ok(!(await page.$('[data-testid="install-item"]')) && await page.evaluate(() => localStorage.getItem('camchat.installDismissed') === '1'), 'dismiss hides the item and remembers it');
  await page.evaluate(() => localStorage.removeItem('camchat.installDismissed'));

  // ---- phone ----
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await toLobby(page);
  await fakePrompt(page);
  await openProfile(page);
  const pItem = await box(page, '[data-action="install-app"]');
  const pDismiss = await box(page, '[data-action="install-dismiss"]');
  ok(!!pItem && pItem.h >= 40 && !!pDismiss && pDismiss.w >= 44 && pDismiss.h >= 44, 'phone: install item and dismiss are full-size tap targets');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone: no sideways scroll with the item shown');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pwa-menu-phone.png') });

  // iOS Safari: hint instead of a button
  // (Safari never fires beforeinstallprompt; headless Chrome does here, so swallow it for this page.)
  const ios = await browser.newPage();
  await ios.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ios.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  await ios.evaluateOnNewDocument(() => { window.addEventListener('beforeinstallprompt', (e) => { e.stopImmediatePropagation(); }, true); });
  await toLobby(ios);
  await openProfile(ios);
  const hint = await ios.$eval('[data-action="install-ios-hint"]', (el) => el.textContent?.replace(/\s+/g, ' ').trim()).catch(() => '');
  ok(/Share → Add to Home Screen/.test(hint) && !(await ios.$('[data-action="install-app"]')), `iOS Safari shows the Share → Add to Home Screen hint (${hint})`);
  if (SHOTS) await ios.screenshot({ path: path.join(SHOTS, 'pwa-menu-ios.png') });
  await ios.close();

  // standalone: no item at all (iOS home-screen app sets navigator.standalone; others match display-mode)
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await p2.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  await p2.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }); });
  await toLobby(p2);
  await fakePrompt(p2);
  await openProfile(p2);
  ok(!!(await p2.$('[data-action="profile-av"], [data-action="get-app-menu"]')) && !(await p2.$('[data-testid="install-item"]')), 'running standalone (navigator.standalone) hides the install item and the iOS hint');
  const cdp2 = await p2.createCDPSession();
  const dm = await cdp2.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] }).then(() => true, () => false);
  if (dm) {
    await p2.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => undefined, configurable: true }); });
    await toLobby(p2);
    await fakePrompt(p2);
    await openProfile(p2);
    const matches = await p2.evaluate(() => matchMedia('(display-mode: standalone)').matches);
    if (matches) ok(!(await p2.$('[data-testid="install-item"]')), 'running standalone (display-mode: standalone) hides the install item');
    else console.log('note  this Chrome cannot emulate display-mode; covered by navigator.standalone above');
  }
  const over = await p2.evaluate(() => getComputedStyle(document.body).overscrollBehaviorY);
  ok(over === 'none', 'overscroll-behavior: none (no pull-to-refresh reloads)');
  await p2.close();

  // ---- notification deep link ----
  await page.goto(`${URL}/?room=lobby`, { waitUntil: 'networkidle0' });
  const joined = await page.waitForSelector('.composer, [data-action="composer-plus"]', { timeout: 15000 }).then(() => true, () => false);
  ok(joined && !(await page.evaluate(() => location.search.includes('room='))), 'a notification link /?room=lobby opens that room and is stripped from the URL');

  // ---- offline navigation ----
  await page.setOfflineMode(true);
  for (const t of await browser.targets()) {
    if (t.type() === 'service_worker' && t.url().startsWith(URL)) {
      const s = await t.createCDPSession();
      await s.send('Network.enable').catch(() => {});
      await s.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    }
  }
  let offlineText = '';
  try {
    await page.goto(`${URL}/lobby`, { waitUntil: 'load', timeout: 15000 });
    offlineText = await page.evaluate(() => document.body.innerText);
  } catch (e) { offlineText = `goto failed: ${e.message}`; }
  ok(offlineText.includes("You're offline — zeronoise will reconnect when you're back"), `offline navigation shows the fallback page (${offlineText.slice(0, 80).replace(/\s+/g, ' ')})`);
  ok(await page.evaluate(() => !!document.querySelector('#retry')).catch(() => false), 'offline page offers a retry button');
  if (SHOTS) { await sleep(300); await page.screenshot({ path: path.join(SHOTS, 'pwa-offline-phone.png') }); }
  await page.setOfflineMode(false);
  void ctx;
} catch (e) {
  failures.push(`crashed: ${e.stack || e.message}`);
  console.log(`FAIL  crashed: ${e.stack || e.message}`);
} finally {
  await browser.close().catch(() => {});
  server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
