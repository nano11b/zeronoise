/**
 * Voice keeps flowing, end to end in real Chrome (two browser contexts, real WebRTC mesh, fake mic = a tone).
 *   npm run build && node scripts/voice-browser.mjs
 * Alice and Bob turn their mics on. Bob collapses the camera strip, then switches to another tab (the room tab
 * goes hidden), then comes back; Alice turns her camera on and off. At every step Bob must still receive Alice's
 * audio (inbound-rtp packets and audio energy rise) and the element playing it must be unmuted and not paused.
 * Runs at 1280 wide and again at a 390 phone width.
 */
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
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n) => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-voice-'));
const server = spawn(process.execPath, ['dist/server/server/index.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', RECONNECT_GRACE_MS: '1500', REGISTRATIONS_PER_IP_PER_HOUR: '50', CONTACT_EMAIL: '', ADMIN_USERNAMES: '',
    ...(process.env.VQ_TURN ? { TURN_URLS: process.env.VQ_TURN, TURN_USER: process.env.VQ_TURN_USER || '', TURN_PASS: process.env.VQ_TURN_PASS || '', TURN_SECRET: '' } : {}) },
});
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 150 && !log.includes('listening'); i++) await sleep(100);
const URL = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'],
});

async function user(nick, width = 1280) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(width < 500 ? { width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width, height: 800 });
  await page.evaluateOnNewDocument(() => {
    const Orig = RTCPeerConnection;
    window.__pcs = []; window.__sld = 0;
    const sld = Orig.prototype.setLocalDescription;
    Orig.prototype.setLocalDescription = function (...a) { window.__sld++; return sld.apply(this, a); };
    window.__srd = []; const srd = Orig.prototype.setRemoteDescription;
    Orig.prototype.setRemoteDescription = function (d, ...a) { window.__srd.push(`${d?.type}@${Math.round(performance.now())}`); return srd.call(this, d, ...a); };
    window.__ice = 0; const aic = Orig.prototype.addIceCandidate;
    Orig.prototype.addIceCandidate = function (...a) { window.__ice++; return aic.apply(this, a); };
    window.RTCPeerConnection = new Proxy(Orig, { construct(t, a) { const pc = new t(...a); window.__pcs.push(pc); return pc; } });
  });
  if (process.env.VQ_TURN) await page.evaluateOnNewDocument(() => localStorage.setItem('camchat.relay', '1'));
  page.on('pageerror', (e) => console.log(`[${nick} pageerror]`, e.message));
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
  await page.click('.room-card[data-room="lobby"]');
  await page.waitForSelector('.composer, [data-action="composer-plus"]', { timeout: 15000 });
  return page;
}

const until = async (fn, test, ms = 12000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (test(v)) return v; await sleep(250); } return v; };
const audioIn = (page) => page.evaluate(async () => {
  let pk = 0, en = 0, n = 0;
  for (const pc of window.__pcs) {
    if (pc.connectionState !== 'connected') continue;
    const st = await pc.getStats();
    st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') { pk += r.packetsReceived || 0; en += r.totalAudioEnergy || 0; n++; } });
  }
  return { pk, en, n };
});
/** The media element that plays a peer's voice: unmuted, playing, with a live audio track. */
const player = (page, nick) => page.evaluate((nick) => {
  const els = [...document.querySelectorAll('video, audio')].filter((e) => e.srcObject && e.srcObject.getAudioTracks().some((t) => t.readyState === 'live'));
  const mine = els.filter((e) => e.closest(`[data-user="${nick}"]`));
  const e = (mine.length ? mine : els.filter((x) => !x.muted))[0];
  if (!e) return { found: false, count: els.length };
  return { found: true, paused: e.paused, muted: e.muted, volume: e.volume, t: e.currentTime, inStrip: !!e.closest('.media-strip'), connected: e.isConnected };
}, nick);
async function flowing(label, page, nick) {
  const a = await audioIn(page); const p1 = await player(page, nick);
  await sleep(2000);
  const b = await audioIn(page); const p2 = await player(page, nick);
  const rtp = b.pk - a.pk > 40 && b.en > a.en;
  const el = p2.found && !p2.paused && !p2.muted && p2.volume > 0 && (p2.t > p1.t);
  ok(rtp && el, `${label}: audio flows (packets +${b.pk - a.pk}, energy ${a.en.toFixed(3)}->${b.en.toFixed(3)}; element ${JSON.stringify(p2)})`);
  return rtp && el;
}
const setHidden = (page, hidden) => page.evaluate((hidden) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event(hidden ? 'blur' : 'focus'));
  if (hidden) window.dispatchEvent(new Event('pagehide')); else window.dispatchEvent(new Event('pageshow'));
}, hidden);
const stripState = (page) => page.$eval('.media-strip', (e) => e.getAttribute('data-media-strip')).catch(() => null);
const stripInfo = (page) => page.$$eval('.media-strip', (els) => els.map((e) => `${e.getAttribute('data-media-strip')}/${e.getAttribute('data-streaming')}/${Math.round(e.getBoundingClientRect().height)}px`).join(','));

async function run(width, tag) {
  const alice = await user(`Vo_A${tag}`, width);
  const bob = await user(`Vo_B${tag}`, width);
  const A = `Vo_A${tag}`;
  for (const p of [alice, bob]) {
    await p.waitForSelector('[data-action="mic"]:not([disabled])', { timeout: 15000 }).catch(async (e) => { await p.screenshot({ path: `/tmp/voice-fail-${tag}.png` }); throw e; });
    await p.click('[data-action="mic"]');
    await p.waitForSelector('[data-action="mic"].on');
    if (process.env.VGAP) await sleep(Number(process.env.VGAP));
  }
  await until(() => audioIn(bob), (s) => s.pk > 50, 20000);
  if (process.env.VDBG) console.log(await bob.evaluate(async () => { const out = [window.__sld, window.__srd.join(' '), window.__ice]; for (const pc of window.__pcs) { const st = await pc.getStats(); const r = []; st.forEach((x) => { if (x.type === 'inbound-rtp' || x.type === 'outbound-rtp') r.push([x.type, x.kind, x.packetsReceived ?? x.packetsSent]); }); out.push({ s: pc.connectionState, ice: pc.iceConnectionState, tx: pc.getTransceivers().map((t) => t.direction + ':' + t.receiver.track.kind), r }); } return JSON.stringify(out); }));
  await flowing(`${width}px voice only`, bob, A);
  const s0 = await until(() => stripState(bob), (s) => s === 'collapsed', 3000);
  ok(s0 === 'collapsed', `${width}px: with no cameras the strip is collapsed (${await stripInfo(bob)})`);
  if (process.env.VSHOT) await bob.screenshot({ path: `/tmp/voice-nocam-${tag}.png` });
  // Alice's camera on: the strip opens; Bob collapses it
  await alice.click('[data-action="cam"]');
  await alice.waitForSelector('[data-action="cam"].on');
  ok(await until(() => stripState(bob), (s) => s === 'open') === 'open', `${width}px: Alice's camera opens Bob's strip`);
  await flowing(`${width}px camera on, strip open`, bob, A);
  await bob.$eval('[data-action="toggle-strip"]', (b) => b.click());
  ok(await until(() => stripState(bob), (s) => s === 'collapsed') === 'collapsed', `${width}px: Bob collapses the strip`);
  await flowing(`${width}px strip collapsed`, bob, A);
  // tab switch: another tab comes to the front, the room tab reports hidden
  const other = await bob.browserContext().newPage();
  await other.goto('about:blank'); await other.bringToFront();
  await setHidden(bob, true);
  await sleep(1500);
  await flowing(`${width}px strip collapsed + tab hidden`, bob, A);
  await bob.bringToFront(); await setHidden(bob, false); await other.close();
  await flowing(`${width}px back on the tab`, bob, A);
  // Alice's camera off again while Bob's strip is collapsed, then on
  await alice.click('[data-action="cam"]');
  await alice.waitForFunction(() => !document.querySelector('[data-action="cam"].on'));
  await flowing(`${width}px Alice camera off`, bob, A);
  ok(await until(() => stripState(bob), (s) => s === 'collapsed') === 'collapsed', `${width}px: after every camera is off the strip is collapsed`);
  await alice.click('[data-action="cam"]');
  await alice.waitForSelector('[data-action="cam"].on');
  await sleep(1500);
  await flowing(`${width}px Alice camera back on (strip stays as Bob left it)`, bob, A);
  // Bob reopens the strip
  if (await stripState(bob) !== 'open') await bob.$eval('[data-action="toggle-strip"]', (b) => b.click());
  ok(await until(() => stripState(bob), (s) => s === 'open') === 'open', `${width}px: Bob reopens the strip`);
  await flowing(`${width}px strip reopened`, bob, A);
  // and the other direction: Alice hears Bob throughout
  await flowing(`${width}px Alice hears Bob`, alice, `Vo_B${tag}`);
  await alice.browserContext().close(); await bob.browserContext().close();
}

try {
  if (process.env.VDBG) { await run(1280, 'd'); throw new Error('dbg'); }
  await run(1280, 'd');
  await sleep(4000); // the desktop pair's reconnect grace runs out
  await run(390, 'm');
} catch (err) {
  failed++; console.log('FAIL  crashed: ' + (err && err.stack || err));
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
