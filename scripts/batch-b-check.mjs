/**
 * Batch B checks: custom emoji reactions + emoji upload limits/review, slow mode + word/link filters (Meowington,
 * mod queue), scheduled banner + event reminder lines, link previews (X, images, SSRF, per-user toggle), admin stats.
 * Screenshots at 1366 and 390.   npm run build && node scripts/batch-b-check.mjs [shots-dir]
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
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-batch-b'));
fs.mkdirSync(OUT, { recursive: true });
const NET = process.env.BATCH_B_NET !== '0'; // real X / image fetches (needs internet)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && extra ? ` (${extra})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-batch-b-'));
const BASE = `http://127.0.0.1:${port}`;
// a local "internal" server the preview fetcher must never reach
let internalHits = 0;
const internal = http.createServer((_q, s) => { internalHits++; s.end('<html><head><title>INTERNAL SECRET</title></head></html>'); }).listen(0, '127.0.0.1');
await new Promise((r) => internal.once('listening', r));
const server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'BbAdmin', RECONNECT_GRACE_MS: '800',
    SCHEDULE_TICK_MS: '300', EVENT_TICK_MS: '300', EVENT_REMIND_LEAD_MS: '4000', STATS_SAMPLE_MS: '500' } });
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
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

try {
  const owner = await nodeUser('BbOwner'); const mem = await nodeUser('BbMember'); const admin = await nodeUser('BbAdmin'); const other = await nodeUser('BbOther');
  sockets.push(owner.s, mem.s, admin.s, other.s);
  const cr = await emit(owner.s, 'room:create', { name: 'bb-party' });
  ok(cr.ok, 'owner creates a room', cr.error);
  const room = cr.roomId;
  await emit(owner.s, 'room:join', { roomId: room });
  await emit(mem.s, 'room:join', { roomId: room });

  // ---------- 6. custom emoji: upload limits, review entry, reactions ----------
  let up = await uploadEmote(owner.j, room, 'partycat', await png('#ff8800'));
  ok(up.ok && up.emote?.name === 'partycat', 'owner uploads a custom emoji', JSON.stringify(up));
  const big = Buffer.concat([await png('#00ff00', 64), Buffer.alloc(600 * 1024, 1)]);
  up = await uploadEmote(owner.j, room, 'toobig', big);
  ok(!up.ok && /too large/i.test(up.error ?? ''), 'emoji over 512 KB is refused', up.error);
  up = await uploadEmote(owner.j, room, 'notimg', Buffer.from('hello world, definitely not an image file at all'), 'text/plain', 'x.txt');
  ok(!up.ok, 'non-image upload is refused', up.error);
  up = await uploadEmote(mem.j, room, 'sneaky', await png('#123456'));
  ok(!up.ok && up.status === 403, 'a non-owner cannot upload emoji', String(up.status));
  const q1 = await admin.j.req('/api/admin/reports?view=queue&status=open');
  const emoteItem = (q1.items ?? []).find((i) => i.key?.startsWith('emote:'));
  ok(!!emoteItem && emoteItem.reports?.[0]?.reporterNick !== undefined || !!emoteItem, 'the new emoji is in the moderation queue for review', JSON.stringify((q1.items ?? []).map((i) => i.key)));
  await emit(mem.s, 'chat:send', { text: 'react to me please' }); await sleep(200);
  const hist = (await emit(other.s, 'room:join', { roomId: room })).room.history;
  const target = [...hist].reverse().find((m) => m.text === 'react to me please');
  let rx = await emit(mem.s, 'chat:react', { messageId: target.id, emoji: ':partycat:' });
  ok(rx.ok && rx.reactions.some((r) => r.emoji === ':partycat:' && r.count === 1 && r.mine), 'react with the room emoji', JSON.stringify(rx));
  rx = await emit(owner.s, 'chat:react', { messageId: target.id, emoji: ':partycat:' });
  ok(rx.reactions.find((r) => r.emoji === ':partycat:')?.count === 2, 'second person adds to the count');
  rx = await emit(owner.s, 'chat:react', { messageId: target.id, emoji: ':nosuch:' });
  ok(!rx.ok, 'unknown :emoji: is refused');
  rx = await emit(owner.s, 'chat:react', { messageId: target.id, emoji: '🔥' });
  ok(rx.ok, 'built-in emoji still work');
  rx = await emit(owner.s, 'chat:react', { messageId: target.id, emoji: '<img src=x>' });
  ok(!rx.ok, 'arbitrary strings are refused');

  // ---------- 7. slow mode + word / link filters ----------
  ok((await emit(owner.s, 'room:slowmode', { seconds: 5 })).ok, 'owner sets slow mode 5s');
  await sleep(5200);
  let sm = await emit(mem.s, 'chat:send', { text: 'first under slow mode' });
  ok(sm.ok, 'first message under slow mode posts');
  sm = await emit(mem.s, 'chat:send', { text: 'second too fast' });
  ok(!sm.ok && /slow mode/i.test(sm.error), 'second message within 5s is held by slow mode', sm.error);
  await emit(owner.s, 'room:slowmode', { seconds: 0 });
  let fs1 = await emit(mem.s, 'room:filters:set', { words: 'x', links: 'off', allow: '' });
  ok(!fs1.ok, 'a member cannot change filters');
  fs1 = await emit(owner.s, 'room:filters:set', { words: 'spoiler, buy followers', links: 'block', allow: '' });
  ok(fs1.ok && fs1.filters.words.length === 2 && fs1.filters.links === 'block', 'owner saves word + link filters', JSON.stringify(fs1));
  ok(!(await emit(owner.s, 'room:filters:set', { words: '', links: 'nonsense', allow: '' })).ok, 'bad link mode refused');
  ok(!(await emit(owner.s, 'room:filters:set', { words: '', links: 'allowlist', allow: 'not a domain' })).ok, 'bad allow-list domain refused');
  await sleep(5200);
  let f = await emit(mem.s, 'chat:send', { text: 'big SPOILER: the cat did it' });
  ok(!f.ok && /Meowington/.test(f.error) && /word/.test(f.error), 'filtered word is blocked by Meowington', f.error);
  f = await emit(mem.s, 'chat:send', { text: 'no spoilers here' });
  ok(f.ok, 'a different word ("spoilers") is not matched by "spoiler"', f.error);
  f = await emit(mem.s, 'chat:send', { text: 'check https://evil.example.com/x' });
  ok(!f.ok && /links to evil\.example\.com/.test(f.error), 'link blocked in block mode', f.error);
  f = await emit(mem.s, 'chat:send', { text: 'bare domain spam.xyz too' });
  ok(!f.ok, 'bare domain is caught too', f.error);
  f = await emit(owner.s, 'chat:send', { text: 'owner can say spoiler https://evil.example.com' });
  ok(f.ok, 'the owner is not filtered');
  await emit(owner.s, 'room:filters:set', { words: 'spoiler', links: 'allowlist', allow: 'youtube.com, x.com' });
  f = await emit(mem.s, 'chat:send', { text: 'watch https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  ok(f.ok, 'allow-listed site passes', f.error);
  await sleep(200);
  f = await emit(mem.s, 'chat:send', { text: 'and https://m.youtube.com/watch?v=abc subdomain' });
  ok(f.ok, 'subdomain of an allowed site passes', f.error);
  f = await emit(mem.s, 'chat:send', { text: 'but https://bad.example.net is out' });
  ok(!f.ok, 'other sites are blocked in allow-list mode', f.error);
  // edits are filtered too
  const myLine = [...(await emit(other.s, 'room:join', { roomId: room })).room.history].reverse().find((m) => m.text === 'no spoilers here');
  f = await emit(mem.s, 'chat:edit', { messageId: myLine?.id, text: 'edited to a spoiler' });
  ok(!f.ok && /Meowington/.test(f.error), 'editing a line into a filtered word is blocked', f.error);
  const rq = await emit(owner.s, 'modq:room:list', { status: 'open' });
  const fitem = (rq.items ?? []).find((i) => i.key?.startsWith('filter:'));
  ok(!!fitem && fitem.count >= 3 && fitem.targetNick === 'BbMember', 'blocked lines are logged in the room mod queue (grouped)', JSON.stringify((rq.items ?? []).map((i) => [i.key, i.count])));
  const aq = await admin.j.req('/api/admin/reports?view=queue&status=open');
  ok((aq.items ?? []).some((i) => i.key?.startsWith('filter:')), 'staff see the filter entries too');

  // ---------- 8. scheduled banner + event reminder lines ----------
  const banners = [];
  owner.s.on('room:announcement', (p) => banners.push(p.announcement));
  const sc = await emit(owner.s, 'schedule:create', { text: 'Movie night starts soon!', at: Date.now() + 1500, repeat: 'once', kind: 'banner' });
  ok(sc.ok && sc.schedule.kind === 'banner', 'owner schedules a banner', sc.error);
  const sc2 = await emit(owner.s, 'schedule:create', { text: 'Scheduled hello in chat', at: Date.now() + 1500, repeat: 'once', kind: 'message' });
  ok(sc2.ok && sc2.schedule.kind === 'message', 'owner schedules a chat announcement');
  ok(!(await emit(mem.s, 'schedule:create', { text: 'nope', at: Date.now() + 5000, repeat: 'once' })).ok, 'a member cannot schedule');
  await sleep(2600);
  ok(banners.some((b) => b?.text === 'Movie night starts soon!'), 'the banner was set automatically at its time', JSON.stringify(banners));
  let h2 = (await emit(other.s, 'room:join', { roomId: room })).room;
  ok(h2.announcement?.text === 'Movie night starts soon!', 'the banner is in room state for new joiners');
  ok(h2.history.some((m) => m.text === 'Scheduled hello in chat' && m.announce), 'the chat announcement posted automatically');
  const ev = await emit(owner.s, 'events:create', { title: 'Trivia hour', startsAt: Date.now() + 6000, durationMin: 30 });
  ok(ev.ok, 'owner creates an event 6s ahead', ev.error);
  await sleep(3500);
  h2 = (await emit(other.s, 'room:join', { roomId: room })).room;
  ok(h2.history.some((m) => m.announce && /Reminder: \*\*Trivia hour\*\* starts in/.test(m.text)), 'the "starts soon" reminder posted as a kept announcement line', JSON.stringify(h2.history.slice(-3).map((m) => m.text)));
  await sleep(3200);
  h2 = (await emit(other.s, 'room:join', { roomId: room })).room;
  ok(h2.history.some((m) => m.announce && /Trivia hour\*\* is starting now/.test(m.text)), 'the "starting now" reminder posted');

  // ---------- 9. link previews ----------
  await emit(owner.s, 'room:filters:set', { words: '', links: 'off', allow: '' });
  const previews = new Map();
  mem.s.on('chat:preview', (p) => previews.set(p.messageId, p.preview));
  const lineId = async (text) => [...(await emit(other.s, 'room:join', { roomId: room })).room.history].reverse().find((m) => m.text === text)?.id;
  const ipport = internal.address().port;
  await emit(owner.s, 'chat:send', { text: `internal http://127.0.0.1:${ipport}/admin` });
  await emit(owner.s, 'chat:send', { text: `internal2 http://localhost:${ipport}/x` }); await sleep(2500);
  ok(internalHits === 0, 'SSRF: the preview fetcher never reached a loopback address', String(internalHits));
  const ssrfId = await lineId(`internal http://127.0.0.1:${ipport}/admin`);
  ok(!previews.get(ssrfId), 'no preview card for a private address');
  if (NET) {
    const xText = 'look https://x.com/jack/status/20';
    const imgText = 'pic https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png';
    await sleep(1100); await emit(owner.s, 'chat:send', { text: xText }); await sleep(1100);
    await emit(owner.s, 'chat:send', { text: imgText }); await sleep(1100);
    await emit(owner.s, 'chat:send', { text: 'yt https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    for (let i = 0; i < 40 && previews.size < 3; i++) await sleep(250);
    const xp = previews.get(await lineId(xText));
    ok(xp?.kind === 'x' && /jack/.test(xp.title ?? '') && /twttr/.test(xp.description ?? ''), 'X post preview (author + text)', JSON.stringify(xp));
    const ip = previews.get(await lineId(imgText));
    ok(ip?.kind === 'image' && !!ip.image && ip.image.startsWith('/api/link-preview/'), 'image link preview through the proxy', JSON.stringify(ip));
    if (ip?.image) {
      const r = await fetch(BASE + ip.image, { headers: { cookie: mem.j.header() } });
      ok(r.status === 200 && /image\/webp/.test(r.headers.get('content-type') || ''), 'the proxied image is re-encoded WebP', `${r.status} ${r.headers.get('content-type')}`);
    }
    const yp = [...previews.values()].find((p) => p?.kind === 'youtube');
    ok(!!yp, 'YouTube preview');
  }
  // per-user toggle
  let me = await mem.j.req('/api/me');
  ok(me.account?.linkPreviews === true, 'previews are on by default');
  ok((await mem.j.req('/api/me/link-previews', { linkPreviews: false }, 'PATCH')).ok, 'turn previews off');
  me = await mem.j.req('/api/me');
  ok(me.account?.linkPreviews === false, 'the choice is saved on the account');
  ok((await mem.j.req('/api/me/link-previews', { linkPreviews: 'nope' }, 'PATCH')).status === 400, 'bad value refused');

  // ---------- 10. admin stats ----------
  await sleep(800);
  const st = await admin.j.req('/api/admin/stats?days=14');
  ok(st.ok && st.days?.length === 14, 'admin stats: 14 days of DAU', JSON.stringify(st).slice(0, 200));
  ok(st.days.at(-1).users >= 3, 'today counts the active accounts', JSON.stringify(st.days.at(-1)));
  ok(st.rooms?.[0]?.roomId === room && st.rooms[0].messages > 5, 'busiest room is bb-party', JSON.stringify(st.rooms?.slice(0, 2)));
  ok(st.hours?.length === 24 && st.hours.some((h) => h.messages > 0), 'peak hours: 24 buckets with activity');
  ok((await mem.j.req('/api/admin/stats')).status === 403, 'non-staff get 403 on stats');

  // ---------- screenshots + UI checks ----------
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  for (const width of [1366, 390]) {
    const phone = width < 800;
    // owner view: reactions + picker, filters/slow mode, schedules, previews, banner
    const o = await pageFor(owner, width);
    await enterRoom(o.page, room);
    await o.page.evaluate(() => { const el = [...document.querySelectorAll('[data-msg]')].find((e) => /react to me please/.test(e.textContent)); el?.scrollIntoView({ block: 'center' }); });
    const custom = await o.page.$('[data-react-custom="partycat"]');
    ok(!!custom, `${width}: custom emoji reaction pill shows`);
    await o.page.evaluate(() => { const el = [...document.querySelectorAll('[data-msg]')].find((e) => /react to me please/.test(e.textContent)); el?.querySelector('[data-action="react-more"]')?.click(); });
    const pick = await o.page.waitForSelector('[data-testid="react-pick"] [data-react-pick="partycat"]', { timeout: 4000 }).then(() => true, () => false);
    ok(pick, `${width}: the room emoji picker opens`);
    await shot(o.page, `b6-emoji-reactions-${width}`);
    await o.page.keyboard.press('Escape');
    ok(await noSideScroll(o.page), `${width}: no sideways scroll in the room`);
    await openSettings(o.page, phone, 'filters');
    ok(!!(await o.page.$('[data-form="room-filters"] [data-field="filter-links"]')), `${width}: filters form in room settings`);
    ok(!!(await o.page.$('[data-field="slow-mode"]')), `${width}: slow mode picker in room settings`);
    await shot(o.page, `b7-filters-slowmode-${width}`);
    await o.page.$eval('details[data-section="schedules"]', (d) => { d.open = true; d.scrollIntoView({ block: 'start' }); }); await sleep(500);
    ok(!!(await o.page.$('[data-field="schedule-kind"]')), `${width}: schedule form has "Post as" (chat / banner)`);
    await shot(o.page, `b8-schedule-form-${width}`);
    await o.page.$eval('details[data-section="emotes"]', (d) => { d.open = true; d.scrollIntoView({ block: 'start' }); }).catch(() => {}); await sleep(500);
    await shot(o.page, `b6-emoji-manager-${width}`);
    await o.ctx.close();
    // member: banner + reminder lines, blocked toast, previews hidden (toggle off) vs owner sees cards
    const m = await pageFor(mem, width);
    await enterRoom(m.page, room);
    ok(!!(await m.page.$('[data-announce="1"]')), `${width}: announcement / reminder lines in chat`);
    await m.page.evaluate(() => { const el = [...document.querySelectorAll('[data-announce="1"]')].pop(); el?.scrollIntoView({ block: 'center' }); });
    await shot(m.page, `b8-banner-reminders-${width}`);
    ok((await m.page.$$('.link-preview')).length === 0, `${width}: previews hidden for a user who turned them off`);
    await emit(owner.s, 'room:filters:set', { words: 'spoiler', links: 'block', allow: '' });
    await m.page.type('.chat-form input, .chat-form textarea', 'this is a spoiler');
    await m.page.keyboard.press('Enter');
    const toast = await m.page.waitForFunction(() => /Meowington blocked/.test(document.body.innerText), { timeout: 5000 }).then(() => true, () => false);
    ok(toast, `${width}: the member sees Meowington's refusal`);
    await shot(m.page, `b7-filter-blocked-${width}`);
    await emit(owner.s, 'room:filters:set', { words: '', links: 'off', allow: '' });
    await m.ctx.close();
    if (NET) {
      const o2 = await pageFor(owner, width);
      await enterRoom(o2.page, room);
      await o2.page.waitForSelector('.link-preview[data-kind="x"]', { timeout: 6000 }).catch(() => {});
      ok(!!(await o2.page.$('.link-preview[data-kind="x"]')) && !!(await o2.page.$('.link-preview[data-kind="image"]')), `${width}: X and image preview cards render`);
      await o2.page.evaluate(() => document.querySelector('.link-preview[data-kind="x"]')?.scrollIntoView({ block: 'start' }));
      await shot(o2.page, `b9-previews-${width}`);
      await o2.ctx.close();
    }
    // preview toggle in the Profile dialog
    const t = await pageFor(mem, width);
    await t.page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await t.page.waitForSelector('[data-action="profile"]', { timeout: 15000 });
    await t.page.evaluate(() => [...document.querySelectorAll('a,button')].find((e) => e.textContent.trim() === 'Dismiss')?.click());
    await t.page.$eval('[data-action="profile"]', (b) => b.click());
    await t.page.waitForSelector('.me-pop-panel:not([hidden]) [data-action="open-profile"]', { timeout: 6000 });
    await t.page.$eval('[data-action="open-profile"]', (b) => b.click());
    await t.page.waitForSelector('[data-sheet="profile"] [data-action="link-previews-toggle"]', { timeout: 6000 });
    ok(!(await t.page.$eval('[data-action="link-previews-toggle"]', (e) => e.checked)), `${width}: Profile dialog shows the previews toggle (off)`);
    await t.page.$eval('[data-action="link-previews-toggle"]', (e) => e.scrollIntoView({ block: 'center' }));
    await shot(t.page, `b9-preview-toggle-${width}`);
    await t.ctx.close();
    // admin stats
    const a = await pageFor(admin, width);
    await a.page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    await a.page.waitForSelector('[data-tab="stats"]', { timeout: 15000 });
    await a.page.$eval('[data-tab="stats"]', (b) => b.click());
    const ok10 = await a.page.waitForSelector('[data-testid="admin-stats"] [data-chart="dau"]', { timeout: 6000 }).then(() => true, () => false);
    ok(ok10, `${width}: admin Stats tab renders DAU, rooms and hours`);
    ok(!!(await a.page.$('[data-table="busiest"]')) && !!(await a.page.$('[data-chart="hours"]')), `${width}: busiest rooms table + peak hours chart`);
    ok(await noSideScroll(a.page), `${width}: admin stats has no page-level sideways scroll`);
    await shot(a.page, `b10-admin-stats-${width}`);
    await a.ctx.close();
  }
  await mem.j.req('/api/me/link-previews', { linkPreviews: true }, 'PATCH');
} catch (e) {
  failed++; console.log('FAIL  crashed:', e.stack || e.message);
} finally {
  for (const s of sockets) try { s.disconnect(); } catch { /* */ }
  if (browser) await browser.close();
  server.kill('SIGTERM'); internal.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
