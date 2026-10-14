// Layout + accessibility check in a real browser. Not part of test:api (it needs Chrome and takes ~1-2 min).
//
//   npm run build && node scripts/ui-check.mjs [--shots <prefix>] [--root <dir>]
//
// Starts the built server on a temp data dir, registers an admin, then at 1280x800, 390x844 and 360x740:
// the login page, the lobby (+ profile menu, A/V settings) and the room with each side tab, menu, picker,
// modal and panel opened in turn. Fails when
//   - the page scrolls sideways, or a visible element sticks partly out of the viewport,
//   - a visible button/tab/link has no accessible name, or an icon-only button relies on title alone,
//   - a visible form field has no label (aria-label, <label>, or aria-labelledby),
//   - Escape does not close an opened menu/modal/panel, or focus does not return to its trigger.
// --shots <prefix> also writes <prefix>-{lobby,room}-{desktop,phone,small}.png, plus the moderation queue shots
// <prefix>-report-dialog-{desktop,phone}.png, <prefix>-queue-{desktop,phone}.png and <prefix>-room-reports-desktop.png.
// Two extra accounts report the friend's message through the report dialog first, so the queue has something in it.
// Smarter lobby: the empty lobby (no friends / recent / active rows, no skeletons) is checked at every size first, then
// two friends come online (one in a public room, one making the lobby room 🔥 active) and the admin gets recent rooms;
// the friends / active / jump-back-in rows, the friend ⋯ menu and the "Active first" chip are audited at every size.
// Room icons add-on: icons are set on three rooms; the room rail (drawer on phones), header icon and the Info-tab
// "Room icon" controls are audited at every size. --lobby-shots <dir> also writes <dir>/roomicons-rail-{desktop,phone}.png
// and <dir>/roomicons-upload-desktop.png.
// Invite links: the room Info-tab invite list + create dialog are audited at every size (one link is created through
// the dialog), and the /i/<code> landing page (valid and expired) is checked signed out at every size.
// --invite-shots <dir> writes <dir>/invites-dialog-{desktop,phone}.png, <dir>/invites-expired-phone.png and an example
// generated share card <dir>/invites-card-example.png.
// Video quality: the A/V settings dialog has the camera-quality select (5 presets, Auto default) and the
// screen-share priority choice; a remote cam tile has a "⋯" menu with "Lower quality for me" / "Pause video"
// (checked at every size, audited for overflow / tap targets / Escape + focus). On desktop the own-tile Auto
// indicator is shown through the `<app>.vqDebug` sample override with the fake camera.
// --vq-shots <dir> writes <dir>/vq-settings-{desktop,phone}.png, vq-tile-menu-desktop.png, vq-indicator-desktop.png.
// --lobby-shots <dir> writes <dir>/lobby2-{desktop,phone}.png (rows populated) and <dir>/lobby2-empty-phone.png.
// Batch 4a: A/V settings Background (Off / Blur light / Blur strong / Image + bundled pictures + upload) and the
// noise-suppression toggles; the collapsible pin bar with unpin; the thread view with the quoted parent and
// "Jump to message"; the staff edit-history dialog; stage mode (Info-tab toggle + cap + mesh cost note, Speakers /
// Audience sections, the raised-hand queue, and an audience member's locked cam/mic with "Raise hand"), all at
// every size. --b4a-shots <dir> writes <dir>/b4a-bg-settings-desktop.png, b4a-stage-{desktop,phone}.png,
// b4a-thread-{desktop,phone}.png and b4a-pins-desktop.png.
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
const ONLY_SHOTS = args.includes('--shots-only');
const LOBBY_SHOTS = opt('--lobby-shots');
const INVITE_SHOTS = opt('--invite-shots');
const VQ_SHOTS = opt('--vq-shots');
const B4A_SHOTS = opt('--b4a-shots');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const { io: ioClient } = require('socket.io-client');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-uicheck-'));
const server = spawn(process.execPath, ['dist/server/server/index.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'),
    ADMIN_USERNAMES: 'Ui_Admin', CONTACT_EMAIL: '', BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '50', ACTIVITY_TICK_MS: '1000' },
});
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 150 && !log.includes('listening'); i++) await sleep(100);
const URL = `http://127.0.0.1:${port}`;

const failures = [];
const notes = [];
let checks = 0;
const fail = (where, what) => failures.push(`${where}: ${what}`);

// ---------- in-page audit ----------
function audit() {
  const W = document.documentElement.clientWidth;
  const H = innerHeight;
  const out = { overflow: [], names: [], labels: [], doc: 0, W };
  const shown = (el) => {
    if (el.closest('[aria-hidden="true"],[hidden],[inert]')) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  const desc = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const da = el.getAttribute('data-action') ? `[data-action=${el.getAttribute('data-action')}]` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}${da}`;
  };
  out.doc = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  // Partly outside the viewport and not clipped by an ancestor that is itself inside it.
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right <= W + 1 && r.left >= -1) continue;
    if (r.right <= 0 || r.left >= W) continue; // fully off-screen on purpose (closed drawers, sr-only)
    if (r.bottom <= 0 || r.top >= H * 3) continue;
    let clipped = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(hidden|auto|scroll|clip)/.test(cs.overflowX) || cs.contain.includes('paint')) {
        const pr = p.getBoundingClientRect();
        if (pr.right <= W + 1 && pr.left >= -1) { clipped = true; break; }
      }
    }
    if (clipped || !shown(el)) continue;
    out.overflow.push(`${desc(el)} x ${Math.round(r.left)}..${Math.round(r.right)} of ${W}`);
    if (out.overflow.length > 8) break;
  }
  const nameOf = (el) => {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return { name: al.trim(), via: 'aria-label' };
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim(); if (t) return { name: t, via: 'labelledby' }; }
    const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const alt = [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ').trim();
    if (txt || alt) return { name: txt || alt, via: 'content' };
    if (el.title && el.title.trim()) return { name: el.title.trim(), via: 'title' };
    return { name: '', via: '' };
  };
  for (const el of document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], a[href], input[type="button"], input[type="submit"]')) {
    if (!shown(el)) continue;
    if (el.tagName === 'INPUT') { if (!(el.value || el.getAttribute('aria-label'))) out.names.push(desc(el)); continue; }
    const n = nameOf(el);
    if (!n.name) out.names.push(`${desc(el)} has no accessible name`);
    else if (n.via === 'title') out.names.push(`${desc(el)} icon-only, title "${n.name}" but no aria-label`);
  }
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || !shown(el)) continue;
    const ok = (el.getAttribute('aria-label') || '').trim() || el.getAttribute('aria-labelledby') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
    if (!ok) out.labels.push(`${desc(el)}${el.placeholder ? ` (placeholder "${el.placeholder}")` : ''}${el.name ? ` name=${el.name}` : ''}`);
  }
  // Tap targets on touch screens: at least 40x40 CSS px (the hit box, so padding/::before extensions count via the element box).
  out.taps = [];
  if (matchMedia('(pointer: coarse)').matches) {
    for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="tab"], select, input[type="checkbox"], input[type="radio"], summary')) {
      if (!shown(el) || el.closest('.room-card-skeleton')) continue;
      if (el.tagName === 'A' && el.closest('p, li, .md, .msg-text')) continue; // inline text links are exempt
      const r = el.getBoundingClientRect();
      if (r.width >= 39.5 && r.height >= 39.5) continue;
      // Hit-test: the real tappable area includes ::before/::after extensions. Probe 19.5px out from the centre.
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hits = (x, y) => { if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true; const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h) || (h.tagName === 'LABEL' && h.contains(el))); };
      if (!hits(cx, cy)) continue; // covered by something else right now: not tappable in this state
      // 19px out (a 38px box) leaves room for sub-pixel layout; a miss only counts when another control takes the tap.
      // Documented exception: reaction pills keep their width so a message's 8 pills stay on one line;
      // their hit area must still be 40px tall and at least 34px wide (emoji widths vary).
      const hx = el.matches('.react') ? 17 : 19;
      const probes = [[cx - hx, cy], [cx + hx, cy], [cx, cy - 19], [cx, cy + 19]];
      const control = 'button, a[href], [role="button"], [role="tab"], input, select, textarea, summary, label';
      let scroller = el.parentElement;
      while (scroller && scroller !== document.body && !/(auto|scroll|hidden)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const sr = scroller && scroller !== document.body ? scroller.getBoundingClientRect() : null;
      const miss = probes.find(([x, y]) => {
        if (hits(x, y)) return false;
        if (sr && (x < sr.left || x > sr.right || y < sr.top || y > sr.bottom)) return false; // scrolled to the edge of its list

        const h = document.elementFromPoint(x, y);
        return !!h && !!h.closest(control); // a plain surface there (panel, backdrop, header) is not a competing target
      });
      if (!miss) {
        // still too small if nothing extends it at all: its own box must reach the probes
        const own = probes.every(([x, y]) => hits(x, y) || (x >= r.left - 0.5 && x <= r.right + 0.5 && y >= r.top - 0.5 && y <= r.bottom + 0.5));
        const anyExt = probes.some(([x, y]) => hits(x, y) && !(x >= r.left && x <= r.right && y >= r.top && y <= r.bottom));
        if (own || anyExt) continue;
      }
      const blocker = miss ? document.elementFromPoint(miss[0], miss[1]) : null;
      // a larger clickable wrapper (label around a checkbox) counts
      const wrap = el.closest('label');
      if (wrap) { const w = wrap.getBoundingClientRect(); if (w.width >= 39.5 && w.height >= 39.5) continue; }
      out.taps.push(`${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}${blocker ? ` (probe lands on ${desc(blocker)})` : ''}`);
    }
  }
  // WCAG AA text contrast (4.5:1, 3:1 for large text) against the nearest opaque background.
  out.contrast = [];
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const mix = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const bgOf = (el) => {
    const stack = [];
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage)) return null; // text over an image: skip
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 11, g: 18, b: 32, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) bg = mix(stack[i], bg);
    return bg;
  };
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (out.contrast.length > 10) break;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own || !shown(el) || el.closest('[disabled],.btn:disabled,button:disabled,.room-card-skeleton')) continue;
    const cs = getComputedStyle(el);
    let fg = parse(cs.color); if (!fg) continue;
    let op = 1; for (let p = el; p; p = p.parentElement) op *= Number(getComputedStyle(p).opacity);
    fg = { ...fg, a: fg.a * op };
    const bg = bgOf(el); if (!bg) continue;
    const c = mix(fg, bg);
    const [hi, lo] = [lum(c), lum(bg)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio + 0.01 < need) {
      const key = `${desc(el)}|${cs.color}`;
      if (seen.has(key)) continue; seen.add(key);
      out.contrast.push(`${desc(el)} "${el.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}:1 < ${need}`);
    }
  }
  return out;
}

async function check(page, where) {
  await sleep(250);
  const r = await page.evaluate(audit);
  checks++;
  if (r.doc > r.W + 1) fail(where, `page scrolls sideways (${r.doc} > ${r.W})`);
  for (const o of r.overflow) fail(where, `overflow ${o}`);
  for (const n of r.names) fail(where, `name: ${n}`);
  for (const l of r.labels) fail(where, `label: ${l}`);
  for (const c of r.contrast) fail(where, `contrast: ${c}`);
  for (const t of r.taps) fail(where, `tap target: ${t}`);
}

const OVERLAY = '[role="dialog"]:not([hidden]), [role="menu"]:not([hidden]), .modal-backdrop, .drawer-backdrop, .emoji-pop, .gif-pop, .more-menu, .plus-menu, .people-pop, .board-dock:not(.is-closed), .watch-dock, .games-dock:not(.is-closed)';
async function overlayCount(page) {
  return page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => {
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }).length, OVERLAY);
}

/** Click the trigger (by DOM, so a collapsed drawer is no obstacle), audit, press Escape, verify close + focus. */
async function openAudit(page, where, sel, { escape = true, pre = [] } = {}) {
  for (const p of pre) { await page.evaluate((s) => document.querySelector(s)?.click(), p); await sleep(250); }
  const before = await overlayCount(page);
  const found = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.focus(); el.click(); return true; }, sel);
  if (!found) { notes.push(`${where}: ${sel} not present`); return false; }
  await sleep(500);
  await check(page, where);
  if (!escape) return true;
  const opened = await overlayCount(page);
  if (opened <= before) return true; // nothing overlay-like opened (an inline tab), nothing to close
  await page.keyboard.press('Escape');
  await sleep(350);
  const after = await overlayCount(page);
  if (after >= opened) fail(where, `Escape did not close it (${opened} -> ${after} overlays)`);
  else {
    const back = await page.evaluate((s) => { const t = document.querySelector(s); const a = document.activeElement; return !t || !t.isConnected || a === t || (t.offsetParent === null) || !!(a && t.contains(a)); }, sel);
    if (!back) fail(where, `focus did not return to ${sel} (now ${await page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()}.${a.className}` : 'none'; })})`);
  }
  return true;
}

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
async function toRoom(page) {
  await toLobby(page);
  await page.click('.room-card[data-room="lobby"]');
  await page.waitForSelector('.composer, [data-action="composer-plus"]', { timeout: 15000 });
  await sleep(600);
}

// ---- node-side helpers (socket.io client with a cookie jar) for seeding friends, presence and activity ----
function nodeJar(initial = '') {
  const jar = new Map(initial.split('; ').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    header,
    async req(pathname, body) {
      const r = await fetch(URL + pathname, { method: body ? 'POST' : 'GET', headers: { 'x-csrf': '1', cookie: header(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
      return r.json().catch(() => ({}));
    },
  };
}
const nemit = (s, ev, ...a) => new Promise((res) => s.emit(ev, ...a, res));
async function nodeSocket(j) {
  const me = await j.req('/api/me');
  const s = ioClient(URL, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: j.header() }, auth: { deviceId: me.deviceId } });
  await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
  await nemit(s, 'login', {});
  return { s, id: me.account?.id };
}
async function nodeUser(nick) {
  const j = nodeJar();
  await j.req('/api/me');
  const cap = await j.req('/api/auth/captcha');
  const m = /What is (\d+) \+ (\d+)/.exec(cap.question || '');
  const solved = m ? { captchaId: cap.id, captchaAnswer: String(+m[1] + +m[2]) } : { captchaToken: 'test' };
  const r = await j.req('/api/auth/register', { username: nick, password: `pw-${nick}-secret-1`, email: `${nick.toLowerCase()}@example.com`, ...solved });
  if (!r.ok) throw new Error(`seed register ${nick}: ${r.error}`);
  return { j, nick, ...(await nodeSocket(j)) };
}
async function nodeIcon(j, roomId, color) {
  const sharp = require('sharp');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${color}"/><circle cx="128" cy="128" r="70" fill="#ffffff" fill-opacity="0.85"/><circle cx="128" cy="128" r="34" fill="${color}"/></svg>`;
  const fd = new FormData();
  fd.append('icon', new Blob([await sharp(Buffer.from(svg)).png().toBuffer()], { type: 'image/png' }), 'icon.png');
  const r = await fetch(`${URL}/api/rooms/${encodeURIComponent(roomId)}/icon`, { method: 'POST', headers: { 'x-csrf': '1', cookie: j.header() }, body: fd });
  return r.json().catch(() => ({}));
}
const lobbyRows = (page) => page.evaluate(() => [...document.querySelectorAll('[data-row]')].filter((el) => el.getBoundingClientRect().height > 0).map((el) => el.getAttribute('data-row')));

const VIEWS = [
  { key: 'desktop', width: 1280, height: 800, mobile: false },
  { key: 'phone', width: 390, height: 844, mobile: true },
  { key: 'small', width: 360, height: 740, mobile: true },
].filter((v) => !process.env.UI_VIEWS || process.env.UI_VIEWS.split(',').includes(v.key)); // UI_VIEWS=phone,small to narrow a run

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const seedSockets = [];
const b4a = { buddy: null, thread: '', edited: '' };
const inviteSeed = { live: '', dead: '', room: '' };
try {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => notes.push(`pageerror: ${e.message}`));
  await page.setViewport({ width: 1280, height: 800 });
  // a login page audit in a fresh context
  {
    const c2 = await browser.createBrowserContext();
    const lp = await c2.newPage();
    for (const v of VIEWS) {
      await lp.setViewport({ width: v.width, height: v.height, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: 1 });
      await lp.goto(URL, { waitUntil: 'networkidle0' });
      if (!ONLY_SHOTS) await check(lp, `login ${v.key}`);
      await lp.click('[data-tab="register"]').catch(() => {});
      if (!ONLY_SHOTS) await check(lp, `register ${v.key}`);
    }
    await c2.close();
  }
  await register(page, 'Ui_Admin');
  // smarter lobby, empty: a fresh account with no friends, no recent rooms and nobody active sees no rows and no skeletons
  for (const v of VIEWS) {
    await page.setViewport({ width: v.width, height: v.height, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: 1 });
    await toLobby(page);
    await sleep(700);
    const rows = await lobbyRows(page);
    if (rows.length) fail(`lobby empty ${v.key}`, `rows should hide when empty (saw ${rows.join(',')})`);
    if (await page.$('.lr-skeleton')) fail(`lobby empty ${v.key}`, 'a lobby-row skeleton is showing with nothing to load');
    if (!ONLY_SHOTS) await check(page, `lobby empty ${v.key}`);
    if (LOBBY_SHOTS && v.key === 'phone') await page.screenshot({ path: path.join(LOBBY_SHOTS, 'lobby2-empty-phone.png') });
  }
  // a second person leaves a message, so name buttons and the profile card have someone to open
  {
    const c3 = await browser.createBrowserContext();
    const fp = await c3.newPage();
    await fp.setViewport({ width: 1280, height: 800 });
    await register(fp, 'Ui_Friend');
    await fp.click('.room-card[data-room="lobby"]');
    await fp.waitForSelector('.chat-form input[placeholder]', { timeout: 15000 });
    await fp.type('.chat-form input[placeholder]', 'Hi! Friend here.');
    await fp.keyboard.press('Enter');
    await sleep(800);
    await c3.close();
  }
  // two people report the friend's message through the dialog (reason + note), so the queues have an item
  for (const [nick, cat, note] of [['Ui_Reporter', 'spam', 'Posting the same link everywhere'], ['Ui_Witness', 'harassment', '']]) {
    const c = await browser.createBrowserContext();
    const rp = await c.newPage();
    await rp.setViewport({ width: 1280, height: 800 });
    await register(rp, nick);
    await rp.click('.room-card[data-room="lobby"]');
    await rp.waitForSelector('[data-action="report-msg"]', { timeout: 15000 });
    await rp.evaluate(() => document.querySelector('[data-action="report-msg"]')?.click());
    await rp.waitForSelector('[data-testid="report-dialog"]', { timeout: 5000 });
    await rp.click(`[data-category="${cat}"]`);
    if (note) await rp.type('[data-testid="report-dialog"] textarea', note);
    await rp.click('[data-action="report-submit"]');
    const toasted = await rp.waitForFunction(() => /Report sent/.test(document.body.textContent || ''), { timeout: 5000 }).then(() => true, () => false);
    if (!toasted) fail(`report seed ${nick}`, 'no "Report sent" toast after submitting the report dialog');
    if (await rp.$('[data-testid="report-dialog"]')) fail(`report seed ${nick}`, 'report dialog stayed open after sending');
    await c.close();
  }
  // smarter lobby, populated: two friends online (one in a public room, one chatting in the lobby room so it is 🔥 active),
  // a password room a friend sits in that must not be revealed, and recent rooms (with unread + a mention) for the admin
  {
    const adminJar = nodeJar((await page.cookies()).map((c) => `${c.name}=${c.value}`).join('; '));
    const pal = await nodeUser('Ui_Pal'); const buddy = await nodeUser('Ui_Buddy');
    seedSockets.push(pal.s, buddy.s);
    const adm = await nodeSocket(adminJar);
    for (const f of [pal, buddy]) {
      await nemit(f.s, 'friends:request', { username: 'Ui_Admin' });
      const ok = await nemit(adm.s, 'friends:respond', { userId: f.id, accept: true });
      if (!ok.ok) fail('lobby seed', `friendship with ${f.nick}: ${ok.error}`);
    }
    const jazz = await nemit(pal.s, 'room:create', { name: 'Late Night Jazz', topic: 'smooth sets till 2am', category: 'music' });
    const art = await nemit(buddy.s, 'room:create', { name: 'Sketch Club', topic: 'draw along' });
    if (!jazz.ok || !art.ok) fail('lobby seed', `room create ${jazz.error || art.error}`);
    // the admin's recent rooms: Sketch Club, then the lobby, then Late Night Jazz (most recent)
    for (const id of [art.roomId, 'lobby', jazz.roomId]) { await nemit(adm.s, 'room:join', { roomId: id }); await sleep(250); adm.s.emit('room:leave'); await sleep(250); }
    adm.s.close();
    // room icons: two user rooms by their owners, the lobby room by the admin (site staff)
    for (const [j, id, color] of [[pal.j, jazz.roomId, '#7b3fe4'], [buddy.j, art.roomId, '#e4572e'], [adminJar, 'lobby', '#1f9d55']]) {
      const r = await nodeIcon(j, id, color);
      if (!r.ok) fail('room icon seed', `${id}: ${r.error}`);
    }
    // a thumbnail too, so the example share card has a background
    {
      const sharp = require('sharp');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b1c6e"/><stop offset="1" stop-color="#d9480f"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/>${Array.from({ length: 14 }, (_, i) => `<circle cx="${90 * i + 40}" cy="${360 + 220 * Math.sin(i)}" r="${30 + (i % 4) * 22}" fill="#fff" fill-opacity="0.12"/>`).join('')}</svg>`;
      const fd = new FormData();
      fd.append('thumb', new Blob([await sharp(Buffer.from(svg)).jpeg().toBuffer()], { type: 'image/jpeg' }), 'thumb.jpg');
      const tr = await fetch(`${URL}/api/rooms/${encodeURIComponent(jazz.roomId)}/thumb`, { method: 'POST', headers: { 'x-csrf': '1', cookie: pal.j.header() }, body: fd }).then((r) => r.json());
      if (!tr.ok) fail('thumb seed', tr.error);
      await nemit(pal.s, 'room:meta', { category: 'music', tags: ['jazz', 'late-night', 'vinyl'] });
    }
    // invite links: a live one and an expired one (for the landing pages)
    {
      const mk = async (body) => fetch(`${URL}/api/rooms/${encodeURIComponent(jazz.roomId)}/invites`, { method: 'POST', headers: { 'x-csrf': '1', 'content-type': 'application/json', cookie: pal.j.header() }, body: JSON.stringify(body) }).then((r) => r.json());
      const live = await mk({ expires: '7d', maxUses: null });
      const dead = await mk({ expires: '30m', maxUses: 5 });
      if (!live.ok || !dead.ok) fail('invite seed', live.error || dead.error);
      inviteSeed.live = live.invite?.code; inviteSeed.dead = dead.invite?.code; inviteSeed.room = jazz.roomId;
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(DATA, 'camchat.db'));
      db.exec('PRAGMA busy_timeout = 3000');
      db.prepare('UPDATE room_invites SET expires_at = ? WHERE code = ?').run(Date.now() - 60_000, inviteSeed.dead);
      db.close();
    }
    await nemit(pal.s, 'room:join', { roomId: jazz.roomId });
    await nemit(buddy.s, 'room:join', { roomId: 'lobby' });
    // a remote broadcaster in the lobby, so cam tiles (and their video menu) are on screen
    { const ms = await nemit(buddy.s, 'media:state', { cam: true, mic: true, screen: false }); if (!ms.ok) fail('vq seed', `buddy cam: ${ms.error}`); }
    for (const t of ['evening all', 'anyone up for a game?', 'hey @Ui_Admin, jump in', 'the jazz room is great tonight', 'ok brb']) { await nemit(buddy.s, 'chat:send', { text: t }); await sleep(1100); }
    await sleep(1500); // one activity tick
    // batch 4a: a thread with replies, an edited line, two pins (by the admin, site staff)
    {
      b4a.buddy = buddy;
      const got = [];
      const h = (m) => { if (m.kind === 'chat') got.push(m); };
      buddy.s.on('chat:message', h);
      for (const t of ['House rules: be kind, no spam, and keep cams on topic. Have fun!', 'Movie night on Friday at 9pm. Vote for the film in the thread', 'Snacks are on me this tim']) { await nemit(buddy.s, 'chat:send', { text: t }); await sleep(1100); }
      await sleep(300);
      const rules = got.find((m) => /House rules/.test(m.text)); const movie = got.find((m) => /Movie night/.test(m.text)); const snack = got.find((m) => /Snacks/.test(m.text));
      for (const t of ['A sci-fi double feature, please', 'Count me in! Anything but horror', 'Blade Runner then Arrival?']) { const rr = await nemit(buddy.s, 'chat:send', { text: t, parentId: movie?.id }); if (!rr.ok) fail('b4a seed', `reply: ${rr.error}`); await sleep(1100); }
      const ed = await nemit(buddy.s, 'chat:edit', { messageId: snack?.id, text: 'Snacks are on me this time' });
      if (!ed.ok) fail('b4a seed', `edit: ${ed.error}`);
      buddy.s.off('chat:message', h);
      const adm2 = await nodeSocket(nodeJar((await page.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')));
      await nemit(adm2.s, 'room:join', { roomId: 'lobby' });
      for (const m of [rules, movie]) { const pr = await nemit(adm2.s, 'chat:pin', { messageId: m?.id, pinned: true }); if (!pr.ok) fail('b4a seed', `pin: ${pr.error}`); }
      adm2.s.emit('room:leave'); await sleep(250);
      // keep the admin's "jump back in" order (Late Night Jazz newest) that the lobby checks expect
      await nemit(adm2.s, 'room:join', { roomId: jazz.roomId }); await sleep(250); adm2.s.emit('room:leave'); await sleep(250); adm2.s.close();
      b4a.thread = movie?.id || ''; b4a.edited = snack?.id || '';
    }
  }
  // invite landing pages, signed out, every size; plus the example share card
  {
    const ci = await browser.createBrowserContext();
    const ip = await ci.newPage();
    ip.on('pageerror', (e) => notes.push(`pageerror (invite): ${e.message}`));
    for (const v of VIEWS) {
      await ip.setViewport({ width: v.width, height: v.height, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: 1 });
      await ip.goto(`${URL}/i/${inviteSeed.live}`, { waitUntil: 'networkidle0' });
      const okPage = await ip.waitForSelector('[data-testid="invite-ok"]', { timeout: 6000 }).then(() => true, () => false);
      const txt = await ip.evaluate(() => document.querySelector('[data-testid="invite-page"]')?.textContent || '');
      if (!okPage || !/Late Night Jazz/.test(txt) || !/online now/.test(txt) || !(await ip.$('[data-action="invite-register"]'))) fail(`invite landing ${v.key}`, `the landing page should show the room and sign-up / sign-in buttons (${txt.slice(0, 120)})`);
      if (!ONLY_SHOTS) await check(ip, `invite landing ${v.key}`);
      await ip.goto(`${URL}/i/${inviteSeed.dead}`, { waitUntil: 'networkidle0' });
      const dead = await ip.waitForSelector('[data-testid="invite-dead"]', { timeout: 6000 }).then(() => true, () => false);
      const dt = await ip.evaluate(() => document.querySelector('[data-testid="invite-dead"]')?.textContent || '');
      if (!dead || !/expired/.test(dt) || /Late Night Jazz/.test(dt)) fail(`invite expired ${v.key}`, `the expired page should be friendly and not name the room (${dt.slice(0, 120)})`);
      if (!ONLY_SHOTS) await check(ip, `invite expired ${v.key}`);
      if (INVITE_SHOTS && v.key === 'phone') await ip.screenshot({ path: path.join(INVITE_SHOTS, 'invites-expired-phone.png') });
    }
    // signed out -> "Create an account" carries the invite to the register form
    await ip.goto(`${URL}/i/${inviteSeed.live}`, { waitUntil: 'networkidle0' });
    await ip.waitForSelector('[data-action="invite-register"]', { timeout: 6000 });
    await ip.click('[data-action="invite-register"]');
    const carried = await ip.waitForSelector('[data-testid="invite-banner"]', { timeout: 6000 }).then(() => true, () => false);
    if (!carried || !(await ip.$('input[name="password2"]')) || (await ip.evaluate(() => location.pathname)) !== '/') fail('invite sign-up', 'after "Create an account" the register form should show with the invite banner');
    // sign up there and land in the room
    await ip.type('input[name="username"]', 'Ui_Invitee');
    await ip.type('input[name="email"]', 'ui_invitee@example.com');
    await ip.type('input[name="password"]', 'pw-Ui_Invitee-secret-1');
    await ip.type('input[name="password2"]', 'pw-Ui_Invitee-secret-1');
    const cap = await ip.$('input[name="captcha"]');
    if (cap) {
      const m = /What is (\d+) \+ (\d+)/.exec(await ip.evaluate(() => [...document.querySelectorAll('label')].map((l) => l.textContent || '').find((t) => /What is/.test(t)) || ''));
      if (m) await cap.type(String(+m[1] + +m[2]));
    }
    await ip.evaluate(() => { for (const el of document.querySelectorAll('input[type="checkbox"]')) if (!el.checked) el.click(); });
    await ip.waitForSelector('[data-action="account-submit"]:not([disabled])');
    await ip.$eval('[data-action="account-submit"]', (b) => b.click());
    const inRoom = await ip.waitForFunction(() => /Late Night Jazz/.test(document.querySelector('.chat-head .room-name')?.textContent || '') && !!document.querySelector('.composer, [data-action="composer-plus"]'), { timeout: 15000 }).then(() => true, () => false);
    if (!inRoom) fail('invite sign-up', 'after signing up from an invite the new account should land in the room');
    await ci.close();
    if (INVITE_SHOTS) {
      const sharp = require('sharp');
      const html = await fetch(`${URL}/?room=${encodeURIComponent(inviteSeed.room)}`).then((r) => r.text());
      const img = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1] || '';
      const r = await fetch(img.startsWith('http') ? img : URL + img);
      if (r.status !== 200 || r.headers.get('content-type') !== 'image/jpeg') fail('share card', `card image ${r.status} ${r.headers.get('content-type')}`);
      else await sharp(Buffer.from(await r.arrayBuffer())).png().toFile(path.join(INVITE_SHOTS, 'invites-card-example.png'));
    }
  }
  const MQ_SHOT = (v) => SHOTS && (v.key === 'desktop' || v.key === 'phone');
  for (const v of VIEWS) {
    await page.setViewport({ width: v.width, height: v.height, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: 1 });
    const W = `${v.key}`;
    await toLobby(page);
    await page.waitForSelector('[data-row="friends"] [data-friend-card]', { timeout: 8000 }).catch(() => {});
    await page.waitForSelector('[data-row="recent"] [data-recent-room]', { timeout: 8000 }).catch(() => {});
    await sleep(400);
    const rows = await lobbyRows(page);
    for (const r of ['friends', 'active', 'recent']) if (!rows.includes(r)) fail(`lobby rows ${W}`, `the ${r} row is missing (saw ${rows.join(',') || 'none'})`);
    const info = await page.evaluate(() => ({
      friends: [...document.querySelectorAll('[data-row="friends"] [data-friend-card]')].map((el) => el.textContent || ''),
      recent: [...document.querySelectorAll('[data-row="recent"] [data-recent-room]')].map((el) => el.textContent || ''),
      hot: document.querySelectorAll('.room-card [data-active="1"]').length,
      snap: getComputedStyle(document.querySelector('.lr-scroll') || document.body).scrollSnapType,
      order: [...document.querySelectorAll('[data-row]')].map((el) => el.getAttribute('data-row')),
    }));
    if (!info.friends.some((t) => /Ui_Pal/.test(t) && /Late Night Jazz/.test(t))) fail(`lobby rows ${W}`, 'Ui_Pal should show in Late Night Jazz');
    if (!info.friends.some((t) => /Ui_Buddy/.test(t))) fail(`lobby rows ${W}`, 'Ui_Buddy should show as online');
    if (!/Late Night Jazz/.test(info.recent[0] || '') || info.recent.length !== 3) fail(`lobby rows ${W}`, `jump back in should list 3 rooms, newest first (${info.recent.length}: ${info.recent[0]})`);
    const minis = await page.evaluate(() => ({ cards: document.querySelectorAll('.room-card [data-room-icon-mini]').length, recent: document.querySelectorAll('[data-row="recent"] [data-room-icon-mini]').length }));
    if (minis.cards < 3 || minis.recent < 3) fail(`lobby icons ${W}`, `room icons should show small next to names on cards and Jump back in (${JSON.stringify(minis)})`);
    if (!info.hot) fail(`lobby rows ${W}`, 'no room card carries the 🔥 active tag');
    if (v.mobile && !/x/.test(info.snap)) fail(`lobby rows ${W}`, `rows should scroll-snap horizontally (${info.snap})`);
    if (info.order[0] !== 'friends') fail(`lobby rows ${W}`, `friends row should come first (${info.order.join(',')})`);
    if (LOBBY_SHOTS && (v.key === 'desktop' || v.key === 'phone')) await page.screenshot({ path: path.join(LOBBY_SHOTS, `lobby2-${v.key}.png`) });
    if (ONLY_SHOTS) continue;
    await check(page, `lobby rows ${W}`);
    await openAudit(page, `lobby friend menu ${W}`, '[data-row="friends"] [data-action="friend-more"]');
    await toLobby(page);
    await page.waitForSelector('[data-action="sort-active"]', { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => document.querySelector('[data-action="sort-active"]')?.click());
    await sleep(400);
    const first = await page.evaluate(() => document.querySelector('.room-card')?.querySelector('[data-active]')?.getAttribute('data-active'));
    if (first !== '1') fail(`lobby sort ${W}`, '"Active first" should put a 🔥 active room first');
    await check(page, `lobby active-first ${W}`);
    await page.evaluate(() => document.querySelector('[data-action="sort-active"]')?.click());
    if (v.mobile) {
      const scrolls = await page.evaluate(() => { const sc = document.querySelector('[data-row="recent"] .lr-scroll'); return sc ? getComputedStyle(sc).overflowX : 'none'; });
      if (!/auto|scroll/.test(scrolls)) fail(`lobby rows ${W}`, `rows should scroll sideways inside themselves (${scrolls})`);
    }
  }
  // seed a message so the chat log has content
  for (const v of VIEWS) {
    await page.setViewport({ width: v.width, height: v.height, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: 1 });
    const W = `${v.key}`;
    await toLobby(page);
    await sleep(500);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}-lobby-${v.key}.png` });
    if (!ONLY_SHOTS) {
      await check(page, `lobby ${W}`);
      await openAudit(page, `lobby profile menu ${W}`, '[data-action="profile"]');
      await toLobby(page);
      await openAudit(page, `lobby music ${W}`, '[data-action="music"]');
      await toLobby(page);
      await openAudit(page, `lobby a/v settings ${W}`, '[data-action="profile-av"]', { pre: ['[data-action="profile"]'] });
    }
    await toRoom(page);
    if (!(await page.evaluate(() => document.querySelector('.chat-log')?.textContent?.includes('polish check')))) {
      const box = await page.$('.chat-form input[placeholder]');
      if (box) { await box.type('Hello from the polish check :)'); await page.keyboard.press('Enter'); await sleep(600); }
    }
    if (SHOTS) {
      await page.evaluate(() => { document.activeElement?.blur?.(); const l = document.querySelector('.chat-log'); if (l) l.scrollTop = l.scrollHeight; });
      await sleep(300);
      await page.screenshot({ path: `${SHOTS}-room-${v.key}.png` });
    }
    if (ONLY_SHOTS) continue;
    await check(page, `room ${W}`);
    // room icons: rail (a drawer on phones), header icon, letter fallback, active ring
    {
      if (v.mobile) { await page.evaluate(() => document.querySelector('[data-action="open-rail"]')?.click()); await sleep(450); }
      const rail = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('.icon-rail [data-rail-room]')];
        const on = document.querySelector('.icon-rail .rail-btn.on');
        const img = on?.querySelector('img.rail-icon');
        const r = img?.getBoundingClientRect(); const b = on?.getBoundingClientRect();
        return {
          icons: btns.filter((x) => x.querySelector('img.rail-icon')).length,
          letters: btns.filter((x) => !x.querySelector('img') && /^[A-Z0-9?]$/.test((x.textContent || '').trim())).length,
          onIcon: !!img, onAlt: img?.getAttribute('alt') || '', onLabel: on?.getAttribute('aria-label') || '', onTitle: on?.getAttribute('title') || '',
          fills: !!(r && b && Math.abs(r.width - b.width) < 1.5 && Math.abs(r.height - b.height) < 1.5),
          ring: on ? getComputedStyle(on, '::after').boxShadow : '', radius: on ? getComputedStyle(on).borderRadius : '',
          loaded: [...document.querySelectorAll('.icon-rail img.rail-icon')].every((i) => i.complete && i.naturalWidth === 128),
          head: !!document.querySelector('[data-room-head-icon="1"]'),
        };
      });
      if (rail.icons < 3) fail(`rail ${W}`, `expected 3 rooms with icons in the rail (got ${rail.icons})`);
      if (rail.letters < 1) fail(`rail ${W}`, 'rooms without an icon should keep the letter');
      if (!rail.onIcon || rail.onAlt !== rail.onLabel || !/ online$/.test(rail.onTitle)) fail(`rail ${W}`, `active room icon: alt should be the room name and the tooltip unchanged (${rail.onAlt} / ${rail.onTitle})`);
      if (!rail.fills) fail(`rail ${W}`, 'the icon should fill the rail button');
      if (!/inset/.test(rail.ring) || rail.radius !== '16px') fail(`rail ${W}`, `the active room should keep the green rounded square (ring "${rail.ring}", radius ${rail.radius})`);
      if (!rail.loaded) fail(`rail ${W}`, 'rail icons should load as 128px images');
      if (!rail.head) fail(`room header ${W}`, 'the header should show the room icon');
      if (LOBBY_SHOTS && (v.key === 'desktop' || v.key === 'phone')) await page.screenshot({ path: path.join(LOBBY_SHOTS, `roomicons-rail-${v.key}.png`) });
      await check(page, `rail ${W}`);
      if (v.mobile) await toRoom(page);
      // Info tab: "Room icon" controls next to the thumbnail ones (the admin is site staff)
      await page.evaluate(() => document.querySelector('[data-action="tab-info"]')?.click());
      if (v.mobile) await page.evaluate(() => document.querySelector('[data-action="collapse-panel"]')?.click());
      await sleep(450);
      const ed = await page.evaluate(() => {
        const e = document.querySelector('.room-icon-edit');
        e?.scrollIntoView({ block: 'center' });
        return { has: !!e, change: !!e?.querySelector('[data-action="room-icon-upload"]') && /Change/.test(e.querySelector('[data-action="room-icon-upload"]').textContent || ''), remove: !!e?.querySelector('[data-action="room-icon-remove"]'), thumb: !!document.querySelector('.room-thumb-edit') };
      });
      if (!ed.has || !ed.change || !ed.remove || !ed.thumb) fail(`room icon editor ${W}`, `Info tab should show Room icon: Change / Remove next to the thumbnail controls (${JSON.stringify(ed)})`);
      await sleep(250);
      if (LOBBY_SHOTS && v.key === 'desktop') await page.screenshot({ path: path.join(LOBBY_SHOTS, 'roomicons-upload-desktop.png') });
      await check(page, `room icon editor ${W}`);
      await toRoom(page);
    }
    // invite links: Info-tab list + create dialog (the admin is site staff)
    {
      await page.evaluate(() => document.querySelector('[data-action="tab-info"]')?.click());
      if (v.mobile) await page.evaluate(() => document.querySelector('[data-action="collapse-panel"]')?.click());
      const panel = await page.waitForSelector('[data-testid="invite-panel"]', { timeout: 6000 }).then(() => true, () => false);
      if (!panel) fail(`invites ${W}`, 'the Info tab has no invite panel for site staff');
      await page.evaluate(() => document.querySelector('[data-testid="invite-panel"]')?.scrollIntoView({ block: 'center' }));
      await sleep(300);
      await openAudit(page, `invite dialog ${W}`, '[data-action="invite-create"]');
      // create one through the dialog (first size only), then the list has a row with uses / expiry / revoke
      if (v.key === VIEWS[0].key) {
        await page.evaluate(() => document.querySelector('[data-action="invite-create"]')?.click());
        await page.waitForSelector('[data-testid="invite-dialog"]', { timeout: 4000 });
        await page.select('[data-testid="invite-dialog"] select[name="expires"]', '7d');
        await page.select('[data-testid="invite-dialog"] select[name="maxUses"]', '25');
        await page.click('[data-action="invite-create-confirm"]');
        const made = await page.waitForSelector('[data-testid="invite-panel"] .invite-item', { timeout: 5000 }).then(() => true, () => false);
        if (!made) fail(`invites ${W}`, 'creating a link through the dialog did not add it to the list');
      }
      const row = await page.evaluate(() => { const r = document.querySelector('[data-testid="invite-panel"] .invite-item'); return r ? { text: r.textContent || '', revoke: !!r.querySelector('[data-action="invite-revoke"]'), copy: !!r.querySelector('[data-action="invite-copy"]') } : null; });
      if (!row || !/0 \/ 25 uses/.test(row.text) || !/expires in/.test(row.text) || !row.revoke || !row.copy) fail(`invites ${W}`, `invite list row should show uses / expiry with copy + revoke (${JSON.stringify(row)})`);
      await check(page, `invite list ${W}`);
      if (INVITE_SHOTS && (v.key === 'desktop' || v.key === 'phone')) {
        await page.evaluate(() => document.querySelector('[data-action="invite-create"]')?.click());
        await page.waitForSelector('[data-testid="invite-dialog"]', { timeout: 4000 });
        await sleep(300);
        await page.screenshot({ path: path.join(INVITE_SHOTS, `invites-dialog-${v.key}.png`) });
        await page.keyboard.press('Escape');
        await sleep(300);
      }
      await toRoom(page);
      // the More menu has "Copy invite link"
      await page.evaluate(() => document.querySelector('[data-action="more"]')?.click());
      await sleep(300);
      if (!(await page.$('[data-action="copy-invite"]'))) fail(`invites ${W}`, 'the More menu has no "Copy invite link"');
      await toRoom(page);
    }
    const panelPre = v.mobile ? ['[data-action="collapse-panel"]'] : [];
    for (const tab of ['info', 'events', 'search', 'saved', 'stats', 'rooms']) {
      await openAudit(page, `room tab ${tab} ${W}`, `[data-action="tab-${tab}"]`, { pre: panelPre, escape: v.mobile });
      if (v.mobile) await toRoom(page);
    }
    if (v.mobile) {
      await openAudit(page, `room rail drawer ${W}`, '[data-action="open-rail"]'); await toRoom(page);
    }
    await openAudit(page, `room more menu ${W}`, '[data-action="more"]'); await toRoom(page);
    for (const item of ['effects', 'sounds', 'room-bots', 'people']) {
      await openAudit(page, `room ${item} ${W}`, `[data-action="${item}"]`, { pre: ['[data-action="more"]'] });
      await toRoom(page);
    }
    for (const item of ['board', 'watch', 'games']) {
      await openAudit(page, `room ${item} ${W}`, `[data-action="${item}"]`, { pre: ['[data-action="more"]'] });
      await toRoom(page);
    }
    await openAudit(page, `room composer tools ${W}`, '[data-action="composer-plus"]'); await toRoom(page);
    for (const item of ['emoji-picker', 'gif-picker', 'name-style', 'new-poll']) {
      await openAudit(page, `room ${item} ${W}`, `[data-action="${item}"]`, { pre: ['[data-action="composer-plus"]'] });
      await toRoom(page);
    }
    await openAudit(page, `room a/v settings ${W}`, '[data-action="av-settings"]'); await toRoom(page);
    // ---- video quality: settings control ----
    {
      await page.evaluate(() => document.querySelector('[data-action="av-settings"]')?.click());
      const sel = await page.waitForSelector('[data-action="av-quality"]', { timeout: 6000 }).then(() => true, () => false);
      const info = await page.evaluate(() => {
        const q = document.querySelector('[data-action="av-quality"]');
        return { opts: q ? [...q.options].map((o) => o.value) : [], value: q?.value, labels: q ? [...q.options].map((o) => o.textContent) : [], share: document.querySelectorAll('[data-testid="vq-share"] input[type="radio"]').length, detail: !!document.querySelector('[data-action="share-detail"]:checked') };
      });
      if (!sel || info.opts.join() !== 'auto,high,medium,low,saver' || info.value !== 'auto') fail(`vq settings ${W}`, `camera quality select should offer 5 presets with Auto selected (${JSON.stringify(info)})`);
      if (!/240p, 15 fps/.test(info.labels.join('|'))) fail(`vq settings ${W}`, 'Data saver label should say 240p, 15 fps');
      if (info.share !== 2 || !info.detail) fail(`vq settings ${W}`, 'screen share should offer sharpness / smoothness with sharpness selected');
      await page.select('[data-action="av-quality"]', 'low');
      await page.evaluate(() => document.querySelector('[data-action="share-motion"]')?.click());
      await sleep(250);
      const stored = await page.evaluate(() => ({ q: localStorage.getItem('camchat.videoQuality'), m: localStorage.getItem('camchat.shareMode'), help: document.querySelector('[data-testid="vq-help"]')?.textContent || '' }));
      if (stored.q !== 'low' || stored.m !== 'motion' || !/Fixed quality/.test(stored.help)) fail(`vq settings ${W}`, `choices should save to localStorage (${JSON.stringify(stored)})`);
      const srv = await page.evaluate(() => fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => j.account?.videoQuality));
      if (srv !== 'low') fail(`vq settings ${W}`, `the preset should also save to the account (got ${srv})`);
      await page.select('[data-action="av-quality"]', 'auto');
      await page.evaluate(() => document.querySelector('[data-action="share-detail"]')?.click());
      await sleep(300);
      await page.evaluate(() => document.querySelector('[data-action="av-quality"]')?.scrollIntoView({ block: 'center' }));
      await check(page, `vq settings ${W}`);
      if (VQ_SHOTS && (v.key === 'desktop' || v.key === 'phone')) { await sleep(400); await page.screenshot({ path: path.join(VQ_SHOTS, `vq-settings-${v.key}.png`) }); }
      await page.keyboard.press('Escape');
      await sleep(300);
      await toRoom(page);
    }
    // ---- video quality: remote tile menu ----
    {
      const tileSel = '.tile[data-user="Ui_Buddy"]';
      const hasTile = await page.waitForSelector(`${tileSel} [data-action="tile-menu"]`, { timeout: 6000 }).then(() => true, () => false);
      if (!hasTile) fail(`vq tile menu ${W}`, 'a remote cam tile should have a video options (⋯) button');
      else {
        await page.evaluate((t) => document.querySelector(t)?.scrollIntoView({ block: 'center' }), tileSel);
        await openAudit(page, `vq tile menu ${W}`, `${tileSel} [data-action="tile-menu"]`);
        await page.evaluate((t) => document.querySelector(`${t} [data-action="tile-menu"]`)?.click(), tileSel);
        await sleep(300);
        const m = await page.evaluate(() => {
          const menu = document.querySelector('.tile-menu[role="menu"]');
          const r = menu?.getBoundingClientRect();
          return { open: !!menu, items: menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent) : [], inView: !!r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5, focus: document.activeElement?.getAttribute('role') };
        });
        if (!m.open || m.items.join('|') !== 'Lower quality for me|Pause video (keep audio)' || !m.inView || m.focus !== 'menuitem') fail(`vq tile menu ${W}`, `menu should show both items inside the viewport with focus on the first (${JSON.stringify(m)})`);
        if (VQ_SHOTS && v.key === 'desktop') { await sleep(200); await page.screenshot({ path: path.join(VQ_SHOTS, 'vq-tile-menu-desktop.png') }); }
        await page.evaluate(() => document.querySelector('.tile-menu [data-action="view-pause"]')?.click());
        await sleep(300);
        const paused = await page.evaluate((t) => ({ status: !!document.querySelector(`${t} [data-view-paused="1"]`), muted: document.querySelector(`${t} video`)?.muted, open: !!document.querySelector('.tile-menu') }), tileSel);
        if (!paused.status || paused.muted !== false || paused.open) fail(`vq tile menu ${W}`, `Pause video should show "Video paused · audio on", keep audio unmuted and close the menu (${JSON.stringify(paused)})`);
        await check(page, `vq tile paused ${W}`);
        await page.evaluate((t) => document.querySelector(`${t} [data-action="tile-menu"]`)?.click(), tileSel);
        await sleep(250);
        const resume = await page.evaluate(() => [...document.querySelectorAll('.tile-menu [role="menuitem"]')].map((b) => b.textContent).join('|'));
        if (!/Resume video/.test(resume)) fail(`vq tile menu ${W}`, `menu should offer "Resume video" when paused (${resume})`);
        await page.evaluate(() => document.querySelector('.tile-menu [data-action="view-pause"]')?.click());
        await sleep(250);
        if (await page.$(`${tileSel} [data-view-paused="1"]`)) fail(`vq tile menu ${W}`, 'Resume video should clear the paused state');
      }
      await toRoom(page);
    }
    // ---- video quality: own-tile Auto indicator (desktop; fake camera + debug sample) ----
    if (v.key === 'desktop') {
      await page.evaluate(() => localStorage.setItem('camchat.vqDebug', JSON.stringify({ sample: { limitation: 'bandwidth', lossPct: 4, rttMs: 220, availBps: 250000 }, intervalMs: 250 })));
      await page.evaluate(() => document.querySelector('[data-action="cam"]')?.click());
      await page.waitForSelector('[data-action="cam"].on', { timeout: 8000 }).catch(() => {});
      await page.evaluate(() => document.querySelector('[data-action="mic"]')?.click());
      const shown = await page.waitForSelector('[data-vq-notice="1"]', { timeout: 15000 }).then(() => true, () => false);
      const txt = shown ? await page.$eval('[data-vq-notice="1"]', (e) => e.textContent) : '';
      if (!shown || txt !== 'Lowered quality: weak connection') fail('vq indicator', `own tile should show "Lowered quality: weak connection" (${txt})`);
      else {
        await check(page, 'vq indicator desktop');
        if (VQ_SHOTS) { await sleep(300); await page.screenshot({ path: path.join(VQ_SHOTS, 'vq-indicator-desktop.png') }); }
      }
      await page.evaluate(() => localStorage.removeItem('camchat.vqDebug'));
      await page.evaluate(() => document.querySelector('[data-action="mic"].on')?.click());
      await sleep(500);
      await page.evaluate(() => document.querySelector('[data-action="cam"]')?.click());
      await sleep(800);
      if (await page.$('[data-vq-notice="1"]')) fail('vq indicator', 'turning the camera off should clear the note');
      await toRoom(page);
    }
    // ---- batch 4a: background + noise settings ----
    {
      await page.evaluate(() => document.querySelector('[data-action="av-settings"]')?.click());
      const has = await page.waitForSelector('[data-testid="av-bg"]', { timeout: 6000 }).then(() => true, () => false);
      if (!has) fail(`b4a bg settings ${W}`, 'A/V settings should have a Background section');
      else {
        const modes = await page.evaluate(() => [...document.querySelectorAll('[data-testid="av-bg"] input[name="bgMode"]')].map((i) => i.value).join());
        if (modes !== 'off,blur-light,blur-strong,image') fail(`b4a bg settings ${W}`, `background modes should be Off / Blur light / Blur strong / Image (${modes})`);
        await page.evaluate(() => document.querySelector('[data-action="bg-image"]')?.click());
        await sleep(300);
        const img = await page.evaluate(() => ({ thumbs: document.querySelectorAll('[data-testid="av-bg"] .av-bg-thumb[data-bg]').length, upload: !!document.querySelector('[data-action="bg-upload"]'), saved: localStorage.getItem('camchat.background') }));
        if (img.thumbs < 4 || !img.upload || !/"image"/.test(img.saved || '')) fail(`b4a bg settings ${W}`, `Image should list the bundled pictures plus upload, saved locally (${JSON.stringify(img)})`);
        await page.evaluate(() => document.querySelector('[data-bg="forest"]')?.click());
        const noise = await page.evaluate(() => ({ on: !!document.querySelector('[data-action="noise-on"]:checked'), strong: !!document.querySelector('[data-action="noise-strong"]') }));
        const fit = await page.evaluate(() => { const m = document.querySelector('.av-modal'); const r = m?.getBoundingClientRect(); return { inView: !!r && r.top >= -0.5 && r.bottom <= innerHeight + 0.5, scrolls: !!m && /auto|scroll/.test(getComputedStyle(m).overflowY) }; });
        if (!fit.inView || !fit.scrolls) fail(`b4a bg settings ${W}`, `the A/V dialog should fit the screen and scroll inside so Apply stays reachable (${JSON.stringify(fit)})`);
        if (!noise.on || !noise.strong) fail(`b4a noise ${W}`, `noise suppression should be on by default with a Stronger option (${JSON.stringify(noise)})`);
        // the preview runs the effect (lazy model); wait for it to settle
        await page.waitForFunction(() => !/Loading the background model/.test(document.querySelector('[data-testid="bg-help"]')?.textContent || ''), { timeout: 30000 }).catch(() => notes.push(`b4a bg ${W}: model still loading after 30 s`));
        await page.evaluate(() => document.querySelector('[data-testid="av-bg"]')?.scrollIntoView({ block: 'center' }));
        await check(page, `b4a bg settings ${W}`);
        if (B4A_SHOTS && v.key === 'desktop') { await sleep(1500); await page.evaluate(() => { const m = document.querySelector('.av-modal'); if (m) m.scrollTop = m.scrollHeight; }); await sleep(500); await page.screenshot({ path: path.join(B4A_SHOTS, 'b4a-bg-settings-desktop.png') }); }
        await page.evaluate(() => document.querySelector('[data-action="bg-off"]')?.click());
        await sleep(200);
      }
      await page.keyboard.press('Escape');
      await sleep(300);
      await toRoom(page);
    }
    // ---- batch 4a: pin bar ----
    {
      const pins = await page.waitForSelector('.pin-list .pin-bar-head', { timeout: 6000 }).then(() => true, () => false);
      if (!pins) fail(`b4a pins ${W}`, 'the pin bar should show at the top of the chat');
      else {
        if (await page.evaluate(() => document.querySelector('.pin-list')?.classList.contains('is-collapsed'))) await page.evaluate(() => document.querySelector('.pin-list .pin-bar-head')?.click());
        await sleep(200);
        const pi = await page.evaluate(() => ({ rows: document.querySelectorAll('.pin-list .pin-row').length, unpin: document.querySelectorAll('.pin-list [data-action="unpin"]').length, head: document.querySelector('.pin-bar-head')?.textContent || '' }));
        if (pi.rows !== 2 || pi.unpin !== 2 || !/Pinned/.test(pi.head)) fail(`b4a pins ${W}`, `expanded bar should list 2 pins with unpin for staff (${JSON.stringify(pi)})`);
        await check(page, `b4a pins ${W}`);
        if (B4A_SHOTS && v.key === 'desktop') { await sleep(200); await page.screenshot({ path: path.join(B4A_SHOTS, 'b4a-pins-desktop.png') }); }
        await page.evaluate(() => document.querySelector('.pin-list .pin-bar-head')?.click());
        await sleep(200);
        const col = await page.evaluate(() => ({ c: document.querySelector('.pin-list')?.classList.contains('is-collapsed'), rows: document.querySelectorAll('.pin-list .pin-row').length, saved: Object.keys(localStorage).some((k) => k.startsWith('camchat.pinsCollapsed.') && localStorage.getItem(k) === '1') }));
        if (!col.c || col.rows !== 0 || !col.saved) fail(`b4a pins ${W}`, `collapsing should hide the rows and remember it (${JSON.stringify(col)})`);
        await check(page, `b4a pins collapsed ${W}`);
        await page.evaluate(() => document.querySelector('.pin-list .pin-bar-head')?.click());
      }
    }
    // ---- batch 4a: thread view with the quoted parent ----
    {
      const sel = `[data-msg="${b4a.thread}"] [data-action="open-thread"]`;
      await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
      const opened = await page.evaluate((s) => { const b = document.querySelector(s); b?.click(); return !!b; }, sel);
      const panel = opened && await page.waitForSelector('[data-testid="thread-quote"]', { timeout: 5000 }).then(() => true, () => false);
      if (!panel) fail(`b4a thread ${W}`, `the "3 replies" button should open the thread with the quoted message (button ${opened})`);
      else {
        await sleep(400);
        const t = await page.evaluate(() => ({ quote: document.querySelector('[data-testid="thread-quote"]')?.textContent || '', replies: document.querySelectorAll('.thread-panel .chat-log .msg[data-msg]').length, jump: !!document.querySelector('[data-action="thread-jump"]'), count: document.querySelector('.thread-panel .thread-count')?.textContent || '' }));
        if (!/Movie night/.test(t.quote) || t.replies !== 3 || !t.jump || !/3 replies/.test(t.count)) fail(`b4a thread ${W}`, `thread should quote the parent, list 3 replies and offer Jump to message (${JSON.stringify(t)})`);
        await check(page, `b4a thread ${W}`);
        if (B4A_SHOTS && (v.key === 'desktop' || v.key === 'phone')) { await sleep(200); await page.screenshot({ path: path.join(B4A_SHOTS, `b4a-thread-${v.key}.png`) }); }
        await page.click('[data-action="thread-jump"]');
        await sleep(500);
        const j = await page.evaluate((id) => ({ closed: !document.querySelector('.thread-panel'), hit: !!document.querySelector(`.chat-log [data-msg="${id}"].jump-hit`) }), b4a.thread);
        if (!j.closed || !j.hit) fail(`b4a thread ${W}`, `Jump to message should close the thread and highlight the message (${JSON.stringify(j)})`);
      }
      await toRoom(page);
    }
    // ---- batch 4a: edit history (staff) ----
    {
      const sel = `[data-msg="${b4a.edited}"] [data-action="edit-history"]`;
      await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
      if (!(await page.$(sel))) fail(`b4a edit history ${W}`, '"(edited)" should be a button for staff');
      else {
        await openAudit(page, `b4a edit history ${W}`, sel);
        await page.evaluate((s) => document.querySelector(s)?.click(), sel);
        const dlg = await page.waitForSelector('[data-testid="edit-history"]', { timeout: 4000 }).then(() => true, () => false);
        const txt = dlg ? await page.$eval('[data-testid="edit-history"]', (e) => [...e.querySelectorAll('.edit-versions li')].map((li) => li.textContent).join(' | ')) : '';
        if (!/^Original · .*Snacks are on me this tim \| Now · .*Snacks are on me this time$/.test(txt)) fail(`b4a edit history ${W}`, `dialog should show the original and the current text (${txt.slice(0, 160)})`);
        await page.keyboard.press('Escape');
        await sleep(250);
      }
      await toRoom(page);
    }
    // ---- batch 4a: stage mode ----
    {
      await page.evaluate(() => document.querySelector('[data-action="tab-info"]')?.click());
      if (v.mobile) await page.evaluate(() => document.querySelector('[data-action="collapse-panel"]')?.click());
      const sec = await page.waitForSelector('[data-testid="stage-settings"]', { timeout: 5000 }).then(() => true, () => false);
      if (!sec) fail(`b4a stage ${W}`, 'Info tab should have a Stage mode section for staff');
      else {
        await page.evaluate(() => document.querySelector('[data-testid="stage-settings"]')?.scrollIntoView({ block: 'center' }));
        if (!(await page.$('[data-action="stage-toggle"]:checked'))) await page.evaluate(() => document.querySelector('[data-action="stage-toggle"]')?.click());
        await page.waitForSelector('[data-action="stage-toggle"]:checked', { timeout: 4000 }).catch(() => {});
        await page.select('[data-action="stage-cap"]', '4');
        await sleep(400);
        const cost = await page.evaluate(() => document.querySelector('[data-testid="stage-cost"]')?.textContent || '');
        if (!/4 speakers × \d+ viewers/.test(cost)) fail(`b4a stage ${W}`, `the mesh cost note should use the cap (${cost})`);
        await check(page, `b4a stage settings ${W}`);
        // an audience member raises a hand
        await nemit(b4a.buddy.s, 'stage:hand', { up: true });
        await sleep(400);
        await toRoom(page);
        if (v.mobile) { await page.evaluate(() => document.querySelector('[data-action="more"]')?.click()); await sleep(250); await page.evaluate(() => document.querySelector('[data-action="people"]')?.click()); await sleep(450); }
        const pl = await page.evaluate(() => ({
          speakers: !!document.querySelector('[data-section="speakers"]'), audience: !!document.querySelector('[data-section="audience"]'),
          queue: document.querySelector('[data-testid="stage-hands"]')?.textContent || '', approve: !!document.querySelector('[data-action="stage-approve"]'),
          hand: !!document.querySelector('.user [data-hand="1"]'),
        }));
        if (!pl.speakers || !pl.audience || !/Ui_Buddy/.test(pl.queue) || !pl.approve || !pl.hand) fail(`b4a stage ${W}`, `people list should show Speakers / Audience with the hand and a queue with Bring up (${JSON.stringify(pl)})`);
        await check(page, `b4a stage people ${W}`);
        if (B4A_SHOTS && (v.key === 'desktop' || v.key === 'phone')) { await sleep(300); await page.screenshot({ path: path.join(B4A_SHOTS, `b4a-stage-${v.key}.png`) }); }
        // audience view (a second browser): locked cam / mic and a Raise hand button
        if (!b4a.aud) {
          const ca = await browser.createBrowserContext();
          b4a.aud = await ca.newPage();
          await b4a.aud.setViewport({ width: 1280, height: 800 });
          await register(b4a.aud, 'Ui_Aud');
        }
        await b4a.aud.setViewport({ width: v.width, height: v.height, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: 1 });
        await toRoom(b4a.aud);
        const au = await b4a.aud.evaluate(() => ({ cam: document.querySelector('[data-action="cam"]')?.disabled, mic: document.querySelector('[data-action="mic"]')?.disabled, hand: !!document.querySelector('[data-action="stage-hand"]'), label: document.querySelector('[data-action="cam"]')?.getAttribute('aria-label') || '' }));
        if (!au.cam || !au.mic || !au.hand || !/Stage mode/.test(au.label)) fail(`b4a stage audience ${W}`, `audience should see cam / mic locked and Raise hand (${JSON.stringify(au)})`);
        await b4a.aud.click('[data-action="stage-hand"]');
        await b4a.aud.waitForSelector('[data-action="stage-hand"].on', { timeout: 4000 }).catch(() => fail(`b4a stage audience ${W}`, 'Raise hand should toggle on'));
        await check(b4a.aud, `b4a stage audience ${W}`);
        await b4a.aud.click('[data-action="stage-hand"]');
        // back to normal for the next size (buddy's cam tile is used by the video-quality checks)
        await nemit(b4a.buddy.s, 'stage:hand', { up: false });
        await page.evaluate(() => document.querySelector('[data-action="people-close"]')?.click());
        await page.evaluate(() => document.querySelector('[data-action="tab-info"]')?.click());
        if (v.mobile) await page.evaluate(() => document.querySelector('[data-action="collapse-panel"]')?.click());
        await sleep(400);
        await page.evaluate(() => { const t = document.querySelector('[data-action="stage-toggle"]'); if (t?.checked) t.click(); });
        await sleep(400);
        const ms = await nemit(b4a.buddy.s, 'media:state', { cam: true, mic: true, screen: false });
        if (!ms.ok) fail(`b4a stage ${W}`, `after stage mode is off the buddy can go back on cam (${ms.error})`);
      }
      await toRoom(page);
    }
    await openAudit(page, `room user menu ${W}`, '[data-action="user-name"]', { pre: v.mobile ? ['[data-action="more"]', '[data-action="people"]'] : [] }); await toRoom(page);
    await openAudit(page, `room profile menu ${W}`, '[data-action="profile"]'); await toRoom(page);
    // moderation queue: report dialog from the message flag and from the profile card
    await openAudit(page, `room report message dialog ${W}`, '[data-action="report-msg"]');
    if (!(await page.$('[data-action="report-msg"]'))) fail(`room ${W}`, 'no report flag on a message from someone else');
    if (MQ_SHOT(v)) {
      await page.evaluate(() => document.querySelector('[data-action="report-msg"]')?.click());
      await page.waitForSelector('[data-testid="report-dialog"]', { timeout: 5000 });
      await page.click('[data-category="harassment"]');
      await page.type('[data-testid="report-dialog"] textarea', 'Keeps posting insults at people.');
      await sleep(200);
      await page.screenshot({ path: `${SHOTS}-report-dialog-${v.key}.png` });
    }
    await toRoom(page);
    await page.evaluate(() => [...document.querySelectorAll('[data-action="user-name"]')].find((b) => /Ui_Friend/.test(b.textContent || ''))?.click());
    await page.waitForSelector('[data-action="report-profile"]', { timeout: 5000 }).catch(() => fail(`room ${W}`, 'profile card has no Report button'));
    await openAudit(page, `room report user dialog ${W}`, '[data-action="report-profile"]');
    await toRoom(page);
    // room Reports view (info tab) for the owner / room mods / staff
    await page.evaluate(() => document.querySelector('[data-action="tab-info"]')?.click());
    if (v.mobile) await page.evaluate(() => document.querySelector('[data-action="collapse-panel"]')?.click());
    await sleep(400);
    await page.evaluate(() => { const d = document.querySelector('details[data-section="reports"]'); if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); } });
    const roomQ = await page.waitForSelector('[data-testid="modq-room"] .queue-item', { timeout: 5000 }).then(() => true, () => false);
    if (!roomQ) fail(`room reports ${W}`, 'room Reports view shows no item for the reported message');
    await check(page, `room reports view ${W}`);
    if (SHOTS && v.key === 'desktop') { await sleep(300); await page.screenshot({ path: `${SHOTS}-room-reports-desktop.png` }); }
    await toRoom(page);
    // mod panel, every tab
    await page.goto(`${URL}/admin`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.admin-tabs [data-tab]', { timeout: 15000 });
    const tabs = await page.$$eval('.admin-tabs [data-tab]', (els) => els.map((e) => e.getAttribute('data-tab')));
    for (const t of tabs) {
      await page.evaluate((x) => document.querySelector(`.admin-tabs [data-tab="${x}"]`)?.click(), t);
      await sleep(700);
      await check(page, `admin ${t} ${W}`);
      if (t !== 'reports') continue;
      const q = await page.waitForSelector('[data-testid="modq-site"] .queue-item', { timeout: 5000 }).then(() => true, () => false);
      if (!q) { fail(`admin queue ${W}`, 'the seeded report is not in the queue'); continue; }
      const n = await page.$eval('[data-testid="modq-site"] .queue-item', (el) => Number(el.getAttribute('data-count')));
      if (n < 2) fail(`admin queue ${W}`, `two reports on one message should be one item with count 2 (got ${n})`);
      if (MQ_SHOT(v)) { await page.evaluate(() => window.scrollTo(0, 0)); await sleep(200); await page.screenshot({ path: `${SHOTS}-queue-${v.key}.png` }); }
      for (const a of ['q-mute', 'q-ban', 'q-warn']) {
        await openAudit(page, `admin queue ${a} dialog ${W}`, `[data-testid="modq-site"] [data-action="${a}"]`);
      }
      for (const b of ['review', 'resolved', 'dismissed', 'open']) {
        await page.evaluate((x) => document.querySelector(`[data-testid="modq-site"] [data-bucket="${x}"]`)?.click(), b);
        await sleep(500);
        await check(page, `admin queue ${b} tab ${W}`);
      }
    }
  }
} catch (e) {
  fail('script', e.stack || String(e));
} finally {
  for (const s of seedSockets) s.close();
  await browser.close();
  server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
}

for (const n of notes) console.log(`note  ${n}`);
for (const f of failures) console.log(`FAIL  ${f}`);
console.log(`${checks} views checked, ${failures.length} failure(s)`);
process.exit(failures.length ? 1 : 0);
