/**
 * Room webhook checks: incoming (Discord-compatible), outgoing (signed, retries, auto-disable, SSRF), management, admin, docs.
 * Screenshots at 1366 and 390.   npm run build && node scripts/webhook-check.mjs [shots-dir]
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
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-webhooks'));
fs.mkdirSync(OUT, { recursive: true });
import crypto from 'node:crypto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// a local receiver for outgoing deliveries (the only loopback host:port the server may call)
const recvHits = []; let recvMode = 'ok';
const recv = http.createServer((req, res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => {
  recvHits.push({ path: req.url, headers: req.headers, body: Buffer.concat(ch).toString('utf8'), at: Date.now() });
  if (recvMode === 'slow') return void setTimeout(() => { res.writeHead(200); res.end('late'); }, 8000);
  res.writeHead(recvMode === 'fail' ? 500 : 200); res.end('ok'); }); });
await new Promise((r) => recv.listen(0, '127.0.0.1', r));
const RECV_PORT = recv.address().port;
const RECV = `http://127.0.0.1:${RECV_PORT}`;
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-webhooks-'));
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'WhAdmin', OUTBOUND_TEST_ALLOW: `127.0.0.1:${RECV_PORT}`, WEBHOOK_RETRY_SCALE: '0.002', PUBLIC_URL: '', RECORDING_MAX_BYTES: '400000', RECORDING_SWEEP_MS: '1500', ONBOARDING_SINCE: '0', RECORDING_IDLE_MS: '6000', RECONNECT_GRACE_MS: '800',
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

const waitFor = async (fn, ms = 4000) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); } return !!fn(); };
const events = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
const R = crypto.randomBytes(2).toString('hex');
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
try {
  const O = await nodeUser(`WhO${R}`), M = await nodeUser(`WhM${R}`), X = await nodeUser(`WhX${R}`);
  sockets.push(O.s, M.s, X.s);
  const rc = await emit(O.s, 'room:create', { name: `hooks ${R}`, topic: 't', category: 'gaming' });
  const ROOM = rc.roomId; globalThis.ROOM = ROOM;
  await emit(O.s, 'room:join', { roomId: ROOM }); await emit(M.s, 'room:join', { roomId: ROOM });
  const mMsg = events(M.s, 'chat:message');
  // @@INCOMING
  {
    const nope = await X.j.req(`/api/rooms/${ROOM}/webhooks`, { kind: 'incoming', name: 'x' });
    ok(nope.status === 403, 'IN: only the owner (or a role with the permission) can create webhooks');
    const c = await O.j.req(`/api/rooms/${ROOM}/webhooks`, { kind: 'incoming', name: 'Deploy bot' });
    ok(c.ok && /\/api\/webhooks\/[a-f0-9]{20}\/[A-Za-z0-9_-]{40,}$/.test(c.url), 'IN: create returns the secret URL once', c.error);
    const URL1 = BASE + new URL(c.url).pathname; globalThis.IN_URL = URL1; globalThis.IN_ID = c.webhook.id;
    const list = await O.j.req(`/api/rooms/${ROOM}/webhooks`);
    ok(list.ok && !JSON.stringify(list).includes(new URL(c.url).pathname.split('/').pop()), 'IN: the token is never listed again (hash only)');
    const r1 = await post(URL1, { content: `hello from a script ${R}` });
    ok(r1.status === 204, `IN: POST JSON returns 204 like Discord (${r1.status})`);
    ok(await waitFor(() => mMsg.some((m) => m.text === `hello from a script ${R}` && m.webhook && m.from === 'Deploy bot')), 'IN: the line arrives live with the webhook name and badge data');
    const r2 = await post(URL1 + '?wait=true', { content: 'with wait', username: 'FiveM Server', embeds: [{ title: 'Player joined', description: '**Bob** joined', color: 0x22aa66, fields: [{ name: 'Ping', value: '42', inline: true }], footer: { text: 'txAdmin' }, timestamp: new Date().toISOString() }] });
    const j2 = await r2.json();
    ok(r2.status === 200 && j2.id && j2.webhook_id === c.webhook.id && j2.author?.username === 'FiveM Server', 'IN: ?wait=true returns the message object (username override)');
    const m2 = await waitFor(() => mMsg.some((m) => m.id === j2.id)) && mMsg.find((m) => m.id === j2.id);
    ok(m2?.webhook?.embeds?.[0]?.title === 'Player joined' && m2.webhook.embeds[0].fields[0].inline === true && m2.webhook.embeds[0].color === 0x22aa66, 'IN: embeds (title/description/color/fields/footer/timestamp) kept');
    const only = await post(URL1 + '?wait=true', { embeds: [{ title: 'Embed only', description: 'desc' }] });
    const oj = await only.json();
    ok(only.status === 200 && oj.id, 'IN: embed-only posts work');
    const long = await post(URL1, { content: 'x'.repeat(2001) });
    ok(long.status === 400, 'IN: content over 2000 characters is refused (400)');
    const empty = await post(URL1, { content: '   ' });
    ok(empty.status === 400 && (await empty.json()).code === 50006, 'IN: empty message refused with Discord code 50006');
    await sleep(2100);
    const ev = await post(URL1 + '?wait=true', { content: `@everyone @here look <@123456789012> <:pog:123456789012345> <t:1700000000:F> @WhM${R}` });
    const evj = await ev.json();
    await waitFor(() => mMsg.some((m) => m.id === evj.id));
    const evm = mMsg.find((m) => m.id === evj.id);
    ok(evm && !/@everyone|@here/.test(evm.text) && /@\u200beveryone/.test(evm.text), 'IN: @everyone / @here are defused');
    ok(evm && evm.mentions.length === 0, 'IN: webhook lines never create @mention notifications');
    ok(evm && evm.text.includes(':pog:') && evm.text.includes('2023-11-14') && evm.text.includes('@user'), 'IN: Discord markup (<:emoji:id>, <t:…>, <@id>) translated');
    const xss = await post(URL1 + '?wait=true', { content: '<img src=x onerror=alert(1)> [click](javascript:alert(1))' });
    ok(xss.status === 200, 'IN: HTML/js links accepted as text (rendered through the chat sanitizer; checked in the UI below)');
    const bad = await post(BASE + `/api/webhooks/${c.webhook.id}/wrongtoken`, { content: 'x' });
    ok(bad.status === 404 && (await bad.json()).code === 10015, 'IN: wrong token = 404 Unknown Webhook');
    const form = await fetch(URL1, { method: 'POST', body: (() => { const f = new FormData(); f.append('payload_json', JSON.stringify({ content: `multipart ${R}` })); f.append('files[0]', new Blob(['hi']), 'a.txt'); return f; })() });
    ok(form.status === 204 && await waitFor(() => mMsg.some((m) => m.text === `multipart ${R}`)), 'IN: multipart payload_json (Discord file uploads) accepted; files ignored');
    await sleep(2100);
    const slack = await post(URL1 + '/slack', { text: `slack style <https://example.com|link> ${R}` });
    ok(slack.status === 204 && await waitFor(() => mMsg.some((m) => m.text.includes(`slack style [link](https://example.com/) ${R}`) || m.text.includes(`slack style [link](https://example.com) ${R}`))), 'IN: /slack variant ({text})');
    const gh = await post(URL1 + '/github', { ref: 'refs/heads/main', compare: 'https://github.com/a/b/compare/x', repository: { full_name: 'a/b' }, sender: { login: 'octo' }, commits: [{ id: 'abcdef123456', url: 'https://github.com/a/b/commit/abc', message: 'Fix things', author: { name: 'Octo' } }] }, { 'x-github-event': 'push' });
    ok(gh.status === 204 && await waitFor(() => mMsg.some((m) => m.webhook?.embeds?.[0]?.title?.includes('[a/b:main] 1 new commit'))), 'IN: /github variant (push)');
    const get = await fetch(URL1); const gj = await get.json();
    ok(get.status === 200 && gj.id === c.webhook.id && gj.channel_id === ROOM, 'IN: GET on the URL answers like Discord (tools check it)');
    // rate limit: 5 per 2 s per hook
    await sleep(2100);
    const codes = []; for (let i = 0; i < 7; i++) codes.push((await post(URL1, { content: `burst ${i}` })).status);
    const lim = await post(URL1, { content: 'over' }); const lj = await lim.json();
    ok(codes.slice(0, 5).every((s) => s === 204) && codes.includes(429) && lim.status === 429 && lj.retry_after > 0 && lim.headers.get('retry-after'), `IN: rate limited with 429 + retry_after (${codes.join(',')})`);
    const hist = await emit(M.s, 'room:join', { roomId: ROOM });
    await emit(M.s, 'room:leave', {}); await emit(M.s, 'room:join', { roomId: ROOM });
    const h2 = (await emit(X.s, 'room:join', { roomId: ROOM })).room.history.find((m) => m.id === j2.id);
    ok(h2?.webhook?.embeds?.length === 1 && h2.from === 'FiveM Server' && h2.fromId.startsWith('hook:'), 'IN: webhook lines keep name, badge and embeds in history');
    void hist;
  }
  // @@OUTGOING
  {
    const bad1 = await O.j.req(`/api/rooms/${ROOM}/webhooks`, { kind: 'outgoing', name: 'o', url: 'http://example.com/x', events: ['message'] });
    ok(!bad1.ok && /https/.test(bad1.error), 'OUT: plain http refused');
    for (const u of ['https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://localhost/x', 'https://user:pw@example.com/']) {
      const r = await O.j.req(`/api/rooms/${ROOM}/webhooks`, { kind: 'outgoing', name: 'o', url: u, events: ['message'] });
      ok(!r.ok, `OUT: SSRF target refused: ${u}`);
    }
    const c = await O.j.req(`/api/rooms/${ROOM}/webhooks`, { kind: 'outgoing', name: 'Relay', url: `${RECV}/hook`, events: ['message', 'join', 'leave', 'voice', 'poll', 'mod'] });
    ok(c.ok && /^whsec_/.test(c.secret || ''), 'OUT: create returns the signing secret once', c.error);
    const SECRET = c.secret, OID = c.webhook.id; globalThis.OUT_ID = OID;
    recvHits.length = 0;
    await emit(M.s, 'chat:send', { text: `outgoing ${R}` });
    ok(await waitFor(() => recvHits.some((h) => h.headers['x-zn-event'] === 'message')), 'OUT: message event delivered');
    const h = recvHits.find((x) => x.headers['x-zn-event'] === 'message');
    const expect = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${h.headers['x-zn-timestamp']}.${h.body}`).digest('hex');
    ok(h.headers['x-zn-signature'] === expect, 'OUT: HMAC-SHA256 signature (timestamp.body) verifies');
    const b = JSON.parse(h.body);
    ok(b.event === 'message' && b.room.id === ROOM && b.data.text === `outgoing ${R}` && b.data.user.nick === M.nick && h.headers['x-zn-delivery'] === b.id, 'OUT: body has event, room, webhook, data');
    ok(h.headers['x-zn-webhook-id'] === OID, 'OUT: x-zn-webhook-id header');
    const wrong = 'sha256=' + crypto.createHmac('sha256', 'nope').update(`${h.headers['x-zn-timestamp']}.${h.body}`).digest('hex');
    ok(wrong !== h.headers['x-zn-signature'], 'OUT: a wrong secret does not verify');
    recvHits.length = 0;
    const Y = await nodeUser(`WhY${R}`); sockets.push(Y.s);
    await emit(Y.s, 'room:join', { roomId: ROOM });
    ok(await waitFor(() => recvHits.some((x) => x.headers['x-zn-event'] === 'join' && JSON.parse(x.body).data.user.nick === Y.nick)), 'OUT: join event');
    await emit(Y.s, 'media:state', { mic: true });
    ok(await waitFor(() => recvHits.some((x) => x.headers['x-zn-event'] === 'voice')), 'OUT: voice start event');
    await emit(Y.s, 'room:leave', {});
    ok(await waitFor(() => recvHits.some((x) => x.headers['x-zn-event'] === 'leave')), 'OUT: leave event');
    const pc = await emit(O.s, 'poll:create', { question: `Pizza ${R}?`, options: ['yes', 'no'] });
    ok(pc.ok && await waitFor(() => recvHits.some((x) => x.headers['x-zn-event'] === 'poll' && JSON.parse(x.body).data.action === 'create')), 'OUT: poll create event', pc.error);
    await emit(O.s, 'poll:close', { pollId: pc.poll?.id });
    ok(await waitFor(() => recvHits.some((x) => x.headers['x-zn-event'] === 'poll' && JSON.parse(x.body).data.action === 'close')), 'OUT: poll close event');
    await emit(Y.s, 'room:join', { roomId: ROOM });
    await emit(O.s, 'room:kick', { userId: Y.s.id });
    ok(await waitFor(() => recvHits.some((x) => x.headers['x-zn-event'] === 'mod' && JSON.parse(x.body).data.action === 'kick')), 'OUT: mod action event (kick)');
    // webhook lines themselves are not re-sent as 'message' (no loops)
    recvHits.length = 0;
    await post(IN_URL, { content: `loop ${R}` }); await sleep(800);
    ok(!recvHits.some((x) => x.body.includes(`loop ${R}`)), 'OUT: incoming webhook lines are not relayed out (no loops)');
    // only subscribed events
    const c2 = await O.j.req(`/api/rooms/${ROOM}/webhooks`, { kind: 'outgoing', name: 'Joins only', url: `${RECV}/joins`, events: ['join'] });
    recvHits.length = 0;
    await emit(M.s, 'chat:send', { text: 'not for joins' }); await sleep(700);
    ok(c2.ok && !recvHits.some((x) => x.path === '/joins'), 'OUT: hooks only get the events they chose');
    // test button
    recvHits.length = 0;
    const tb = await O.j.req(`/api/rooms/${ROOM}/webhooks/${OID}/test`, {});
    ok(tb.ok && await waitFor(() => recvHits.some((x) => x.headers['x-zn-event'] === 'test')), 'OUT: test button sends a signed test event');
    // retries then success
    recvMode = 'fail'; recvHits.length = 0;
    await emit(M.s, 'chat:send', { text: `retry ${R}` });
    await waitFor(() => recvHits.filter((x) => x.body.includes(`retry ${R}`)).length >= 2, 3000);
    recvMode = 'ok';
    ok(await waitFor(() => recvHits.filter((x) => x.body.includes(`retry ${R}`)).length >= 3, 5000), `OUT: failed deliveries are retried with backoff (${recvHits.length} tries)`);
    const lg = await O.j.req(`/api/rooms/${ROOM}/webhooks/${OID}/log`);
    ok(lg.ok && lg.log.length <= 20 && lg.log.some((e) => e.status === 500) && lg.log.some((e) => e.ok), 'OUT: delivery log shows failures and successes (max 20)');
    // timeout
    recvMode = 'slow';
    await O.j.req(`/api/rooms/${ROOM}/webhooks/${OID}/test`, {});
    await sleep(6500);
    const lg2 = await O.j.req(`/api/rooms/${ROOM}/webhooks/${OID}/log`);
    ok(lg2.log.some((e) => /time/i.test(e.error || '')), 'OUT: slow receivers time out (5 s)');
    // auto-disable after repeated failures
    recvMode = 'fail';
    for (let i = 0; i < 11; i++) await O.j.req(`/api/rooms/${ROOM}/webhooks/${c2.webhook.id}/test`, {});
    const dis = await (async () => { for (let i = 0; i < 300; i++) { const l = await O.j.req(`/api/rooms/${ROOM}/webhooks`); const w = l.webhooks.find((x) => x.id === c2.webhook.id); if (!w.enabled) return w; await sleep(100); } return null; })();
    ok(dis && /fail/i.test(dis.disabledReason || ''), 'OUT: auto-disabled after 10 failed deliveries');
    recvMode = 'ok';
    const re = await O.j.req(`/api/rooms/${ROOM}/webhooks/${c2.webhook.id}`, { enabled: true }, 'PATCH');
    ok(re.ok, 'OUT: can be enabled again', re.error);
  }
  // @@API-END
  // @@UI
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  server.kill('SIGTERM'); recv.close();
}
if (failed && process.env.SHOWLOG) console.log(log.slice(-3000));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
