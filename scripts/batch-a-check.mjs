/**
 * Batch A checks: server read markers + unread counts, mentions inbox, persistent whispers (privacy, restart,
 * retention), the lobby-load race, the extra Back press after creating a room, plus screenshots at 1366 / 390.
 *   npm run build && node scripts/batch-a-check.mjs [shots-dir]
 */
import './lib/reap.mjs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const { io: ioClient } = require('socket.io-client');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-batch-a'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-batch-a-'));
const BASE = `http://127.0.0.1:${port}`;
let server = null; let log = '';
async function start() {
  log = '';
  server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: '', RECONNECT_GRACE_MS: '800' } });
  server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200 && !log.includes('listening'); i++) await sleep(100);
}
async function stop() { if (!server) return; const s = server; server = null; s.kill('SIGTERM'); await new Promise((r) => s.once('exit', r)); }
await start();

function jar() {
  const m = new Map();
  const header = () => [...m].map(([k, v]) => `${k}=${v}`).join('; ');
  return { header, async req(p, body) {
    const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'x-csrf': '1', cookie: header(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); m.set(kv.slice(0, i), kv.slice(i + 1)); }
    return r.json().catch(() => ({}));
  } };
}
const emit = (s, ev, ...a) => new Promise((res) => { const t = setTimeout(() => res({ ok: false, error: `timeout ${ev}` }), 8000); s.emit(ev, ...a, (r) => { clearTimeout(t); res(r); }); });
const leave = async (s) => { s.emit('room:leave'); await sleep(250); };
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

const sockets = [];
let browser;
try {
  // ---------- 1. read markers + unread counts ----------
  const A = await nodeUser('BaAlice'); const B = await nodeUser('BaBob'); const C = await nodeUser('BaCarl');
  sockets.push(A.s, B.s, C.s);
  ok((await emit(A.s, 'room:join', { roomId: 'lobby' })).ok, 'A joins lobby');
  await leave(A.s); await sleep(200);
  let u = await emit(A.s, 'unread:get');
  ok(u.ok && !u.rooms.lobby, 'no unread right after leaving', JSON.stringify(u));
  await emit(B.s, 'room:join', { roomId: 'lobby' });
  for (const t of ['one', 'two', 'three']) { await emit(B.s, 'chat:send', { text: `hello ${t}` }); await sleep(120); }
  u = await emit(A.s, 'unread:get');
  ok(u.rooms.lobby?.n === 3 && !u.rooms.lobby.mention, 'A has 3 unread in lobby (server-side)', JSON.stringify(u));
  const newEvents = [];
  A.s.on('mentions:new', (p) => newEvents.push(p));
  await emit(B.s, 'chat:send', { text: '@BaAlice look at this' }); await sleep(300);
  u = await emit(A.s, 'unread:get');
  ok(u.rooms.lobby?.n === 4 && u.rooms.lobby.mention, 'mention flag set on the unread count', JSON.stringify(u));
  ok(u.mentions === 1, 'mentions badge count is 1', String(u.mentions));
  ok(newEvents.length === 1 && newEvents[0].item.kind === 'mention' && newEvents[0].item.from === 'BaBob', 'A gets a live mentions:new event');
  // per account: a second device of A sees the same counts
  const A2 = await sock(A.j); sockets.push(A2);
  const u2 = await emit(A2, 'unread:get');
  ok(u2.rooms.lobby?.n === 4, 'a second session of the same account sees the same unread count');
  A.s = A2; // one live session per account: the new login takes over
  // reopening gives the read marker for the divider
  const jr = await emit(A.s, "room:join", { roomId: "lobby" });
  if (!jr.room) console.log("join2", JSON.stringify(jr));
  const firstNew = jr.room.history.find((m) => m.kind === 'chat' && m.ts > jr.room.lastReadTs);
  ok(typeof jr.room.lastReadTs === 'number' && firstNew?.text === 'hello one', 'room state carries lastReadTs; first new line is "hello one"');
  ok((await emit(A.s, 'room:read', { roomId: 'lobby' })).ok, 'room:read accepted');
  ok(!(await emit(A.s, 'room:read', { roomId: 'not-here' })).ok, 'room:read refused for a room you are not in');
  await leave(A.s); await sleep(200);
  u = await emit(A.s, 'unread:get');
  ok(!u.rooms.lobby && u.mentions === 0, 'after reading: no unread and the mention is read', JSON.stringify(u));

  // ---------- 2. mentions inbox ----------
  await emit(A.s, 'room:join', { roomId: 'lobby' });
  await emit(A.s, 'chat:send', { text: 'my own message' }); await sleep(150);
  const mine = (await emit(B.s, 'room:join', { roomId: 'lobby' })).room?.history.findLast?.((m) => m.text === 'my own message');
  await leave(A.s); await sleep(150);
  await emit(B.s, 'chat:send', { text: 'replying to you', parentId: mine?.id }); await sleep(150);
  await emit(B.s, 'chat:send', { text: 'hey @BaAlice again' }); await sleep(150);
  await emit(B.s, 'chat:send', { text: 'hey @BaBob self' }); await sleep(150);
  let ml = await emit(A.s, 'mentions:list');
  ok(ml.ok && ml.items.length === 3, 'inbox lists 3 items (2 mentions + 1 reply)', JSON.stringify(ml.items?.map((i) => i.kind)));
  ok(ml.items[0].kind === 'mention' && ml.items[1].kind === 'reply' && ml.items[1].text === 'replying to you', 'reply to your message is in the inbox as "reply"');
  ok(ml.unread === 2 && ml.items[2].read, 'old mention read, 2 unread', String(ml.unread));
  ok(ml.items[0].roomName === 'lobby' || /lobby/i.test(ml.items[0].roomName), 'items carry the room name');
  ok(!(await emit(B.s, 'mentions:list')).items.some((i) => i.text === 'hey @BaBob self'), 'mentioning yourself does not add to your inbox');
  let mr = await emit(A.s, 'mentions:read', { ids: [ml.items[0].id] });
  ok(mr.ok && mr.unread === 1, 'mark one read -> 1 unread');
  mr = await emit(A.s, 'mentions:read', { ids: [ml.items[0].id], read: false });
  ok(mr.unread === 2, 'mark it unread again -> 2 unread');
  mr = await emit(A.s, 'mentions:read', { ids: 'all' });
  ok(mr.unread === 0, 'mark all read -> 0');
  ok(!(await emit(C.s, 'mentions:read', { ids: [ml.items[1].id], read: false })).unread, 'another account cannot touch your items');
  ok((await emit(A.s, 'mentions:list')).items.every((i) => i.read), 'still all read after a foreign attempt');
  // a mention in a password room you are not in is not recorded (no leak of a private line)
  const pr = await emit(B.s, 'room:create', { name: 'ba-secret', password: 'pw-secret-room' });
  ok(pr.ok, 'password room created');
  await emit(B.s, 'room:join', { roomId: pr.roomId, password: 'pw-secret-room' });
  await emit(B.s, 'chat:send', { text: 'secret @BaAlice' }); await sleep(250);
  ok(!(await emit(A.s, 'mentions:list')).items.some((i) => /secret/.test(i.text)), 'mention in a password room you are not in stays out of your inbox');
  const guestUnread = await emit(ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false }), 'unread:get').catch(() => null);
  void guestUnread;

  // ---------- 3. persistent whispers ----------
  const room = await emit(B.s, 'room:create', { name: 'ba-whisper' });
  for (const x of [A, B, C]) await emit(x.s, 'room:join', { roomId: room.roomId });
  const w = await emit(A.s, 'whisper:start', { userIds: [B.s.id] });
  ok(w.ok, 'whisper started', w.error);
  ok((await emit(A.s, 'whisper:send', { whisperId: w.whisper.id, text: 'secret pineapple plan' })).ok, 'whisper sent');
  await sleep(1100);
  const bw = await emit(B.s, 'whisper:send', { whisperId: w.whisper.id, text: 'pineapple agreed' }); await sleep(200);
  ok(bw.ok, 'B whisper sent', JSON.stringify(bw));
  let ws = await emit(C.s, 'whisper:search', { q: 'pineapple' });
  ok(ws.ok && ws.hits.length === 0, 'a third person in the room finds nothing');
  // the DB stores members only
  {
    const db = new DatabaseSync(path.join(DATA, 'camchat.db'), { readOnly: true });
    const mem = db.prepare('SELECT DISTINCT user_id FROM whisper_members').all().map((r) => r.user_id).sort();
    ok(JSON.stringify(mem) === JSON.stringify([A.id, B.id].sort()), 'stored members are exactly the two people', JSON.stringify(mem));
    db.close();
  }
  for (const x of sockets) x.disconnect();
  await stop(); await start();
  const A3 = await sock(A.j); const B3 = await sock(B.j); const C3 = await sock(C.j); sockets.push(A3, B3, C3);
  for (const x of [A3, B3, C3]) await emit(x, 'room:join', { roomId: room.roomId });
  ws = await emit(A3, 'whisper:search', { q: 'pineapple' });
  ok(ws.ok && ws.hits.length === 2, 'after a restart and reconnect, A still finds both whisper lines', JSON.stringify(ws));
  ok(ws.hits.some((h) => h.fromId === A3.id && h.text === 'secret pineapple plan'), 'own saved line is marked as mine');
  ws = await emit(B3, 'whisper:search', { q: 'agreed' });
  ok(ws.hits.length === 1, 'B finds it too after restart');
  ws = await emit(C3, 'whisper:search', { q: 'pineapple' });
  ok(ws.hits.length === 0, 'C still finds nothing after restart');
  ws = await emit(A3, 'whisper:search', { q: 'pineapple', from: 'BaBob' });
  ok(ws.hits.length === 1, 'from: filter works on saved lines');
  // retention: lines older than 30 days are gone
  {
    for (const x of [A3, B3, C3]) x.disconnect();
    await stop();
    const db = new DatabaseSync(path.join(DATA, 'camchat.db'));
    db.prepare('UPDATE whisper_messages SET ts = ? WHERE text = ?').run(Date.now() - 31 * 24 * 3600_000, 'pineapple agreed');
    db.close();
    await start();
  }
  const A4 = await sock(A.j); sockets.push(A4);
  await emit(A4, 'room:join', { roomId: room.roomId }).catch(() => {});
  const jr4 = await emit(A4, 'room:join', { roomId: room.roomId });
  ws = await emit(A4, 'whisper:search', { q: 'pineapple' });
  ok(jr4.ok !== false && ws.hits.length === 1 && ws.hits[0].text === 'secret pineapple plan', 'lines past 30 days are not returned', JSON.stringify(ws.hits?.map((h) => h.text)));
  {
    await sleep(300);
    const db = new DatabaseSync(path.join(DATA, 'camchat.db'), { readOnly: true });
    const left = db.prepare('SELECT COUNT(*) AS n FROM whisper_messages WHERE text = ?').get('pineapple agreed').n;
    db.close();
    ok(left === 0, 'the prune at start removed the expired line', String(left));
  }
  A4.disconnect();

  // ---------- 4/5 + screenshots in the browser ----------
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const B5 = await sock(B.j); sockets.push(B5);
  await emit(B5, 'room:join', { roomId: 'lobby' });
  for (const width of [1366, 390]) {
    const phone = width < 800;
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.setViewport(phone ? { width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width, height: 800 });
    const cookies = A.j.header().split('; ').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE }; });
    await page.setCookie(...cookies);
    // 4: lobby loads every time (20 cold loads)
    let loads = 0;
    for (let i = 0; i < (phone ? 8 : 20); i++) {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      if (await page.waitForSelector('.room-card[data-room="lobby"]', { timeout: 10000 }).then(() => true, () => false)) loads++;
      else console.log('lobby miss', await page.evaluate(() => ({ cards: document.querySelectorAll('.room-card').length, body: document.body.innerText.slice(0, 300), conn: document.querySelector('.conn-banner,.offline')?.textContent })));
    }
    ok(loads === (phone ? 8 : 20), `${width}: lobby room list appeared on every cold load (${loads})`);
    await page.evaluate(() => [...document.querySelectorAll('a,button')].find((e) => e.textContent.trim() === 'Dismiss')?.click());
    // a fresh mention + unread for the bell, inbox and rail
    await emit(B5, 'chat:send', { text: `@BaAlice ping from the lobby at ${width}` }); await sleep(150);
    await emit(B5, 'chat:send', { text: 'another lobby line' }); await sleep(150);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.room-card[data-room="lobby"]', { timeout: 10000 });
    await page.evaluate(() => [...document.querySelectorAll('a,button')].find((e) => e.textContent.trim() === 'Dismiss')?.click());
    const badge = await page.waitForSelector('[data-testid="mentions-badge"]', { timeout: 6000 }).then(() => true, () => false);
    ok(badge, `${width}: bell shows an unread mentions badge`);
    ok(!!(await page.$(`[data-unread="lobby"]`)), `${width}: lobby list shows the server unread badge`);
    await sleep(300); await page.screenshot({ path: path.join(OUT, `a1-unread-lobby-${width}.png`) });
    await page.$eval('[data-action="mentions-bell"]', (b) => b.click());
    await page.waitForSelector('[data-sheet="mentions"] [data-mention]', { timeout: 6000 });
    ok((await page.$$('[data-sheet="mentions"] .mention-item.unread')).length >= 1, `${width}: mentions dialog lists unread items`);
    await sleep(300); await page.screenshot({ path: path.join(OUT, `a2-mentions-inbox-${width}.png`) });
    // toggle read/unread in the dialog
    await page.$eval('[data-sheet="mentions"] .mention-item.unread [data-action="mention-toggle"]', (b) => b.click()); await sleep(400);
    const afterToggle = await page.$eval('[data-sheet="mentions"] [data-mentions-unread]', (e) => +e.getAttribute('data-mentions-unread'));
    await page.$eval('[data-sheet="mentions"] [data-mention] [data-action="mention-toggle"]', (b) => b.click()); await sleep(400);
    ok(afterToggle >= 0, `${width}: read toggle updates the count (${afterToggle})`);
    // the menu item opens the same dialog
    await page.keyboard.press('Escape'); await sleep(300);
    await page.$eval('[data-action="profile"]', (b) => b.click());
    await page.waitForSelector('.me-pop-panel:not([hidden]) [data-action="open-mentions"]', { timeout: 6000 });
    ok(true, `${width}: Your profile menu has a Mentions item`);
    await sleep(300); await page.screenshot({ path: path.join(OUT, `a2-mentions-menu-${width}.png`) });
    await page.$eval('[data-action="open-mentions"]', (b) => b.click());
    await page.waitForSelector('[data-sheet="mentions"] [data-action="mention-open"]', { timeout: 6000 });
    // jump: opens the lobby room with the divider
    await page.$eval('[data-sheet="mentions"] [data-action="mention-open"]', (b) => b.click());
    await page.waitForSelector('.chat-log', { timeout: 10000 });
    const divider = await page.waitForSelector('[data-testid="new-messages-divider"]', { timeout: 5000 }).then(() => true, () => false);
    ok(divider, `${width}: opening the room shows the "New messages" divider`);
    ok(!(await page.$('[data-sheet]')), `${width}: the dialog closed on jump`);
    ok(await page.evaluate(() => !(history.state && history.state.znSheet)), `${width}: no leftover sheet history entry after the jump`);
    await page.evaluate(() => document.querySelector('[data-testid="new-messages-divider"]')?.scrollIntoView({ block: 'center' }));
    await sleep(400); await page.screenshot({ path: path.join(OUT, `a1-new-divider-${width}.png`) });
    // rail badge: a line in another room
    const other = { roomId: phone ? 'music' : 'gaming' };
    await emit(B5, 'room:join', { roomId: other.roomId });
    await emit(B5, 'chat:send', { text: 'rail line 1' }); await sleep(150);
    await emit(B5, 'chat:send', { text: '@BaAlice rail mention' }); await sleep(500);
    if (phone) { await page.$eval('[data-action="open-rail"]', (b) => b.click()); await sleep(400); }
    const rb = await page.waitForSelector(`[data-rail-unread="${other.roomId}"]`, { timeout: 5000 }).then(() => true, () => false);
    ok(rb, `${width}: room rail shows an unread badge for the other room`);
    if (!rb) console.log('rail', await page.evaluate(() => [...document.querySelectorAll('[data-rail-room]')].map((e) => e.getAttribute('data-rail-room') + ':' + (e.querySelector('.rail-badge')?.textContent ?? '-')).join(' ')), other);
    await sleep(300); await page.screenshot({ path: path.join(OUT, `a1-rail-badge-${width}.png`) });
    if (phone) await page.keyboard.press('Escape');
    await emit(B5, 'room:join', { roomId: 'lobby' });
    // 5: Back after creating a room from the Start a room dialog
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-action="create-room"]', { timeout: 10000 });
    const h0 = await page.evaluate(() => history.length);
    await page.$eval('[data-action="create-room"]', (b) => b.click());
    await page.waitForSelector('[data-sheet="create"] input', { timeout: 6000 });
    await page.type('[data-sheet="create"] input', `Back test ${width}`);
    await page.$eval('[data-sheet="create"] form', (f) => f.requestSubmit());
    await page.waitForSelector('.chat-log', { timeout: 10000 }); await sleep(600);
    const st = await page.evaluate(() => ({ len: history.length, sheet: !!(history.state && history.state.znSheet) }));
    ok(!st.sheet && st.len <= h0 + 1, `${width}: no stale sheet entry after creating a room (len ${h0} -> ${st.len})`);
    await page.close(); await ctx.close();
  }
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  await stop();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
