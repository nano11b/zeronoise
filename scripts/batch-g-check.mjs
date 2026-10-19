/**
 * Batch G checks: translate, clips, room templates, custom room roles, whisper read receipts.
 *
 * Screenshots at 1366 and 390.   npm run build && node scripts/batch-g-check.mjs [shots-dir]
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
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-batch-g'));
fs.mkdirSync(OUT, { recursive: true });
import crypto from 'node:crypto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-batch-g-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'GgAdmin', RECORDING_MAX_BYTES: '400000', RECORDING_SWEEP_MS: '1500', RECORDING_IDLE_MS: '6000', RECONNECT_GRACE_MS: '800',
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
import { execFileSync } from 'node:child_process';
const webm = (secs, freq = 440) => { try { return execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`, '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', 'pipe:1'], { maxBuffer: 8 << 20 }); } catch { return null; } };
const libreHits = [];
const libre = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { const j = JSON.parse(b || '{}'); libreHits.push(j); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ translatedText: `[${j.target}] ${j.q}`, detectedLanguage: { language: 'es', confidence: 90 } })); }); });
await new Promise((r) => libre.listen(0, '127.0.0.1', r));
const LIBRE = `http://127.0.0.1:${libre.address().port}`;
const fakeTranslator = () => {
  window.LanguageDetector = { create: async () => ({ detect: async () => [{ detectedLanguage: 'es', confidence: 0.9 }] }) };
  window.Translator = { availability: async () => 'available', create: async (o) => ({ translate: async (t) => `(${o.sourceLanguage}→${o.targetLanguage}) ${t.replace('hola amigos', 'hello friends')}` }) };
};
try {
  const owner = await nodeUser('GgOwner'); const mem = await nodeUser('GgMember'); const admin = await nodeUser('GgAdmin'); const other = await nodeUser('GgOther');
  sockets.push(owner.s, mem.s, admin.s, other.s);
  const vr = await emit(owner.s, 'room:create', { name: 'gg-voice', voice: true, category: 'talk' });
  const room = vr.roomId;
  ok(vr.ok, 'voice room created');
  for (const u of [owner, mem, other]) await emit(u.s, 'room:join', { roomId: room });
  // ---------- G1 translate API ----------
  {
    ok((await mem.j.req('/api/translate/config')).server === false, 'G1: no translation server by default');
    ok((await mem.j.req('/api/translate', { text: 'hola', target: 'en' })).status === 404, 'G1: server translate refuses when not set up');
    ok((await mem.j.req('/api/admin/settings/translate', { url: LIBRE })).status === 403, 'G1: members cannot set the translation server');
    ok((await admin.j.req('/api/admin/settings/translate', { url: 'javascript:alert(1)' })).status === 400, 'G1: bad URL refused');
    const set = await admin.j.req('/api/admin/settings/translate', { url: LIBRE + '/' });
    ok(set.ok && set.url === LIBRE, 'G1: admin sets a LibreTranslate URL (trailing slash trimmed)', JSON.stringify(set));
    ok((await mem.j.req('/api/translate/config')).server === true, 'G1: clients see that a server is available');
    const tr = await mem.j.req('/api/translate', { text: 'hola amigos', target: 'en-US' });
    ok(tr.ok && tr.text === '[en] hola amigos' && tr.from === 'es' && libreHits.at(-1)?.source === 'auto', 'G1: server translation goes through LibreTranslate', JSON.stringify(tr));
    ok((await mem.j.req('/api/translate', { text: '', target: 'en' })).status === 400, 'G1: empty text refused');
    await emit(owner.s, 'chat:send', { text: 'hola amigos' });
  }
  // ---------- G2 clips API ----------
  {
    const full = webm(8);
    const st = await emit(owner.s, 'rec:start', {});
    const fd0 = new FormData(); fd0.append('chunk', new Blob([full]), 'c.webm');
    await owner.j.form(`/api/rooms/${encodeURIComponent(room)}/recordings/${st.rec.id}/chunk`, fd0);
    await emit(owner.s, 'rec:stop', {});
    await sleep(300);
    const recRow = (await owner.j.req(`/api/rooms/${encodeURIComponent(room)}/recordings`)).recordings.find((r) => r.id === st.rec.id);
    ok(!!full && recRow?.status === 'done', 'G2: a finished recording to cut from', JSON.stringify(recRow));
    const clipUp = (u, fields, buf = webm(3, 660)) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, String(v)); fd.append('voice', new Blob([buf]), 'clip.webm'); return u.j.form(`/api/rooms/${encodeURIComponent(room)}/clips`, fd); };
    ok((await clipUp(mem, { recordingId: st.rec.id, startMs: 0, durationMs: 3000 })).status === 403, 'G2: only the owner can make clips');
    ok((await clipUp(owner, { recordingId: st.rec.id, startMs: 0, durationMs: 61000 })).status === 400, 'G2: clips are at most 60 s');
    ok((await clipUp(owner, { recordingId: 'f'.repeat(24), startMs: 0, durationMs: 3000 })).status === 404, 'G2: must come from one of this room\'s recordings');
    ok((await clipUp(owner, { recordingId: st.rec.id, startMs: 0, durationMs: 3000 }, Buffer.from('not audio at all'))).status === 400, 'G2: must be real audio');
    const c = await clipUp(owner, { recordingId: st.rec.id, startMs: 2000, durationMs: 3000 });
    ok(c.ok && !!c.voiceId && Math.abs(c.expiresAt - (recRow.startedAt + 30 * 86400000)) < 5000, 'G2: clip stored, expiring with the recording', JSON.stringify(c));
    const msgP = ev(mem.s, 'chat:message');
    const posted = await emit(owner.s, 'chat:voice', { voiceId: c.voiceId, durationMs: 3000 });
    const m = await msgP;
    ok(posted.ok && /🎬 Clip from the room recording \(0:03\)/.test(m?.text || '') && m.voice?.url, 'G2: posted to the room as an audio message', JSON.stringify(m));
    ok((await fetch(BASE + m.voice.url, { headers: { cookie: mem.j.header() } })).status === 200, 'G2: members can play it');
    // retention: age the recording past 30 days; the sweep removes the clip audio and says so
    const db = new DatabaseSync(path.join(DATA, 'camchat.db'));
    db.prepare('UPDATE room_recordings SET started_at = started_at - ? WHERE id = ?').run(91 * 86400000, st.rec.id);
    let row; for (let i = 0; i < 20; i++) { await sleep(400); row = db.prepare('SELECT status FROM room_clips WHERE id = ?').get(c.id); if (row?.status === 'expired') break; }
    const txt = db.prepare('SELECT text FROM messages WHERE id = ?').get(m.id)?.text;
    db.close();
    ok(row?.status === 'expired' && /expired/.test(txt || '') && (await fetch(BASE + m.voice.url, { headers: { cookie: mem.j.header() } })).status === 404, 'G2: clips are removed with the recording (retention)', JSON.stringify({ row, txt }));
    ok([404, 410].includes((await clipUp(owner, { recordingId: st.rec.id, startMs: 0, durationMs: 3000 })).status), 'G2: no new clips from an expired recording');
  }
  // ---------- G4 custom room roles ----------
  {
    const kickee = await nodeUser('GgKickee'); sockets.push(kickee.s);
    const pr = await emit(owner.s, 'room:create', { name: 'gg-roles', category: 'talk' });
    const rr = pr.roomId;
    for (const u of [owner, mem, other, kickee]) await emit(u.s, 'room:join', { roomId: rr });
    ok((await emit(owner.s, 'roles:save', { name: 'Helper', color: '#202830', perms: ['pin'] })).error?.includes('too dark'), 'G4: a hard-to-read name colour is refused');
    ok(!(await emit(owner.s, 'roles:save', { name: 'Admin', color: null, perms: [] })).ok, 'G4: reserved names refused');
    ok(!(await emit(mem.s, 'roles:save', { name: 'Mine', color: null, perms: ['kick'] })).ok, 'G4: members cannot create roles');
    const h = await emit(owner.s, 'roles:save', { name: 'Helper', color: '#7cc4ff', perms: ['pin', 'kick', 'messages', 'bogus'] });
    ok(h.ok && h.role.perms.join() === 'pin,kick,messages', 'G4: owner creates a role with chosen powers (unknown powers dropped)', JSON.stringify(h));
    const t = await emit(owner.s, 'roles:save', { name: 'Talker', color: '#ffd166', perms: ['floor'] });
    await sleep(300);
    const upP = new Promise((res) => { const t0 = setTimeout(() => res(null), 4000); const f = (p) => { if (p.members?.[mem.id]) { clearTimeout(t0); kickee.s.off('roles:update', f); res(p); } }; kickee.s.on('roles:update', f); });
    ok((await emit(owner.s, 'roles:assign', { accountId: mem.id, roleId: h.role.id })).ok, 'G4: owner assigns the role');
    const up = await upP;
    ok(up?.members?.[mem.id] === h.role.id && up.roles.length === 2, 'G4: everyone in the room gets the role update (for name colours)', JSON.stringify(up));
    ok(!(await emit(owner.s, 'roles:assign', { accountId: admin.id, roleId: h.role.id })).ok, 'G4: staff cannot be given room roles');
    ok(!(await emit(mem.s, 'roles:assign', { accountId: other.id, roleId: h.role.id })).ok, 'G4: role holders cannot hand out roles');
    // other's message: Helper may pin and delete it
    const sent = await new Promise((res) => { owner.s.once('chat:message', res); emit(other.s, 'chat:send', { text: 'please pin me' }); });
    ok((await emit(mem.s, 'chat:pin', { messageId: sent.id, pinned: true })).ok, 'G4: Helper pins (pin power)');
    ok(!(await emit(mem.s, 'room:mute', { userId: other.s.id, minutes: 5 })).ok, 'G4: Helper cannot mute (power not given)');
    ok(!(await emit(mem.s, 'room:ban', { userId: kickee.s.id, minutes: 60 })).ok, 'G4: roles never ban');
    ok(!(await emit(mem.s, 'room:kick', { userId: owner.s.id })).ok, 'G4: cannot act on the owner');
    ok(!(await emit(mem.s, 'room:filters:set', { words: ['x'], links: false, allow: [] })).ok && !(await emit(mem.s, 'room:theme:set', { accent: '#7cc4ff', welcome: 'hi' })).ok, 'G4: roles cannot change filters or theme');
    await emit(owner.s, 'roles:assign', { accountId: other.id, roleId: t.role.id });
    ok(!(await emit(mem.s, 'chat:delete', { messageId: sent.id })).ok, 'G4: cannot delete another role holder\'s message');
    ok(!(await emit(mem.s, 'room:kick', { userId: other.s.id })).ok, 'G4: cannot kick another role holder');
    await emit(owner.s, 'roles:assign', { accountId: other.id, roleId: null });
    ok((await emit(mem.s, 'chat:delete', { messageId: sent.id })).ok, 'G4: Helper deletes an ordinary member\'s message (messages power)');
    const modSent = await new Promise((res) => { mem.s.once('chat:message', res); emit(owner.s, 'chat:send', { text: 'owner line' }); });
    ok(!(await emit(mem.s, 'chat:delete', { messageId: modSent.id })).ok, 'G4: cannot delete the owner\'s message');
    ok((await emit(mem.s, 'room:kick', { userId: kickee.s.id })).ok, 'G4: Helper kicks an ordinary member (kick power)');
    // floor power in a voice room
    await emit(owner.s, 'roles:assign', { accountId: other.id, roleId: null });
    const vroles = await emit(owner.s, 'roles:save', { name: 'Floor', color: '#ffd166', perms: ['floor'] });
    void vroles;
    await emit(owner.s, 'room:join', { roomId: room }); await emit(other.s, 'room:join', { roomId: room }); await emit(mem.s, 'room:join', { roomId: room });
    const ft = await emit(owner.s, 'roles:save', { name: 'Floorie', color: '#ffd166', perms: ['floor'] });
    await emit(owner.s, 'roles:assign', { accountId: other.id, roleId: ft.role.id });
    ok(!(await emit(mem.s, 'stage:invite', { userId: owner.s.id })).ok, 'G4: no floor power, no floor control');
    await emit(mem.s, 'stage:hand', { up: true });
    ok((await emit(other.s, 'stage:invite', { userId: mem.s.id })).ok, 'G4: floor power gives the voice floor');
    const arc = await emit(owner.s, 'roles:archive', { id: ft.role.id });
    await emit(mem.s, 'stage:hand', { up: true });
    ok(arc.ok && !(await emit(other.s, 'stage:invite', { userId: mem.s.id })).ok, 'G4: removing a role removes its powers');
    globalThis.__rolesRoom = rr;
  }
  // ---------- G3 room templates ----------
  {
    const cr = await emit(other.s, 'room:create', { name: 'gg-study', category: 'talk', template: 'study' });
    const j = await emit(other.s, 'room:join', { roomId: cr.roomId });
    const f = await emit(other.s, 'room:filters:get');
    const rl = await emit(other.s, 'roles:get', {});
    ok(cr.ok && j.room.theme.accent === '#60a5fa' && /Study room/.test(j.room.theme.welcome) && j.room.slowModeSec === 30, 'G3: creating with the Study template sets accent, welcome and slow mode', JSON.stringify({ t: j.room?.theme, s: j.room?.slowModeSec }));
    ok(f.filters.links === 'allowlist' && f.filters.allow.includes('wikipedia.org'), 'G3: template filters applied', JSON.stringify(f.filters));
    ok(rl.roles.map((r) => r.name).join() === 'Tutor,Proctor' && rl.roles[0].perms.join() === 'pin,floor', 'G3: template roles created', JSON.stringify(rl.roles));
    await emit(mem.s, 'room:join', { roomId: cr.roomId });
    ok(!(await emit(mem.s, 'room:template:apply', { template: 'chill' })).ok, 'G3: members cannot apply templates');
    ok(!(await emit(other.s, 'room:template:apply', { template: 'nope' })).ok, 'G3: unknown template refused');
    const thP = ev(mem.s, 'room:theme');
    const ap = await emit(other.s, 'room:template:apply', { template: 'gaming' });
    const th = await thP;
    const rl2 = await emit(other.s, 'roles:get', {});
    const j2 = await emit(mem.s, 'room:join', { roomId: cr.roomId });
    ok(ap.ok && th?.theme?.accent === '#a78bfa' && j2.room.slowModeSec === 0, 'G3: applying Gaming to an existing room updates it live', JSON.stringify({ th, s: j2.room?.slowModeSec }));
    ok(rl2.roles.map((r) => r.name).join() === 'Tutor,Proctor,Squad Lead,Ref', 'G3: template adds its roles and keeps existing ones', rl2.roles.map((r) => r.name).join());
    for (const k of ['gaming', 'study', 'music', 'chill', 'support']) {
      const r = await emit(other.s, 'room:template:apply', { template: k });
      if (!r.ok) { ok(false, `G3: ${k} applies`, r.error); }
      await sleep(150);
    }
    ok(true, 'G3: all five templates apply cleanly');
    globalThis.__tplRoom = cr.roomId;
  }
  // ---------- G5 whisper read receipts ----------
  {
    for (const u of [mem, other, admin]) await emit(u.s, 'room:join', { roomId: room });
    ok((await emit(mem.s, 'whisper:receipts', {})).on === true, 'G5: receipts are on by default');
    const w = await emit(mem.s, 'whisper:start', { userIds: [other.s.id] });
    const wid = w.whisper.id;
    const msgP = ev(other.s, 'whisper:message');
    await emit(mem.s, 'whisper:send', { whisperId: wid, text: 'psst' });
    const m = await msgP;
    const seenP = ev(mem.s, 'whisper:seen');
    other.s.emit('whisper:seen', { whisperId: wid, messageId: m.id });
    const seen = await seenP;
    ok(seen?.messageId === m.id && seen.nick === 'GgOther', 'G5: the sender gets a "seen" when the other person reads it', JSON.stringify(seen));
    // outsiders can't fake it
    const fakeP = ev(mem.s, 'whisper:seen');
    admin.s.emit('whisper:seen', { whisperId: wid, messageId: m.id });
    ok(!(await fakeP), 'G5: people outside the whisper cannot send receipts');
    // reader turns theirs off: no receipt goes out
    ok((await emit(other.s, 'whisper:receipts', { on: false })).on === false, 'G5: a user turns their receipts off');
    const m2P = ev(other.s, 'whisper:message'); await emit(mem.s, 'whisper:send', { whisperId: wid, text: 'still there?' }); const m2 = await m2P;
    const offP = ev(mem.s, 'whisper:seen'); other.s.emit('whisper:seen', { whisperId: wid, messageId: m2.id });
    ok(!(await offP), 'G5: with receipts off you send none');
    // ...and you see none (mutual)
    const m3P = ev(mem.s, 'whisper:message'); await emit(other.s, 'whisper:send', { whisperId: wid, text: 'yes' }); const m3 = await m3P;
    const mutP = ev(other.s, 'whisper:seen'); mem.s.emit('whisper:seen', { whisperId: wid, messageId: m3.id });
    ok(!(await mutP), 'G5: with receipts off you see nobody else\'s (mutual)');
    await fresh0(other);
    ok((await emit(other.s, 'whisper:receipts', {})).on === false, 'G5: the off setting is saved on the account');
    await emit(other.s, 'whisper:receipts', { on: true });
    await emit(other.s, 'room:join', { roomId: room });
  }
  // @@API-END

  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--lang=en-US'] });
  const fresh = async (u) => { try { u.s.disconnect(); } catch { /* */ } u.s = await sock(u.j); sockets.push(u.s); return u.s; };
  const clickMsgAction = (page, text, action) => page.evaluate((text, action) => { const li = [...document.querySelectorAll('.chat-log .msg')].reverse().find((e) => e.textContent.includes(text)); const b = li?.querySelector(`[data-action="${action}"]`); b?.scrollIntoView({ block: 'center' }); b?.click(); return !!b; }, text, action);
  for (const width of [1366, 390]) {
    // G1 UI: browser on-device translation, server fallback, and the clear note when neither exists
    {
      const a = await pageFor(mem, width);
      await a.page.evaluateOnNewDocument(fakeTranslator);
      await enterRoom(a.page, room);
      await a.page.evaluate(() => document.querySelector('[data-action="rec-ok"]')?.click());
      ok(await clickMsgAction(a.page, 'hola amigos', 'translate-msg'), `${width}: G1: messages have a Translate button`);
      const t = await a.page.waitForSelector('.msg-translation[data-translation="browser"]', { timeout: 6000 }).catch(() => null);
      ok(!!t && /hello friends/.test(await t.evaluate((e) => e.textContent)), `${width}: G1: on-device browser translation shows under the message`);
      await t?.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      ok(await noSideScroll(a.page), `${width}: G1: no sideways scroll`);
      await shot(a.page, `g1-translate-browser-${width}`);
      await a.ctx.close(); await fresh(mem); await emit(mem.s, 'room:join', { roomId: room });
      const b = await pageFor(mem, width);
      await b.page.evaluateOnNewDocument(() => { delete window.Translator; delete window.LanguageDetector; });
      await enterRoom(b.page, room);
      await clickMsgAction(b.page, 'hola amigos', 'translate-msg');
      const s = await b.page.waitForSelector('.msg-translation[data-translation="server"]', { timeout: 6000 }).catch(() => null);
      ok(!!s && /\[en\] hola amigos/.test(await s.evaluate((e) => e.textContent)), `${width}: G1: without on-device translation, the admin's LibreTranslate is used`);
      await shot(b.page, `g1-translate-server-${width}`);
      await b.ctx.close(); await fresh(mem); await emit(mem.s, 'room:join', { roomId: room });
      await admin.j.req('/api/admin/settings/translate', { url: '' });
      const c = await pageFor(mem, width);
      await c.page.evaluateOnNewDocument(() => { delete window.Translator; delete window.LanguageDetector; });
      await enterRoom(c.page, room);
      await clickMsgAction(c.page, 'hola amigos', 'translate-msg');
      const n = await c.page.waitForSelector('.msg-translation[data-translation="unavailable"]', { timeout: 6000 }).catch(() => null);
      ok(!!n && /isn't available/.test(await n.evaluate((e) => e.textContent)), `${width}: G1: a clear note where neither is available`);
      await shot(c.page, `g1-translate-unavailable-${width}`);
      await c.ctx.close(); await fresh(mem); await emit(mem.s, 'room:join', { roomId: room });
      const ad = await pageFor(admin, width);
      await ad.page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
      await ad.page.waitForSelector('.admin-tabs [data-tab="security"]', { timeout: 15000 }).catch(() => null); await sleep(300);
      await ad.page.evaluate(() => document.querySelector('.admin-tabs [data-tab="security"]')?.click());
      const ts = await ad.page.waitForSelector('[data-testid="translate-settings"]', { timeout: 6000 }).catch(() => null);
      if (ts) { await ad.page.type('[data-testid="libre-url"]', LIBRE); await ad.page.$eval('[data-action="save-translate"]', (x) => x.click()); }
      const saved = await ad.page.waitForFunction(() => /Saved/.test(document.querySelector('[data-testid="translate-settings"]')?.textContent || ''), { timeout: 6000 }).catch(() => null);
      ok(!!saved && (await admin.j.req('/api/admin/settings/translate')).url === LIBRE, `${width}: G1: admin sets LibreTranslate in the admin panel`);
      await ts?.evaluate((e) => e.scrollIntoView({ block: 'start' }));
      ok(await noSideScroll(ad.page), `${width}: G1: admin panel: no sideways scroll`);
      await shot(ad.page, `g1-admin-translate-${width}`);
      await ad.ctx.close();
    }
    // G2 UI: owner trims a clip from a recording in the browser and shares it
    {
      const full = webm(8, 330);
      const st = await emit(owner.s, 'rec:start', {});
      const fd0 = new FormData(); fd0.append('chunk', new Blob([full]), 'c.webm');
      await owner.j.form(`/api/rooms/${encodeURIComponent(room)}/recordings/${st.rec.id}/chunk`, fd0);
      await emit(owner.s, 'rec:stop', {});
      await fresh(owner);
      const o = await pageFor(owner, width);
      await enterRoom(o.page, room);
      await o.page.$eval('[data-action="rec-list"]', (b) => b.click());
      await o.page.waitForSelector('[data-action="clip-open"]', { timeout: 8000 });
      await o.page.$eval('[data-action="clip-open"]', (b) => b.click());
      const cm = await o.page.waitForSelector('[data-testid="clip-len"]', { timeout: 10000 }).catch(() => null);
      ok(!!cm, `${width}: G2: the recording decodes in the browser with start/length controls`);
      if (cm) {
        await o.page.$eval('[data-testid="clip-start"]', (e) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '2'); e.dispatchEvent(new Event('input', { bubbles: true })); });
        await o.page.$eval('[data-testid="clip-len"]', (e) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '3'); e.dispatchEvent(new Event('input', { bubbles: true })); });
        await sleep(200);
        ok(/0:02 – 0:05 of 0:0[78]/.test(await o.page.$eval('[data-testid="clip-range"]', (e) => e.textContent)), `${width}: G2: trim range shows`, await o.page.$eval('[data-testid="clip-range"]', (e) => e.textContent));
        await o.page.$eval('[data-testid="clip-maker"]', (e) => e.scrollIntoView({ block: 'center' }));
        ok(await noSideScroll(o.page), `${width}: G2: no sideways scroll`);
        await shot(o.page, `g2-clip-trim-${width}`);
        await o.page.$eval('[data-action="clip-share"]', (b) => b.click());
        const posted = await o.page.waitForFunction(() => [...document.querySelectorAll('.chat-log .msg')].some((e) => e.querySelector('[data-clip]') && /0:03/.test(e.textContent)), { timeout: 15000 }).catch(() => null);
        ok(!!posted, `${width}: G2: clip is shared to the room as an audio post`, await o.page.evaluate(() => [...document.querySelectorAll('.toast, [role=alert], .toasts *')].map((e) => e.textContent).join(' | ') + ' // ' + [...document.querySelectorAll('.chat-log .msg')].slice(-2).map((e) => e.textContent + (e.querySelector('audio') ? '[audio]' : '') + e.innerHTML.slice(0, 300)).join(' || ')));
        await o.page.evaluate(() => [...document.querySelectorAll('.chat-log .msg')].reverse().find((e) => /🎬/.test(e.textContent))?.scrollIntoView({ block: 'center' }));
        await shot(o.page, `g2-clip-posted-${width}`);
      }
      await o.ctx.close(); await fresh(owner); await emit(owner.s, 'room:join', { roomId: room });
    }
    // G4 UI: owner manages roles; holder's name shows in the role colour; holder gets only their powers in menus
    {
      const rr = globalThis.__rolesRoom;
      await fresh(owner); await emit(owner.s, 'room:join', { roomId: rr });
      await fresh(other); await emit(other.s, 'room:join', { roomId: rr }); await fresh(mem); await emit(mem.s, 'room:join', { roomId: rr });
      await emit(mem.s, 'chat:send', { text: `helper says hi ${width}` });
      const o = await pageFor(owner, width);
      await enterRoom(o.page, rr);
      await openSettings(o.page, width < 800, 'roles');
      const panel = await o.page.waitForSelector('[data-testid="roles-panel"] [data-role="Helper"]', { timeout: 8000 }).catch(() => null);
      ok(!!panel, `${width}: G4: owner sees the roles list`);
      await o.page.$eval('[data-action="role-new"]', (b) => b.click());
      await o.page.waitForSelector('[data-testid="role-name"]');
      await o.page.type('[data-testid="role-name"]', `Greeter${width}`);
      await o.page.$eval('[data-testid="role-color"]', (e) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '#1a1a40'); e.dispatchEvent(new Event('input', { bubbles: true })); });
      const warn = await o.page.waitForSelector('[data-testid="role-color-warn"]', { timeout: 3000 }).catch(() => null);
      ok(!!warn && await o.page.$eval('[data-action="role-save"]', (b) => b.disabled), `${width}: G4: dark colours are flagged and can't be saved`);
      await o.page.$eval('[data-testid="role-form"]', (e) => e.scrollIntoView({ block: 'center' }));
      await shot(o.page, `g4-role-contrast-${width}`);
      await o.page.$eval('[data-testid="role-color"]', (e) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '#9be38c'); e.dispatchEvent(new Event('input', { bubbles: true })); });
      await o.page.$eval('[data-perm="mute"]', (b) => b.click());
      await o.page.$eval('[data-action="role-save"]', (b) => b.click());
      const saved = await o.page.waitForSelector(`[data-role="Greeter${width}"]`, { timeout: 5000 }).catch(() => null);
      ok(!!saved, `${width}: G4: owner creates a role from the panel`);
      await saved?.evaluate((e) => e.closest('[data-testid="roles-panel"]').scrollIntoView({ block: 'start' }));
      ok(await noSideScroll(o.page), `${width}: G4: roles panel: no sideways scroll`);
      await shot(o.page, `g4-roles-panel-${width}`);
      await o.ctx.close(); await fresh(owner); await emit(owner.s, 'room:join', { roomId: rr });
      // holder view: chip + colour in chat; menu on an ordinary member shows Kick but not Ban
      await fresh(mem);
      const m = await pageFor(mem, width);
      await enterRoom(m.page, rr);
      const chip = await m.page.waitForSelector('.chat-log [data-role-chip="Helper"]', { timeout: 6000 }).catch(() => null);
      const col = chip ? await chip.evaluate((e) => getComputedStyle(e).color) : '';
      ok(!!chip && col === 'rgb(124, 196, 255)', `${width}: G4: role name colour shows in chat`, col);
      await m.page.evaluate(() => document.querySelector('[data-action="rec-ok"]')?.click());
      if (width < 800) { await m.page.evaluate(() => document.querySelector('[data-action="people"], [data-action="toggle-people"], [aria-label*="Online"]')?.click()); await sleep(400); }
      const opened = await m.page.evaluate(() => { const li = [...document.querySelectorAll('.users li')].find((e) => e.textContent.includes('GgOther')); const b = li?.querySelector('button, .user-row, [role=button]') || li; b?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return !!li; });
      await sleep(400);
      const menu = await m.page.evaluate(() => [...document.querySelectorAll('.menu.person-menu [data-action]')].map((b) => b.dataset.action)); // MC2 part 3: the person menu is portaled to <body>
      ok(opened && menu.includes('kick') && !menu.includes('room-ban') && !menu.includes('room-mute'), `${width}: G4: holder's menu shows exactly their powers`, JSON.stringify(menu));
      await shot(m.page, `g4-holder-menu-${width}`);
      await m.ctx.close(); await fresh(mem); await emit(mem.s, 'room:join', { roomId: rr });
      await emit(owner.s, 'room:join', { roomId: room }); await emit(mem.s, 'room:join', { roomId: room }); await emit(other.s, 'room:join', { roomId: room });
    }
    // G3 UI: owner picks a template, sees what it sets, applies it
    {
      const tr = globalThis.__tplRoom;
      await fresh(other);
      const o = await pageFor(other, width);
      await enterRoom(o.page, tr);
      await openSettings(o.page, width < 800, 'template');
      const card = await o.page.waitForSelector('[data-template="music"]', { timeout: 8000 }).catch(() => null);
      ok(!!card, `${width}: G3: five template cards`, String(await o.page.$$eval('[data-template]', (x) => x.length)));
      await card?.click();
      const pv = await o.page.waitForSelector('[data-testid="template-preview"]', { timeout: 3000 }).catch(() => null);
      ok(!!pv && /DJ/.test(await pv.evaluate((e) => e.textContent)), `${width}: G3: preview lists accent, slow mode, links, roles and welcome`);
      await o.page.$eval('[data-testid="template-picker"]', (e) => e.scrollIntoView({ block: 'start' }));
      ok(await noSideScroll(o.page), `${width}: G3: no sideways scroll`);
      await shot(o.page, `g3-template-preview-${width}`);
      await o.page.$eval('[data-action="template-apply"]', (b) => b.click());
      const done = await o.page.waitForFunction(() => /Music template applied/.test(document.body.textContent), { timeout: 6000 }).catch(() => null);
      const acc = await o.page.waitForFunction(() => /f472b6|244, 114, 182/i.test(document.documentElement.outerHTML), { timeout: 4000 }).catch(() => null);
      ok(!!done && !!acc, `${width}: G3: applied; the room picks up the new accent`);
      if (width < 800) { await o.page.evaluate(() => document.querySelector('[data-action="panel-close"], [data-action="collapse-panel"]')?.click()); await sleep(300); }
      await shot(o.page, `g3-template-applied-${width}`);
      await o.ctx.close(); await fresh(other); await emit(other.s, 'room:join', { roomId: room });
    }
    // G5 UI: "Seen" under my whisper; the toggle
    {
      await fresh(mem);
      const a = await pageFor(mem, width);
      await enterRoom(a.page, room);
      await a.page.evaluate(() => document.querySelector('[data-action="rec-ok"]')?.click());
      await fresh(other);
      const j = await emit(other.s, 'room:join', { roomId: room });
      const memId = (j.room?.users ?? j.users ?? []).find((u) => u.nick === 'GgMember')?.id;
      const w = await emit(other.s, 'whisper:start', { userIds: [memId] });
      await a.page.waitForSelector('[data-action="whisper-tab"]', { timeout: 6000 });
      await a.page.$eval('[data-action="whisper-tab"]', (b) => b.click());
      await a.page.type('[aria-label="Whisper message"]', 'meet at 8?');
      const mP = ev(other.s, 'whisper:message');
      await a.page.$eval('[data-action="whisper-send"]', (b) => b.click());
      const m = await mP;
      other.s.emit('whisper:seen', { whisperId: w.whisper.id, messageId: m.id });
      const seen = await a.page.waitForSelector('[data-testid="whisper-seen"]', { timeout: 5000 }).catch(() => null);
      ok(!!seen && /Seen by GgOther/.test(await seen.evaluate((e) => e.textContent)), `${width}: G5: "Seen by" shows under my whisper`);
      const back = ev(other.s, 'whisper:seen');
      await emit(other.s, 'whisper:send', { whisperId: w.whisper.id, text: 'yes!' });
      ok(!!(await back), `${width}: G5: reading in the open whisper sends my receipt`);
      await a.page.$eval('[data-testid="whisper-strip"]', (e) => e.scrollIntoView({ block: 'center' }));
      ok(await noSideScroll(a.page), `${width}: G5: no sideways scroll`);
      await shot(a.page, `g5-whisper-seen-${width}`);
      await a.page.$eval('[data-testid="whisper-receipts"]', (b) => b.click());
      const gone = await a.page.waitForFunction(() => !document.querySelector('[data-testid="whisper-seen"]'), { timeout: 4000 }).catch(() => null);
      await shot(a.page, `g5-whisper-receipts-off-${width}`);
      await a.ctx.close(); await fresh(mem);
      const saved = (await emit(mem.s, 'whisper:receipts', {})).on;
      ok(!!gone && saved === false, `${width}: G5: turning receipts off hides others' receipts and saves`, JSON.stringify({ gone: !!gone, saved }));
      await emit(mem.s, 'whisper:receipts', { on: true }); await emit(mem.s, 'room:join', { roomId: room }); await fresh(other); await emit(other.s, 'room:join', { roomId: room });
    }
    // @@UI-END
  }
  void fresh;
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  server.kill('SIGTERM'); libre.close();
}
if (failed && process.env.SHOWLOG) console.log(log.slice(-3000));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
