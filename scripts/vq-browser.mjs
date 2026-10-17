/**
 * Video quality, end to end in real Chrome with fake cameras (two browser contexts, real WebRTC mesh).
 *   npm run build && node scripts/vq-browser.mjs
 * Alice publishes her camera, Bob watches. Checks that Bob's "Pause video" / "Lower quality for me" change
 * only Alice's sender towards Bob (RTCRtpSender parameters), that Alice's presets and Auto step-down apply
 * through setParameters / applyConstraints, and that none of it renegotiates.
 * Where Chrome may not use host candidates (e.g. a WebRtcIPHandling policy), point it at a TURN relay:
 *   VQ_TURN=turn:<ip>:3478?transport=udp VQ_TURN_USER=u VQ_TURN_PASS=p node scripts/vq-browser.mjs
 * (the app's own TURN_URLS / TURN_USER / TURN_PASS settings plus its relay-only switch are used).
 * Batch 4a adds: Alice's background blur swaps in a canvas track with replaceTrack (no renegotiation) and Bob
 * still gets frames; stage mode (Alice is site staff here): Bob as audience cannot publish, even by forcing a
 * sendonly transceiver (the server drops the offer); after Alice brings him up his camera reaches her, and
 * leaving the stage stops his send transceivers.
 */
import './lib/reap.mjs';
import { signUp } from './lib/signup.mjs';
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-vq-'));
const server = spawn(process.execPath, ['dist/server/server/index.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '50', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'Vq_Alice',
    ...(process.env.VQ_TURN ? { TURN_URLS: process.env.VQ_TURN, TURN_USER: process.env.VQ_TURN_USER || '', TURN_PASS: process.env.VQ_TURN_PASS || '', TURN_SECRET: '' } : {}) },
});
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 150 && !log.includes('listening'); i++) await sleep(100);
const URL = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'],
});

async function user(nick) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 800 });
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
  await signUp(page, URL, nick);
  await page.click('.room-card[data-room="lobby"]');
  await page.waitForSelector('.composer, [data-action="composer-plus"]', { timeout: 15000 });
  return page;
}
/** Alice's outgoing video encoding (first connected pc with a live video sender). */
const senderParams = (page) => page.evaluate(() => {
  for (const pc of window.__pcs) {
    if (pc.connectionState !== 'connected') continue;
    const s = pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    if (!s) continue;
    const p = s.getParameters();
    const e = p.encodings?.[0] || {};
    return { active: e.active, maxBitrate: e.maxBitrate ?? null, scale: e.scaleResolutionDownBy ?? null, fps: e.maxFramerate ?? null, trackH: s.track.getSettings().height, hint: s.track.contentHint };
  }
  return null;
});
const until = async (fn, test, ms = 12000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (test(v)) return v; await sleep(250); } return v; };
const inbound = (page) => page.evaluate(async () => {
  for (const pc of window.__pcs) {
    if (pc.connectionState !== 'connected') continue;
    const st = await pc.getStats();
    let out = null;
    st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') out = { frames: r.framesDecoded || 0, h: r.frameHeight || 0, bytes: r.bytesReceived || 0 }; });
    if (out) return out;
  }
  return null;
});

try {
  const alice = await user('Vq_Alice');
  const bob = await user('Vq_Bob');
  // Carol joins before Alice starts her camera: an offer sent while a joiner's room view is still mounting is lost (pre-existing race, see the report)
  const carol = await user('Vq_Carol');
  await alice.waitForSelector('[data-action="cam"]:not([disabled])');
  await alice.click('[data-action="cam"]');
  await alice.waitForSelector('[data-action="cam"].on');
  await alice.click('[data-action="mic"]');
  await alice.waitForSelector('[data-action="mic"].on');
  const tile = '.tile[data-user="Vq_Alice"]';
  const playing = await bob.waitForFunction((t) => { const v = document.querySelector(`${t} video`); return v && v.videoWidth > 0 && !v.paused; }, { timeout: 20000 }, tile).then(() => true, () => false);
  ok(playing, 'Bob receives Alice\'s camera');
  const p0 = await until(() => senderParams(alice), (p) => !!p);
  ok(p0 && p0.active !== false && p0.maxBitrate === null && p0.scale === null, `Auto at the top keeps browser defaults (${JSON.stringify(p0)})`);
  const sldA = await alice.evaluate(() => window.__sld); const sldB = await bob.evaluate(() => window.__sld);

  // ---- Bob: Pause video (audio stays) ----
  await bob.click(`${tile} [data-action="tile-menu"]`);
  await bob.click('.tile-menu [data-action="view-pause"]');
  const pPause = await until(() => senderParams(alice), (p) => p?.active === false);
  ok(pPause?.active === false, 'Bob pauses: Alice stops encoding video for Bob (encoding active=false)');
  const bobTile = await bob.evaluate((t) => ({ paused: !!document.querySelector(`${t} [data-view-paused="1"]`), muted: document.querySelector(`${t} video`)?.muted, audio: document.querySelector(`${t} video`)?.srcObject?.getAudioTracks().filter((x) => x.readyState === 'live').length }), tile);
  ok(bobTile.paused && bobTile.muted === false && bobTile.audio === 1, 'Bob\'s tile says paused, Alice\'s audio track still plays');
  const f1 = await inbound(bob); await sleep(2500); const f2 = await inbound(bob);
  ok(f1 && f2 && f2.frames - f1.frames <= 3, `no video frames reach Bob while paused (${f1?.frames} -> ${f2?.frames})`);
  await bob.click(`${tile} [data-action="tile-menu"]`);
  await bob.click('.tile-menu [data-action="view-pause"]');
  const pRes = await until(() => senderParams(alice), (p) => p?.active === true);
  ok(pRes?.active === true, 'Bob resumes: Alice\'s encoding for Bob is active again');
  const f3 = await inbound(bob); await sleep(2500); const f4 = await inbound(bob);
  ok(f4.frames - f3.frames > 10, `video frames flow again (${f3.frames} -> ${f4.frames})`);

  // ---- Bob: Lower quality for me ----
  await bob.click(`${tile} [data-action="tile-menu"]`);
  await bob.click('.tile-menu [data-action="view-low"]');
  const pLow = await until(() => senderParams(alice), (p) => p?.maxBitrate === 400000);
  ok(pLow?.maxBitrate === 400000 && pLow.fps === 20 && pLow.scale >= 1.3, `Bob asks for lower: Alice caps her sender to Bob at Low (${JSON.stringify(pLow)})`);
  const hLow = await until(() => inbound(bob), (s) => s && s.h > 0 && s.h <= 362, 15000);
  ok(hLow && hLow.h <= 362, `Bob now receives ≤360p (${hLow?.h}p)`);
  ok(await bob.$(`${tile} [data-view-low="1"]`), 'Bob\'s tile shows a "Low" chip');
  await bob.click(`${tile} [data-action="tile-menu"]`);
  await bob.click('.tile-menu [data-action="view-low"]');
  const pFull = await until(() => senderParams(alice), (p) => p?.maxBitrate === null);
  ok(pFull?.maxBitrate === null && pFull.scale === null, 'Back to full quality restores the defaults');

  // ---- Alice: presets ----
  await alice.click('[data-action="av-settings"]');
  await alice.waitForSelector('[data-action="av-quality"]');
  await alice.select('[data-action="av-quality"]', 'saver');
  const pSaver = await until(() => senderParams(alice), (p) => p?.fps === 15 && p.trackH <= 240 && p.scale === 1);
  ok(pSaver?.fps === 15 && pSaver.maxBitrate === 150000 && pSaver.scale === 1, `Data saver: 15 fps, 150 kbps, no extra scaling once the capture is 240p (${JSON.stringify(pSaver)})`);
  ok(pSaver?.trackH <= 240, `Data saver: capture constrained to 240p via applyConstraints (${pSaver?.trackH}p)`);
  await alice.select('[data-action="av-quality"]', 'high');
  const pHigh = await until(() => senderParams(alice), (p) => p?.maxBitrate === 1500000);
  ok(pHigh?.maxBitrate === 1500000 && pHigh.fps === 30, `High: 1.5 Mbps, 30 fps (${JSON.stringify(pHigh)}; fake camera gives ${pHigh?.trackH}p)`);
  await alice.select('[data-action="av-quality"]', 'auto');
  await alice.keyboard.press('Escape');
  const pAuto = await until(() => senderParams(alice), (p) => p?.maxBitrate === null);
  ok(pAuto?.maxBitrate === null, 'back to Auto: defaults again');

  // ---- Auto step-down (sample override) ----
  await alice.evaluate(() => localStorage.setItem('camchat.vqDebug', JSON.stringify({ sample: { limitation: 'bandwidth', lossPct: 5, rttMs: 250, availBps: 200000 }, intervalMs: 300 })));
  // the controller reads the override on its next tick; restart it by toggling Auto -> Low -> Auto
  await alice.click('[data-action="av-settings"]');
  await alice.waitForSelector('[data-action="av-quality"]');
  await alice.select('[data-action="av-quality"]', 'low');
  await sleep(200);
  await alice.select('[data-action="av-quality"]', 'auto');
  await alice.keyboard.press('Escape');
  const pStep = await until(() => senderParams(alice), (p) => p?.maxBitrate === 150000, 20000);
  ok(pStep?.maxBitrate === 150000, `Auto on a weak link steps Alice down to Data saver (${JSON.stringify(pStep)})`);
  const note = await alice.$eval('[data-vq-notice="1"]', (e) => e.textContent).catch(() => '');
  ok(note === 'Lowered quality: weak connection', `Alice sees "${note}" on her own tile`);
  ok(!(await bob.$('[data-vq-notice="1"]')), 'Bob does not see Alice\'s note');
  await alice.evaluate(() => localStorage.removeItem('camchat.vqDebug'));

  ok((await alice.evaluate(() => window.__sld)) === sldA && (await bob.evaluate(() => window.__sld)) === sldB, 'none of the quality changes renegotiated (no new setLocalDescription)');
  ok((await inbound(bob)).frames > f4.frames, 'Bob still receives video at the end');

  // ---- batch 4a: background blur reaches the peer (replaceTrack, no renegotiation) ----
  await alice.evaluate(() => localStorage.setItem('camchat.bgDebug', JSON.stringify({ noSlow: true })));
  const sendTrack = (page) => page.evaluate(() => {
    for (const pc of window.__pcs) {
      if (pc.connectionState !== 'connected') continue;
      const s = pc.getSenders().find((x) => x.track && x.track.kind === 'video');
      if (s) return { label: s.track.label, id: s.track.id, live: s.track.readyState === 'live', w: s.track.getSettings().width ?? 0, tx: pc.getTransceivers().length };
    }
    return null;
  });
  const t0 = await sendTrack(alice);
  ok(!!t0?.label, `before: Alice sends her camera track (${t0?.label})`);
  const txCount = (page) => page.evaluate(() => window.__pcs.filter((p) => p.connectionState !== 'closed').map((p) => p.getTransceivers().length).join());
  const tx0A = await txCount(alice); const tx0B = await txCount(bob);
  await alice.click('[data-action="av-settings"]');
  await alice.waitForSelector('[data-action="bg-blur-strong"]');
  await alice.evaluate(() => document.querySelector('[data-action="bg-blur-strong"]')?.click());
  await alice.keyboard.press('Escape');
  const t1 = await until(() => sendTrack(alice), (t) => t && t.id !== t0.id && t.label !== t0.label && t.live, 40000);
  ok(t1 && t1.id !== t0.id && t1.label !== t0.label && t1.live, `with Blur strong Alice sends a processed (canvas) track, not the camera (${JSON.stringify(t1)})`);
  const g1 = await inbound(bob); await sleep(3000); const g2 = await inbound(bob);
  ok(g1 && g2 && g2.frames - g1.frames > 10 && g2.h > 0, `the blurred track reaches Bob (${g1?.frames} -> ${g2?.frames} frames, ${g2?.h}p)`);
  const own = await alice.evaluate(() => { const v = document.querySelector('.tile[data-user="Vq_Alice"] video'); return v?.srcObject?.getVideoTracks?.()[0]?.id ?? 'none'; });
  ok(own === t1?.id, `Alice's own tile shows the processed track too`);
  const tx1A = await txCount(alice); const tx1B = await txCount(bob);
  ok(tx1A === tx0A && tx1B === tx0B, `the swap used replaceTrack: no new transceivers on either side (${tx0A} -> ${tx1A}, ${tx0B} -> ${tx1B})`);
  await alice.click('[data-action="av-settings"]');
  await alice.waitForSelector('[data-action="bg-off"]');
  await alice.evaluate(() => document.querySelector('[data-action="bg-off"]')?.click());
  await alice.keyboard.press('Escape');
  const t2 = await until(() => sendTrack(alice), (t) => t?.label === t0.label);
  ok(t2?.label === t0.label && t2.tx === t0.tx, 'Background Off puts the camera track back (same transceiver)');

  // ---- batch 4a: stage mode ----
  await alice.evaluate(() => document.querySelector('[data-action="tab-info"]')?.click());
  await alice.waitForSelector('[data-action="stage-toggle"]', { timeout: 6000 });
  await alice.evaluate(() => document.querySelector('[data-action="stage-toggle"]')?.click());
  await bob.waitForSelector('[data-action="stage-hand"]', { timeout: 6000 }).catch(() => {});
  const bUi = await bob.evaluate(() => ({ cam: document.querySelector('[data-action="cam"]')?.disabled, mic: document.querySelector('[data-action="mic"]')?.disabled, hand: !!document.querySelector('[data-action="stage-hand"]') }));
  ok(bUi.cam && bUi.mic && bUi.hand, `Bob (audience) sees cam / mic locked and Raise hand (${JSON.stringify(bUi)})`);
  ok(await until(() => inbound(bob).then((x) => x?.frames ?? 0), (n) => n > g2.frames), 'the audience still receives the speaker');
  // force a publish around the UI, from a third person's page (Carol, audience): a sendonly transceiver with a camera track
  const carolGets = await until(() => inbound(carol).then((x) => x?.frames ?? 0), (n) => n > 10, 25000);
  if (!(carolGets > 10)) {
    const dumpC = (page) => page.evaluate(() => window.__pcs.map((p) => ({ cs: p.connectionState, ice: p.iceConnectionState, ss: p.signalingState, tx: p.getTransceivers().map((t) => `${t.mid}:${t.direction}/${t.currentDirection}:${t.sender.track?.kind ?? '-'}`) })));
    console.log('debug carol', JSON.stringify(await dumpC(carol)), 'room', await carol.evaluate(() => location.href), 'tile', await carol.evaluate(() => !!document.querySelector('.tile[data-user="Vq_Alice"]')), 'srd', await carol.evaluate(() => JSON.stringify([window.__srd, window.__ice, Math.round(performance.now())])));
    console.log('debug alice', JSON.stringify(await dumpC(alice)));
  }
  ok(carolGets > 10, 'Carol (audience) receives Alice');
  const aliceRecv = () => alice.evaluate(async () => {
    let frames = 0, recv = 0;
    for (const pc of window.__pcs) {
      if (pc.connectionState === 'closed') continue;
      recv += pc.getTransceivers().filter((t) => t.receiver.track?.kind === 'video' && (t.currentDirection === 'recvonly' || t.currentDirection === 'sendrecv')).length;
      (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') frames += r.framesDecoded || 0; });
    }
    return { frames, recv };
  });
  const before = await aliceRecv();
  const forced = await carol.evaluate(async () => {
    const pc = window.__pcs.find((p) => p.connectionState === 'connected');
    if (!pc) return 'no pc';
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    pc.addTransceiver(s.getVideoTracks()[0], { direction: 'sendonly' });
    return 'added';
  });
  await sleep(5000);
  const after = await aliceRecv();
  const carolSig = await carol.evaluate(() => window.__pcs.find((p) => p.connectionState !== 'closed')?.signalingState);
  ok(forced === 'added' && after.recv === before.recv && after.frames === before.frames, `a forced sendonly offer from the audience never reaches Alice (recv ${before.recv} -> ${after.recv}, frames ${before.frames} -> ${after.frames}, Carol's pc ${carolSig})`);
  ok(!(await alice.$('.tile[data-user="Vq_Carol"] video')), 'Alice has no video tile for Carol');
  await carol.browserContext().close();
  // the normal way up: Bob raises his hand, Alice approves
  await bob.click('[data-action="stage-hand"]');
  await alice.waitForSelector('[data-action="stage-approve"]', { timeout: 8000 });
  await alice.evaluate(() => document.querySelector('[data-action="stage-approve"]')?.click());
  await bob.waitForSelector('[data-action="cam"]:not([disabled])', { timeout: 8000 });
  await bob.click('[data-action="cam"]');
  const bobUp = await alice.waitForFunction(() => { const v = document.querySelector('.tile[data-user="Vq_Bob"] video'); return v && v.videoWidth > 0 && !v.paused; }, { timeout: 25000 }).then(() => true, () => false);
  if (!bobUp) {
    const dump = (page) => page.evaluate(() => window.__pcs.map((p) => ({ cs: p.connectionState, ss: p.signalingState, tx: p.getTransceivers().map((t) => `${t.mid}:${t.direction}/${t.currentDirection}:${t.sender.track?.kind ?? '-'}`) })));
    console.log('debug bob', JSON.stringify(await dump(bob)));
    console.log('debug alice', JSON.stringify(await dump(alice)));
    console.log('debug bob cam', await bob.evaluate(() => !!document.querySelector('[data-action="cam"].on')), 'alice tile', await alice.evaluate(() => !!document.querySelector('.tile[data-user="Vq_Bob"]')));
  }
  ok(bobUp, 'after Alice brings Bob up, his camera reaches her');
  await bob.waitForSelector('[data-action="stage-leave"]', { timeout: 5000 });
  await bob.click('[data-action="stage-leave"]');
  const down = await until(() => bob.evaluate(() => ({
    cam: !!document.querySelector('[data-action="cam"].on'), locked: !!document.querySelector('[data-action="cam"][disabled]'),
    sending: window.__pcs.filter((p) => p.connectionState !== 'closed').reduce((n, p) => n + p.getTransceivers().filter((t) => !t.stopped && t.direction !== 'stopped' && (t.direction === 'sendonly' || t.direction === 'sendrecv')).length, 0),
  })), (d) => !d.cam && d.locked && d.sending === 0, 10000);
  ok(down && !down.cam && down.locked && down.sending === 0, `leaving the stage turns Bob's cam off and stops his send transceivers (${JSON.stringify(down)})`);
  const gone = await alice.waitForFunction(() => !document.querySelector('.tile[data-user="Vq_Bob"]'), { timeout: 10000 }).then(() => true, () => false);
  ok(gone, 'Alice no longer shows a tile for Bob');
  ok(await until(() => inbound(bob).then((x) => x?.frames ?? 0), (n) => n > 30, 15000), 'as audience again, Bob still receives Alice');
  await alice.evaluate(() => document.querySelector('[data-action="tab-info"]')?.click());
  await alice.evaluate(() => { const t = document.querySelector('[data-action="stage-toggle"]'); if (t?.checked) t.click(); });
} catch (e) {
  failed++;
  console.log('FAIL  exception:', e.stack || e.message);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
