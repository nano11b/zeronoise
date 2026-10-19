/**
 * Phone layout sweep for the newer room features, in real Chrome at phone widths (default 390 and 360).
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
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-phone-sweep'));
const WIDTHS = (process.argv[3] || '390,360').split(',').map(Number);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n) => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };
const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-phone-'));
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '50', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'Ph_Owner390,Ph_Owner360', RECONNECT_GRACE_MS: '1500' } });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 150 && !log.includes('listening'); i++) await sleep(100);
const BASE = `http://127.0.0.1:${port}`;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function user(nick, width) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
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
/** Layout problems: page scrolls sideways, or a visible control pokes past the screen edge outside any scroll box. */
const layout = (page) => page.evaluate(() => {
  const W = innerWidth;
  const issues = [];
  const se = document.scrollingElement;
  if (se.scrollWidth > W + 1) issues.push(`page scrollWidth ${se.scrollWidth} > ${W}`);
  const clipped = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll') return true; if ((ox === 'hidden' || ox === 'clip')) { const r = p.getBoundingClientRect(); if (r.right <= W + 1 && r.left >= -1) return true; } } return false; };
  for (const e of document.querySelectorAll('button, a, input, select, textarea, [role="menuitem"], [role="dialog"], .card, .poll-card, .event-card, .plus-menu, .more-menu, .dropdown')) {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || e.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if ((r.right > W + 1 || r.left < -1) && !clipped(e)) {
      const name = (e.getAttribute('data-action') || e.getAttribute('aria-label') || e.className.toString() || e.tagName).slice(0, 40);
      issues.push(`${name} at ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
  }
  return [...new Set(issues)].slice(0, 8);
});
const click = async (page, sel) => {
  const h = await page.$(sel);
  if (!h) return false;
  await h.evaluate((e) => e.scrollIntoView({ block: 'nearest' }));
  await h.evaluate((e) => e.click());
  await sleep(600);
  return true;
};
const clickText = (page, re) => page.evaluate((src) => { const re = new RegExp(src); const e = [...document.querySelectorAll('button, a, [role="menuitem"], [role="tab"]')].find((x) => (re.test(x.getAttribute('aria-label') || '') || re.test(x.textContent.trim())) && x.getClientRects().length && !x.closest('[inert]')); if (e) { e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true; } return false; }, re.source);
const shots = [];
async function snap(page, width, name, opened = true) {
  const file = path.join(OUT, `${width}-${name}.png`);
  await sleep(400);
  await page.screenshot({ path: file });
  shots.push(file);
  const issues = await layout(page);
  ok(opened && issues.length === 0, `${width}px ${name}${opened ? '' : ' (could not open)'}${issues.length ? ': ' + issues.join('; ') : ''}`);
}
const closeAll = async (page) => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); } };

async function sweep(width) {
  const owner = await user(`Ph_Owner${width}`, width);
  const guest = await user(`Ph_Pal${width}`, width);
  const room = `phone-${width}`;
  await click(owner, '[data-action="create-room"]') || await clickText(owner, /New room|Create room/);
  await owner.waitForSelector('input[name="name"], input[aria-label="Room name"]', { timeout: 8000 }).catch(() => {});
  const nameInput = await owner.$('input[name="name"], input[aria-label="Room name"]');
  if (nameInput) { await nameInput.type(room); await owner.keyboard.press('Enter'); }
  await owner.waitForSelector('.chat-form input, .composer', { timeout: 15000 });
  await sleep(800);
  await guest.goto(`${BASE}/r/${room}`, { waitUntil: 'networkidle0' }).catch(() => {});
  if (!(await guest.$('.chat-form input, .composer'))) { await guest.goto(BASE, { waitUntil: 'networkidle0' }); await click(guest, `.room-card[data-room="${room}"]`); }
  await sleep(1200);
  await snap(owner, width, '01-room');
  await snap(owner, width, '02-more-menu', await click(owner, '[data-action="more"]'));
  await closeAll(owner);
  // poll
  let o = await click(owner, '[data-action="composer-plus"]');
  await snap(owner, width, '03-plus-menu', o);
  o = await click(owner, '[data-action="new-poll"]');
  if (o) {
    const inputs = await owner.$$('input[placeholder="Ask a question"], input[placeholder^="Option"]');
    const vals = ['Which track tonight?', 'Drift park', 'Mountain pass', 'City loop'];
    for (let i = 0; i < inputs.length && i < vals.length; i++) await inputs[i].type(vals[i]);
  }
  await snap(owner, width, '04-poll-draft', o);
  const posted = await clickText(owner, /^(Post poll|Create poll|Start poll|Post)$/);
  await sleep(800); await closeAll(owner);
  await snap(owner, width, '05-poll-in-chat', posted);
  // side panel: events, info (invites), stats
  await closeAll(owner);
  o = await click(owner, '[data-action="collapse-panel"]');
  await snap(owner, width, '06-side-panel', o);
  for (const [i, tab] of [['07', 'events'], ['08', 'info'], ['09', 'search'], ['10', 'stats'], ['11', 'saved']]) {
    if (!(await owner.$(`[data-action="tab-${tab}"]`)) || !(await owner.$eval(`[data-action="tab-${tab}"]`, (e) => !!e.getClientRects().length && !e.closest('[inert]')).catch(() => false))) await click(owner, '[data-action="collapse-panel"]');
    o = await click(owner, `[data-action="tab-${tab}"]`);
    await snap(owner, width, `${i}-tab-${tab}`, o);
    if (tab === 'info' && await click(owner, '[data-action="invite-create"]')) await snap(owner, width, '12-invite-create', true);
  }
  await closeAll(owner);
  await owner.reload({ waitUntil: 'networkidle0' }); await sleep(800);
  if (!(await owner.$('.chat-form input, .composer'))) { await click(owner, `.room-card[data-room="${room}"]`); await owner.waitForSelector('.chat-form input, .composer', { timeout: 15000 }); }
  await sleep(800);
  // stage mode (owner turns it on from the side panel's room settings)
  const stage = async (on) => {
    await click(owner, '[data-action="collapse-panel"]');
    await click(owner, '[data-action="tab-info"]');
    const box = await owner.$('[data-action="stage-toggle"]');
    if (!box) return false;
    const cur = await box.evaluate((e) => e.checked);
    if (cur !== on) { await box.evaluate((e) => e.click()); await sleep(800); }
    await closeAll(owner);
    if (await owner.$('.drawer-backdrop')) await owner.$eval('.drawer-backdrop', (e) => e.click());
    await sleep(500);
    return true;
  };
  o = await stage(true);
  await snap(owner, width, '13-stage-mode-owner', o);
  await snap(guest, width, '14-stage-mode-audience', o);
  if (o) { const h = await click(guest, '[data-action="stage-hand"]'); await sleep(600); await snap(guest, width, '14b-stage-hand-raised', h); await snap(owner, width, '14c-stage-owner-sees-hand', h); }
  await stage(false);
  // games / trivia
  await click(owner, '[data-action="more"]');
  o = await click(owner, '[data-action="games"]');
  await snap(owner, width, '15-games', o);
  if (o) { const t = await clickText(owner, /Trivia/); await sleep(500); await snap(owner, width, '16-trivia', t); const s = await click(owner, '[data-action="trivia-start"]'); await sleep(1500); await snap(owner, width, '17-trivia-question', s); }
  await closeAll(owner);
  // watch together
  await click(owner, '[data-action="more"]');
  o = await click(owner, '[data-action="watch"]');
  await snap(owner, width, '18-watch-together', o);
  await closeAll(owner);
  // whispers (people list -> user menu)
  await click(owner, '[data-action="more"]');
  o = await click(owner, '[data-action="people"]');
  await snap(owner, width, '19-people', o);
  o = await owner.evaluate((nick) => { const e = [...document.querySelectorAll(`.user-row[data-nick="${nick}"]`)].find((x) => x.getClientRects().length); if (e) { e.click(); return true; } return false; }, `Ph_Pal${width}`);
  await sleep(600);
  await snap(owner, width, '20-user-menu', o);
  o = await click(owner, '[data-action="whisper"]');
  await sleep(800);
  await snap(owner, width, '21-whisper', o);
  await snap(guest, width, '21b-whisper-guest', o);
  await closeAll(owner);
  // voice note
  o = await click(owner, '[data-action="voice-note"], [aria-label*="voice note" i], .voice-note-btn');
  await sleep(1200);
  await snap(owner, width, '22-voice-note', o);
  await closeAll(owner);
  // profile dropdown + mod queue
  o = await click(owner, '[data-action="profile"]');
  await snap(owner, width, '23-profile-menu', o);
  await closeAll(owner);
  o = await click(owner, '[data-action="admin"]');
  await snap(owner, width, '24-mod-panel', o);
  if (o) { const r = await clickText(owner, /^Reports/); await snap(owner, width, '25-mod-queue', r || !!(await owner.$('[data-testid="modq-tab-badge"], .modq, [data-modq]'))); }
  // ---- nine features ----
  await closeAll(owner);
  await owner.goto(`${BASE}/r/${room}`, { waitUntil: 'networkidle0' }).catch(() => {}); await sleep(800);
  if (!(await owner.$('.chat-form input, .composer'))) { await click(owner, `.room-card[data-room="${room}"]`); await owner.waitForSelector('.chat-form input, .composer', { timeout: 15000 }); }
  await sleep(600);
  const sendAs = async (page, text) => { const i = await page.$('.chat-main .chat-form input, .chat-form input'); if (!i) return false; await i.click(); await i.type(text); await page.keyboard.press('Enter'); await sleep(900); return true; };
  await sendAs(guest, 'kart night is friday');
  await sleep(1200);
  await sendAs(guest, 'who is bringing snacks');
  await sleep(800);
  // threads: open from a message, reply, count shows, panel fits the phone
  o = await owner.evaluate(() => { const m = [...document.querySelectorAll('.msg')].find((x) => /kart night/.test(x.textContent || '')); const b = m?.querySelector('[data-action="reply-thread"]'); if (b) { b.click(); return true; } return false; });
  await sleep(700);
  if (o) { const ti = await owner.$('.thread-panel .chat-form input'); if (ti) { await ti.type('count me in'); await owner.keyboard.press('Enter'); await sleep(900); } }
  await snap(owner, width, '26-thread-panel', o && !!(await owner.$('.thread-panel')));
  o = await click(owner, '[data-action="close-thread"]');
  await sleep(500);
  const cnt = await guest.evaluate(() => [...document.querySelectorAll('[data-action="open-thread"]')].map((b) => b.textContent).join('|'));
  ok(/1 reply/.test(cnt), `${width}px thread reply count shows for others (${cnt || 'none'})`);
  await snap(guest, width, '27-thread-reply-count', /1 reply/.test(cnt));
  o = await click(guest, '[data-action="open-thread"]');
  await snap(guest, width, '27b-thread-guest-open', o && !!(await guest.$('.thread-panel')));
  await click(guest, '[data-action="close-thread"]');
  // search with filters
  await click(owner, '[data-action="collapse-panel"]');
  o = await click(owner, '[data-action="tab-search"]');
  if (o) {
    const q = await owner.$('[data-field="search"]');
    if (q) await q.type('kart');
    const f = await owner.$('[data-field="search-from"]'); if (f) await f.type(`Ph_Pal${width}`);
    await click(owner, '[data-action="search-go"]'); await sleep(800);
  }
  const hits = await owner.evaluate(() => document.querySelectorAll('.side-body .search-hit, .side-body [data-hit]').length);
  await snap(owner, width, '28-search-filters', o);
  o = await click(owner, '[data-action="search-scope-whispers"]');
  await snap(owner, width, '29-search-whispers', o);
  await closeAll(owner);
  if (await owner.$('.drawer-backdrop')) await owner.$eval('.drawer-backdrop', (e) => e.click());
  // notifications
  await click(owner, '[data-action="more"]');
  o = await click(owner, '[data-action="notify"]');
  if (o) { await click(owner, '[data-notify-level="all"]'); await click(owner, '[data-action="quiet-toggle"]'); }
  await snap(owner, width, '30-notifications', o && !!(await owner.$('[data-notify-level]')));
  if (o) { await click(owner, '[data-action="notify-save"]'); await sleep(600); }
  await closeAll(owner);
  // room theme (owner settings in Room info)
  await click(owner, '[data-action="collapse-panel"]');
  await click(owner, '[data-action="tab-info"]');
  o = !!(await owner.$('[data-action="theme-save"]'));
  if (o) {
    await owner.$eval('[data-action="theme-save"]', (e) => e.scrollIntoView({ block: 'center' }));
    const t = await owner.$('[data-action="accent-toggle"]'); if (t && !(await t.evaluate((e) => e.checked))) await t.evaluate((e) => e.click());
    await sleep(200);
    const ta = await owner.$('[data-field="welcome"]'); if (ta) { await ta.click({ clickCount: 3 }); await ta.type('Welcome to kart night! Read the pins before you race.'); }
  }
  await snap(owner, width, '31-theme-settings', o);
  if (o) { await click(owner, '[data-action="theme-save"]'); await sleep(900); }
  await closeAll(owner);
  if (await owner.$('.drawer-backdrop')) await owner.$eval('.drawer-backdrop', (e) => e.click());
  await sleep(500);
  const welcome = await guest.waitForSelector('[data-room-welcome]', { timeout: 4000 }).then(() => true, () => false);
  ok(welcome, `${width}px pinned welcome reaches the room live`);
  await snap(guest, width, '32-theme-welcome-guest', welcome);
  const accent = await guest.evaluate(() => !!document.querySelector('[data-accent]'));
  ok(accent, `${width}px room accent applied`);
  // stale tile: guest goes on cam, then drops; owner's strip collapses right away
  o = await click(guest, '[data-action="cam"]');
  await sleep(2500);
  const tilesOn = await owner.evaluate(() => document.querySelectorAll('.video-tile, .tile').length);
  await snap(owner, width, '33-cam-tile-live', o && tilesOn > 0);
  await guest.browserContext().close();
  await sleep(900);
  const tilesOff = await owner.evaluate(() => document.querySelectorAll('.video-tile, .tile').length);
  ok(tilesOff < tilesOn, `${width}px a dropped camera tile goes at once (${tilesOn} -> ${tilesOff}, within the 1.5s grace)`);
  await snap(owner, width, '34-cam-tile-gone', tilesOff < tilesOn);
  // mod queue with bot actions
  o = await click(owner, '[data-action="admin"]');
  if (o) await clickText(owner, /^Reports/);
  await sleep(600);
  await snap(owner, width, '35-modq-bot-actions', o && !!(await owner.$('[data-panel="bot-actions"]')));
  await closeAll(owner);
  // public status page
  await owner.goto(`${BASE}/status`, { waitUntil: 'networkidle0' });
  await snap(owner, width, '36-status-page', /Uptime/.test(await owner.content()));
  await owner.browserContext().close();
}
try {
  for (const w of WIDTHS) { await sweep(w); await sleep(2000); }
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
