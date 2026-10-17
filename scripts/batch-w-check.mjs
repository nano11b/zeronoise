/**
 * Batch W checks: private conversations (whispers) — groups, calls, files, voice notes, reactions/replies/edits,
 * typing, disappearing messages, pin/archive, message requests, block and report.
 *
 * Screenshots at 1366 and 390.   npm run build && node scripts/batch-w-check.mjs [shots-dir]
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
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');
const { io: ioClient } = require('socket.io-client');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-batch-w'));
fs.mkdirSync(OUT, { recursive: true });
import crypto from 'node:crypto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-batch-w-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'WwAdmin', DM_SWEEP_MS: '700', RECORDING_MAX_BYTES: '400000', RECORDING_SWEEP_MS: '1500', ONBOARDING_SINCE: '0', RECORDING_IDLE_MS: '6000', RECONNECT_GRACE_MS: '800',
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
const befriend = async (a, b) => { await emit(a.s, 'friends:request', { username: b.nick }); await emit(b.s, 'friends:respond', { userId: a.id, accept: true }); };
const events = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
const waitFor = async (fn, ms = 4000) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); } return !!fn(); };
const R = crypto.randomBytes(2).toString('hex');
try {
  const A = await nodeUser(`WwA${R}`), B = await nodeUser(`WwB${R}`), C = await nodeUser(`WwC${R}`), D = await nodeUser(`WwD${R}`);
  sockets.push(A.s, B.s, C.s, D.s);
  await befriend(A, B); await befriend(A, C); await befriend(A, D);
  // @@W1-1
  {
    const bConvo = events(B.s, 'dm:convo'), bMsg = events(B.s, 'dm:message');
    const d = await emit(A.s, 'dm:start', { usernames: [B.nick] });
    ok(d.ok && d.convo.kind === 'direct', 'W1-1: start a direct whisper', d.error);
    const again = await emit(A.s, 'dm:start', { usernames: [B.nick] });
    ok(again.ok && again.convo.id === d.convo.id, 'W1-1: starting again reopens the same conversation');
    const s1 = await emit(A.s, 'dm:send', { convoId: d.convo.id, text: `hello ${R} zebra` });
    ok(s1.ok && await waitFor(() => bMsg.some((m) => m.text.includes('zebra'))), 'W1-1: message reaches the other side live');
    const tooSmall = await emit(A.s, 'dm:start', { usernames: [B.nick, A.nick], name: 'x' });
    ok(!tooSmall.ok || tooSmall.convo.kind === 'direct', 'W1-1: a group needs at least 3 different people');
    const noName = await emit(A.s, 'dm:start', { usernames: [B.nick, C.nick] });
    ok(!noName.ok, 'W1-1: a group needs a name', noName.error);
    const g = await emit(A.s, 'dm:start', { usernames: [B.nick, C.nick], name: `Crew ${R}` });
    ok(g.ok && g.convo.kind === 'group' && g.convo.members.length === 3, 'W1-1: create a named group of 3', g.error);
    globalThis.GROUP = g.convo.id; globalThis.DIRECT = d.convo.id;
    ok(await waitFor(() => bConvo.some((c) => c.id === g.convo.id)), 'W1-1: members get the new group live');
    const notOwner = await emit(B.s, 'dm:group:add', { convoId: g.convo.id, username: D.nick });
    ok(!notOwner.ok, 'W1-1: only the creator adds people');
    const add = await emit(A.s, 'dm:group:add', { convoId: g.convo.id, username: D.nick });
    ok(add.ok, 'W1-1: creator adds a person', add.error);
    const ren = await emit(A.s, 'dm:group:rename', { convoId: g.convo.id, name: `Crew2 ${R}` });
    ok(ren.ok, 'W1-1: creator renames the group', ren.error);
    const rem = await emit(A.s, 'dm:group:remove', { convoId: g.convo.id, userId: D.id });
    ok(rem.ok, 'W1-1: creator removes a person', rem.error);
    const dOpen = await emit(D.s, 'dm:open', { convoId: g.convo.id });
    ok(!dOpen.ok, 'W1-1: a removed person can no longer open the group');
    await emit(B.s, 'dm:send', { convoId: g.convo.id, text: `group line ${R} quokka` });
    const op = await emit(C.s, 'dm:open', { convoId: g.convo.id });
    ok(op.ok && op.messages.some((m) => m.text.includes('quokka')) && op.messages.some((m) => m.kind === 'system'), 'W1-1: history persists, with system notices for changes');
    const srch = await emit(C.s, 'dm:search', { q: 'quokka' });
    ok(srch.ok && srch.results.length === 1, 'W1-1: search finds my conversations', srch.error);
    const srchD = await emit(D.s, 'dm:search', { q: 'quokka' });
    ok(srchD.ok && srchD.results.length === 0, 'W1-1: search never shows conversations I am not in');
    const aRead = events(A.s, 'dm:read');
    const last = op.messages[op.messages.length - 1];
    await emit(C.s, 'dm:read', { convoId: g.convo.id, ts: last.ts });
    ok(await waitFor(() => aRead.some((r) => r.userId === C.id)), 'W1-1: read receipts reach the group');
    const http404 = await D.j.req(`/api/dm/files/nope`);
    ok(http404.status === 404, 'W1-1: file route hides unknown files');
    const lv = await emit(C.s, 'dm:leave', { convoId: g.convo.id });
    ok(lv.ok, 'W1-1: a member can leave');
    const ex = await A.j.req('/api/me/export', { format: 'json' });
    ok(Array.isArray(ex.conversations) && ex.conversations.length >= 2, 'W1-1: data export includes conversations', JSON.stringify(Object.keys(ex)).slice(0, 120));
  }
  // @@W1-2
  {
    const g2 = await emit(A.s, 'dm:start', { usernames: [B.nick, C.nick], name: `Call crew ${R}` });
    globalThis.GROUP2 = g2.convo.id;
    const bRing = events(B.s, 'call:incoming'), cRing = events(C.s, 'call:incoming'), dRing = events(D.s, 'call:incoming');
    const c1 = await emit(A.s, 'dm:call', { convoId: g2.convo.id, video: true });
    ok(c1.ok && c1.rang === 2 && c1.room?.id, 'W1-2: one tap rings everyone in the group', c1.error);
    ok(await waitFor(() => bRing.length && cRing.length) && bRing[0].convoId === g2.convo.id && bRing[0].video === true && !!bRing[0].group, 'W1-2: ring says who, which group and video');
    ok(dRing.length === 0, 'W1-2: people outside the conversation are not rung');
    const dec = await emit(C.s, 'call:respond', { roomId: c1.roomId, accept: false });
    const acc = await emit(B.s, 'call:respond', { roomId: c1.roomId, accept: true });
    ok(dec.ok && acc.ok && acc.room?.id === c1.roomId, 'W1-2: one person declining keeps the group call going for the rest', acc.error);
    const dj = await emit(D.s, 'room:join', { roomId: c1.roomId });
    ok(!dj.ok, 'W1-2: outsiders cannot join the call room');
    const late = await emit(C.s, 'room:join', { roomId: c1.roomId });
    ok(late.ok, 'W1-2: a group member can still join after declining', late.error);
    for (const u of [A, B, C]) await emit(u.s, 'room:leave', {});
    const op = await emit(B.s, 'dm:open', { convoId: g2.convo.id });
    ok(op.messages.some((m) => m.kind === 'system' && /started a video call/.test(m.text)), 'W1-2: the call shows in the conversation');
    const d1 = await emit(B.s, 'dm:call', { convoId: globalThis.DIRECT, video: false });
    ok(d1.ok && d1.rang === 1, 'W1-2: 1:1 voice call from a whisper', d1.error);
    await emit(A.s, 'call:respond', { roomId: d1.roomId, accept: false });
    await emit(B.s, 'room:leave', {});
  }
  // @@W1-3
  {
    const up = (u, convo, buf, type, name) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name); return u.j.form(`/api/dm/${convo}/files`, fd); };
    const jpg = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#3366cc' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'SECRET-EXIF', Artist: 'Someone' } } }).toBuffer();
    ok(jpg.includes(Buffer.from('SECRET-EXIF')), 'W1-3: (test image carries EXIF)');
    const r1 = await up(A, globalThis.DIRECT, jpg, 'image/jpeg', 'holiday.jpg');
    ok(r1.ok && r1.file?.image, 'W1-3: upload an image', r1.error);
    const s1 = await emit(A.s, 'dm:send', { convoId: globalThis.DIRECT, fileId: r1.file?.id });
    ok(s1.ok, 'W1-3: send it as a message', s1.error);
    const again = await emit(A.s, 'dm:send', { convoId: globalThis.DIRECT, fileId: r1.file?.id });
    ok(!again.ok, 'W1-3: one upload, one message');
    const got = await fetch(BASE + r1.file.url, { headers: { cookie: B.j.header() } });
    const body = Buffer.from(await got.arrayBuffer());
    const meta = await sharp(body).metadata();
    ok(got.status === 200 && !body.includes(Buffer.from('SECRET-EXIF')) && !meta.exif, 'W1-3: re-encoded without EXIF');
    ok(Math.max(meta.width, meta.height) <= 2048, `W1-3: large images are scaled for preview (${meta.width}x${meta.height})`);
    ok(got.headers.get('x-content-type-options') === 'nosniff', 'W1-3: served with nosniff');
    const out = await fetch(BASE + r1.file.url, { headers: { cookie: D.j.header() } });
    ok(out.status === 404, 'W1-3: non-participants get 404');
    const anon = await fetch(BASE + r1.file.url);
    ok(anon.status === 404, 'W1-3: signed-out visitors get 404');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 32), Buffer.from('\n%%EOF')]);
    const r2 = await up(B, globalThis.DIRECT, pdf, 'application/pdf', 'notes.pdf');
    ok(r2.ok && !r2.file.image && r2.file.mime === 'application/pdf', 'W1-3: PDFs are allowed as files', r2.error);
    await emit(B.s, 'dm:send', { convoId: globalThis.DIRECT, fileId: r2.file?.id });
    const dl = await fetch(BASE + r2.file.url + '?download=1', { headers: { cookie: A.j.header() } });
    ok(/attachment/.test(dl.headers.get('content-disposition') || ''), 'W1-3: files download as attachments');
    const exe = await up(A, globalThis.DIRECT, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500)]), 'application/octet-stream', 'x.exe');
    ok(!exe.ok && exe.status === 400, 'W1-3: other file types are refused', exe.error);
    const fake = await up(A, globalThis.DIRECT, Buffer.from('<script>alert(1)</script>'), 'image/png', 'x.png');
    ok(!fake.ok, 'W1-3: content is sniffed, not trusted from the name/type');
    const big = await up(A, globalThis.DIRECT, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 10)]), 'application/pdf', 'big.pdf');
    ok(big.status === 413, 'W1-3: files over 10 MB are refused', String(big.status));
    const dUp = await up(D, globalThis.DIRECT, pdf, 'application/pdf', 'n.pdf');
    ok(!dUp.ok, 'W1-3: non-participants cannot upload');
    const op = await emit(B.s, 'dm:open', { convoId: globalThis.DIRECT });
    ok(op.messages.some((m) => m.file?.image && m.file.name === 'holiday.webp'), 'W1-3: the image shows in the history');
  }
  // @@W1-4
  {
    const webm = (secs, freq = 440) => execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`, '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', 'pipe:1'], { maxBuffer: 8 << 20 });
    const fd = new FormData(); fd.append('voice', new Blob([webm(2)], { type: 'audio/webm' }), 'voice.webm');
    const v = await A.j.form(`/api/dm/${globalThis.DIRECT}/voice`, fd);
    ok(v.ok && v.id, 'W1-4: record and upload a voice note to a whisper', v.error);
    const sv = await emit(A.s, 'dm:send', { convoId: globalThis.DIRECT, voiceId: v.id, durationMs: 2000 });
    ok(sv.ok, 'W1-4: send the voice note', sv.error);
    const op = await emit(B.s, 'dm:open', { convoId: globalThis.DIRECT });
    const vm = op.messages.find((m) => m.kind === 'voice');
    ok(vm?.voice?.durationMs === 2000, 'W1-4: voice note in the history with its length');
    const bGet = await fetch(BASE + vm.voice.url, { headers: { cookie: B.j.header() } });
    const dGet = await fetch(BASE + vm.voice.url, { headers: { cookie: D.j.header() } });
    ok(bGet.status === 200 && dGet.status >= 400, `W1-4: only participants can play it (${bGet.status}/${dGet.status})`);
    const stolen = await emit(D.s, 'dm:send', { convoId: globalThis.DIRECT, voiceId: v.id });
    ok(!stolen.ok, 'W1-4: outsiders cannot post into the conversation');
    const reuse = await emit(B.s, 'dm:send', { convoId: globalThis.GROUP2, voiceId: v.id, durationMs: 2000 });
    ok(!reuse.ok, 'W1-4: a voice note cannot be moved to another conversation');
  }
  // @@W1-5
  {
    const bUpd = events(B.s, 'dm:update');
    const m1 = await emit(A.s, 'dm:send', { convoId: globalThis.DIRECT, text: `original ${R}` });
    const mid = m1.message?.id ?? (await emit(A.s, 'dm:open', { convoId: globalThis.DIRECT })).messages.at(-1).id;
    const rp = await emit(B.s, 'dm:send', { convoId: globalThis.DIRECT, text: 'a reply', replyTo: mid });
    const op = await emit(A.s, 'dm:open', { convoId: globalThis.DIRECT });
    const rl = op.messages.find((m) => m.text === 'a reply');
    ok(rp.ok && rl?.replyTo?.id === mid, 'W1-5: reply quotes the original', rp.error);
    const rc = await emit(B.s, 'dm:react', { messageId: mid, emoji: '👍' });
    ok(rc.ok && await waitFor(() => bUpd.some((m) => m.id === mid && m.reactions?.some((r) => r.emoji === '👍' && r.mine))), 'W1-5: react and see it live', rc.error);
    const rc2 = await emit(B.s, 'dm:react', { messageId: mid, emoji: '👍' });
    const op2 = await emit(A.s, 'dm:open', { convoId: globalThis.DIRECT });
    ok(rc2.ok && !op2.messages.find((m) => m.id === mid).reactions?.length, 'W1-5: reacting again removes it');
    await emit(B.s, 'dm:react', { messageId: mid, emoji: '❤️' });
    const ed = await emit(A.s, 'dm:edit', { messageId: mid, text: `edited ${R}` });
    const edB = await emit(B.s, 'dm:edit', { messageId: mid, text: 'hijack' });
    ok(ed.ok && !edB.ok && await waitFor(() => bUpd.some((m) => m.id === mid && m.editedAt && m.text === `edited ${R}`)), 'W1-5: only the author edits; others see "edited"', ed.error);
    const del = await emit(A.s, 'dm:delete', { messageId: mid });
    ok(del.ok && await waitFor(() => bUpd.some((m) => m.id === mid && m.deleted && !m.text)), 'W1-5: delete for everyone leaves a placeholder without the text', del.error);
    const srch = await emit(B.s, 'dm:search', { q: `edited ${R}` });
    ok(srch.results.length === 0, 'W1-5: deleted messages drop out of search');
    const ed2 = await emit(D.s, 'dm:react', { messageId: rl.id, emoji: '👍' });
    ok(!ed2.ok, 'W1-5: outsiders cannot react');
  }
  // @@W2-6
  {
    const bT = events(B.s, 'dm:typing'), aT = events(A.s, 'dm:typing'), dT = events(D.s, 'dm:typing');
    A.s.emit('dm:typing', { convoId: globalThis.DIRECT });
    ok(await waitFor(() => bT.some((t) => t.convoId === globalThis.DIRECT && t.userId === A.id), 2000), 'W2-6: typing reaches the other side');
    const before = bT.length;
    for (let i = 0; i < 5; i++) A.s.emit('dm:typing', { convoId: globalThis.DIRECT });
    await sleep(400);
    ok(bT.length === before, 'W2-6: typing pings are throttled on the server');
    D.s.emit('dm:typing', { convoId: globalThis.DIRECT }); await sleep(300);
    ok(aT.length === 0 && dT.length === 0, 'W2-6: outsiders cannot send or see typing');
    const off = await emit(B.s, 'dm:settings', { typing: false });
    ok(off.ok && off.typing === false, 'W2-6: turn my typing indicator off');
    await sleep(2600); const n = bT.length;
    A.s.emit('dm:typing', { convoId: globalThis.DIRECT });
    B.s.emit('dm:typing', { convoId: globalThis.DIRECT });
    await sleep(500);
    ok(bT.length === n && aT.length === 0, 'W2-6: off is mutual — I neither send nor see typing');
    await emit(B.s, 'dm:settings', { typing: true });
  }
  // @@W2-7
  {
    const bMsg = events(B.s, 'dm:message'), bGone = events(B.s, 'dm:gone');
    const bad = await emit(B.s, 'dm:disappear', { convoId: globalThis.DIRECT, sec: 60 });
    ok(!bad.ok, 'W2-7: only off / 1h / 1d / 7d');
    const on = await emit(B.s, 'dm:disappear', { convoId: globalThis.DIRECT, sec: 3600 });
    ok(on.ok && await waitFor(() => bMsg.some((m) => m.kind === 'system' && /disappearing messages/.test(m.text))), 'W2-7: either side turns it on, with a visible notice', on.error);
    const m = await emit(A.s, 'dm:send', { convoId: globalThis.DIRECT, text: `vanish ${R}` });
    const op = await emit(A.s, 'dm:open', { convoId: globalThis.DIRECT });
    ok(op.convo.disappearSec === 3600, 'W2-7: the conversation shows the timer');
    const vm = op.messages.find((x) => x.text === `vanish ${R}`);
    ok(vm && vm.expiresAt && Math.abs(vm.expiresAt - vm.ts - 3600e3) < 5, 'W2-7: new messages get an expiry');
    const fd = new FormData(); fd.append('file', new Blob([await png('#aa3355', 80)], { type: 'image/png' }), 'gone.png');
    const up = await A.j.form(`/api/dm/${globalThis.DIRECT}/files`, fd);
    await emit(A.s, 'dm:send', { convoId: globalThis.DIRECT, fileId: up.file.id });
    const fp = path.join(DATA, 'dm-files', up.file.id);
    ok(fs.existsSync(fp), 'W2-7: (file stored on disk)');
    const db = new DatabaseSync(path.join(DATA, 'camchat.db'));
    db.prepare('UPDATE dm_messages SET expires_at = ? WHERE convo_id = ? AND expires_at IS NOT NULL').run(Date.now() - 1000, globalThis.DIRECT);
    db.close();
    ok(await waitFor(() => bGone.some((g) => g.convoId === globalThis.DIRECT && g.ids.includes(vm.id)), 5000), 'W2-7: the server deletes expired messages and tells the open conversation');
    const op2 = await emit(B.s, 'dm:open', { convoId: globalThis.DIRECT });
    ok(!op2.messages.some((x) => x.text === `vanish ${R}` || x.file?.id === up.file.id), 'W2-7: gone from the history');
    ok(!fs.existsSync(fp), 'W2-7: the file is deleted from disk too');
    const f404 = await fetch(BASE + up.file.url, { headers: { cookie: B.j.header() } });
    ok(f404.status === 404, 'W2-7: and its link stops working');
    const s2 = await emit(B.s, 'dm:search', { q: `vanish ${R}` });
    ok(s2.results.length === 0, 'W2-7: and from search');
    const offR = await emit(A.s, 'dm:disappear', { convoId: globalThis.DIRECT, sec: 0 });
    const keep = await emit(A.s, 'dm:send', { convoId: globalThis.DIRECT, text: 'kept' });
    const op3 = await emit(A.s, 'dm:open', { convoId: globalThis.DIRECT });
    ok(offR.ok && !op3.messages.find((x) => x.text === 'kept')?.expiresAt, 'W2-7: turning it off stops new expiries');
    void m; void keep;
  }
  // @@API-END
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--lang=en-US'] });
  for (const width of [1366, 390]) {
    const phone = width < 800;
    const a = await pageFor(A, width);
    await a.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await a.page.waitForSelector('[data-action="dm-open"]', { timeout: 15000 });
    await sleep(600);
    await a.page.evaluate(() => [...document.querySelectorAll('a,button')].filter((e) => /^(Skip tour|Dismiss)$/.test(e.textContent.trim())).forEach((e) => e.click()));
    await sleep(300);
    await a.page.click('[data-action="dm-open"]');
    await a.page.waitForSelector('[data-testid="dm-rows"] [data-convo]', { timeout: 8000 }).catch(async (e) => { await a.page.screenshot({ path: path.join(os.tmpdir(), 'w-fail.png') }); console.log('[ui]', (await a.page.evaluate(() => document.querySelector('[data-testid="dm-panel"]')?.innerText ?? document.body.innerText.slice(0, 300)))); throw e; });
    ok(true, `${width}: W1-1: inbox opens with conversations`);
    await shot(a.page, `w1-inbox-${width}`);
    await a.page.click(`[data-convo="${globalThis.GROUP}"]`);
    await a.page.waitForSelector('[data-testid="dm-log"] .dm-line', { timeout: 8000 });
    if (phone) ok(await a.page.$eval('.dm-list', (e) => getComputedStyle(e).display === 'none'), `${width}: W1-1: phone shows one pane at a time`);
    const over = await a.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    ok(!over, `${width}: W1-1: no horizontal overflow`);
    await a.page.click('[data-action="dm-manage"]'); await sleep(200);
    await shot(a.page, `w1-group-${width}`);
    await a.page.click('[data-action="dm-manage"]');
    await a.page.type('[data-field="dm-text"]', `from the browser ${width}`);
    await a.page.keyboard.press('Enter');
    ok(await a.page.waitForFunction((w) => document.querySelector('[data-testid="dm-log"]').innerText.includes(`from the browser ${w}`), { timeout: 5000 }, width).then(() => true, () => false), `${width}: W1-1: send from the composer`);
    if (!phone) {
      const b = await pageFor(B, width);
      await b.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
      await b.page.waitForSelector('[data-action="dm-open"]', { timeout: 15000 }); await sleep(600); await dismiss(b.page);
      await a.page.click(`[data-convo="${globalThis.GROUP}"]`).catch(() => {});
      await a.page.click('[data-action="dm-back"]').catch(() => {});
      await a.page.click(`[data-convo="${globalThis.DIRECT}"]`); await sleep(400);
      await a.page.click('[data-action="dm-call"]');
      const rang = await b.page.waitForSelector('[data-testid="dm-ring"]', { timeout: 8000 }).then(() => true, () => false);
      ok(rang, `${width}: W1-2: the other side sees the ring in the top bar`);
      await shot(b.page, `w2-ring-${width}`);
      await b.page.click('[data-action="dm-ring-accept"]').catch(() => {});
      ok(await b.page.waitForSelector('.chat-log', { timeout: 10000 }).then(() => true, () => false), `${width}: W1-2: Join puts both in the call room`);
      await shot(b.page, `w2-call-${width}`);
      await b.ctx.close();
      await a.page.goto(BASE + '/', { waitUntil: 'networkidle0' }); await sleep(600);
      await a.page.click('[data-action="dm-open"]'); await sleep(500);
    }
    {
      if (phone) await a.page.click('[data-action="dm-back"]').catch(() => {});
      await sleep(300);
      await a.page.click(`[data-convo="${globalThis.DIRECT}"]`); await sleep(600);
      const img = await a.page.waitForSelector('[data-testid="dm-image"] img', { timeout: 6000 }).then(() => true, () => false);
      ok(img, `${width}: W1-3: image preview in the conversation`);
      ok(!!(await a.page.$('[data-testid="dm-file"]')), `${width}: W1-3: file chip for documents`);
      const input = await a.page.$('[data-field="dm-file"]');
      const tmp = path.join(os.tmpdir(), `w-up-${width}.png`); fs.writeFileSync(tmp, await png('#22aa66', 200));
      await input.uploadFile(tmp);
      ok(await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="dm-image"] img').length >= 2, { timeout: 8000 }).then(() => true, () => false), `${width}: W1-3: attach from the composer`);
      await sleep(500);
      await shot(a.page, `w3-files-${width}`);
      ok(!!(await a.page.$('[data-testid="dm-voice"]')), `${width}: W1-4: voice note player in the conversation`);
      ok(!!(await a.page.$('.dm-composer [data-action="voice-note"]')), `${width}: W1-4: push-to-talk mic in the composer`);
      await a.page.$eval('[data-testid="dm-log"]', (e) => { const v = e.querySelector('[data-testid="dm-voice"]'); v?.scrollIntoView({ block: 'center' }); });
      await shot(a.page, `w4-voice-${width}`);
    }
    {
      await a.page.evaluate(() => { const l = [...document.querySelectorAll('.dm-line.mine')].at(-1); l?.scrollIntoView(); });
      const btns = await a.page.$$('.dm-line.mine [data-action="dm-msg-menu"]');
      const lastText = btns.at(-1);
      await a.page.type('[data-field="dm-text"]', `edit me ${width}`); await a.page.keyboard.press('Enter'); await sleep(500);
      const menu = (await a.page.$$('.dm-line.mine [data-action="dm-msg-menu"]')).at(-1);
      await menu.click(); await sleep(200);
      await a.page.click('[data-react="😂"]'); await sleep(500);
      ok(await a.page.evaluate(() => [...document.querySelectorAll('.dm-line.mine')].at(-1)?.querySelector('[data-emoji="😂"]') != null), `${width}: W1-5: react from the message menu`);
      await (await a.page.$$('.dm-line.mine [data-action="dm-msg-menu"]')).at(-1).click(); await sleep(200);
      await a.page.$eval('[data-testid="dm-actions"]', (e) => e.scrollIntoView({ block: 'end' })); await sleep(150);
      await shot(a.page, `w5-actions-${width}`);
      await a.page.click('[data-action="dm-edit"]'); await sleep(150);
      await a.page.$eval('[data-field="dm-text"]', (e) => { e.select(); });
      await a.page.keyboard.press('Backspace');
      await a.page.type('[data-field="dm-text"]', `edited in ui ${width}`); await a.page.keyboard.press('Enter');
      ok(await a.page.waitForFunction((w) => [...document.querySelectorAll('.dm-line.mine')].at(-1)?.innerText.includes(`edited in ui ${w}`) && /edited/.test([...document.querySelectorAll('.dm-line.mine .dm-meta')].at(-1)?.textContent), { timeout: 5000 }, width).then(() => true, () => false), `${width}: W1-5: edit from the menu`);
      await (await a.page.$$('.dm-line.mine [data-action="dm-msg-menu"]')).at(-1).click(); await sleep(150);
      await a.page.click('[data-action="dm-reply"]'); await sleep(150);
      ok(!!(await a.page.$('[data-testid="dm-replying"]')), `${width}: W1-5: reply bar above the composer`);
      await a.page.type('[data-field="dm-text"]', `reply ${width}`); await a.page.keyboard.press('Enter');
      ok(await a.page.waitForFunction(() => [...document.querySelectorAll('.dm-line.mine')].at(-1)?.querySelector('[data-testid="dm-quote"]') != null, { timeout: 5000 }).then(() => true, () => false), `${width}: W1-5: reply shows the quote`);
      a.page.once('dialog', (d) => d.accept());
      await (await a.page.$$('.dm-line.mine [data-action="dm-msg-menu"]')).at(-1).click(); await sleep(150);
      await a.page.click('[data-action="dm-delete"]');
      ok(await a.page.waitForFunction(() => /Message deleted/.test([...document.querySelectorAll('.dm-line.mine')].at(-1)?.innerText), { timeout: 5000 }).then(() => true, () => false), `${width}: W1-5: delete from the menu`);
      await shot(a.page, `w5-thread-${width}`);
      void lastText;
      if (phone) { await a.page.click('[data-action="dm-back"]'); await sleep(300); }
    }
    if (!phone) {
      const b = await pageFor(B, width);
      await b.page.goto(BASE + '/', { waitUntil: 'networkidle0' });
      await b.page.waitForSelector('[data-action="dm-open"]', { timeout: 15000 }); await sleep(500); await dismiss(b.page);
      await b.page.click('[data-action="dm-open"]');
      await b.page.waitForSelector(`[data-convo="${globalThis.DIRECT}"]`, { timeout: 8000 });
      await b.page.click(`[data-convo="${globalThis.DIRECT}"]`); await sleep(600);
      await sleep(2600);
      await a.page.type('[data-field="dm-text"]', 'typing…');
      ok(await b.page.waitForSelector('[data-testid="dm-typing"]', { timeout: 4000 }).then(() => true, () => false), `${width}: W2-6: "is typing…" shows under the conversation`);
      await shot(b.page, `w6-typing-${width}`);
      await a.page.keyboard.press('Enter');
      ok(await b.page.waitForFunction(() => !document.querySelector('[data-testid="dm-typing"]'), { timeout: 8000 }).then(() => true, () => false), `${width}: W2-6: the line clears when the message lands`);
      globalThis.BPAGE = b;
    }
    {
      const target = phone ? globalThis.GROUP2 : globalThis.GROUP2;
      if (phone) await a.page.click('[data-action="dm-back"]').catch(() => {});
      await sleep(200);
      await a.page.click(`[data-convo="${target}"]`); await sleep(500);
      await a.page.click('[data-action="dm-manage"]'); await sleep(200);
      await a.page.select('[data-field="dm-disappear"]', width === 1366 ? '86400' : '604800');
      ok(await a.page.waitForFunction(() => [...document.querySelectorAll('[data-kind="system"]')].some((e) => /disappearing messages/.test(e.textContent)), { timeout: 5000 }).then(() => true, () => false), `${width}: W2-7: set the timer from the options; the notice appears`);
      await shot(a.page, `w7-disappear-${width}`);
      await a.page.click('[data-action="dm-manage"]'); await sleep(150);
      ok(/⏱/.test(await a.page.$eval('.dm-thread-title', (e) => e.textContent)), `${width}: W2-7: the header shows the timer`);
    }
    // @@UI-W
    await a.ctx.close();
    if (globalThis.BPAGE) { await globalThis.BPAGE.ctx.close(); globalThis.BPAGE = null; }
  }
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
if (failed && process.env.SHOWLOG) console.log(log.slice(-3000));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
