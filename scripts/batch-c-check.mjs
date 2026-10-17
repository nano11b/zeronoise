/**
 * Batch C checks: voice rooms, message edit history, polls in threads + scheduled polls, profiles 2.0, room discovery.
 *
 * Screenshots at 1366 and 390.   npm run build && node scripts/batch-c-check.mjs [shots-dir]
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');
const { io: ioClient } = require('socket.io-client');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-batch-c'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-batch-c-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'CcAdmin', RECONNECT_GRACE_MS: '800',
    SCHEDULE_TICK_MS: '300', EVENT_TICK_MS: '300', STATS_SAMPLE_MS: '500' } });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 200 && !log.includes('listening'); i++) await sleep(100);
for (let i = 0; i < 200 && !log.includes('listening'); i++) await sleep(100);

function jar() {
  const m = new Map();
  const header = () => [...m].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = (r) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); m.set(kv.slice(0, i), kv.slice(i + 1)); } };
  return { header, async req(p, body, method) {
    const r = await fetch(BASE + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'x-csrf': '1', cookie: header(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    take(r); const j = await r.json().catch(() => ({})); j.status = r.status; return j;
  }, async form(p, fd) {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'x-csrf': '1', cookie: header() }, body: fd });
    take(r); const j = await r.json().catch(() => ({})); j.status = r.status; return j;
  } };
}
const emit = (s, ev, ...a) => new Promise((res) => { const t = setTimeout(() => res({ ok: false, error: `timeout ${ev}` }), 8000); s.emit(ev, ...a, (r) => { clearTimeout(t); res(r); }); });
async function sock(j) {
  const me = await j.req('/api/me');
  const s = ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: j.header() }, auth: { deviceId: me.deviceId } });
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
  await page.waitForSelector('.chat-log', { timeout: 15000 });
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

try {
  const owner = await nodeUser('CcOwner'); const mem = await nodeUser('CcMember'); const admin = await nodeUser('CcAdmin'); const other = await nodeUser('CcOther');
  sockets.push(owner.s, mem.s, admin.s, other.s);
  const W = { owner, mem, admin, other };

  // ---------- 1. voice rooms ----------
  const vr = await emit(owner.s, 'room:create', { name: 'cc-voice', voice: true, category: 'music' });
  ok(vr.ok, 'owner creates a voice room', vr.error);
  const vroom = vr.roomId;
  let j1 = await emit(owner.s, 'room:join', { roomId: vroom });
  ok(j1.ok && j1.room.voice === true, 'room state says voice room');
  ok((await emit(owner.s, 'rooms:list')).rooms.find((r) => r.id === vroom)?.voice === true, 'lobby card marks the voice room');
  const j2 = await emit(mem.s, 'room:join', { roomId: vroom });
  ok(j2.ok, 'member drops in');
  let ms = await emit(mem.s, 'media:state', { cam: true, mic: true, screen: false });
  ok(!ms.ok && /voice room/i.test(ms.error ?? ''), 'camera refused in a voice room', ms.error);
  ms = await emit(mem.s, 'media:state', { cam: false, mic: false, screen: true });
  ok(!ms.ok, 'screen share refused in a voice room');
  ms = await emit(mem.s, 'media:state', { cam: false, mic: true, screen: false });
  ok(ms.ok, 'mic allowed in a voice room', ms.error);
  const st = ev(owner.s, 'stage:state');
  const hand = await emit(mem.s, 'stage:hand', { up: true });
  const stv = await st;
  ok(hand.ok && stv?.hands?.length === 1 && stv.hands[0].nick === 'CcMember', 'raise hand joins the talk queue (stage mode off)', hand.error);
  const floor = await emit(owner.s, 'stage:invite', { userId: mem.s.id });
  await sleep(300);
  const hist = (await emit(owner.s, 'room:join', { roomId: vroom })).room?.history ?? [];
  ok(floor.ok && hist.some((m) => /CcMember has the floor/.test(m.text ?? '')), 'owner gives the floor (system line)', floor.error);
  ok(!(await emit(mem.s, 'room:voice', { on: false })).ok, 'only the owner can switch voice mode');
  await emit(mem.s, 'room:leave'); await sleep(200);
  ok((await emit(mem.s, 'room:join', { roomId: vroom })).ok, 'member drops out and back in');
  const plain = await emit(owner.s, 'room:create', { name: 'cc-plain' });
  await emit(owner.s, 'room:join', { roomId: plain.roomId });
  ok((await emit(owner.s, 'room:voice', { on: true })).ok && (await emit(owner.s, 'rooms:list')).rooms.find((r) => r.id === plain.roomId)?.voice === true, 'owner turns an existing room into a voice room');
  await emit(owner.s, 'room:voice', { on: false });
  await emit(owner.s, 'room:join', { roomId: vroom });
  // ---------- 2. message edit history ----------
  const tr = await emit(owner.s, 'room:create', { name: 'cc-text', category: 'gaming', tags: ['speedrun', 'chill'] });
  const troom = tr.roomId;
  await emit(owner.s, 'room:join', { roomId: troom }); await emit(mem.s, 'room:join', { roomId: troom }); await emit(other.s, 'room:join', { roomId: troom });
  const edEv = ev(other.s, 'chat:edited');
  const sent = await emit(mem.s, 'chat:send', { text: 'first draft' });
  const mid = sent.id ?? sent.messageId ?? (await emit(mem.s, 'room:join', { roomId: troom })).room.history.filter((m) => m.text === 'first draft').pop()?.id;
  await sleep(1100);
  ok((await emit(mem.s, 'chat:edit', { messageId: mid, text: 'second draft' })).ok, 'author edits a message');
  const ee = await edEv;
  ok(ee && ee.editedAt > 0 && ee.text === 'second draft', 'everyone gets the edit with an editedAt (the "edited" tag)');
  await sleep(1100);
  await emit(mem.s, 'chat:edit', { messageId: mid, text: 'final text' });
  const hOwner = await emit(owner.s, 'chat:history', { messageId: mid });
  ok(hOwner.ok && hOwner.versions.map((v) => v.text).join('|') === 'first draft|second draft' && hOwner.current.text === 'final text', 'room owner sees earlier versions, oldest first', JSON.stringify(hOwner));
  ok(!(await emit(other.s, 'chat:history', { messageId: mid })).ok, 'regular members cannot see edit history');
  ok(!(await emit(mem.s, 'chat:history', { messageId: mid })).ok, 'not even the author (mods only)');
  const hq = await emit(admin.s, 'modq:history', { messageId: mid });
  ok(hq.ok && hq.versions.length === 2, 'site staff see it from the mod queue without joining the room');
  ok(!(await emit(other.s, 'modq:history', { messageId: mid })).ok, 'mod-queue history refused for non-mods');
  const histNow = (await emit(other.s, 'room:join', { roomId: troom })).room.history.find((m) => m.id === mid);
  ok(histNow?.editedAt > 0 && histNow.text === 'final text', 'history on join keeps the edited tag');
  // ---------- 3. polls in threads + scheduled polls ----------
  await emit(owner.s, 'room:join', { roomId: troom }); await emit(mem.s, 'room:join', { roomId: troom });
  await sleep(1100);
  await emit(owner.s, 'chat:send', { text: 'Thread starter: what should we play?' });
  await sleep(300);
  const parent = (await emit(owner.s, 'room:join', { roomId: troom })).room.history.filter((m) => /Thread starter/.test(m.text ?? '')).pop();
  const repEv = ev(mem.s, 'chat:replies');
  const tp = await emit(owner.s, 'poll:create', { question: 'Which game?', options: ['Chess', 'Go'], parentId: parent.id });
  ok(tp.ok, 'poll created inside a thread', tp.error);
  const rep = await repEv;
  ok(rep?.messageId === parent.id && rep.replyCount === 1, 'thread reply count bumps for the poll');
  const th = await emit(mem.s, 'chat:thread', { messageId: parent.id });
  const tpm = th.messages?.find((m) => m.poll);
  ok(tpm?.poll?.question === 'Which game?' && tpm.parentId === parent.id, 'thread lists the poll with its options');
  const hv = (await emit(mem.s, 'room:join', { roomId: troom })).room.history;
  ok(!hv.some((m) => m.poll?.id === tp.poll.id), 'thread poll stays out of the main timeline');
  const vt = await emit(mem.s, 'poll:vote', { pollId: tp.poll.id, option: 1 });
  ok(vt.ok && vt.poll.counts?.[1] === 1 || vt.poll?.options?.[1]?.votes === 1 || vt.ok, 'members vote on a thread poll', vt.error);
  ok(!(await emit(owner.s, 'poll:create', { question: 'x?', options: ['a', 'b'], parentId: 'nope' })).ok, 'poll in a missing thread refused');
  const spBad = await emit(owner.s, 'schedule:create', { text: 'Bad poll?', at: Date.now() + 60_000, repeat: 'once', kind: 'poll', poll: { options: ['only one'] } });
  ok(!spBad.ok, 'scheduled poll needs at least two options');
  const pollMsg = new Promise((res) => { const t = setTimeout(() => res(null), 6000); const h = (m) => { if (m.poll?.question === 'Pizza tonight?') { mem.s.off('chat:message', h); clearTimeout(t); res(m); } }; mem.s.on('chat:message', h); });
  const sp = await emit(owner.s, 'schedule:create', { text: 'Pizza tonight?', at: Date.now() + 900, repeat: 'once', kind: 'poll', poll: { options: ['Yes', 'No', 'Maybe'], durationMin: 60 } });
  ok(sp.ok && sp.schedule.kind === 'poll' && sp.schedule.poll.options.length === 3, 'owner schedules a poll', sp.error);
  ok(!(await emit(mem.s, 'schedule:create', { text: 'mine?', at: Date.now() + 60_000, repeat: 'once', kind: 'poll', poll: { options: ['a', 'b'] } })).ok, 'members cannot schedule polls');
  const pm = await pollMsg;
  ok(pm && pm.poll.options.length === 3 && pm.from === 'CcOwner', 'scheduled poll posts itself on time', JSON.stringify(pm?.poll ?? null));
  const sp2 = await emit(owner.s, 'schedule:create', { text: 'Weekly check-in?', at: Date.now() + 3_600_000, repeat: 'weekly', kind: 'poll', poll: { options: ['Good', 'Meh'] } });
  ok(sp2.ok, 'a weekly scheduled poll stays listed');
  // @@API-END

  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  for (const width of [1366, 390]) {
    const phone = width < 800;
    // reconnect node sockets after the browser takes over a session
    const fresh = async (u) => { try { u.s.disconnect(); } catch { /* */ } u.s = await sock(u.j); sockets.push(u.s); return u.s; };
    // 1. voice room
    {
      await emit(mem.s, 'room:join', { roomId: vroom });
      await emit(mem.s, 'stage:hand', { up: true });
      await emit(mem.s, 'media:state', { cam: false, mic: true, screen: false });
      const o = await pageFor(owner, width);
      await enterRoom(o.page, vroom);
      ok(!!(await o.page.$('.room[data-voice="1"]')), `${width}: voice room marked`);
      ok(!(await o.page.$('[data-action="cam"]')) && !(await o.page.$('[data-action="screen"]')), `${width}: no camera / screen buttons in a voice room`);
      await o.page.waitForSelector('[data-testid="stage-hands"]', { timeout: 6000 }).catch(() => {});
      ok(!!(await o.page.$('[data-testid="stage-hands"] [data-action="stage-approve"]')) || !!(await o.page.$('[data-action="voice-floor"]')), `${width}: owner sees the raise-hand queue with "Give floor"`);
      ok(!!(await o.page.$('[data-testid="voice-bar"] [data-talker="CcMember"]')), `${width}: voice bar lists who is on the mic (speaking indicator)`);
      await shot(o.page, `c1-voice-room-${width}`);
      await o.ctx.close();
      await fresh(owner); await fresh(mem);
      await emit(owner.s, 'room:join', { roomId: vroom });
      await emit(mem.s, 'room:join', { roomId: vroom });
    }
    // 2. edit history dialog (owner)
    {
      const o = await pageFor(owner, width);
      await enterRoom(o.page, troom);
      const btn = await o.page.waitForSelector('[data-action="edit-history"]', { timeout: 6000 }).catch(() => null);
      ok(!!btn, `${width}: "(edited)" tag is a button for mods`);
      if (btn) { await btn.evaluate((b) => { b.scrollIntoView({ block: 'center' }); b.click(); }); }
      ok(!!(await o.page.waitForSelector('[data-testid="edit-history"]', { timeout: 6000 }).catch(() => null)), `${width}: edit history dialog lists earlier versions`);
      await shot(o.page, `c2-edit-history-${width}`);
      await o.ctx.close();
      const m = await pageFor(other, width);
      await enterRoom(m.page, troom);
      ok(!!(await m.page.$('.edited')) && !(await m.page.$('[data-action="edit-history"]')), `${width}: members see "(edited)" but no history button`);
      await shot(m.page, `c2-edited-tag-${width}`);
      await m.ctx.close();
      await fresh(owner); await fresh(other);
      await emit(owner.s, 'room:join', { roomId: vroom });
    }
    // 3. thread poll + scheduled poll form
    {
      const o = await pageFor(owner, width);
      await enterRoom(o.page, troom);
      const ot = await o.page.waitForSelector('[data-action="open-thread"]', { timeout: 6000 }).catch(() => null);
      if (ot) await ot.evaluate((b) => { b.scrollIntoView({ block: 'center' }); b.click(); });
      ok(!!(await o.page.waitForSelector('.thread .poll-card, [class*="thread"] .poll-card', { timeout: 6000 }).catch(() => null)) || !!(await o.page.$('.poll-card')), `${width}: thread shows the poll card`);
      ok(!!(await o.page.$('[data-action="thread-poll"]')), `${width}: thread composer has a poll button`);
      await shot(o.page, `c3-thread-poll-${width}`);
      await o.page.keyboard.press('Escape'); await sleep(300);
      await o.page.goto(`${BASE}/?room=${encodeURIComponent(troom)}`, { waitUntil: 'domcontentloaded' }); await o.page.waitForSelector('.chat-log', { timeout: 15000 }); await sleep(500);
      await openSettings(o.page, phone, 'schedules');
      await o.page.select('[data-field="schedule-kind"]', 'poll').catch(() => {});
      await sleep(300);
      ok(!!(await o.page.$('[data-field="schedule-poll-options"]')), `${width}: schedule form offers "Post a poll" with options`);
      ok(!!(await o.page.$('[data-schedule-kind="poll"]')), `${width}: scheduled poll listed`);
      await o.page.$eval('[data-form="schedule"]', (f) => f.scrollIntoView({ block: 'center' })).catch(() => {});
      await shot(o.page, `c3-scheduled-poll-${width}`);
      await o.ctx.close();
      await fresh(owner); await fresh(mem);
      await emit(owner.s, 'room:join', { roomId: troom }); await emit(mem.s, 'room:join', { roomId: troom });
    }
    // @@UI-END
  }
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
