// Self-contained test for accounts, persistence, moderation, bans, reports and TURN credentials.
// Starts its own server (dist build) on a free port with a throwaway DATA_DIR, restarts it once.
//   npm run build && npm run test:api
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, createHmac, createECDH, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { io } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-test-'));
const TURN_SECRET = 'test-turn-secret';
const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://127.0.0.1:${port}`;
// ---- batch 2 fixture: a local "website" and a fake push service. Only this exact host:port is allowlisted
// (OUTBOUND_TEST_ALLOW); every other private / loopback address stays blocked. ----
const pushHits = [];
const fixHits = [];
let fixPng = null;
// batch 3: fake AzuraCast now-playing upstream
const radioFix = { mode: 'ok', title: 'Fixture Song', artist: 'Fixture Artist', art: '/radio/art.jpg', listeners: 42 };
let radioArtJpg = null;
const fixture = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  fixHits.push(u.pathname);
  const html = (body, extra = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra }); res.end(body); };
  const go = (loc) => { res.writeHead(302, { location: loc }); res.end(); };
  switch (u.pathname) {
    case '/page': return html('<html><head><title>Fallback</title><meta property="og:title" content="Fixture &amp; Page"><meta name="description" content="A test page"><meta property="og:image" content="/img.png"><meta property="og:site_name" content="FixtureSite"></head><body>hi</body></html>');
    case '/page2': return html('<html><head><title>Second page</title></head></html>');
    case '/r0': return go('/r1');
    case '/r1': return go('/r2');
    case '/r2': return go('/r3');
    case '/r3': return go('/page2');
    case '/to-meta': return go('http://169.254.169.254/latest/meta-data/');
    case '/to-local': return go(`http://127.0.0.1:${port}/api/health`);
    case '/to-v6': return go('http://[::1]/');
    case '/json': res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"title":"nope"}');
    case '/slow': return void setTimeout(() => html('<title>Too slow</title>'), 4000);
    case '/big': return html('<html><head>' + '<!-- pad -->'.repeat(60_000) + '<title>Late title</title></head></html>');
    case '/img.png': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fixPng);
    case '/radio/np': {
      if (radioFix.mode === '500') { res.writeHead(500); return res.end('down'); }
      if (radioFix.mode === 'bad') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"now_playing": nope'); }
      const art = radioFix.art.startsWith('/') ? `http://127.0.0.1:${fixture.address().port}${radioFix.art}` : radioFix.art;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        station: { name: '7LFM', shortcode: 'labsfm' }, listeners: { total: radioFix.listeners, unique: 3, current: radioFix.listeners },
        live: { is_live: false, streamer_name: '' },
        now_playing: { played_at: Math.floor(Date.now() / 1000) - 30, duration: 200, elapsed: 30, remaining: 170, song: { title: radioFix.title, artist: radioFix.artist, album: 'Fixture Album', art } },
      }));
    }
    case '/radio/art.jpg': res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(radioArtJpg);
    case '/push/ok': case '/push/gone': {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        pushHits.push({ path: u.pathname + u.search, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(u.pathname === '/push/ok' ? 201 : 410); res.end();
      });
      return;
    }
    default: res.writeHead(404); res.end();
  }
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const FIX = `http://127.0.0.1:${fixture.address().port}`;
const env = {
  ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback',
  ADMIN_USERNAMES: 'Root_Admin', TURN_SECRET, TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:5349', TURN_TTL: '21600',
  MAX_CONN_PER_IP: '6', WORD_FILTER: 'badword,frick', GUEST_CAM_AFTER_MINUTES: '-1',
  RECONNECT_GRACE_MS: '2000',
  MOD_BOT_PRESENCE_MS: '800',
  BOT_ROOM_READS_PER_MIN: '8',
  MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'),
  TIKTOK_CLIENT_KEY: '', TIKTOK_CLIENT_SECRET: '',
  TIKTOK_AUTHORIZE_URL: '', TIKTOK_TOKEN_URL: '', TIKTOK_USERINFO_URL: '',
  CONTACT_EMAIL: '',
  TRIVIA_QUESTION_MS: '3000', TRIVIA_PAUSE_MS: '300',
  BURN_TTL_SCALE: '0.1', BURN_HARD_MS: '4000',
  BADGE_THRESHOLD_DIV: '100', BADGE_AIR_FLUSH_MS: '500',
  CAMCHAT_TEST_CRASH_HOOKS: '1',
  // batch 2 test knobs
  OUTBOUND_TEST_ALLOW: `127.0.0.1:${fixture.address().port}`, LINK_PREVIEW_TIMEOUT_MS: '1500',
  EVENT_REMIND_LEAD_MS: '2500', EVENT_TICK_MS: '250', POLL_MINUTE_MS: '1000',
  // batch 3 test knobs (RADIO_NOWPLAYING_URL is test-only; it also unlocks a poll interval under 15 s)
  RADIO_NOWPLAYING_URL: `http://127.0.0.1:${fixture.address().port}/radio/np`, RADIO_POLL_MS: '300', RADIO_TIMEOUT_MS: '800',
  SCHEDULE_TICK_MS: '200', SCHEDULE_DAY_MS: '1500',
  // backup test knobs (all test-only): fake free space via a file, short manual-run gap, a slow run to observe the guard
  BACKUP_TEST_FREE_FILE: path.join(DATA, 'fake-free-bytes'), BACKUP_TEST_NOW_GAP_MS: '2500', BACKUP_TEST_SLOW_MS: '600',
};

// SKEW_DB=1: start from a database whose user_version came from another branch's numbering (past ours)
// with none of our feature tables, like the live server. The server must still create what it needs.
if (process.env.SKEW_DB) {
  execFileSync(process.execPath, ['-e', `const m = require('./dist/server/server/db.js'); m.migrate(15); m.db.exec('PRAGMA user_version = 21');`],
    { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, NODE_ENV: 'development' }, stdio: 'ignore' });
}

let passed = 0, failed = 0;
const ok = (cond, name) => { cond ? passed++ : failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;
let serverLog = '';
async function startServer() {
  server = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = '';
  const take = (d) => { const s = String(d); boot += s; serverLog += s; };
  server.stdout.on('data', (d) => take(d));
  server.stderr.on('data', (d) => { take(d); process.stderr.write(d); });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (boot.includes('listening')) return;
    if (server.exitCode !== null) throw new Error(`server exited: ${boot}`);
  }
  throw new Error(`server did not start: ${boot}`);
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await done;
}

// ---- a fake "browser": cookie jar + fixed client IP (sent as CF-Connecting-IP from a trusted loopback proxy) ----
let ipSeq = 10;
function browser(ip = `198.51.100.${ipSeq++}`) {
  const jar = new Map();
  const b = {
    ip, jar, deviceId: null,
    cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    async req(pathname, body, method) {
      const headers = { 'cf-connecting-ip': b.ip, 'x-csrf': '1', cookie: b.cookieHeader() };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(BASE + pathname, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of r.headers.getSetCookie()) {
        const [kv] = c.split(';'); const i = kv.indexOf('=');
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
      }
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, json: json ?? {} };
    },
    async boot() { const r = await b.req('/api/me'); b.deviceId = r.json.deviceId; return r.json; },
    connect(extra = {}) {
      return new Promise((res, rej) => {
        const s = io(BASE, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: b.cookieHeader(), 'cf-connecting-ip': b.ip, ...(extra.headers || {}) }, auth: { deviceId: extra.deviceId ?? b.deviceId } });
        s.once('connect', () => res(s));
        s.once('connect_error', (e) => { s.close(); rej(e); });
      });
    },
  };
  return b;
}
const emit = (s, ev, ...args) => new Promise((res) => s.emit(ev, ...args, res));
const once = (s, ev, pred = () => true, ms = 3000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout waiting for ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const rejects = (p) => p.then((s) => { s.close(); return null; }, (e) => e.message);
const sockets = [];
const track = (s) => { sockets.push(s); return s; };


async function captchaFor(b) {
  const r = await b.req('/api/auth/captcha');
  if (r.json.mode === 'builtin') {
    // solve "What is A + B?"
    const m = /What is (\d+) \+ (\d+)/.exec(r.json.question || '');
    if (!m) throw new Error('bad captcha question: ' + JSON.stringify(r.json));
    return { captchaId: r.json.id, captchaAnswer: String(+m[1] + +m[2]) };
  }
  return { captchaToken: 'test' };
}
async function register(b, username, password = 'password123', email) {
  const cap = await captchaFor(b);
  const addr = email === undefined ? `${username.toLowerCase()}@example.com` : email;
  return b.req('/api/auth/register', { username, password, email: addr, ...cap });
}
function readMail() {
  const file = path.join(DATA, 'mail.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

try {
  await startServer();

  {
    const health = await fetch(BASE + '/api/health');
    const body = await health.json();
    ok(health.status === 200 && body.app === 'zeronoise', 'health app name is zeronoise');
    ok(body.mail === true && body.emailVerifyRequired === false && !JSON.stringify(body).includes('RESEND_API_KEY'), 'health reports mail configured and hides secrets');
    ok(body.tiktok === false && !/TIKTOK_CLIENT|tiktok-test-secret/i.test(JSON.stringify(body)), 'health reports tiktok unconfigured and hides TikTok secrets');
    ok(Number.isInteger(body.uptimeSec) && body.uptimeSec >= 0 && body.uptimeSec < 600, 'health reports integer uptimeSec');
    ok(Number.isInteger(body.startedAt) && body.startedAt <= Date.now() && Date.now() - body.startedAt < 600_000 && Math.abs((Date.now() - body.startedAt) / 1000 - body.uptimeSec) < 3, 'health reports startedAt (ms) matching uptime');
    ok(body.ok === true && body.db === true && typeof body.build === 'string' && 'rooms' in body && 'users' in body, 'health keeps existing fields');
    const crawl = { 'user-agent': 'Mozilla/5.0 (compatible; TikTokSpider)' };
    for (const p of ['/terms', '/privacy']) {
      const page = await fetch(BASE + p, { redirect: 'manual', headers: crawl });
      const html = await page.text();
      const type = page.headers.get('content-type') || '';
      ok(page.status === 200 && type.includes('text/html') && !page.headers.get('location') && !page.headers.get('set-cookie') && html.includes('Last updated: October 7, 2026') && !html.includes('id="root"'), `${p} returns the policy HTML with no login`);
    }
    const terms = await fetch(BASE + '/terms').then((r) => r.text());
    const privacy = await fetch(BASE + '/privacy').then((r) => r.text());
    ok(/18 or older/.test(terms) && /harassment/i.test(terms) && /as is/.test(terms) && /ban an account, an IP address, or a device/.test(terms), 'terms match how the service is run');
    ok(/Password hash/.test(privacy) && privacy.includes('camchat_did') && /TikTok open id/.test(privacy) && /do not record calls/.test(privacy) && /contact a moderator in the app/.test(privacy) && !/mailto:/i.test(privacy), 'privacy lists stored data and hides a contact address when unset');
    const loginJs = fs.readdirSync(path.join(ROOT, 'dist/client/assets')).filter((n) => n.endsWith('.js')).map((n) => fs.readFileSync(path.join(ROOT, 'dist/client/assets', n), 'utf8')).join('\n');
    ok(loginJs.includes('href:"/terms"') || loginJs.includes('href="/terms"'), 'login bundle links to /terms');
    ok((loginJs.includes('href:"/privacy"') || loginJs.includes('href="/privacy"')) && loginJs.includes('Privacy Policy'), 'login bundle links to /privacy from the register checkbox');
    const missingAsset = await fetch(BASE + '/assets/does-not-exist.js');
    const missingBody = await missingAsset.text();
    ok(missingAsset.status === 404 && !/<\s*!doctype|<html/i.test(missingBody), 'missing /assets file is 404, not the app page');
    // polish: brotli/gzip for text assets, immutable hashed assets, revalidated HTML shell, split chunks
    {
      const indexHtml = fs.readFileSync(path.join(ROOT, 'dist/client/index.html'), 'utf8');
      const entry = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(indexHtml)?.[1] || '';
      const raw = fs.readFileSync(path.join(ROOT, 'dist/client', entry.slice(1)));
      const br = await fetch(BASE + entry, { headers: { 'accept-encoding': 'br' } });
      const brBody = Buffer.from(await br.arrayBuffer());
      ok(br.status === 200 && br.headers.get('content-encoding') === 'br' && brBody.equals(raw), 'hashed JS is served brotli-compressed and decodes to the file');
      ok((br.headers.get('cache-control') || '') === 'public, max-age=31536000, immutable' && /accept-encoding/i.test(br.headers.get('vary') || ''), 'hashed assets: immutable year cache, Vary: Accept-Encoding');
      const gz = await fetch(BASE + entry, { headers: { 'accept-encoding': 'gzip' } });
      ok(gz.headers.get('content-encoding') === 'gzip' && Buffer.from(await gz.arrayBuffer()).equals(raw), 'gzip when brotli is not accepted');
      const plain = await fetch(BASE + entry, { headers: { 'accept-encoding': 'identity' } });
      ok(!plain.headers.get('content-encoding') && Number(plain.headers.get('content-length')) === raw.length, 'identity request gets the file as is');
      const etag = br.headers.get('etag') || '';
      const again = await fetch(BASE + entry, { headers: { 'accept-encoding': 'br', 'if-none-match': etag } });
      ok(etag.startsWith('"') && again.status === 304, 'assets revalidate with an ETag (304)');
      const css = /href="(\/assets\/[^"]+\.css)"/.exec(indexHtml)?.[1] || '';
      const cssRes = await fetch(BASE + css, { headers: { 'accept-encoding': 'br, gzip' } });
      ok(cssRes.headers.get('content-encoding') === 'br' && (cssRes.headers.get('content-type') || '').includes('text/css'), 'CSS is compressed with the right type');
      for (const route of ['/', '/lobby', '/index.html']) {
        const r = await fetch(BASE + route, { headers: { 'accept-encoding': 'gzip' } });
        const body = await r.text();
        ok(r.status === 200 && r.headers.get('cache-control') === 'no-cache' && body.includes('id="root"') && (r.headers.get('content-type') || '').includes('text/html'), `${route} serves the app shell with no-cache`);
      }
      const sw = await fetch(BASE + '/sw.js');
      ok(sw.status !== 200 || sw.headers.get('cache-control') === 'no-cache', 'sw.js stays no-cache');
      const trav = await fetch(BASE + '/assets/..%2f..%2fserver%2fserver%2findex.js');
      const travBody = await trav.text();
      ok(!travBody.includes('require(') && !travBody.includes('listening'), 'encoded ../ cannot read server files');
      const chunks = fs.readdirSync(path.join(ROOT, 'dist/client/assets')).filter((n) => n.endsWith('.js'));
      ok(chunks.length > 5 && chunks.some((n) => n.startsWith('Room-')) && chunks.some((n) => n.startsWith('AdminPanel-')) && !indexHtml.includes('/assets/Room-'), 'client is code-split: room and admin load on demand, not from index.html');
    }
    // PWA: manifest, icons, build-stamped service worker, offline page
    {
      const pngSize = (buf) => (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.toString('latin1', 12, 16) === 'IHDR'
        ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null);
      const man = await fetch(BASE + '/manifest.webmanifest');
      const manText = await man.text();
      let mj = null;
      try { mj = JSON.parse(manText); } catch { mj = null; }
      ok(man.status === 200 && /application\/manifest\+json/.test(man.headers.get('content-type') || ''), 'manifest is served as application/manifest+json');
      ok(man.headers.get('cache-control') === 'no-cache', 'manifest is no-cache');
      ok(!!mj && mj.name === 'zeronoise' && mj.short_name === 'zeronoise' && mj.start_url === '/' && mj.scope === '/' && mj.display === 'standalone', 'manifest is valid JSON with name, short_name, start_url, scope, display');
      ok(!!mj && mj.theme_color === '#0b1220' && mj.background_color === '#0b1220', 'manifest colors match the default theme background');
      const icons = Array.isArray(mj?.icons) ? mj.icons : [];
      for (const [size, purpose] of [[192, 'any'], [512, 'any'], [192, 'maskable'], [512, 'maskable']]) {
        ok(icons.some((i) => i.sizes === `${size}x${size}` && (i.purpose || 'any').split(' ').includes(purpose) && i.type === 'image/png'), `manifest lists a ${size}px ${purpose} PNG icon`);
      }
      const want = [...icons.map((i) => [i.src, Number(String(i.sizes).split('x')[0])]), ['/apple-touch-icon.png', 180], ['/badge-96.png', 96]];
      for (const [src, size] of want) {
        const r = await fetch(BASE + src);
        const buf = Buffer.from(await r.arrayBuffer());
        const dim = pngSize(buf);
        ok(r.status === 200 && (r.headers.get('content-type') || '').includes('image/png') && dim?.w === size && dim?.h === size, `${src} is a ${size}x${size} PNG`);
        ok(/max-age=[1-9]/.test(r.headers.get('cache-control') || ''), `${src} is cacheable`);
      }
      const badge = Buffer.from(await (await fetch(BASE + '/badge-96.png')).arrayBuffer());
      ok(badge[25] === 6 || badge[25] === 4, 'badge icon has an alpha channel (monochrome silhouette)');
      const shell = await (await fetch(BASE + '/')).text();
      ok(/<link rel="manifest" href="\/manifest\.webmanifest"/.test(shell) && /<meta name="theme-color" content="#0b1220"/.test(shell), 'index links the manifest and sets theme-color');
      ok(/apple-mobile-web-app-capable" content="yes"/.test(shell) && /apple-mobile-web-app-title" content="zeronoise"/.test(shell) && /rel="apple-touch-icon" sizes="180x180"/.test(shell), 'index has the iOS web-app meta tags and 180px touch icon');
      const sw = await fetch(BASE + '/sw.js');
      const swText = await sw.text();
      const build = (await (await fetch(BASE + '/api/build')).json()).build;
      ok(sw.status === 200 && sw.headers.get('cache-control') === 'no-cache' && sw.headers.get('service-worker-allowed') === '/' && /javascript/.test(sw.headers.get('content-type') || ''), 'sw.js is no-cache JavaScript with Service-Worker-Allowed: /');
      ok(!!build && swText.includes(`const BUILD = '${build}'`) && !swText.includes('__BUILD_ID__'), 'sw.js carries the live build id (cache version)');
      ok(swText.includes("addEventListener('push'") && swText.includes("addEventListener('notificationclick'") && swText.includes("addEventListener('fetch'"), 'sw.js keeps push + notification click and adds a fetch handler');
      ok(/startsWith\('\/api\/'\)/.test(swText) && /startsWith\('\/socket\.io\/'\)/.test(swText) && swText.includes("caches.delete"), 'sw.js skips /api and socket.io and deletes old caches');
      const off = await fetch(BASE + '/offline.html');
      const offText = await off.text();
      ok(off.status === 200 && (off.headers.get('content-type') || '').includes('text/html') && off.headers.get('cache-control') === 'no-cache', 'offline page is served as no-cache HTML');
      ok(offText.includes("You're offline — zeronoise will reconnect when you're back") && !offText.includes('id="root"'), 'offline page has the reconnect message and is standalone');
      const appJs = fs.readdirSync(path.join(ROOT, 'dist/client/assets')).filter((n) => n.endsWith('.js')).map((n) => fs.readFileSync(path.join(ROOT, 'dist/client/assets', n), 'utf8')).join('\n');
      ok(appJs.includes('beforeinstallprompt') && appJs.includes('setAppBadge') && appJs.includes('install-app'), 'client captures the install prompt, sets the app badge and has the Install app item');
      const serverSrc = fs.readFileSync(path.join(ROOT, 'server/index.ts'), 'utf8');
      ok((serverSrc.match(/url: `\/\?room=\$\{encodeURIComponent\(room\.id\)\}`/g) || []).length === 3, 'mention, whisper and Everything notifications link to their room');
    }
    const docs = await fetch(BASE + '/docs/bots', { redirect: 'manual', headers: crawl });
    const docsHtml = await docs.text();
    const docsType = docs.headers.get('content-type') || '';
    const docsEtag = docs.headers.get('etag') || '';
    ok(docs.status === 200 && docsType.includes('text/html') && !docs.headers.get('location') && !docs.headers.get('set-cookie') && docsHtml.includes('Authorization: Bearer') && !docsHtml.includes('id="root"'), 'GET /docs/bots returns bot API HTML with no login');
    ok((docs.headers.get('cache-control') || '').includes('must-revalidate') && docsEtag.startsWith('"'), 'bot docs are revalidated with an ETag');
    const docs304 = await fetch(BASE + '/docs/bots', { headers: { 'if-none-match': docsEtag } });
    ok(docs304.status === 304, 'bot docs ETag returns 304');
    const docsMd = await fetch(BASE + '/docs/bots.md', { redirect: 'manual', headers: crawl });
    const mdBody = await docsMd.text();
    const mdType = docsMd.headers.get('content-type') || '';
    ok(docsMd.status === 200 && mdType.includes('text/markdown') && mdType.includes('charset=utf-8') && mdBody.startsWith('# ') && mdBody.includes('Authorization: Bearer') && !mdBody.includes('<html'), '/docs/bots.md returns markdown');
    const llms = await fetch(BASE + '/llms.txt', { redirect: 'manual' });
    const llmsBody = await llms.text();
    ok(llms.status === 200 && (llms.headers.get('content-type') || '').includes('text/plain') && llmsBody.includes('/docs/bots.md'), '/llms.txt points at the bot markdown');
    const secretLeak = /set-moderator-bot|DATA_DIR|\/var\/lib|\/opt\/camchat|TURN_SECRET|test-turn-secret|127\.0\.0\.1|localhost/.test(docsHtml + mdBody + llmsBody);
    ok(!secretLeak, 'public bot docs hide secrets and internal hosts');
  }

  // ---------- CSRF / origin ----------
  {
    const r1 = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"username":"Csrf_1","password":"password123"}' });
    ok(r1.status === 403, 'register without CSRF header is rejected');
    const r2 = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': '1', origin: 'https://evil.example' }, body: '{"username":"Csrf_2","password":"password123"}' });
    ok(r2.status === 403, 'cross-origin register is rejected');
    const e = await rejects(browser().connect({ headers: { origin: 'https://evil.example' } }));
    ok(!!e, 'cross-origin WebSocket handshake is rejected');
  }

  // ---------- accounts ----------
  const admin = browser(); await admin.boot();
  let r = await register(admin, 'Root_Admin', 'correct horse 1');
  ok(r.json.ok && r.json.account.role === 'admin', 'register bootstrap admin (ADMIN_USERNAMES) -> role admin');
  ok([...admin.jar.keys()].includes('camchat_sid'), 'session cookie set');
  const alice = browser(); const aliceMe = await alice.boot();
  ok(typeof aliceMe.deviceId === 'string' && aliceMe.deviceId.length >= 16 && alice.jar.has('camchat_did'), 'device id issued (JSON + cookie)');
  r = await register(alice, 'Alice', 'short');
  ok(!r.json.ok, 'rejects short password');
  r = await register(alice, 'Alice', 'alice-password');
  ok(r.json.ok && r.json.account.role === 'user' && r.json.account.email === 'alice@example.com' && r.json.account.emailVerified === false, 'register Alice with an unverified email');
  {
    const me = await alice.req('/api/me');
    ok(me.json.account?.email === 'alice@example.com' && me.json.emailVerifyRequired === false, '/api/me returns only this account email');
    const sent = readMail().filter((m) => m.to === 'alice@example.com');
    ok(sent.length === 1 && /verify-email\?token=/.test(sent[0].text) && /code: \d{6}/.test(sent[0].text), 'registration mails a link and a code');
  }
  r = await register(browser(), 'Other_Name', 'other-password-1', 'alice@example.com');
  ok(r.status === 409 && r.json.error === 'That email is already in use.', 'duplicate email rejected without naming the other account');
  r = await register(browser(), 'No_Mail', 'password123', 'not-an-email');
  ok(r.status === 400, 'rejects a malformed email');
  r = await register(browser(), 'alice', 'other-password');
  ok(r.status === 409, 'duplicate username (case-insensitive) rejected');
  r = await register(browser(), 'Admin', 'whatever123');
  ok(!r.json.ok, 'reserved name "Admin" cannot be registered');
  const alice2 = browser(); await alice2.boot();
  r = await alice2.req('/api/auth/login', { username: 'alice', password: 'wrong-password' });
  ok(r.status === 401, 'login with wrong password rejected');
  r = await alice2.req('/api/auth/login', { username: 'alice', password: 'alice-password' });
  ok(r.json.ok && r.json.account.username === 'Alice', 'login (case-insensitive username)');
  ok((await alice2.req('/api/me')).json.account?.username === 'Alice', '/api/me returns the account');
  await alice2.req('/api/auth/logout', {});
  ok((await alice2.req('/api/me')).json.account === null, 'logout clears the session');
  {
    const lb = browser();
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) limited = (await lb.req('/api/auth/login', { username: 'nobody', password: `bad-password-${i}` })).status === 429;
    ok(limited, 'login attempts are rate-limited per IP');
  }

  const mod = browser(); await mod.boot();
  await register(mod, 'Mod_Mary', 'mod-password-1');
  const bob = browser(); await bob.boot();
  await register(bob, 'Bob', 'bob-password-1');

  // role change: only admins
  const users = (await admin.req('/api/admin/users?q=')).json.users;
  const maryId = users.find((u) => u.username === 'Mod_Mary').id;
  const bobId = users.find((u) => u.username === 'Bob').id;
  ok((await bob.req(`/api/admin/users/${maryId}/role`, { role: 'moderator' })).status === 403, 'non-staff cannot use admin API');
  ok((await browser().req('/api/admin/reports')).status === 401, 'anonymous admin API -> 401');
  ok((await admin.req(`/api/admin/users/${maryId}/role`, { role: 'moderator' })).json.ok, 'admin makes Mod_Mary a moderator');
  ok((await mod.req(`/api/admin/users/${bobId}/role`, { role: 'moderator' })).status === 403, 'moderator cannot change roles');

  // ---------- sockets: login, reserved names ----------
  const sAdmin = track(await admin.connect());
  const sAlice = track(await alice.connect());
  const sMod = track(await mod.connect());
  const sBob = track(await bob.connect());
  const outsider = browser(); await outsider.boot();
  const sOut = track(await outsider.connect());
  r = await emit(sAlice, 'login', { nick: 'SomethingElse' });
  ok(r.ok && r.user.nick === 'Alice' && r.user.registered && r.user.role === 'user' && r.user.email === undefined, 'account socket logs in with its username and does not publish email');
  ok((await emit(sMod, 'login', {})).user?.role === 'moderator', 'moderator role on socket');
  await emit(sAdmin, 'login', {});
  await emit(sBob, 'login', {});
  r = await emit(sOut, 'login', { nick: 'Gus_Guest' });
  ok(!r.ok && /sign in/i.test(r.error || ''), 'nickname login is rejected');
  ok(!(await emit(sOut, 'room:join', { roomId: 'lobby' })).ok, 'unsigned socket cannot join a room');
  ok(!(await emit(sOut, 'room:create', { name: 'Nope Room' })).ok, 'unsigned socket cannot create a room');
  ok(!(await emit(sOut, 'chat:send', { text: 'hi' })).ok, 'unsigned socket cannot chat');

  const kickeeB = browser(); await kickeeB.boot();
  ok((await register(kickeeB, 'Kick_Me', 'kick-password-1')).json.ok, 'kick target registers');
  const sGuest = track(await kickeeB.connect());
  ok((await emit(sGuest, 'login', {})).ok, 'kick target logs in');

  // ---------- rooms ----------
  r = await emit(sAlice, 'room:create', { name: 'Alice Place', topic: 'first topic' });
  ok(r.ok, 'registered user creates a room');
  const roomId = r.roomId;
  const rl = await emit(sAlice, 'rooms:list');
  ok(rl.rooms.find((x) => x.id === roomId)?.persistent === true, 'room made by an account is persistent');
  for (const s of [sAlice, sMod, sBob, sGuest, sAdmin]) await emit(s, 'room:join', { roomId });
  ok((await emit(sBob, 'media:state', { cam: true, mic: true })).ok, 'registered user can start camera and mic');
  await emit(sBob, 'media:state', { cam: false, mic: false });

  // ---------- chat, word filter, history ----------
  const gotMsg = once(sBob, 'chat:message', (m) => m.kind === 'chat' && m.from === 'Alice');
  ok((await emit(sAlice, 'chat:send', { text: 'hello badword and Frick!' })).ok, 'Alice chats');
  const m1 = await gotMsg;
  ok(m1.text === 'hello b****** and F****!', `word filter masks words (${m1.text})`);
  ok((await emit(sAlice, 'chat:send', { text: 'two links https://a.example.com and https://b.example.com' })).ok, 'registered user can post more than one link');
  const bobMsg = once(sAlice, 'chat:message', (m) => m.kind === 'chat' && m.from === 'Bob');
  await emit(sBob, 'chat:send', { text: 'rude message from bob' });
  const bobMsgId = (await bobMsg).id;
  sBob.emit('room:leave');
  await sleep(50);
  const rj = await emit(sBob, 'room:join', { roomId });
  const chatHist = rj.room.history.filter((m) => m.kind === 'chat');
  ok(chatHist.length >= 2 && chatHist.at(-1).text === 'rude message from bob', `message history shown on join (${chatHist.length} msgs)`);

  // ---------- role checks for moderation ----------
  ok(!(await emit(sBob, 'mod:camoff', { userId: sAlice.id })).ok, 'non-mod cannot force cam off');
  ok(!(await emit(sBob, 'mod:delete', { messageId: m1.id })).ok, 'non-mod cannot delete messages');
  ok(!(await emit(sBob, 'mod:mute', { userId: sAlice.id, minutes: 5 })).ok, 'non-mod cannot mute');
  ok(!(await emit(sBob, 'mod:ban', { userId: sAlice.id, reason: 'x', minutes: 5 })).ok, 'non-mod cannot site-ban');
  ok(!(await emit(sBob, 'room:topic', { topic: 'hijack' })).ok, 'non-owner non-mod cannot set topic');
  ok(!(await emit(sBob, 'room:kick', { userId: sGuest.id })).ok, 'non-owner cannot kick');
  ok(!(await emit(sMod, 'mod:mute', { userId: sAdmin.id, minutes: 5 })).ok, 'moderator cannot act on an admin');
  ok(!(await emit(sAlice, 'room:kick', { userId: sMod.id })).ok, 'room owner cannot kick a moderator');

  // ---------- report ----------
  r = await emit(sAlice, 'report', { messageId: bobMsgId, reason: 'Bob was rude' });
  ok(r.ok && r.reportId > 0, 'report on a message is stored');
  r = await emit(sGuest, 'report', { userId: sBob.id, reason: 'bothering me' });
  ok(r.ok, 'room member can report a user');
  const reps = (await mod.req('/api/admin/reports?status=open')).json.reports;
  const rep = reps.find((x) => x.messageId === bobMsgId);
  ok(rep && rep.targetNick === 'Bob' && rep.targetUserId === bobId && rep.messageText === 'rude message from bob' && rep.context.length >= 3 && rep.hasIp && rep.hasDevice,
    'report has target, message, IP/device and chat context');

  // ---------- mod actions ----------
  const camOffAtBob = once(sBob, 'mod:camoff');
  const camUpdAtAlice = once(sAlice, 'user:updated', (u) => u.id === sBob.id && !u.cam);
  ok((await emit(sMod, 'mod:camoff', { userId: sBob.id, minutes: 5 })).ok, 'mod forces Bob\'s cam off');
  ok(!!(await camOffAtBob) && !!(await camUpdAtAlice), 'Bob notified; room sees cam off');
  r = await emit(sBob, 'media:state', { cam: true, mic: false });
  ok(!r.ok && /moderator/i.test(r.error), 'Bob cannot re-enable cam during the block');

  const delAtAlice = once(sAlice, 'chat:deleted', (p) => p.id === bobMsgId);
  ok((await emit(sMod, 'mod:delete', { messageId: bobMsgId })).ok, 'mod deletes Bob\'s message');
  ok(!!(await delAtAlice), 'room receives chat:deleted');
  const mutedAtBob = once(sBob, 'mod:muted');
  ok((await emit(sMod, 'mod:mute', { userId: sBob.id, minutes: 10 })).ok, 'mod mutes Bob for 10 min');
  await mutedAtBob;
  r = await emit(sBob, 'chat:send', { text: 'can I talk?' });
  ok(!r.ok && /muted/i.test(r.error), 'muted user cannot chat');
  const topicAtBob = once(sBob, 'room:topic');
  ok((await emit(sMod, 'room:topic', { topic: 'moderated topic' })).ok && (await topicAtBob).topic === 'moderated topic', 'mod sets the room topic');
  ok((await emit(sAlice, 'room:topic', { topic: 'Owner topic' })).ok, 'room owner sets the topic');

  // room-level kick / ban by owner
  const kickedGuest = once(sGuest, 'room:kicked');
  ok((await emit(sAlice, 'room:kick', { userId: sGuest.id })).ok, 'owner kicks a member');
  await kickedGuest;
  ok(!(await emit(sGuest, 'room:join', { roomId })).ok, 'kicked member cannot rejoin right away');
  const kickedBob = once(sBob, 'room:kicked');
  ok((await emit(sAlice, 'room:ban', { userId: sBob.id, minutes: null, reason: 'room rules' })).ok, 'owner bans Bob from the room');
  await kickedBob;
  r = await emit(sBob, 'room:join', { roomId });
  ok(!r.ok && /banned/i.test(r.error), 'room-banned Bob cannot join');
  ok((await emit(sBob, 'room:join', { roomId: 'lobby' })).ok, 'room ban does not affect other rooms');

  // ---------- site bans: account / IP / device ----------
  // account ban via admin API
  const endedBob = once(sBob, 'session:ended');
  r = await mod.req('/api/admin/bans', { kind: 'account', value: 'Bob', reason: 'spamming', minutes: 60 });
  ok(r.json.ok, 'mod bans Bob\'s account from the panel');
  ok(/banned/i.test((await endedBob).reason), 'Bob\'s live socket is ended with the ban reason');
  let err = await rejects(bob.connect());
  ok(err && err.startsWith('banned:'), 'banned account cannot connect');
  r = await browser().req('/api/auth/login', { username: 'Bob', password: 'bob-password-1' });
  ok(r.status === 403 && /banned/i.test(r.json.error), 'banned account cannot log in');
  const bobBanId = (await mod.req('/api/admin/bans')).json.bans.find((b) => b.kind === 'account' && b.label === 'Bob').id;
  ok((await mod.req(`/api/admin/bans/${bobBanId}/lift`, {})).json.ok, 'unban Bob');
  ok(!!track(await bob.connect()), 'unbanned account can connect again');

  // IP ban via socket mod action (account: ip + device cookie still applies)
  const guest = browser(); await guest.boot();
  ok((await register(guest, 'Ip_User', 'ip-password-1')).json.ok, 'IP-ban target registers');
  const sIp = track(await guest.connect());
  ok((await emit(sIp, 'login', {})).ok, 'IP-ban target logs in');
  const endedGuest = once(sIp, 'session:ended');
  ok((await emit(sMod, 'mod:ban', { userId: sIp.id, minutes: 30, reason: 'trolling', kinds: ['ip'] })).ok, 'mod IP-bans the account holder');
  await endedGuest;
  err = await rejects(browser(guest.ip).connect());
  ok(err && err.startsWith('banned:'), 'any client from the banned IP is refused');
  r = await register(browser(guest.ip), 'Evader1', 'evader-password');
  ok(r.status === 403, 'banned IP cannot register');
  // device ban: new IP, same device id
  const dev = browser(); await dev.boot();
  ok((await register(dev, 'Dev_User', 'dev-password-1')).json.ok, 'device-ban target registers');
  const sDev = track(await dev.connect());
  await emit(sDev, 'login', {});
  const endedDev = once(sDev, 'session:ended');
  ok((await emit(sMod, 'mod:ban', { userId: sDev.id, minutes: null, reason: 'ban evasion', kinds: ['device'] })).ok, 'mod device-bans an account (permanent)');
  await endedDev;
  const sameDeviceNewIp = browser(); sameDeviceNewIp.jar.set('camchat_did', dev.deviceId);
  err = await rejects(sameDeviceNewIp.connect({ deviceId: dev.deviceId }));
  ok(err && err.startsWith('banned:'), 'banned device (cookie) is refused from a new IP');
  err = await rejects(browser().connect({ deviceId: dev.deviceId }));
  ok(err && err.startsWith('banned:'), 'banned device (localStorage id) is refused even without the cookie');
  const bans = (await admin.req('/api/admin/bans')).json.bans;
  ok(bans.some((b) => b.kind === 'ip' && b.value === guest.ip) && bans.some((b) => b.kind === 'device' && b.expiresAt === null), 'active bans listed with kind / permanence');

  // ---------- per-IP connection cap ----------
  {
    const shared = `203.0.113.77`;
    const conns = [];
    let refused = null;
    for (let i = 0; i < 7; i++) {
      try { conns.push(await browser(shared).connect({ deviceId: `capdevice${i}xxxxxxxxxxx` })); } catch (e) { refused = e.message; break; }
    }
    ok(conns.length === 6 && /Too many connections/.test(refused ?? ''), `per-IP connection cap (MAX_CONN_PER_IP=6, got ${conns.length})`);
    conns.forEach((s) => s.close());
  }

  // ---------- TURN credentials ----------
  {
    const b = browser(); await b.boot();
    const ice = (await b.req('/api/ice')).json;
    const turn = ice.iceServers.find((s) => s.urls.some((u) => u.startsWith('turn:')));
    const [exp, uid] = (turn?.username ?? '').split(':');
    const expected = createHmac('sha1', TURN_SECRET).update(turn?.username ?? '').digest('base64');
    ok(!!turn && turn.credential === expected, '/api/ice issues HMAC-SHA1 (use-auth-secret) credentials');
    const ttl = Number(exp) - Math.floor(Date.now() / 1000);
    ok(ttl > 21500 && ttl <= 21600 && /^g[0-9a-f]{12}$/.test(uid) && ice.ttl === 21600, `credential expiry = now + TURN_TTL, username "<expiry>:<id>" (${turn?.username})`);
    ok(turn.urls.includes('turns:turn.example.com:5349'), 'all TURN_URLS returned');
    const aliceIce = (await alice.req('/api/ice')).json.iceServers.find((s) => s.username);
    ok(aliceIce?.username.endsWith(':u2'), 'account id used in TURN username');
    const anon = await fetch(`${BASE}/api/ice`, { headers: { 'cf-connecting-ip': '192.0.2.200' } }).then((x) => x.json());
    ok(!anon.iceServers.some((s) => s.username), 'no TURN credentials without a device cookie / session');
  }

  // ---------- crash safety: failing handlers never take the process down ----------
  {
    const crashRoom = await emit(sAlice, 'room:create', { name: 'Crash Room', topic: 'guard test' });
    ok(crashRoom.ok, 'crash test room created');
    ok((await emit(sAlice, 'room:join', { roomId: crashRoom.roomId })).ok && (await emit(sAdmin, 'room:join', { roomId: crashRoom.roomId })).ok, 'two clients join the crash test room');
    const logStart = serverLog.length;
    const sync = await Promise.race([emit(sAlice, 'test:throw', { mode: 'sync' }), sleep(2000).then(() => 'no-ack')]);
    ok(sync !== 'no-ack' && sync.ok === false && typeof sync.error === 'string' && sync.error.length > 0, 'sync throw in a socket handler acks a generic error');
    const asyncR = await Promise.race([emit(sAlice, 'test:throw', { mode: 'async' }), sleep(2000).then(() => 'no-ack')]);
    ok(asyncR !== 'no-ack' && asyncR.ok === false && typeof asyncR.error === 'string', 'rejected promise in a socket handler acks a generic error');
    sAlice.emit('test:throw', { mode: 'sync' }); // no ack passed: must not crash either
    sAlice.emit('test:throw', null);
    await emit(sAlice, 'test:throw', { mode: 'timer' });
    await sleep(150);
    ok(server.exitCode === null && sAlice.connected && sAdmin.connected, 'server and sockets stay up after handler failures');
    const logged = serverLog.slice(logStart);
    ok(/\[socket\] test:throw failed/.test(logged) && /test:throw async failure/.test(logged), 'handler failures are logged as [socket] <event> failed');
    ok(/\[timer\] test:throw timer failed/.test(logged), 'a throwing guarded timer is logged, not fatal');
    const heard = once(sAdmin, 'chat:message', (m) => m.kind === 'chat' && m.text === 'still chatting after a crash');
    ok((await emit(sAlice, 'chat:send', { text: 'still chatting after a crash' })).ok, 'sender can still chat after handler failures');
    ok(!!(await heard.catch(() => null)), 'other clients keep receiving chat after handler failures');
    const other = await emit(sAdmin, 'rooms:list');
    ok(other.ok && other.rooms.some((x) => x.id === crashRoom.roomId), 'other clients keep working (rooms:list)');
    for (const mode of ['sync', 'async']) {
      const t = await fetch(`${BASE}/api/test/throw?mode=${mode}`);
      const tb = await t.json().catch(() => null);
      ok(t.status === 500 && tb && tb.ok === false && tb.error === 'Server error' && !JSON.stringify(tb).includes('test '), `${mode} route failure returns 500 JSON without internals`);
    }
    const bad = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': '1' }, body: '{not json' });
    const badBody = await bad.json().catch(() => null);
    ok(bad.status === 400 && badBody?.ok === false, 'malformed JSON body returns 400 JSON');
    ok(/\[http\] GET \/api\/test\/throw failed/.test(serverLog.slice(logStart)), 'route failures are logged');
    const h = await fetch(BASE + '/api/health').then((x) => x.json());
    ok(server.exitCode === null && h.ok === true, 'server still healthy after route failures');
    sAlice.emit('room:leave'); sAdmin.emit('room:leave');
  }

  // ---------- admin log ----------
  const log = (await admin.req('/api/admin/log')).json.log;
  ok(['cam-off', 'delete-message', 'mute', 'topic', 'kick', 'room-ban', 'ban', 'unban', 'role'].every((a) => log.some((l) => l.action === a)), 'moderation log records every action type');
  ok((await mod.req(`/api/admin/reports/${rep.id}`, { status: 'resolved' })).json.ok, 'resolve a report');
  ok((await mod.req('/api/admin/reports?status=resolved')).json.reports.some((x) => x.id === rep.id && x.handledBy === 'Mod_Mary'), 'resolved report listed with handler');

  // ---------- restart: persistence + pruning ----------
  sockets.forEach((s) => s.close());
  await sleep(200);
  await stopServer();
  // seed 150 old messages directly, to check the 100-per-room pruning job at startup
  execFileSync(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    const st = db.prepare("INSERT INTO messages (id, room_id, ts, nick, text) VALUES (?, 'lobby', ?, 'seed', ?)");
    for (let i = 0; i < 150; i++) st.run('seed-' + i, 1000 + i, 'seed message ' + i);
  `, path.join(DATA, 'camchat.db')], { stdio: 'ignore' });
  await startServer();
  const a2 = track(await alice.connect());
  ok((await emit(a2, 'login', {})).ok, 'session cookie survives restart');
  const rooms2 = (await emit(a2, 'rooms:list')).rooms;
  const persisted = rooms2.find((x) => x.id === roomId);
  ok(persisted && persisted.topic === 'Owner topic', 'room + topic persisted across restart');
  const j2 = await emit(a2, 'room:join', { roomId });
  const texts = j2.room.history.filter((m) => m.kind === 'chat').map((m) => m.text);
  ok(j2.room.isOwner && texts.includes('hello b****** and F****!') && !texts.includes('rude message from bob'), 'history persisted across restart (deleted message stays hidden)');
  const jl = await emit(a2, 'room:join', { roomId: 'lobby' });
  const lobbyChat = jl.room.history.filter((m) => m.kind === 'chat');
  ok(lobbyChat.length === 100 && lobbyChat.at(-1).text === 'seed message 149', `pruning keeps the newest 100 messages per room (${lobbyChat.length})`);
  r = await emit(a2, 'room:join', { roomId });
  const delRoom = await emit(a2, 'room:delete');
  ok(delRoom.ok && !(await emit(a2, 'rooms:list')).rooms.some((x) => x.id === roomId), 'owner deletes the persistent room');

  // make-admin CLI
  const out = execFileSync(process.execPath, ['scripts/make-admin.mjs', 'Alice'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA } }).toString();
  ok(/user -> admin/.test(out), 'make-admin CLI promotes a user');
  a2.close();
  const a3 = track(await alice.connect());
  ok((await emit(a3, 'login', {})).user?.role === 'admin', 'promoted role applies on next connect');

  // client IP resolution (CF-Connecting-IP only from trusted proxies)
  const ipCheck = execFileSync(process.execPath, ['-e', `
    const { clientIp } = require('./dist/server/server/net.js');
    const mk = (remote, h) => ({ socket: { remoteAddress: remote }, connection: { remoteAddress: remote }, headers: h });
    console.log(JSON.stringify([
      clientIp(mk('127.0.0.1', { 'cf-connecting-ip': '203.0.113.5' })),
      clientIp(mk('198.51.100.9', { 'cf-connecting-ip': '203.0.113.5' })),
      clientIp(mk('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.6' })),
      clientIp(mk('198.51.100.9', { 'x-forwarded-for': '203.0.113.6' })),
    ]));
  `], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, TRUST_PROXY: 'loopback' } }).toString().trim();
  ok(ipCheck === JSON.stringify(['203.0.113.5', '198.51.100.9', '203.0.113.6', '198.51.100.9']), `client IP: CF/XFF trusted only from trusted proxy (${ipCheck})`);

  // ---------- v3: captcha, password reset, friends, room mods ----------
  {
    const b = browser(); await b.boot();
    const c = await b.req('/api/auth/captcha');
    ok(c.json.mode === 'builtin' && c.json.id && c.json.question, 'builtin captcha challenge');
    const wrong = await b.req('/api/auth/register', { username: 'Cap_Wrong', password: 'password123xx', captchaId: c.json.id, captchaAnswer: '9999' });
    ok(!wrong.json.ok, 'wrong captcha rejected');
  }
  {
    const u = browser(); await u.boot();
    await register(u, 'Reset_Me', 'old-password-99');
    const forgot = await u.req('/api/auth/forgot', { username: 'Reset_Me' });
    ok(forgot.json.ok && /reset/i.test(forgot.json.message || ''), 'forgot password returns generic ok');
    const found = (await admin.req('/api/admin/users?q=Reset_Me')).json.users[0];
    const issued = await admin.req(`/api/admin/users/${found.id}/reset`, {});
    ok(issued.json.ok && issued.json.token && issued.json.link, 'admin issues one-time reset link');
    const other = browser(); await other.boot();
    const reset = await other.req('/api/auth/reset', { token: issued.json.token, password: 'new-password-99' });
    ok(reset.json.ok && reset.json.account.username === 'Reset_Me', 'password reset with token signs in');
    const reuse = await (await (async () => { const x = browser(); await x.boot(); return x; })()).req('/api/auth/reset', { token: issued.json.token, password: 'another-password-1' });
    ok(!reuse.json.ok, 'reset token cannot be reused');
    const login = browser(); await login.boot();
    ok((await login.req('/api/auth/login', { username: 'Reset_Me', password: 'new-password-99' })).json.ok, 'login works with new password');
    const resetMails = readMail().filter((m) => m.to === 'reset_me@example.com' && /Reset your zeronoise password/.test(m.subject));
    ok(resetMails.length === 0, 'unverified address does not receive the reset link');
  }
  {
    const u = browser(); await u.boot();
    const reg = await register(u, 'Verify_Me', 'verify-password-1', '  Mixed.Case@Example.com ');
    ok(reg.json.ok && reg.json.account.email === 'Mixed.Case@Example.com' && reg.json.account.emailVerified === false, 'email is stored trimmed; verification starts false');
    const dup = await register(browser(), 'Other_Mix', 'other-password-1', 'mixed.case@example.com');
    ok(dup.status === 409 && dup.json.error === 'That email is already in use.', 'email uniqueness is case-insensitive');
    const sent = readMail().filter((m) => m.to === 'Mixed.Case@Example.com');
    ok(sent.length === 1 && sent[0].html.includes('zeronoise') && /verify-email\?token=/.test(sent[0].text), 'confirmation mail is branded text and HTML');
    const token = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(sent[0].text)[1];
    const code = /code: (\d{6})/.exec(sent[0].text)[1];
    ok(!serverLog.includes(token) && !serverLog.includes(code), 'the server log does not contain the confirmation token or code');
    const byToken = browser(); await byToken.boot();
    const verified = await byToken.req('/api/auth/verify-email', { token });
    ok(verified.json.ok && verified.json.account.emailVerified === true && verified.json.account.username === 'Verify_Me', 'link verifies the address and signs in');
    ok(!(await byToken.req('/api/auth/verify-email', { token })).json.ok, 'confirmation link is single use');
    ok(!(await u.req('/api/auth/verify-email', { code })).json.ok, 'the code on a used link cannot be reused');

    const coder = browser(); await coder.boot();
    await register(coder, 'Code_User', 'code-password-1', 'code.user@example.com');
    const codeMail = readMail().filter((m) => m.to === 'code.user@example.com').at(-1);
    const six = /code: (\d{6})/.exec(codeMail.text)[1];
    const byCode = await coder.req('/api/auth/verify-email', { code: six });
    ok(byCode.json.ok && byCode.json.account.emailVerified === true, '6-digit code verifies the address');

    const changed = await coder.req('/api/me/email', { email: 'code.user.new@example.com' });
    ok(changed.json.ok && changed.json.account.email === 'code.user.new@example.com' && changed.json.account.emailVerified === false, 'changing the address clears verified');
    ok(!(await coder.req('/api/auth/verify-email', { code: six })).json.ok, 'the old code does not confirm the new address');
    const taken = await coder.req('/api/me/email', { email: 'mixed.case@example.com' });
    ok(taken.status === 409 && taken.json.error === 'That email is already in use.', 'changing to a used address does not name the other account');

    const resendUser = browser(); await resendUser.boot();
    await register(resendUser, 'Resend_Me', 'resend-password-1', 'resend.me@example.com');
    const again1 = await resendUser.req('/api/auth/verify-email/send', {});
    const again2 = await resendUser.req('/api/auth/verify-email/send', {});
    const again3 = await resendUser.req('/api/auth/verify-email/send', {});
    ok(again1.json.ok && again2.json.ok && again3.status === 429, 'a third resend in the hour is rejected (3 sends including registration)');

    const resetMailBefore = readMail().filter((m) => /Reset your zeronoise password/.test(m.subject) && m.to === 'Mixed.Case@Example.com').length;
    const forgot = await browser().req('/api/auth/forgot', { username: 'mixed.case@example.com' });
    ok(forgot.json.ok && forgot.json.message === 'If that account exists, a password reset was created. Ask a moderator for a reset link, or check email if configured.', 'forgot by email keeps the generic reply');
    const resetMail = readMail().filter((m) => /Reset your zeronoise password/.test(m.subject) && m.to === 'Mixed.Case@Example.com');
    ok(resetMail.length === resetMailBefore + 1 && /\/reset\?token=/.test(resetMail.at(-1).text), 'verified email receives the 60-minute reset link');
    const unknown = await browser().req('/api/auth/forgot', { username: 'nobody@example.com' });
    ok(unknown.json.ok && unknown.json.message === forgot.json.message, 'unknown email gets the same reply');

    const legacy = browser(); await legacy.boot();
    ok((await register(legacy, 'Legacy_User', 'legacy-password-1')).json.ok, 'legacy account registers');
    execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.prepare('UPDATE users SET email = NULL, email_lower = NULL, email_verified_at = NULL WHERE username = ?').run(process.argv[2]);
    `, path.join(DATA, 'camchat.db'), 'Legacy_User'], { stdio: 'ignore' });
    const legacyMe = await legacy.req('/api/me');
    ok(legacyMe.json.account?.email === null && legacyMe.json.account?.emailVerified === false, 'an existing account can have no email');
    const sLegacy = track(await legacy.connect());
    ok((await emit(sLegacy, 'login', {})).ok, 'legacy account signs in');
    const blocked = await emit(sLegacy, 'room:join', { roomId: 'lobby' });
    ok(!blocked.ok && /email/i.test(blocked.error || ''), 'an account with no email cannot enter a room');
    const added = await legacy.req('/api/me/email', { email: 'legacy.user@example.com' });
    ok(added.json.ok && added.json.account.email === 'legacy.user@example.com' && added.json.account.emailVerified === false, 'the account can add an email');
    ok((await emit(sLegacy, 'room:join', { roomId: 'lobby' })).ok, 'with verification not required, an unverified email can enter a room');

    const found = (await admin.req('/api/admin/users?q=legacy.user@example.com')).json.users.find((x) => x.username === 'Legacy_User');
    ok(found && found.email === 'legacy.user@example.com' && found.emailVerified === false, 'staff user search can see the email');
    const marked = await admin.req(`/api/admin/users/${found.id}/email`, { verified: true });
    ok(marked.json.ok && marked.json.user.emailVerified === true && marked.json.user.email === 'legacy.user@example.com', 'a moderator can mark the email verified');
    const edited = await mod.req(`/api/admin/users/${found.id}/email`, { email: 'legacy.staff@example.com' });
    ok(edited.json.ok && edited.json.user.email === 'legacy.staff@example.com' && edited.json.user.emailVerified === false, 'a moderator can edit the email');
    const log = (await admin.req('/api/admin/log')).json.log.filter((l) => l.action === 'email-update' && l.target === 'Legacy_User');
    ok(log.length >= 2 && log.every((l) => !JSON.stringify(l).includes('@')), 'the action log records the email change without the address');
    const stranger = browser(); await stranger.boot();
    await register(stranger, 'Stranger_Z', 'stranger-password-1');
    const theirMe = await stranger.req('/api/me');
    ok(theirMe.json.account?.email === 'stranger_z@example.com' && !JSON.stringify(theirMe.json).includes('legacy.staff@example.com'), 'another account /api/me does not include someone else\'s email');
  }
  {
    const a = browser(); await a.boot(); await register(a, 'Friend_A', 'friend-pass-aa');
    const b = browser(); await b.boot(); await register(b, 'Friend_B', 'friend-pass-bb');
    const sa = track(await a.connect()); const sb = track(await b.connect());
    ok((await emit(sa, 'login', {})).ok && (await emit(sb, 'login', {})).ok, 'friends A/B socket login');
    const updP = once(sb, 'friend:update', (p) => p.type === 'request', 3000);
    ok((await emit(sa, 'friends:request', { username: 'Friend_B' })).ok, 'friend request sent');
    const upd = await updP;
    ok(!!upd, 'peer notified of friend request');
    const listB = await emit(sb, 'friends:list');
    const pending = listB.pendingIn[0];
    ok(!!pending, 'B sees pending request');
    ok((await emit(sb, 'friends:respond', { userId: pending.userId, accept: true })).ok, 'B accepts friend request');
    const listA = await emit(sa, 'friends:list');
    const bFriend = listA.friends.find((f) => f.username === 'Friend_B');
    ok(!!bFriend && !JSON.stringify(listA).includes('@'), 'A sees B as friend and the list has no email');
    const incomingP = once(sb, 'call:incoming', () => true, 3000);
    const call2 = await emit(sa, 'call:invite', { userId: bFriend.userId });
    ok(call2.ok && call2.room?.isPrivate, '1:1 call creates private room');
    const incoming = await incomingP;
    ok(!!incoming?.roomId, 'B receives call:incoming');
    const ans = await emit(sb, 'call:respond', { roomId: incoming.roomId, accept: true });
    ok(ans.ok && ans.room?.isPrivate, 'B accepts call and joins private room');
  }
  {
    const owner = browser(); await owner.boot(); await register(owner, 'Room_Owner', 'owner-pass-11');
    const so = track(await owner.connect());
    ok((await emit(so, 'login', {})).ok, 'room owner login');
    const created = await emit(so, 'room:create', { name: 'LockTest', topic: 't' });
    ok(created.ok, 'create room for lock test');
    ok((await emit(so, 'room:join', { roomId: created.roomId })).ok, 'owner joins');
    ok((await emit(so, 'room:lock', { locked: true })).ok, 'owner locks room');
    ok((await emit(so, 'room:slowmode', { seconds: 10 })).ok, 'owner sets slow mode');
    ok((await emit(so, 'chat:send', { text: 'hello purge me' })).ok, 'chat before purge');
    ok((await emit(so, 'room:purge', { minutes: 60 })).ok, 'owner purges chat');
  }



  // ---------- chat color + avatar ----------
  {
    const u = browser(); await u.boot();
    await register(u, 'Color_User', 'color-pass-99');
    let me = (await u.req('/api/me')).json;
    ok(me.account && me.account.chatColor === null && me.account.hasAvatar === false, 'new account has null color and no avatar');
    ok(me.account.chatEffect == null, 'new account has no name effect');
    const palette = await u.req('/api/profile/colors');
    ok(palette.json.ok && Array.isArray(palette.json.colors) && palette.json.colors.length >= 12, 'color palette endpoint');
    let bad = await u.req('/api/me/color', { color: '#ff0000' }, 'PATCH');
    ok(!bad.json.ok && bad.status === 400, 'arbitrary hex color rejected');
    bad = await u.req('/api/me/color', { color: 'javascript:alert(1)' }, 'PATCH');
    ok(!bad.json.ok, 'non-palette color id rejected');
    let okc = await u.req('/api/me/color', { color: 'rose' }, 'PATCH');
    ok(okc.json.ok && okc.json.chatColor === 'rose', 'whitelist color rose accepted');
    me = (await u.req('/api/me')).json;
    ok(me.account.chatColor === 'rose', '/api/me reflects chatColor');
    okc = await u.req('/api/me/color', { color: null }, 'PATCH');
    ok(okc.json.ok && okc.json.chatColor === null, 'color reset to null');
    let fx = await u.req('/api/me/effect', { effect: 'glow' }, 'PATCH');
    ok(fx.json.ok && fx.json.chatEffect === 'glow', 'valid effect glow accepted');
    me = (await u.req('/api/me')).json;
    ok(me.account.chatEffect === 'glow', '/api/me reflects chatEffect');
    fx = await u.req('/api/me/effect', { effect: 'sparkle' }, 'PATCH');
    ok(!fx.json.ok && fx.status === 400, 'unknown effect rejected');
    fx = await u.req('/api/me/effect', { effect: 'glow;}</style><script>alert(1)</script>' }, 'PATCH');
    ok(!fx.json.ok && fx.status === 400, 'CSS snippet rejected as an effect');
    me = (await u.req('/api/me')).json;
    ok(me.account.chatEffect === 'glow', 'rejected effect did not change the saved one');

    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('avatar', new Blob([png], { type: 'image/png' }), 'dot.png');
    const up = await fetch(BASE + '/api/me/avatar', {
      method: 'POST',
      headers: { 'cf-connecting-ip': u.ip, 'x-csrf': '1', cookie: u.cookieHeader() },
      body: fd,
    });
    const upj = await up.json();
    ok(up.ok && upj.ok && upj.hasAvatar === true, 'avatar upload happy path');
    me = (await u.req('/api/me')).json;
    ok(me.account.hasAvatar === true, '/api/me reflects hasAvatar');
    const aid = me.account.id;
    const img = await fetch(BASE + `/api/avatars/${aid}.webp`, { headers: { 'cf-connecting-ip': u.ip } });
    ok(img.ok && img.headers.get('content-type')?.includes('image/webp'), 'GET avatar webp served');
    const body = Buffer.from(await img.arrayBuffer());
    ok(body.length > 20 && body[0] === 0x52 && body[1] === 0x49, 'avatar bytes look like RIFF/webp');

    // reject garbage
    const fd2 = new FormData();
    fd2.append('avatar', new Blob([Buffer.from('not-an-image-at-all')], { type: 'image/png' }), 'bad.png');
    const badUp = await fetch(BASE + '/api/me/avatar', {
      method: 'POST',
      headers: { 'cf-connecting-ip': u.ip, 'x-csrf': '1', cookie: u.cookieHeader() },
      body: fd2,
    });
    const badj = await badUp.json().catch(() => ({}));
    ok(!badUp.ok || badj.ok === false, 'non-image upload rejected');

    // too large (>512KB)
    const big = Buffer.alloc(600 * 1024, 1);
    const fd3 = new FormData();
    fd3.append('avatar', new Blob([big], { type: 'image/jpeg' }), 'big.jpg');
    const bigUp = await fetch(BASE + '/api/me/avatar', {
      method: 'POST',
      headers: { 'cf-connecting-ip': u.ip, 'x-csrf': '1', cookie: u.cookieHeader() },
      body: fd3,
    });
    const bigj = await bigUp.json().catch(() => ({}));
    ok(bigUp.status === 400 || bigj.ok === false, 'oversized avatar rejected');

    const guest = browser(); await guest.boot();
    const gUp = await fetch(BASE + '/api/me/avatar', {
      method: 'POST',
      headers: { 'cf-connecting-ip': guest.ip, 'x-csrf': '1', cookie: guest.cookieHeader() },
      body: fd,
    });
    ok(gUp.status === 401, 'guest cannot upload avatar');
    const gCol = await guest.req('/api/me/color', { color: 'cyan' }, 'PATCH');
    ok(gCol.status === 401, 'guest cannot set color');
    ok((await guest.req('/api/me/effect', { effect: 'glow' }, 'PATCH')).status === 401, 'guest cannot set an effect');

    const del = await u.req('/api/me/avatar', undefined, 'DELETE');
    ok(del.json.ok && del.json.hasAvatar === false, 'avatar delete');
    me = (await u.req('/api/me')).json;
    ok(me.account.hasAvatar === false, '/api/me after avatar delete');
    const gone = await fetch(BASE + `/api/avatars/${aid}.webp`);
    ok(gone.status === 404, 'deleted avatar 404');
  }


  // ---------- GIF search ----------
  {
    const me = await browser().boot();
    ok(me.gifs === false, '/api/me reports gifs:false when no provider key');
    const s = await fetch(`${BASE}/api/gifs/search?q=cat`);
    const sj = await s.json();
    ok(s.status === 503 && sj.ok === false, 'GIF search is 503 when not configured');
    const tr = await fetch(`${BASE}/api/gifs/trending`);
    ok(tr.status === 503, 'GIF trending is 503 when not configured');
  }
  {
    const portG = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const dataG = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-gif-'));
    const envG = { ...env, PORT: String(portG), DATA_DIR: dataG, GIF_FIXTURE: '1', TENOR_API_KEY: 'fixture-key' };
    const child = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, env: envG, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const baseG = `http://127.0.0.1:${portG}`;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if (log.includes('listening')) break;
    }
    const me = await fetch(`${baseG}/api/me`).then((r) => r.json());
    ok(me.gifs === true, '/api/me reports gifs:true when Tenor key (fixture) is set');
    const search = await fetch(`${baseG}/api/gifs/search?q=cat&limit=20`).then((r) => r.json());
    ok(search.ok && Array.isArray(search.gifs) && search.gifs.length >= 1, 'GIF search returns results');
    const g = search.gifs[0];
    ok(g && typeof g.id === 'string' && g.url.startsWith('https://') && g.previewUrl.startsWith('https://'), 'GIF hit has id, https url and preview');
    ok(!('api_key' in g) && !JSON.stringify(g).includes('fixture-key'), 'GIF payload does not leak the API key');
    const keys = Object.keys(g).sort().join(',');
    ok(keys === 'height,id,previewUrl,url,width', 'GIF hit fields are only id/preview/url/size');
    const trend = await fetch(`${baseG}/api/gifs/trending?limit=20`).then((r) => r.json());
    ok(trend.ok && trend.gifs.length >= 1, 'GIF trending returns results');
    const empty = await fetch(`${baseG}/api/gifs/search`);
    ok(empty.status === 400, 'GIF search without q is 400');
    child.kill('SIGTERM');
  }


  // ---------- chat image upload + reactions ----------
  {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    {
      const b = browser(); await b.boot();
      await register(b, 'Img_User', 'img-pass-99');
      const sImg = track(await b.connect());
      ok((await emit(sImg, 'login', {})).ok, 'image user login');
      const imgRoom = await emit(sImg, 'room:create', { name: 'ImgRoom', topic: 't' });
      ok(imgRoom.ok, 'image room created');
      ok((await emit(sImg, 'room:join', { roomId: imgRoom.roomId })).ok, 'image user joins for upload');
      const fd = new FormData();
      fd.append('image', new Blob([png], { type: 'image/png' }), 'dot.png');
      const up = await fetch(BASE + '/api/rooms/' + encodeURIComponent(imgRoom.roomId) + '/images', { method: 'POST', headers: { 'cf-connecting-ip': b.ip, 'x-csrf': '1', cookie: b.cookieHeader() }, body: fd });
      const upj = await up.json();
      ok(up.ok && upj.ok && /^\/api\/uploads\/[A-Za-z0-9_-]+\.webp$/.test(upj.url), 'chat image upload happy path');
      const img = await fetch(BASE + (upj.url || '/missing'));
      ok(img.ok && (img.headers.get('content-type') || '').includes('image/webp'), 'uploaded chat image is served');
      ok(/private/.test(img.headers.get('cache-control') || '') && /no-store/.test(img.headers.get('cache-control') || ''), 'chat images are private, no-store');
      const noRoom = new FormData();
      noRoom.append('image', new Blob([png], { type: 'image/png' }), 'dot.png');
      const denied = await fetch(BASE + '/api/chat/image', { method: 'POST', headers: { 'cf-connecting-ip': b.ip, 'x-csrf': '1', cookie: b.cookieHeader() }, body: noRoom });
      ok(denied.status === 400, 'legacy /api/chat/image without roomId is refused');
      const bad = new FormData();
      bad.append('image', new Blob([Buffer.from('not-an-image')], { type: 'image/png' }), 'bad.png');
      const rej = await fetch(BASE + '/api/rooms/' + encodeURIComponent(imgRoom.roomId) + '/images', { method: 'POST', headers: { 'cf-connecting-ip': b.ip, 'x-csrf': '1', cookie: b.cookieHeader() }, body: bad });
      ok(rej.status === 400, 'non-image chat upload rejected');
      const big = new FormData();
      big.append('image', new Blob([Buffer.alloc(2.2 * 1024 * 1024, 7)], { type: 'image/jpeg' }), 'big.jpg');
      const bigR = await fetch(BASE + '/api/rooms/' + encodeURIComponent(imgRoom.roomId) + '/images', { method: 'POST', headers: { 'cf-connecting-ip': b.ip, 'x-csrf': '1', cookie: b.cookieHeader() }, body: big });
      ok(bigR.status === 400, 'oversized chat image rejected');
      sImg.close();
    }

    const b = browser(); await b.boot();
    await register(b, 'React_User', 'react-pass-99');
    const s = track(await b.connect());
    ok((await emit(s, 'login', {})).ok, 'reaction user login');
    const created = await emit(s, 'room:create', { name: 'ReactRoom', topic: 't' });
    ok(created.ok, 'reaction room created');
    const joined = await emit(s, 'room:join', { roomId: created.roomId });
    ok(joined.ok, 'reaction user joins');
    const sent = new Promise((res) => s.once('chat:message', res));
    ok((await emit(s, 'chat:send', { text: 'react me' })).ok, 'send message to react to');
    const msg = await sent;
    const rx = await emit(s, 'chat:react', { messageId: msg.id, emoji: '👍' });
    ok(rx.ok && rx.reactions.some((r) => r.emoji === '👍' && r.count === 1 && r.mine), 'reaction persisted and counted');
    const rx2 = await emit(s, 'chat:react', { messageId: msg.id, emoji: '👍' });
    ok(rx2.ok && !rx2.reactions.some((r) => r.emoji === '👍'), 'reacting again removes it');
    const badRx = await emit(s, 'chat:react', { messageId: msg.id, emoji: '<script>' });
    ok(!badRx.ok, 'non-whitelist reaction rejected');
  }

  // ---------- Discord OAuth (disabled by default) ----------
  {
    const me = await browser().boot();
    ok(me.discord === false, '/api/me reports discord:false when not configured');
    ok(me.tiktok === false, '/api/me reports tiktok:false when not configured');
    const r = await fetch(`${BASE}/api/auth/discord`, { redirect: 'manual' });
    ok(r.status === 404, 'GET /api/auth/discord is 404 when Discord is not configured');
    const tt = await fetch(`${BASE}/api/auth/tiktok`, { redirect: 'manual' });
    ok(tt.status === 404, 'GET /api/auth/tiktok is 404 when TikTok is not configured');
  }
  {
    // Enabled path: spawn a short-lived server with Discord env; no real Discord calls needed for start+redirect+state
    const port2 = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const data2 = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-discord-'));
    const env2 = {
      ...env, PORT: String(port2), DATA_DIR: data2,
      DISCORD_CLIENT_ID: 'discord-test-client', DISCORD_CLIENT_SECRET: 'discord-test-secret',
      PUBLIC_URL: `http://127.0.0.1:${port2}`,
    };
    const child = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      if (log.includes('listening')) break;
      if (child.exitCode !== null) throw new Error('discord test server died: ' + log);
    }
    const base2 = `http://127.0.0.1:${port2}`;
    const me2 = await fetch(`${base2}/api/me`).then((r) => r.json());
    ok(me2.discord === true, '/api/me reports discord:true when configured');
    const start = await fetch(`${base2}/api/auth/discord`, { redirect: 'manual' });
    ok(start.status === 302 && /discord\.com\/api\/oauth2\/authorize/.test(start.headers.get('location') || ''), 'Discord authorize redirects to discord.com');
    const loc = new URL(start.headers.get('location'));
    ok(loc.searchParams.get('scope') === 'identify' && loc.searchParams.get('client_id') === 'discord-test-client', 'Discord authorize has identify scope + client id');
    const setCookie = start.headers.getSetCookie?.() || [];
    const oauthCookie = setCookie.map((c) => c.split(';')[0]).find((c) => /oauth=/.test(c)) || '';
    const bad = await fetch(`${base2}/api/auth/discord/callback?code=x&state=wrong`, {
      redirect: 'manual', headers: { cookie: oauthCookie },
    });
    ok(bad.status === 302 && /authError=/.test(bad.headers.get('location') || ''), 'Discord callback rejects state mismatch');
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(data2, { recursive: true, force: true });
  }

  // ---------- TikTok Login Kit (mocked token + user info) ----------
  {
    const clientJs = [];
    const walkJs = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walkJs(p);
        else if (name.endsWith('.js')) clientJs.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walkJs(path.join(ROOT, 'dist/client'));
    const bundle = clientJs.join('\n');
    ok(bundle.includes('Sign in with TikTok') && bundle.includes('TikTok linked'), 'built client has the TikTok button and the Users tag');

    const ADA = '723f24d7-e717-40f8-a2b6-cb8464cd23b4';
    const BEA = 'afd97af1-b87b-48b9-ac98-410aghda5344';
    const SECRET = 'tiktok-test-secret-value';
    const KEY = 'tiktok-test-client-key';
    const profiles = {
      'code-ada': { open_id: ADA, union_id: 'c9c60f44-a68e-4f5d-84dd-ce22faeb0ba1', display_name: 'Ada Lovelace', avatar_url: 'https://example.invalid/ada.png' },
      'code-bea': { open_id: BEA, union_id: 'union-bea-0001', display_name: 'Bea', avatar_url: 'https://example.invalid/bea.png' },
    };
    const tokens = { 'code-ada': 'act.tiktok-mock-token-ada', 'code-bea': 'act.tiktok-mock-token-bea' };
    const seen = [];
    const mock = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      if (req.method === 'POST' && url.pathname === '/v2/oauth/token/') {
        const body = new URLSearchParams(raw);
        const code = body.get('code') || '';
        seen.push({
          code,
          verifier: body.get('code_verifier') || '',
          secret: body.get('client_secret') || '',
          key: body.get('client_key') || '',
          grant: body.get('grant_type') || '',
          redirect: body.get('redirect_uri') || '',
        });
        const profile = profiles[code];
        if (!profile || !body.get('code_verifier') || body.get('client_secret') !== SECRET) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_request', error_description: 'rejected', log_id: 'mock' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: tokens[code], open_id: profile.open_id, expires_in: 86400,
          refresh_token: 'rft.not-stored', scope: 'user.info.basic', token_type: 'Bearer',
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v2/user/info/') {
        const bearer = String(req.headers.authorization || '');
        const code = Object.keys(tokens).find((k) => bearer === `Bearer ${tokens[k]}`);
        const fields = url.searchParams.get('fields') || '';
        if (!code || !fields.includes('open_id') || !fields.includes('display_name')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: {}, error: { code: 'access_token_invalid', message: '', log_id: 'mock' } }));
          return;
        }
        const profile = profiles[code];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { user: profile }, error: { code: 'ok', message: '', log_id: 'mock' } }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    const mockPort = mock.address().port;
    const mockBase = `http://127.0.0.1:${mockPort}`;

    const portT = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const dataT = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-tiktok-'));
    const envT = {
      ...env, PORT: String(portT), DATA_DIR: dataT, PUBLIC_URL: `http://127.0.0.1:${portT}`,
      ADMIN_USERNAMES: 'Tik_Admin', EMAIL_VERIFY_REQUIRED: '0',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '',
      TIKTOK_CLIENT_KEY: KEY, TIKTOK_CLIENT_SECRET: SECRET,
      TIKTOK_AUTHORIZE_URL: 'https://www.tiktok.com/v2/auth/authorize/',
      TIKTOK_TOKEN_URL: `${mockBase}/v2/oauth/token/`,
      TIKTOK_USERINFO_URL: `${mockBase}/v2/user/info/`,
    };
    const child = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, env: envT, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const baseT = `http://127.0.0.1:${portT}`;
    try {
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        if (log.includes('listening')) break;
        if (child.exitCode !== null) throw new Error('tiktok test server died: ' + log);
      }
      const health = await fetch(baseT + '/api/health').then((r) => r.json());
      ok(health.tiktok === true && health.ok === true && !JSON.stringify(health).includes(SECRET) && !JSON.stringify(health).includes(KEY), 'health tiktok flag is true and hides the client key and secret');
      const meFlag = await fetch(baseT + '/api/me').then((r) => r.json());
      ok(meFlag.tiktok === true && !JSON.stringify(meFlag).includes(SECRET), '/api/me reports tiktok:true without the secret');

      const absorb = (jar, res) => {
        for (const c of res.headers.getSetCookie?.() || []) {
          const [kv] = c.split(';');
          const i = kv.indexOf('=');
          const k = kv.slice(0, i), v = kv.slice(i + 1);
          if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
        }
      };
      const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      async function begin(pathAndQuery) {
        const res = await fetch(baseT + pathAndQuery, { redirect: 'manual' });
        const jar = new Map();
        absorb(jar, res);
        return { res, jar, loc: new URL(res.headers.get('location') || 'http://invalid/') };
      }
      async function finish(jar, code, state) {
        const oauth = decodeURIComponent(jar.get('camchat_oauth') || '');
        const useState = state === undefined ? oauth : state;
        const res = await fetch(`${baseT}/auth/tiktok/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(useState)}`, {
          redirect: 'manual',
          headers: { cookie: cookieHeader(jar), 'cf-connecting-ip': '203.0.113.40' },
        });
        absorb(jar, res);
        return res;
      }
      function challengeOf(jar) {
        const verifier = decodeURIComponent(jar.get('camchat_oauth_pkce') || '');
        return { verifier, challenge: createHash('sha256').update(verifier).digest('hex') };
      }

      const googleOff = await fetch(`${baseT}/api/auth/google`, { redirect: 'manual' });
      ok(googleOff.status === 404, 'Google start stays 404 when only TikTok is configured');
      const started = await begin('/api/auth/tiktok');
      const redir = started.loc;
      const pkce = challengeOf(started.jar);
      ok(started.res.status === 302 && redir.origin + redir.pathname === 'https://www.tiktok.com/v2/auth/authorize/', 'TikTok authorize redirects to www.tiktok.com/v2/auth/authorize/');
      ok(redir.searchParams.get('client_key') === KEY && redir.searchParams.get('response_type') === 'code' && redir.searchParams.get('scope') === 'user.info.basic', 'TikTok authorize has client_key, code, and user.info.basic');
      ok(redir.searchParams.get('redirect_uri') === `${baseT}/auth/tiktok/callback`, 'TikTok redirect URI is PUBLIC_URL + /auth/tiktok/callback');
      ok(redir.searchParams.get('state') === decodeURIComponent(started.jar.get('camchat_oauth') || '') && pkce.verifier.length >= 43 && pkce.verifier.length <= 128, 'TikTok state cookie matches and code_verifier is 43-128 chars');
      ok(redir.searchParams.get('code_challenge') === pkce.challenge && redir.searchParams.get('code_challenge_method') === 'S256', 'TikTok code_challenge is hex SHA256 of the verifier');

      const alias = await begin('/api/auth/google?provider=tiktok');
      ok(alias.res.status === 302 && alias.loc.hostname === 'www.tiktok.com' && alias.loc.pathname === '/v2/auth/authorize/', '1.2.0 shell path /api/auth/google?provider=tiktok starts TikTok');
      const aliasD = await begin('/api/auth/discord?provider=tiktok');
      ok(aliasD.res.status === 302 && aliasD.loc.hostname === 'www.tiktok.com', '/api/auth/discord?provider=tiktok starts TikTok');

      const created = await finish(started.jar, 'code-ada');
      ok(created.status === 302 && (created.headers.get('location') || '') === '/', 'new TikTok account redirects home');
      ok(seen.length === 1 && seen[0].secret === SECRET && seen[0].grant === 'authorization_code' && seen[0].redirect === `${baseT}/auth/tiktok/callback` && seen[0].verifier === pkce.verifier, 'token request sends the verifier, secret, and redirect URI');
      const me = await fetch(baseT + '/api/me', { headers: { cookie: cookieHeader(started.jar) } }).then((r) => r.json());
      ok(me.account?.username === 'AdaLovelace' && me.account?.email === null && me.account?.emailVerified === false, 'new TikTok account is named from display_name and has no email');

      const again = await begin('/api/auth/tiktok');
      const back = await finish(again.jar, 'code-ada');
      const me2 = await fetch(baseT + '/api/me', { headers: { cookie: cookieHeader(again.jar) } }).then((r) => r.json());
      ok(back.status === 302 && me2.account?.username === 'AdaLovelace' && me2.account?.id === me.account?.id, 'returning TikTok open_id signs into the same account');

      const s = await new Promise((resolve, reject) => {
        const sock = io(baseT, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: cookieHeader(started.jar), 'cf-connecting-ip': '203.0.113.40' }, auth: { deviceId: me.deviceId } });
        sock.once('connect', () => resolve(sock));
        sock.once('connect_error', (e) => { sock.close(); reject(e); });
      });
      sockets.push(s);
      ok((await emit(s, 'login', {})).ok, 'TikTok account can sign the socket in');
      const blocked = await emit(s, 'room:join', { roomId: 'lobby' });
      ok(!blocked.ok && /email/i.test(blocked.error || ''), 'TikTok account with no email is sent to confirm an email before a room');

      const admin = { jar: new Map() };
      const capRes = await fetch(baseT + '/api/auth/captcha', { headers: { 'cf-connecting-ip': '203.0.113.41' } });
      absorb(admin.jar, capRes);
      const cap = await capRes.json();
      const sum = /What is (\d+) \+ (\d+)/.exec(cap.question || '');
      const reg = await fetch(baseT + '/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': '1', 'cf-connecting-ip': '203.0.113.41', cookie: cookieHeader(admin.jar) },
        body: JSON.stringify({ username: 'Tik_Admin', password: 'admin-pass-99', email: 'tik.admin@example.com', captchaId: cap.id, captchaAnswer: String(+sum[1] + +sum[2]) }),
      });
      absorb(admin.jar, reg);
      const users = await fetch(baseT + '/api/admin/users?q=AdaLovelace', { headers: { cookie: cookieHeader(admin.jar) } }).then((r) => r.json());
      const row = (users.users || []).find((u) => u.username === 'AdaLovelace');
      ok(reg.ok && row && row.tiktok === true && row.email === null, 'staff user search shows the TikTok account as linked');

      execFileSync(process.execPath, ['-e', `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[1]);
        const u = db.prepare('SELECT id, username FROM users WHERE tiktok_open_id = ?').get(process.argv[2]);
        if (!u) process.exit(1);
        db.prepare('INSERT INTO bans (kind, value, label, reason, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,NULL)').run('account', String(u.id), u.username, 'tiktok test ban', 'test', Date.now());
      `, path.join(dataT, 'camchat.db'), ADA], { cwd: ROOT, stdio: 'ignore' });
      const bannedStart = await begin('/api/auth/tiktok');
      const banned = await finish(bannedStart.jar, 'code-ada');
      const bannedLoc = decodeURIComponent(banned.headers.get('location') || '');
      const bannedSid = (banned.headers.getSetCookie?.() || []).find((c) => c.startsWith('camchat_sid=') && !/Max-Age=0/.test(c));
      ok(banned.status === 302 && /banned/i.test(bannedLoc) && !bannedSid, 'banned TikTok account is refused and gets no session');

      const seenBefore = seen.length;
      const mismatch = await finish(await begin('/api/auth/tiktok').then((x) => x.jar), 'code-ada', 'not-the-state');
      const mismatchLoc = decodeURIComponent(mismatch.headers.get('location') || '');
      ok(mismatch.status === 302 && /expired/i.test(mismatchLoc) && seen.length === seenBefore, 'TikTok callback rejects a state mismatch before calling TikTok');

      const nonce = 'nativeNonceTiktokTestValue01';
      const nativeStart = await begin(`/api/auth/google?provider=tiktok&client=native&nonce=${nonce}`);
      ok(nativeStart.jar.get('camchat_oauth_nonce') === nonce, 'native TikTok start stores the handoff nonce');
      const nativeDone = await finish(nativeStart.jar, 'code-bea');
      const nativeLoc = nativeDone.headers.get('location') || '';
      const nativeUrl = new URL(nativeLoc);
      ok(nativeDone.status === 302 && nativeUrl.protocol === 'camchat:' && nativeUrl.hostname === 'auth' && nativeUrl.searchParams.get('nonce') === nonce && (nativeUrl.searchParams.get('token') || '').length > 20 && !nativeUrl.searchParams.has('error'), 'native TikTok callback redirects to camchat://auth with a handoff token');

      ok(!log.includes(SECRET) && !log.includes(tokens['code-ada']) && !log.includes(tokens['code-bea']), 'TikTok server log does not contain the secret or access tokens');
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
      await new Promise((r) => mock.close(r));
      fs.rmSync(dataT, { recursive: true, force: true });
    }
  }

  // ---------- optional room passwords + public directory ----------
  {
    const secret = 'room-secret-99';
    const owner = browser(); await owner.boot(); await register(owner, 'Pw_Owner', 'owner-pass-99');
    const other = browser(); await other.boot(); await register(other, 'Pw_Other', 'other-pass-99');
    const so = track(await owner.connect());
    const sx = track(await other.connect());
    ok((await emit(so, 'login', {})).ok && (await emit(sx, 'login', {})).ok, 'password room users login');
    const created = await emit(so, 'room:create', { name: 'SecretDen', topic: 'shh', password: secret });
    ok(created.ok && created.roomId, 'create with password');
    const listed = await emit(sx, 'rooms:list');
    const row = listed.rooms.find((r) => r.id === created.roomId);
    ok(!!row && row.passwordRequired === true && typeof row.users === 'number' && typeof row.broadcasters === 'number', 'directory shows password room and live counts');
    ok(row && !('password' in row) && !('passwordHash' in row) && !JSON.stringify(listed.rooms).includes(secret), 'password not present in directory payload');
    const httpList = await other.req('/api/rooms');
    const httpRow = (httpList.json.rooms || []).find((r) => r.id === created.roomId);
    ok(!!httpRow && httpRow.passwordRequired === true && !JSON.stringify(httpList.json).includes(secret) && !('password' in httpRow), 'HTTP directory has the flag and not the secret');
    const wrong = await emit(sx, 'room:join', { roomId: created.roomId, password: 'nope-nope-99' });
    ok(!wrong.ok && /wrong room password/i.test(wrong.error || ''), 'join wrong password rejected');
    ok(!(await emit(sx, 'chat:send', { text: 'should fail' })).ok, 'wrong password did not join');
    const missing = await emit(sx, 'room:join', { roomId: created.roomId });
    ok(!missing.ok && /password/i.test(missing.error || ''), 'join without password rejected');
    const right = await emit(sx, 'room:join', { roomId: created.roomId, password: secret });
    ok(right.ok && right.room && right.room.passwordRequired === true && !JSON.stringify(right.room).includes(secret), 'join right password accepted');
    const denied = await emit(sx, 'room:password', { password: 'another-secret-1' });
    ok(!denied.ok, 'non-owner cannot set it');
    ok((await emit(so, 'room:join', { roomId: created.roomId, password: secret })).ok, 'owner joins with password');
    ok((await emit(so, 'room:password', { password: '' })).ok, 'owner can clear password');
    const after = await emit(sx, 'rooms:list');
    const cleared = after.rooms.find((r) => r.id === created.roomId);
    ok(!!cleared && cleared.passwordRequired === false, 'directory shows room open after clear');
    const third = browser(); await third.boot(); await register(third, 'Pw_Third', 'third-pass-99');
    const st = track(await third.connect());
    ok((await emit(st, 'login', {})).ok, 'third logs in');
    ok((await emit(st, 'room:join', { roomId: created.roomId })).ok, 'open room joins with no password');
    ok((await emit(so, 'friends:request', { username: 'Pw_Other' })).ok, 'owner requests friend for call privacy check');
    const pend = await emit(sx, 'friends:list');
    const req = (pend.pendingIn || []).find((f) => f.username === 'Pw_Owner');
    ok(!!req && (await emit(sx, 'friends:respond', { userId: req.userId, accept: true })).ok, 'other accepts friend for call privacy check');
    const friends = await emit(so, 'friends:list');
    const peer = (friends.friends || []).find((f) => f.username === 'Pw_Other');
    const call = await emit(so, 'call:invite', { userId: peer && peer.userId });
    ok(call.ok && call.roomId, 'private call started');
    const dir = await emit(st, 'rooms:list');
    ok(!dir.rooms.some((r) => r.id === call.roomId), 'directory hides 1:1 rooms');
    const http2 = await third.req('/api/rooms');
    ok(!(http2.json.rooms || []).some((r) => r.id === call.roomId), 'HTTP directory hides 1:1 rooms');
  }

  // ---------- threads, edits, deletes, pins, mentions ----------
  {
    const ba = browser(); await ba.boot();
    const bb = browser(); await bb.boot();
    const bc = browser(); await bc.boot();
    ok((await register(ba, 'Chat_A', 'password123')).json.ok, 'chat feature user A');
    ok((await register(bb, 'Chat_B', 'password123')).json.ok, 'chat feature user B');
    ok((await register(bc, 'Chat_C', 'password123')).json.ok, 'chat feature user C');
    const sa = track(await ba.connect());
    const sb = track(await bb.connect());
    const sc = track(await bc.connect());
    const sm = track(await mod.connect());
    const la = await emit(sa, 'login', {});
    const lb = await emit(sb, 'login', {});
    const lc = await emit(sc, 'login', {});
    const lm = await emit(sm, 'login', {});
    ok(la.ok && lb.ok && lc.ok && lm.ok && lm.user.role === 'moderator', 'chat feature sockets logged in');
    const bId = lb.user.accountId;
    const created = await emit(sa, 'room:create', { name: 'ChatFeat', topic: 'threads' });
    ok(created.ok, 'chat feature room created');
    const roomId = created.roomId;
    ok((await emit(sa, 'room:join', { roomId })).ok, 'A joins chat feature room');
    ok((await emit(sb, 'room:join', { roomId })).ok, 'B joins chat feature room');
    const mentioned = once(sb, 'chat:message', (m) => m.kind === 'chat' && String(m.text).includes('@Chat_B'));
    ok((await emit(sa, 'chat:send', { text: '@Chat_B hello thread' })).ok, 'A sends a mention');
    const msg = await mentioned;
    ok(Array.isArray(msg.mentions) && msg.mentions.includes(bId), 'mention payload marks the account id');
    const parentId = msg.id;
    const editedEv = once(sb, 'chat:edited', (p) => p.id === parentId);
    ok(!(await emit(sb, 'chat:edit', { messageId: parentId, text: 'hijack' })).ok, 'reject edit of someone else');
    ok((await emit(sa, 'chat:edit', { messageId: parentId, text: '@Chat_B hello edited' })).ok, 'author can edit');
    const edited = await editedEv;
    ok(edited.text === '@Chat_B hello edited' && edited.editedAt > 0, 'edit is marked and broadcast');
    const replyEv = once(sb, 'chat:message', (m) => m.parentId === parentId);
    ok((await emit(sa, 'chat:send', { text: 'thread reply body', parentId })).ok, 'thread reply sent');
    const reply = await replyEv;
    ok(reply.text === 'thread reply body', 'reply stays attached to the parent');
    const joined = await emit(sc, 'room:join', { roomId });
    const hist = (joined.room.history || []).filter((m) => m.kind === 'chat');
    const parent = hist.find((m) => m.id === parentId);
    ok(!!parent && parent.text === '@Chat_B hello edited' && parent.editedAt > 0 && parent.replyCount >= 1, 'history keeps the edit and reply count');
    ok(!hist.some((m) => m.id === reply.id || m.text === 'thread reply body'), 'thread reply not in the top-level page');
    const thread = await emit(sc, 'chat:thread', { messageId: parentId });
    ok(thread.ok && thread.messages.some((m) => m.id === reply.id), 'thread view returns the reply');
    const goneReply = once(sb, 'chat:deleted', (p) => p.id === reply.id);
    ok((await emit(sa, 'chat:delete', { messageId: reply.id })).ok, 'author deletes own reply');
    ok((await goneReply).id === reply.id, 'own delete is broadcast');
    const threadAfter = await emit(sc, 'chat:thread', { messageId: parentId });
    ok(threadAfter.ok && !threadAfter.messages.some((m) => m.id === reply.id), 'deleted reply is gone from the thread');
    ok(!(await emit(sb, 'chat:pin', { messageId: parentId, pinned: true })).ok, 'non-owner cannot pin');
    const pinnedEv = once(sb, 'chat:pins', (p) => (p.pins || []).some((m) => m.id === parentId));
    ok((await emit(sa, 'chat:pin', { messageId: parentId, pinned: true })).ok, 'owner can pin');
    ok((await pinnedEv).pins.some((m) => m.id === parentId), 'pin list includes the message');
    const unpinned = once(sb, 'chat:pins', (p) => !(p.pins || []).some((m) => m.id === parentId));
    ok((await emit(sa, 'chat:pin', { messageId: parentId, pinned: false })).ok, 'owner can unpin');
    await unpinned;
    const goneParent = once(sb, 'chat:deleted', (p) => p.id === parentId);
    ok((await emit(sa, 'chat:delete', { messageId: parentId })).ok, 'author deletes own message');
    await goneParent;
    const sd = track(await bc.connect());
    ok((await emit(sd, 'login', {})).ok, 'C reconnects');
    const again = await emit(sd, 'room:join', { roomId });
    ok(again.ok && !(again.room.history || []).some((m) => m.id === parentId || m.id === reply.id), 'rejoin does not resurrect a deleted message');
    ok((await emit(sm, 'room:join', { roomId })).ok, 'mod joins for delete');
    const bobLine = once(sa, 'chat:message', (m) => m.kind === 'chat' && m.text === 'mod target');
    ok((await emit(sb, 'chat:send', { text: 'mod target' })).ok, 'B posts a message');
    const target = await bobLine;
    const modGone = once(sa, 'chat:deleted', (p) => p.id === target.id);
    ok((await emit(sm, 'mod:delete', { messageId: target.id })).ok, 'mod deletes someone else');
    await modGone;
    const se = track(await ba.connect());
    ok((await emit(se, 'login', {})).ok, 'A reconnects');
    const hist2 = await emit(se, 'room:join', { roomId });
    ok(hist2.ok && !(hist2.room.history || []).some((m) => m.id === target.id), 'mod-deleted message stays out of history');
  }

  // ---------- watch party (YouTube / Twitch) ----------
  {
    const require = createRequire(import.meta.url);
    const { parseWatchUrl, parseTimeParam, canControlWatch, expectedPosition } = require('../dist/server/shared/watch.js');
    const yt = parseWatchUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s');
    ok(yt && yt.provider === 'youtube' && yt.id === 'dQw4w9WgXcQ' && yt.startSec === 90, 'watch URL: youtube.com/watch?v= with t=1m30s');
    ok(parseWatchUrl('https://youtu.be/dQw4w9WgXcQ?t=42')?.startSec === 42, 'watch URL: youtu.be with t=42');
    ok(parseWatchUrl('https://youtube.com/shorts/dQw4w9WgXcQ')?.id === 'dQw4w9WgXcQ', 'watch URL: shorts');
    ok(parseWatchUrl('m.youtube.com/watch?v=dQw4w9WgXcQ')?.id === 'dQw4w9WgXcQ', 'watch URL: scheme-less m.youtube.com');
    const tl = parseWatchUrl('https://www.twitch.tv/SomeChannel');
    ok(tl && tl.provider === 'twitch' && tl.kind === 'live' && tl.id === 'somechannel', 'watch URL: twitch channel is live');
    const tv = parseWatchUrl('https://twitch.tv/videos/1234567890?t=1h2m3s');
    ok(tv && tv.kind === 'vod' && tv.id === '1234567890' && tv.startSec === 3723, 'watch URL: twitch VOD with t=1h2m3s');
    ok(parseWatchUrl('https://evil.example/watch?v=dQw4w9WgXcQ') === null, 'watch URL: other hosts rejected');
    ok(parseWatchUrl('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ') === null, 'watch URL: lookalike host rejected');
    ok(parseWatchUrl('javascript:alert(1)') === null, 'watch URL: javascript: rejected');
    ok(parseWatchUrl('https://www.youtube.com/watch?v=short') === null, 'watch URL: bad video id rejected');
    ok(parseWatchUrl('https://www.twitch.tv/directory') === null, 'watch URL: twitch site pages rejected');
    ok(parseWatchUrl('https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ') === null, 'watch URL: credentials rejected');
    ok(parseWatchUrl('x'.repeat(400)) === null, 'watch URL: too long rejected');
    ok(parseTimeParam('01:02:03') === 3723 && parseTimeParam('abc') === 0, 'watch time param formats');
    ok(canControlWatch({ locked: false, isCreator: false, isModerator: false }), 'control: anyone when unlocked');
    ok(!canControlWatch({ locked: true, isCreator: false, isModerator: false }), 'control: locked blocks regular members');
    ok(canControlWatch({ locked: true, isCreator: true, isModerator: false }) && canControlWatch({ locked: true, isCreator: false, isModerator: true }), 'control: locked allows creator and mods');
    ok(!canControlWatch({ locked: false, isCreator: true, isModerator: true, isBot: true }), 'control: bots never');
    ok(expectedPosition({ kind: 'video', playing: true, positionSec: 10, updatedAt: 1000 }, 6000) === 15, 'expected position advances while playing');
    ok(expectedPosition({ kind: 'video', playing: false, positionSec: 10, updatedAt: 1000 }, 6000) === 10, 'expected position holds while paused');

    const ownerB = browser(); await ownerB.boot();
    await register(ownerB, 'Watch_Owner', 'watch-password-1');
    const so = track(await ownerB.connect());
    ok((await emit(so, 'login', {})).ok, 'watch owner logs in');
    const created = await emit(so, 'room:create', { name: 'Watch Room', topic: 'movies' });
    ok(created.ok, 'watch room created');
    const roomId = created.roomId;
    const joined = await emit(so, 'room:join', { roomId });
    ok(joined.ok && joined.room.watch === null && joined.room.watchLocked === false && typeof joined.room.serverNow === 'number', 'join payload has empty watch state');
    ok(!('whipUrl' in joined.room) && !('rtmpUrl' in joined.room) && !('streamLabel' in joined.room), 'join payload has no stream fields');

    const guest = browser(); await guest.boot();
    await register(guest, 'WatchGuest', 'watch-guest-pass1');
    const sg = track(await guest.connect());
    ok((await emit(sg, 'login', {})).ok, 'watch guest logs in');
    ok((await emit(sg, 'room:join', { roomId })).ok, 'watch guest joins');

    const outB = browser(); await outB.boot();
    await register(outB, 'WatchOutsider', 'watch-out-pass1');
    const sx = track(await outB.connect());
    ok((await emit(sx, 'login', {})).ok, 'watch outsider logs in');
    ok(!(await emit(sx, 'watch:update', { action: 'load', url: 'https://youtu.be/dQw4w9WgXcQ' })).ok, 'outsider (not in the room) cannot load a video');

    ok(!(await emit(sg, 'watch:update', { action: 'load', url: 'https://example.com/v.mp4' })).ok, 'server rejects a non-YouTube/Twitch link');
    const seen = once(so, 'watch:state', (p) => p.action === 'load');
    ok((await emit(sg, 'watch:update', { action: 'load', url: 'https://youtu.be/dQw4w9WgXcQ?t=30' })).ok, 'member (guest) loads a YouTube link');
    const st = await seen;
    ok(st.watch.provider === 'youtube' && st.watch.id === 'dQw4w9WgXcQ' && st.watch.positionSec === 30 && st.watch.playing && st.by === 'WatchGuest', 'room sees the loaded video, start time, and who started it');
    ok((await emit(so, 'watch:update', { action: 'pause', positionSec: 41.5 })).ok, 'member pauses');
    ok(!(await emit(so, 'watch:update', { action: 'seek', positionSec: -5 })).ok, 'negative seek rejected');

    const late = browser(); await late.boot();
    await register(late, 'WatchLate', 'watch-late-pass1');
    const sl = track(await late.connect());
    ok((await emit(sl, 'login', {})).ok, 'late joiner logs in');
    const lj = await emit(sl, 'room:join', { roomId });
    ok(lj.ok && lj.room.watch?.id === 'dQw4w9WgXcQ' && lj.room.watch.playing === false && lj.room.watch.positionSec === 41.5, 'late joiner gets the watch state in the join payload');

    ok(!(await emit(sg, 'watch:lock', { locked: true })).ok, 'non-creator cannot lock playback controls');
    ok((await emit(so, 'watch:lock', { locked: true })).ok, 'creator locks playback controls');
    const blocked = await emit(sg, 'watch:update', { action: 'play', positionSec: 41.5 });
    ok(!blocked.ok && blocked.status === 403, 'locked: a regular member cannot control playback');
    const sm = track(await mod.connect());
    ok((await emit(sm, 'login', {})).user?.role === 'moderator', 'watch mod logs in');
    ok((await emit(sm, 'room:join', { roomId })).ok, 'watch mod joins');
    ok((await emit(sm, 'watch:update', { action: 'play', positionSec: 41.5 })).ok, 'locked: a moderator can control playback');
    ok((await emit(so, 'watch:update', { action: 'seek', positionSec: 100 })).ok, 'locked: the creator can control playback');
    ok((await emit(so, 'watch:lock', { locked: false })).ok, 'creator unlocks playback controls');

    let limitedHit = false;
    for (let i = 0; i < 10; i++) {
      const r = await emit(sg, 'watch:update', { action: 'seek', positionSec: 100 + i });
      if (!r.ok && r.status === 429) { limitedHit = true; break; }
    }
    ok(limitedHit, 'watch updates are rate-limited per user (~5/s)');

    const cleared = once(so, 'watch:state', (p) => p.action === 'clear');
    await sleep(1100);
    ok((await emit(sg, 'watch:update', { action: 'clear' })).ok, 'member stops the video');
    ok((await cleared).watch === null, 'room sees the video stopped');
  }

  // ---------- whispers (in-room side chats) ----------
  {
    const require = createRequire(import.meta.url);
    const { whisperAddError, WHISPER_MAX_MEMBERS } = require('../dist/server/shared/whisper.js');
    ok(WHISPER_MAX_MEMBERS === 5, 'whisper cap is 5 participants');
    ok(whisperAddError({ memberIds: ['a'], targetId: 'bot:x', targetInRoom: true }) === 'Bots cannot whisper', 'whisper rule: bots rejected');
    ok(whisperAddError({ memberIds: ['a'], targetId: 'b', targetInRoom: false }) === 'They are not in this room', 'whisper rule: non-member rejected');
    ok(whisperAddError({ memberIds: ['a', 'b', 'c', 'd', 'e'], targetId: 'f', targetInRoom: true }) === 'A whisper holds at most 5 people', 'whisper rule: sixth person rejected');
    ok(whisperAddError({ memberIds: ['a', 'b'], targetId: 'b', targetInRoom: true }) === 'Already in this whisper', 'whisper rule: duplicate rejected');
    ok(whisperAddError({ memberIds: ['a'], targetId: 'b', targetInRoom: true }) === null, 'whisper rule: room member allowed');

    const ownerB = browser(); await ownerB.boot();
    await register(ownerB, 'Whisper_Owner', 'whisper-password-1');
    const so = track(await ownerB.connect());
    ok((await emit(so, 'login', {})).ok, 'whisper owner logs in');
    const created = await emit(so, 'room:create', { name: 'Whisper Room', topic: 'psst' });
    ok(created.ok, 'whisper room created');
    const roomId = created.roomId;
    ok((await emit(so, 'room:join', { roomId })).ok, 'whisper owner joins');

    const g = [];
    for (let i = 1; i <= 6; i++) {
      const b = browser(); await b.boot();
      await register(b, `Whisp${i}`, `whisp-pass-${i}`);
      const sk = track(await b.connect());
      ok((await emit(sk, 'login', {})).ok && (await emit(sk, 'room:join', { roomId })).ok, `whisper guest ${i} joins`);
      g.push(sk);
    }
    const outB = browser(); await outB.boot();
    await register(outB, 'WhispOutsider', 'whisp-out-pass1');
    const sx = track(await outB.connect());
    ok((await emit(sx, 'login', {})).ok, 'whisper outsider logs in (not in the room)');
    const sm = track(await mod.connect());
    ok((await emit(sm, 'login', {})).user?.role === 'moderator' && (await emit(sm, 'room:join', { roomId })).ok, 'moderator joins the whisper room');

    const got = new Map();
    for (const sk of [so, ...g, sx, sm]) { got.set(sk, []); sk.on('whisper:message', (m) => got.get(sk).push(m)); }

    // non-member rejected
    const outStart = await emit(sx, 'whisper:start', { userIds: [g[0].id] });
    ok(!outStart.ok && outStart.error === 'Not in a room', 'someone not in the room cannot start a whisper');
    const toOutsider = await emit(so, 'whisper:start', { userIds: [sx.id] });
    ok(!toOutsider.ok && toOutsider.error === 'They are not in this room', 'cannot whisper someone outside the room');

    // start + participant-only delivery
    const g0Update = once(g[0], 'whisper:update');
    const started = await emit(so, 'whisper:start', { userIds: [g[0].id] });
    ok(started.ok && started.whisper.members.length === 2 && started.whisper.roomId === roomId, 'guest-friendly whisper started with one person');
    const wid = started.whisper.id;
    ok((await g0Update).whisper.id === wid, 'invited participant is told about the whisper');
    ok((await emit(g[0], 'whisper:send', { whisperId: wid, text: 'hi there badword' })).ok, 'participant (guest) sends a whisper');
    await sleep(300);
    const m1 = got.get(so).find((m) => m.whisperId === wid);
    ok(!!m1 && m1.from === 'Whisp1' && got.get(g[0]).some((m) => m.whisperId === wid), 'all participants receive the whisper');
    ok(m1 && !m1.text.includes('badword'), 'word filter applies to whispers');
    ok(got.get(g[1]).length === 0 && got.get(sm).length === 0 && got.get(sx).length === 0, 'non-participants (incl. a moderator) receive nothing');
    const peek = await emit(g[1], 'whisper:send', { whisperId: wid, text: 'let me in' });
    ok(!peek.ok && peek.error === 'Whisper not found', 'non-participant cannot post into a whisper');
    ok(!(await emit(g[1], 'whisper:add', { whisperId: wid, userId: g[1].id })).ok, 'non-participant cannot add themselves');
    ok(!(await emit(sm, 'whisper:add', { whisperId: wid, userId: sm.id })).ok, 'a moderator cannot join a whisper uninvited');

    // cap 5
    for (const k of [1, 2, 3]) ok((await emit(so, 'whisper:add', { whisperId: wid, userId: g[k].id })).ok, `participant adds guest ${k + 1}`);
    const sixth = await emit(g[0], 'whisper:add', { whisperId: wid, userId: g[4].id });
    ok(!sixth.ok && sixth.error === 'A whisper holds at most 5 people', 'a sixth participant is rejected');
    const tooBig = await emit(so, 'whisper:start', { userIds: g.slice(0, 5).map((x) => x.id) });
    ok(!tooBig.ok && tooBig.error === 'A whisper holds at most 5 people', 'starting with 6 people is rejected');

    // rate limit like chat
    await sleep(5100);
    let slowed = false;
    for (let i = 0; i < 8; i++) { const r = await emit(g[2], 'whisper:send', { whisperId: wid, text: `w${i}` }); if (!r.ok && r.error === 'Slow down') { slowed = true; break; } }
    ok(slowed, 'whispers are rate-limited like chat');

    // leave room removes the participant
    const leftEv = once(g[3], 'whisper:ended', (p) => p.whisperId === wid);
    const shrunk = once(so, 'whisper:update', (p) => p.whisper.id === wid && p.whisper.members.length === 4);
    g[3].emit('room:leave');
    ok((await leftEv).reason === 'left', 'leaving the room tells the leaver they left the whisper');
    ok(!(await shrunk).whisper.members.some((m) => m.id === g[3].id), 'others see the participant removed');
    const before = got.get(g[3]).length;
    ok((await emit(so, 'whisper:send', { whisperId: wid, text: 'after leave' })).ok, 'whisper continues with 4');
    await sleep(300);
    ok(got.get(g[3]).length === before, 'someone who left the room no longer receives the whisper');

    // ends below 2
    const pair = await emit(so, 'whisper:start', { userIds: [g[4].id] });
    ok(pair.ok, 'second two-person whisper started');
    const endedEv = once(so, 'whisper:ended', (p) => p.whisperId === pair.whisper.id);
    g[4].emit('room:leave');
    ok((await endedEv).reason === 'ended', 'a whisper ends when fewer than 2 remain');
    ok(!(await emit(so, 'whisper:send', { whisperId: pair.whisper.id, text: 'anyone?' })).ok, 'ended whisper rejects messages');

    // explicit leave
    const leaveAck = await emit(g[0], 'whisper:leave', { whisperId: wid });
    ok(leaveAck.ok, 'a participant can leave a whisper');
    ok(!(await emit(g[0], 'whisper:send', { whisperId: wid, text: 'still here?' })).ok, 'after leaving, sending is rejected');
  }

  // ---------- push-to-talk voice notes ----------
  {
    const require = createRequire(import.meta.url);
    const { sniffVoice, pickVoiceMime, fmtVoiceDuration, VOICE_MAX_BYTES } = require('../dist/server/shared/voice.js');
    const pad = (head, n = 200) => Buffer.concat([head, Buffer.alloc(n, 0x11)]);
    const WEBM = pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0x82, 0x84, ...Buffer.from('webm'), 0x42, 0x87, 0x81, 0x04]));
    const MKV = pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88, ...Buffer.from('matroska')]));
    const OGG = pad(Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2]), Buffer.alloc(22, 0), Buffer.from('OpusHead')]));
    const MP4 = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(12, 0)]));
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    ok(sniffVoice(WEBM) === 'webm' && sniffVoice(OGG) === 'ogg' && sniffVoice(MP4) === 'mp4', 'voice sniff: webm / ogg / mp4 magic bytes');
    ok(sniffVoice(MKV) === null && sniffVoice(PNG) === null && sniffVoice(Buffer.from('OggS')) === null, 'voice sniff: non-webm Matroska, PNG and truncated data rejected');
    ok(pickVoiceMime((t) => t === 'audio/mp4') === 'audio/mp4' && pickVoiceMime(() => true) === 'audio/webm;codecs=opus' && pickVoiceMime(() => false) === null, 'recorder type preference: webm/opus, then ogg, then mp4 (Safari)');
    ok(fmtVoiceDuration(7000) === '0:07' && fmtVoiceDuration(60000) === '1:00', 'voice duration format');

    const voiceUp = async (b, roomId, buf, name = 'voice.webm', type = 'audio/webm') => {
      const fd = new FormData();
      fd.append('voice', new Blob([buf], { type }), name);
      const r = await fetch(`${BASE}/api/rooms/${encodeURIComponent(roomId)}/voice`, { method: 'POST', headers: { 'cf-connecting-ip': b.ip, 'x-csrf': '1', cookie: b.cookieHeader(), 'x-device-id': b.deviceId }, body: fd });
      let json = {}; try { json = await r.json(); } catch {}
      return { status: r.status, json };
    };
    const voiceGet = (b, id) => fetch(`${BASE}/api/voice/${id}`, { headers: { 'cf-connecting-ip': b.ip, cookie: b.cookieHeader(), 'x-device-id': b.deviceId } });
    const voiceFile = (id, ext) => path.join(DATA, 'voice', `${id}.${ext}`);

    const ownerB = browser(); await ownerB.boot();
    await register(ownerB, 'Voice_Owner', 'voice-password-1');
    const so = track(await ownerB.connect());
    ok((await emit(so, 'login', {})).ok, 'voice owner logs in');
    const created = await emit(so, 'room:create', { name: 'Voice Room', topic: 'talk' });
    const roomId = created.roomId;
    ok(created.ok && (await emit(so, 'room:join', { roomId })).ok, 'voice room created and joined');

    const guest = browser(); await guest.boot();
    await register(guest, 'VoiceGuest', 'voice-guest-pass1');
    const sg = track(await guest.connect());
    ok((await emit(sg, 'login', {})).ok && (await emit(sg, 'room:join', { roomId })).ok, 'voice guest joins');
    const outB = browser(); await outB.boot();
    await register(outB, 'VoiceOutsider', 'voice-out-pass1');
    const sx = track(await outB.connect());
    ok((await emit(sx, 'login', {})).ok, 'voice outsider logs in (not in the room)');

    // format acceptance
    const upWebm = await voiceUp(guest, roomId, WEBM);
    ok(upWebm.status === 200 && upWebm.json.ok && upWebm.json.mime === 'audio/webm' && fs.existsSync(voiceFile(upWebm.json.id, 'webm')), 'guest member uploads a WebM voice note (stored under DATA_DIR/voice)');
    const upOgg = await voiceUp(ownerB, roomId, OGG, 'voice.ogg', 'audio/ogg');
    ok(upOgg.status === 200 && upOgg.json.mime === 'audio/ogg', 'Ogg voice note accepted');
    const upMp4 = await voiceUp(ownerB, roomId, MP4, 'voice.m4a', 'audio/mp4');
    ok(upMp4.status === 200 && upMp4.json.mime === 'audio/mp4' && fs.existsSync(voiceFile(upMp4.json.id, 'm4a')), 'MP4/M4A (Safari) voice note accepted');
    // rejections
    const wrong = await voiceUp(guest, roomId, PNG, 'voice.webm', 'audio/webm');
    ok(wrong.status === 400 && !wrong.json.ok, 'wrong magic bytes rejected even when labelled audio/webm');
    ok((await voiceUp(guest, roomId, MKV)).status === 400, 'Matroska without the webm DocType rejected');
    const big = await voiceUp(guest, roomId, Buffer.concat([WEBM, Buffer.alloc(VOICE_MAX_BYTES, 1)]));
    ok(big.status === 413 && /1 MB/.test(big.json.error || ''), 'voice note over 1 MB rejected');
    const outsiderUp = await voiceUp(outB, roomId, WEBM);
    ok(outsiderUp.status === 403, 'non-member upload rejected');
    ok((await voiceUp(outB, 'no-such-room', WEBM)).status === 403, 'upload to an unknown room rejected');

    // posting
    const heard = once(so, 'chat:message', (m) => !!m.voice);
    const posted = await emit(sg, 'chat:voice', { voiceId: upWebm.json.id, durationMs: 7200 });
    ok(posted.ok, 'guest posts the voice note');
    const vm = await heard;
    ok(vm.voice.id === upWebm.json.id && vm.voice.durationMs === 7200 && vm.voice.url === `/api/voice/${upWebm.json.id}` && vm.voice.mime === 'audio/webm' && vm.from === 'VoiceGuest', 'room receives a voice message with its duration');
    ok(/Voice note \(0:07\)/.test(vm.text), 'voice message carries a plain-text fallback');
    ok(!(await emit(sg, 'chat:voice', { voiceId: upWebm.json.id, durationMs: 7200 })).ok, 'a voice note can be posted only once');
    ok(!(await emit(sg, 'chat:voice', { voiceId: upOgg.json.id, durationMs: 3000 })).ok, "cannot post someone else's upload");
    ok(!(await emit(sx, 'chat:voice', { voiceId: upMp4.json.id, durationMs: 3000 })).ok, 'non-member cannot post a voice note');
    await sleep(1100);
    const short = await emit(so, 'chat:voice', { voiceId: upOgg.json.id, durationMs: 300 });
    ok(!short.ok && /short/.test(short.error), 'voice notes under 0.5 s rejected');
    const capped = once(sg, 'chat:message', (m) => m.voice?.id === upOgg.json.id);
    ok((await emit(so, 'chat:voice', { voiceId: upOgg.json.id, durationMs: 999999 })).ok, 'over-long duration accepted but clamped');
    ok((await capped).voice.durationMs === 60000, 'duration clamped to 60 s');
    ok(!(await emit(sg, 'chat:edit', { messageId: vm.id, text: 'changed' })).ok, 'voice notes cannot be edited');

    // playback is members-only, private, uncached
    const got = await voiceGet(ownerB, upWebm.json.id);
    ok(got.status === 200 && got.headers.get('content-type') === 'audio/webm' && /no-store/.test(got.headers.get('cache-control') || '') && /private/.test(got.headers.get('cache-control') || '') && got.headers.get('x-content-type-options') === 'nosniff', 'member plays the note (audio/webm, private no-store, nosniff)');
    ok(Buffer.from(await got.arrayBuffer()).equals(WEBM), 'served bytes match the upload');
    ok((await voiceGet(outB, upWebm.json.id)).status === 403, 'non-member cannot fetch a voice note');
    const joinedHistory = await emit(sx, 'room:join', { roomId });
    ok(joinedHistory.ok && joinedHistory.room.history.some((m) => m.voice?.id === upWebm.json.id), 'voice notes appear in room history for later joiners');
    sx.emit('room:leave');

    // threads
    const threadUp = await voiceUp(guest, roomId, WEBM);
    await sleep(1100);
    const reply = once(so, 'chat:message', (m) => m.voice?.id === threadUp.json.id);
    ok((await emit(sg, 'chat:voice', { voiceId: threadUp.json.id, durationMs: 2000, parentId: vm.id })).ok, 'voice note posted as a thread reply');
    ok((await reply).parentId === vm.id, 'thread voice reply carries its parent');

    // deletion removes the file
    ok(fs.existsSync(voiceFile(upWebm.json.id, 'webm')) && fs.existsSync(voiceFile(threadUp.json.id, 'webm')), 'voice files exist before delete');
    ok((await emit(sg, 'chat:delete', { messageId: vm.id })).ok, 'author deletes the voice message');
    ok(!fs.existsSync(voiceFile(upWebm.json.id, 'webm')), 'voice file deleted with its message');
    ok(!fs.existsSync(voiceFile(threadUp.json.id, 'webm')), 'thread reply voice file deleted with the parent');
    ok((await voiceGet(ownerB, upWebm.json.id)).status === 404, 'deleted voice note is no longer served');
    // purge removes files too
    ok((await emit(so, 'room:purge', { minutes: 60 })).ok, 'owner purges recent chat');
    ok(!fs.existsSync(voiceFile(upOgg.json.id, 'ogg')), 'purge removes voice files');

    // guest room removed when empty -> its voice files go too
    const gb = browser(); await gb.boot();
    await register(gb, 'VoiceHost', 'voice-host-pass1');
    const sgr = track(await gb.connect());
    ok((await emit(sgr, 'login', {})).ok, 'guest host logs in');
    const gr = await emit(sgr, 'room:create', { name: 'Voice Guest Room', topic: 'tmp' });
    ok(gr.ok && (await emit(sgr, 'room:join', { roomId: gr.roomId })).ok, 'guest creates and joins a temporary room');
    const tmpUp = await voiceUp(gb, gr.roomId, OGG, 'v.ogg', 'audio/ogg');
    ok(tmpUp.status === 200 && (await emit(sgr, 'chat:voice', { voiceId: tmpUp.json.id, durationMs: 1500 })).ok, 'voice note posted in the temporary room');
    ok((await emit(sgr, 'room:delete')).ok, 'owner deletes the temporary room');
    await sleep(300);
    ok(!fs.existsSync(voiceFile(tmpUp.json.id, 'ogg')), 'room deletion removes its voice files');
  }

  // ---------- trivia ----------
  {
    const require = createRequire(import.meta.url);
    const { triviaPoints, canPlayTrivia, TRIVIA_CATEGORIES } = require('../dist/server/shared/trivia.js');
    const { TRIVIA_QUESTIONS } = require('../dist/server/server/triviaQuestions.js');
    ok(TRIVIA_QUESTIONS.length >= 150 && TRIVIA_CATEGORIES.every((c) => TRIVIA_QUESTIONS.filter((q) => q.category === c).length >= 15), `question bank: ${TRIVIA_QUESTIONS.length} questions, every category can fill a 15-question round`);
    ok(TRIVIA_QUESTIONS.every((q) => q.options.length === 4 && new Set(q.options).size === 4), 'every question has 4 distinct options');
    ok(new Set(TRIVIA_QUESTIONS.map((q) => q.text)).size === TRIVIA_QUESTIONS.length, 'no duplicate questions');
    ok(triviaPoints(true, 15000) === 150 && triviaPoints(true, 7500) === 125 && triviaPoints(true, 0) === 100 && triviaPoints(false, 15000) === 0, 'scoring: 100 + linear speed bonus up to 50; wrong = 0');
    ok(!canPlayTrivia('bot:7') && canPlayTrivia('abc123'), 'bots cannot play trivia');

    const mk = async (name, pw) => {
      const b = browser(); await b.boot();
      await register(b, name, pw || (name.toLowerCase() + '-pass12'));
      const sk = track(await b.connect());
      ok((await emit(sk, 'login', {})).ok, `${name} logs in`);
      return { b, s: sk };
    };
    const owner = await mk('Trivia_Owner', 'trivia-owner-pass');
    const pal = await mk('Trivia_Pal', 'trivia-pal-pass');
    const g1 = await mk('TriviaGuestA');
    const g2 = await mk('TriviaGuestB');
    const out = await mk('TriviaOutsider');
    const created = await emit(owner.s, 'room:create', { name: 'Trivia Room', topic: 'quiz' });
    const roomId = created.roomId;
    for (const p of [owner, pal, g1, g2]) ok((await emit(p.s, 'room:join', { roomId })).ok, 'trivia player joins');
    const players = [owner, pal, g1, g2];

    // outsider + validation
    ok(!(await emit(out.s, 'trivia:start', { count: 5, category: 'science' })).ok, 'outsider (not in the room) cannot start trivia');
    ok(!(await emit(g1.s, 'trivia:start', { count: 7, category: 'mixed' })).ok, 'only 5/10/15 questions allowed');
    ok(!(await emit(g1.s, 'trivia:start', { count: 5, category: 'astrology' })).ok, 'unknown category rejected');

    const seen = [];
    owner.s.on('trivia:state', (st) => seen.push(st));
    const firstQ = once(pal.s, 'trivia:state', (st) => st.phase === 'question' && st.index === 0);
    const started = await emit(g1.s, 'trivia:start', { count: 5, category: 'science' });
    ok(started.ok && started.state.total === 5 && started.state.category === 'science' && started.state.phase === 'question', 'a guest starts a 5-question science round');
    const q0 = await firstQ;
    const leaks = (st) => 'reveal' in st || /"(correct|answer)"/.test(JSON.stringify(st));
    ok(!leaks(started.state) && !leaks(q0) && q0.question.options.length === 4, 'question payload carries no answer before the reveal');
    ok((await emit(owner.s, 'trivia:start', { count: 5, category: 'mixed' })).status === 409, 'only one round per room at a time');
    ok(!(await emit(out.s, 'trivia:answer', { roundId: q0.roundId, index: 0, choice: 0 })).ok, 'outsider cannot answer');

    // Q1: four players pick four different options -> exactly one is right
    const rev0 = once(owner.s, 'trivia:state', (st) => st.index === 0 && st.phase === 'reveal', 5000);
    const a0 = await emit(players[0].s, 'trivia:answer', { roundId: q0.roundId, index: 0, choice: 0 });
    ok(a0.ok && Object.keys(a0).join() === 'ok', 'answer ack does not say whether it was right');
    const dup = await emit(players[0].s, 'trivia:answer', { roundId: q0.roundId, index: 0, choice: 1 });
    ok(!dup.ok && /already/i.test(dup.error), 'one answer per player per question');
    ok(seen.every((st) => !leaks(st)) , 'no state before reveal leaks the answer');
    for (let i = 1; i < 4; i++) await emit(players[i].s, 'trivia:answer', { roundId: q0.roundId, index: 0, choice: i });
    const r0 = await rev0;
    ok(r0.reveal && r0.reveal.counts.every((c) => c === 1) && r0.reveal.correct >= 0 && r0.reveal.correct <= 3, 'everyone answered -> early reveal with the correct option and per-option counts');
    const winner0 = ['Trivia_Owner', 'Trivia_Pal', 'TriviaGuestA', 'TriviaGuestB'][r0.reveal.correct];
    const sc0 = r0.scores.find((x) => x.name === winner0);
    ok(sc0 && sc0.points >= 140 && sc0.points <= 150, `fast correct answer scores 100 + speed bonus (${sc0?.points})`);
    ok(r0.scores.filter((x) => x.name !== winner0).every((x) => x.points === 0), 'wrong answers score 0');

    // Q2: answer after ~1.5 s of a 3 s timer -> about half the bonus
    const q1 = await once(owner.s, 'trivia:state', (st) => st.index === 1 && st.phase === 'question', 5000);
    await sleep(1500);
    const rev1 = once(owner.s, 'trivia:state', (st) => st.index === 1 && st.phase === 'reveal', 5000);
    await Promise.all(players.map((p, i) => emit(p.s, 'trivia:answer', { roundId: q1.roundId, index: 1, choice: i })));
    const r1 = await rev1;
    const winner1 = ['Trivia_Owner', 'Trivia_Pal', 'TriviaGuestA', 'TriviaGuestB'][r1.reveal.correct];
    const before = r0.scores.find((x) => x.name === winner1)?.points ?? 0;
    const delta = r1.scores.find((x) => x.name === winner1).points - before;
    ok(delta >= 110 && delta <= 135, `slower correct answer earns a smaller bonus (+${delta})`);

    // stop permission (round still running)
    const gStop = await emit(g1.s, 'trivia:stop');
    ok(!gStop.ok && gStop.status === 403, 'the guest who started the round cannot stop it (creator/mods only)');
    ok(!(await emit(pal.s, 'trivia:stop')).ok, 'a regular registered member cannot stop it');

    // late joiner sees the current question with remaining time
    const q2 = await once(owner.s, 'trivia:state', (st) => st.index === 2 && st.phase === 'question', 5000);
    const late = await mk('TriviaLate');
    ok((await emit(late.s, 'room:join', { roomId })).ok, 'late joiner joins mid-round');
    const got = await emit(late.s, 'trivia:get');
    const ls = got.state;
    ok(got.ok && ls && ls.roundId === q2.roundId && ls.index === 2 && ls.phase === 'question' && ls.endsAt > ls.serverNow && !leaks(ls), 'late joiner gets the live question and time left, no answer');
    ok(got.ok && got.state?.index === 2 && got.myChoice === null, 'trivia:get returns the live round');
    late.s.emit('room:leave');
    await sleep(100);

    // play out Q3..Q5 quickly
    const ended = once(owner.s, 'trivia:ended', () => true, 15000);
    const sysLine = once(owner.s, 'chat:message', (m) => m.kind === 'system' && /^Trivia: .+ won with \d+$/.test(m.text), 15000);
    for (let idx = 2; idx < 5; idx++) {
      const st = idx === 2 ? q2 : await once(owner.s, 'trivia:state', (x) => x.index === idx && x.phase === 'question', 5000);
      await Promise.all(players.map((p, i) => emit(p.s, 'trivia:answer', { roundId: st.roundId, index: idx, choice: i })));
    }
    const end = await ended;
    ok(!end.stopped && end.winner && end.winner.points > 0 && end.state.phase === 'ended', `round ends with a winner (${end.winner?.name} ${end.winner?.points})`);
    ok(end.state.scores.length === 4 && end.state.scores[0].points >= end.state.scores[3].points, 'round leaderboard sorted, everyone listed');
    ok(!!(await sysLine), 'one compact system line posted: "Trivia: <name> won with <points>"');

    // persistence: registered players only
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(DATA, 'camchat.db'), { readOnly: true });
    const rows = db.prepare('SELECT u.username, t.points, t.rounds FROM trivia_scores t JOIN users u ON u.id = t.user_id WHERE t.room_id = ?').all(roomId);
    db.close();
    const finalBy = Object.fromEntries(end.state.scores.map((x) => [x.name, x.points]));
    ok(rows.length === 4 && rows.every((r) => r.points === finalBy[r.username] && r.rounds === 1), 'leaderboard stored for all registered players');
    const board = (await emit(pal.s, 'trivia:get')).board;
    ok(board.some((x) => x.name === 'Trivia_Owner' && !x.guest) && board.every((x) => !x.guest), 'all-time board: registered players only (live has no guest nick login)');

    // creator and mods can stop
    const r2 = await emit(pal.s, 'trivia:start', { count: 10, category: 'mixed' });
    ok(r2.ok && r2.state.total === 10, 'a registered member starts a 10-question mixed round');
    const stopped = once(g1.s, 'trivia:ended', (p) => p.stopped);
    ok((await emit(owner.s, 'trivia:stop')).ok, 'room creator stops the round');
    ok((await stopped).by === 'Trivia_Owner', 'room sees who stopped it');
    const r3 = await emit(g2.s, 'trivia:start', { count: 15, category: 'tech' });
    ok(r3.ok && r3.state.total === 15, '15-question category round starts');
    const sm = track(await mod.connect());
    ok((await emit(sm, 'login', {})).user?.role === 'moderator' && (await emit(sm, 'room:join', { roomId })).ok, 'moderator joins the trivia room');
    ok((await emit(sm, 'trivia:stop')).ok, 'a moderator can stop a round');
    const db2 = new DatabaseSync(path.join(DATA, 'camchat.db'), { readOnly: true });
    const rounds = db2.prepare('SELECT SUM(rounds) AS n FROM trivia_scores WHERE room_id = ?').get(roomId).n;
    db2.close();
    ok(rounds === 4, 'stopped rounds are not added to the leaderboard');
    // answers rate-limited
    const r4 = await emit(owner.s, 'trivia:start', { count: 5, category: 'food' });
    let limitedHit = false;
    for (let i = 0; i < 8; i++) { const r = await emit(g1.s, 'trivia:answer', { roundId: r4.state.roundId, index: 9, choice: 0 }); if (r.status === 429) { limitedHit = true; break; } }
    ok(limitedHit, 'trivia answers are rate-limited');
    ok((await emit(owner.s, 'trivia:stop')).ok, 'cleanup: stop round');
  }



  // ---------- full-screen effects ----------
  {
    const require = createRequire(import.meta.url);
    const { FX, fxSlashCommand, fxCooldown, isFxId } = require('../dist/server/shared/fx.js');
    ok(FX.length === 8 && FX.map((f) => f.id).join() === 'confetti,fireworks,balloons,hearts,rain,snow,money,matrix', '8 whitelisted effects');
    ok(fxSlashCommand('/confetti') === 'confetti' && fxSlashCommand(' /MATRIX ') === 'matrix' && fxSlashCommand('/confetti now') === null && fxSlashCommand('🎉') === null && fxSlashCommand('/nuke') === null, 'slash commands map only to whitelisted effects; emoji alone does not trigger');
    ok(fxCooldown(1000, 1000, 5000) !== null && fxCooldown(undefined, 1000, 3500) !== null && fxCooldown(undefined, 1000, 4000) === null && fxCooldown(1000, undefined, 11_000) === null, 'cooldown rule: 10 s per user, 3 s per room');
    ok(!isFxId('__proto__') && !isFxId('constructor'), 'no prototype tricks');

    const mk = async (name, pw) => {
      const b = browser(); await b.boot();
      await register(b, name, pw || (name.toLowerCase() + '-pass12'));
      const sk = track(await b.connect());
      ok((await emit(sk, 'login', {})).ok, `${name} logs in`);
      return { b, s: sk };
    };
    const a = await mk('Fx_Ann', 'fx-ann-pass12');
    const g = await mk('FxGuest');
    const out = await mk('FxOutsider');
    const room = await emit(a.s, 'room:create', { name: 'Fx Room', topic: 'party' });
    for (const p of [a, g]) ok((await emit(p.s, 'room:join', { roomId: room.roomId })).ok, 'fx member joins');
    const seenChat = []; g.s.on('chat:message', (m) => seenChat.push(m));

    ok(!(await emit(out.s, 'fx:play', { id: 'confetti' })).ok, 'outsider (not in a room) cannot play effects');
    const bad = await emit(a.s, 'fx:play', { id: 'nuke' });
    ok(!bad.ok && bad.status === 400, 'non-whitelisted effect rejected');
    ok(!(await emit(a.s, 'fx:play', { id: '<img src=x onerror=alert(1)>' })).ok, 'markup as an effect id rejected');

    const heard = once(g.s, 'fx:played', (p) => p.id === 'confetti');
    ok((await emit(a.s, 'fx:play', { id: 'confetti' })).ok, 'member plays confetti');
    const ev = await heard;
    ok(ev.by === 'Fx_Ann' && Object.keys(ev).sort().join() === 'by,id', 'room receives fx:played {id, by}');
    const again = await emit(a.s, 'fx:play', { id: 'hearts' });
    ok(!again.ok && again.status === 429 && /You can play another effect/.test(again.error), `per-user cooldown (${again.error})`);
    const roomCd = await emit(g.s, 'fx:play', { id: 'snow' });
    ok(!roomCd.ok && roomCd.status === 429 && /just played here/.test(roomCd.error), `room-wide cooldown (${roomCd.error})`);
    await sleep(3100);
    const slashHeard = once(a.s, 'fx:played', (p) => p.id === 'fireworks');
    const slash = await emit(g.s, 'chat:send', { text: '/fireworks' });
    ok(slash.ok, 'slash command /fireworks accepted after the room cooldown');
    ok((await slashHeard).by === 'FxGuest', 'slash command plays the effect');
    const stillUser = await emit(a.s, 'fx:play', { id: 'rain' });
    ok(!stillUser.ok && /You can play another effect/.test(stillUser.error), 'per-user cooldown still applies at ~3 s');
    await sleep(200);
    ok(!seenChat.some((m) => m.kind === 'chat' && /fireworks/.test(m.text)), 'slash command is not posted as chat');
    const hist = (await emit(g.s, 'room:join', { roomId: room.roomId }));
    ok(!JSON.stringify(hist).includes('/fireworks'), 'slash command is not in history');
    const sentPlain = await emit(a.s, 'chat:send', { text: '🎉' });
    ok(sentPlain.ok, 'a lone 🎉 is posted as a normal message (no auto-trigger)');
  }

  // ---------- badges ----------
  {
    const require = createRequire(import.meta.url);
    const { BADGES, crossedBadges, cleanShownBadges, shownBadges, badgeThreshold, hourIn, isNightOwlHour } = require('../dist/server/shared/badges.js');
    {
      const { TriviaRound, pickQuestions } = require('../dist/server/server/trivia.js');
      const qs = pickQuestions('mixed', 2);
      let ended = null;
      const r = new TriviaRound('t', 'mixed', qs, 60_000, 10, { state() {}, progress() {}, ended: (_r, info) => { ended = info; }, players: () => 2 });
      r.start();
      const right = (i) => qs[i].correct, wrong = (i) => (qs[i].correct + 1) % 4;
      r.answer({ key: 'u:1', name: 'A', accountId: 1 }, 0, right(0)); r.answer({ key: 'g:b', name: 'B', accountId: null }, 0, wrong(0));
      await sleep(80);
      r.answer({ key: 'u:1', name: 'A', accountId: 1 }, 1, right(1)); r.answer({ key: 'g:b', name: 'B', accountId: null }, 1, right(1));
      await sleep(80);
      const st = r.standings();
      ok(st.find((x) => x.name === 'A').correct === 2 && st.find((x) => x.name === 'B').correct === 1, 'trivia tracks correct answers per player (Sharpshooter = all correct)');
    }
    ok(BADGES.length === 12 && BADGES.every((b) => b.emoji && b.name && b.description), '12 badges with emoji, name and description');
    const chatter = BADGES.find((b) => b.id === 'chatter');
    ok(badgeThreshold(chatter) === 500 && badgeThreshold(chatter, 100) === 5, 'thresholds (and the test divisor)');
    ok(crossedBadges('messages', 499, 500).map((b) => b.id).join() === 'chatter' && crossedBadges('messages', 500, 501).length === 0, 'a threshold is crossed exactly once');
    const owned = new Set(['owl', 'host', 'early', 'pyro']);
    ok(cleanShownBadges(['owl', 'host', 'early'], owned)?.length === 3 && cleanShownBadges(['owl', 'host', 'early', 'pyro'], owned) === null, 'shown badges capped at 3');
    ok(cleanShownBadges(['brain'], owned) === null && cleanShownBadges(['owl', 'owl'], owned) === null && cleanShownBadges(['nope'], owned) === null, 'shown badges must be owned, known and unique');
    ok(shownBadges(null, ['a', 'b', 'c', 'd']).join() === 'a,b,c' && shownBadges(['d', 'x'], ['a', 'b', 'c', 'd']).join() === 'd', 'default shows the 3 most recent; a pick drops anything not owned');
    ok(hourIn(Date.UTC(2026, 0, 1, 7, 30), 'America/New_York') === 2 && isNightOwlHour(2) && !isNightOwlHour(5) && isNightOwlHour(1) && !isNightOwlHour(0), 'Night Owl window is 1–5 AM in the given zone');

    // Early Bird (+ Social / Host backfill) granted by the migration to existing accounts
    {
      const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-mig-'));
      const script = `
        const { createRequire } = require('node:module');
        const r = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))});
        const db = r('./dist/server/server/db.js');
        db.migrate(16);
        const t = Date.now();
        const ins = db.db.prepare("INSERT INTO users (username, username_lower, role, created_at) VALUES (?, ?, 'user', ?)");
        for (let i = 1; i <= 12; i++) ins.run('Old' + i, 'old' + i, t);
        const fr = db.db.prepare("INSERT INTO friendships (user_id, peer_id, status, requested_by, created_at, updated_at) VALUES (?, ?, 'accepted', ?, ?, ?)");
        for (let i = 2; i <= 11; i++) fr.run(1, i, 1, t, t);
        const rm = db.db.prepare("INSERT INTO rooms (id, name, name_lower, topic, owner_user_id, owner_nick, permanent, persistent, created_at) VALUES (?, ?, ?, '', 2, 'Old2', 0, 1, ?)");
        for (let i = 1; i <= 5; i++) rm.run('old-room-' + i, 'Old Room ' + i, 'old room ' + i, t);
        db.migrate();
        const after = db.db.prepare('SELECT user_id, badge FROM user_badges ORDER BY user_id, badge').all();
        const stats = db.db.prepare('SELECT user_id, stat, value FROM user_stats ORDER BY user_id, stat').all();
        const v = db.db.prepare('PRAGMA user_version').get().user_version;
        db.db.prepare("INSERT INTO users (username, username_lower, role, created_at) VALUES ('New1', 'new1', 'user', ?)").run(t);
        const newOne = db.db.prepare("SELECT COUNT(*) AS n FROM user_badges b JOIN users u ON u.id = b.user_id WHERE u.username = 'New1'").get().n;
        console.log(JSON.stringify({ after, stats, v, newOne }));
      `;
      const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, DATA_DIR: mdir, NODE_ENV: 'development' }, cwd: ROOT }).toString().trim().split('\n').pop());
      const has = (uid, b) => out.after.some((x) => x.user_id === uid && x.badge === b);
      ok(out.v >= 20 && [...Array(12)].every((_, i) => has(i + 1, 'early')), 'migration grants Early Bird to every existing account');
      ok(has(1, 'social') && !has(2, 'social') && out.stats.some((x) => x.user_id === 1 && x.stat === 'friends' && x.value === 10), 'migration backfills Social from existing friends (10 -> badge)');
      ok(has(2, 'host') && !has(1, 'host'), 'migration backfills Host from existing owned rooms (5 -> badge)');
      ok(out.newOne === 0, 'accounts created after the upgrade do not get Early Bird');
      fs.rmSync(mdir, { recursive: true, force: true });
    }

    // live: find a zone where it is 1–5 AM right now, and one where it is not
    const zones = []; for (let o = -12; o <= 14; o++) zones.push(o === 0 ? 'Etc/GMT' : `Etc/GMT${o > 0 ? '-' : '+'}${Math.abs(o)}`);
    const nightTz = zones.find((z) => isNightOwlHour(hourIn(Date.now() + 15_000, z)) && isNightOwlHour(hourIn(Date.now() - 1000, z)) && isNightOwlHour(hourIn(Date.now() + 60_000, z)));
    const dayTz = zones.find((z) => { const h = hourIn(Date.now(), z); return h >= 8 && h <= 20; });
    const mk = async (name, pw, tz) => {
      const b = browser(); await b.boot();
      await register(b, name, pw || (name.toLowerCase() + '-pass12'));
      const sk = track(await b.connect());
      const r = await emit(sk, 'login', { tz });
      ok(r.ok, `${name} logs in`);
      return { b, s: sk, user: r.user, earned: [], toasts: [] };
    };
    const ava = await mk('Badge_Ava', 'badge-ava-pass1', nightTz);
    const bo = await mk('Badge_Bo', 'badge-bo-pass1', dayTz);
    const gil = await mk('BadgeGuest', 'badge-guest-pass1', nightTz);
    for (const p of [ava, bo, gil]) { p.s.on('badge:earned', (x) => p.earned.push(x.id)); p.s.on('badge:toast', (x) => p.toasts.push(x)); }
    ok(ava.user.badges === undefined && gil.user.badges === undefined, 'fresh accounts have no badges in their payload');
    const stats = async (p) => (await p.b.req('/api/me/badges')).json;

    const room = await emit(ava.s, 'room:create', { name: 'Badge Room', topic: 'shiny' });
    await sleep(150);
    ok(ava.earned.includes('host'), 'creating a room counts toward Host (awarded at the test threshold)');
    const gRoom = await emit(gil.s, 'room:create', { name: 'Guest Badge Room', topic: 'x' });
    ok(gRoom.ok, 'guest creates a room');
    const roomId = room.roomId;
    for (const p of [ava, bo, gil]) ok((await emit(p.s, 'room:join', { roomId })).ok, 'badge member joins');

    // messages: Chatterbox (5 at test scale), Night Owl only inside 1–5 AM local
    const owlUpd = once(bo.s, 'user:updated', (u) => u.nick === 'Badge_Ava' && (u.badges || []).includes('owl'), 4000);
    for (let i = 0; i < 6; i++) {
      ok((await emit(ava.s, 'chat:send', { text: `badge msg ${i}` })).ok, `Ava message ${i}`);
      if (i === 0) {
        ok((await emit(bo.s, 'chat:send', { text: 'daytime msg' })).ok && (await emit(gil.s, 'chat:send', { text: 'guest msg' })).ok, 'Bo and the guest chat');
      }
      await sleep(1050);
    }
    const sa = await stats(ava);
    ok(sa.stats.messages === 6, `message counter increments per room message (${sa.stats.messages})`);
    if (nightTz) {
      ok(sa.stats.night_messages === 6 && ava.earned.includes('owl'), 'Night Owl counts messages sent 1–5 AM in the user\'s zone');
      const u = await owlUpd.catch(() => null);
      ok(!!u, 'payload update to the room includes the new shown badge');
    } else ok(true, 'no night zone found (skipped)');
    const sb = await stats(bo);
    ok(sb.stats.messages === 1 && !sb.stats.night_messages && !bo.earned.includes('owl'), 'messages outside 1–5 AM local do not count for Night Owl');
    ok(ava.earned.filter((x) => x === 'chatter').length === 1 && sa.earned.filter((x) => x.id === 'chatter').length === 1, 'Chatterbox awarded once (6 messages > threshold 5, no duplicate)');
    ok(bo.toasts.some((t) => t.nick === 'Badge_Ava' && t.id === 'chatter') && !ava.toasts.some((t) => t.nick === 'Badge_Ava'), 'room gets a light "earned" toast event; the earner gets their own toast instead');
    ok(gil.earned.includes('host'), 'registered BadgeGuest earns Host after creating a room (live has no guest nick login)');

    // burn, watch party, On Air
    ok((await emit(ava.s, 'chat:send', { text: 'burny', burnTtl: 10 })).ok, 'burn message counts');
    ok((await emit(ava.s, 'watch:update', { action: 'load', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).ok, 'watch party video started');
    ok((await emit(ava.s, 'media:state', { cam: false, mic: true, screen: false })).ok, 'Ava turns her mic on');
    await sleep(2200);
    ok((await emit(ava.s, 'media:state', { cam: false, mic: false, screen: false })).ok, 'Ava turns her mic off');
    const s2 = await stats(ava);
    ok(s2.stats.burns === 1 && ava.earned.includes('pyro'), 'Pyro counter + badge');
    ok(s2.stats.watch_starts === 1 && ava.earned.includes('movie'), 'Movie Night counter + badge');
    ok(s2.stats.onair_sec >= 2 && s2.stats.onair_sec <= 3, `On Air counts seconds with mic on (${s2.stats.onair_sec}s)`);
    ok(s2.thresholds.chatter === 5 && s2.thresholds.onair === 18, 'API returns effective thresholds for progress');
    const sAfterOff = s2.stats.onair_sec; await sleep(700);
    ok((await stats(ava)).stats.onair_sec === sAfterOff, 'On Air stops counting when the mic goes off');

    // friends -> Social for both
    ok((await emit(ava.s, 'friends:request', { username: 'Badge_Bo' })).ok, 'badge friend request');
    const pend = (await emit(bo.s, 'friends:list')).pendingIn.find((f) => f.username === 'Badge_Ava');
    ok((await emit(bo.s, 'friends:respond', { userId: pend.userId, accept: true })).ok, 'badge friend accepted');
    await sleep(150);
    ok(ava.earned.includes('social') && bo.earned.includes('social') && (await stats(bo)).stats.friends === 1, 'Social counts friends for both people');

    // shown badges: default = 3 most recent; pick up to 3 owned
    const s3 = await stats(ava);
    ok(s3.shown.length === 3 && s3.chosen === null && s3.shown.join() === s3.earned.slice(0, 3).map((e) => e.id).join(), 'default shows the 3 most recent badges');
    const tooMany = await ava.b.req('/api/me/badges', { shown: ['host', 'owl', 'chatter', 'pyro'].filter((id) => s3.earned.some((e) => e.id === id)).concat(['movie']).slice(0, 4) }, 'PATCH');
    ok(tooMany.status === 400, 'more than 3 shown badges rejected');
    ok((await ava.b.req('/api/me/badges', { shown: ['brain'] }, 'PATCH')).status === 400, 'cannot show a badge you have not earned');
    ok((await ava.b.req('/api/me/badges', { shown: ['bogus'] }, 'PATCH')).status === 400, 'unknown badge id rejected');
    ok((await gil.b.req('/api/me/badges')).status === 200, 'registered BadgeGuest can use the badges API');
    const pickUpd = once(bo.s, 'user:updated', (u) => u.nick === 'Badge_Ava' && (u.badges || []).join() === 'host,pyro', 3000);
    const pick = await ava.b.req('/api/me/badges', { shown: ['host', 'pyro'] }, 'PATCH');
    ok(pick.status === 200 && pick.json.shown.join() === 'host,pyro', 'user picks which badges to show');
    await pickUpd; ok(true, 'room sees the picked badges in the user payload');
    const joinB = await emit(gil.s, 'room:join', { roomId: gRoom.roomId });
    const back = await emit(gil.s, 'room:join', { roomId });
    const avaInList = back.room.users.find((u) => u.nick === 'Badge_Ava');
    ok(joinB.ok && avaInList && avaInList.badges.join() === 'host,pyro' && Array.isArray(back.room.users.find((u) => u.nick === 'BadgeGuest').badges), 'participant list carries shown badge ids (ids only)');
    ok(JSON.stringify(avaInList.badges).length < 30, 'badge payload is compact');
    const reset = await ava.b.req('/api/me/badges', { shown: null }, 'PATCH');
    ok(reset.status === 200 && reset.json.chosen === null && reset.json.shown.length === 3, 'can go back to most recent 3');
  }

  // ---------- burn after reading ----------
  {
    const require = createRequire(import.meta.url);
    const { burnExpired, burnRevealAllowed, isBurnTtl, BURN_HINT } = require('../dist/server/shared/burn.js');
    ok(isBurnTtl(10) && isBurnTtl(30) && isBurnTtl(60) && !isBurnTtl(15) && !isBurnTtl('10'), 'burn timers are 10/30/60 s only');
    ok(burnRevealAllowed(1000, 10_000, 10_999) && !burnRevealAllowed(1000, 10_000, 11_000), 'reveal allowed only within ttl of the first reveal');
    const views = new Map([['u:1', 5000]]);
    ok(!burnExpired({ createdAt: 0, hardMs: 600_000, ttlMs: 10_000, recipients: ['u:1', 'u:2'], views, now: 20_000 }), 'not expired while a recipient has not burned it');
    ok(burnExpired({ createdAt: 0, hardMs: 600_000, ttlMs: 10_000, recipients: ['u:1'], views, now: 15_000 }), 'expired once every recipient burned it');
    ok(burnExpired({ createdAt: 0, hardMs: 600_000, ttlMs: 10_000, recipients: [], views: new Map(), now: 600_000 }) && !burnExpired({ createdAt: 0, hardMs: 600_000, ttlMs: 10_000, recipients: [], views: new Map(), now: 599_999 }), 'hard expiry at 10 minutes (empty room: hard expiry only)');
    ok(/Screenshots are still possible/.test(BURN_HINT), 'tooltip hint says screenshots are still possible');

    const mk = async (name, pw) => {
      const b = browser(); await b.boot();
      await register(b, name, pw || (name.toLowerCase() + '-pass12'));
      const sk = track(await b.connect());
      ok((await emit(sk, 'login', {})).ok, `${name} logs in`);
      return { b, s: sk };
    };
    const ann = await mk('Burn_Ann', 'burn-ann-pass1');
    const ben = await mk('Burn_Ben', 'burn-ben-pass1');
    const gus = await mk('BurnGuest');
    const out = await mk('BurnOutsider');
    const room = await emit(ann.s, 'room:create', { name: 'Burn Room', topic: 'shh' });
    const roomId = room.roomId;
    for (const p of [ann, ben, gus]) ok((await emit(p.s, 'room:join', { roomId })).ok, 'burn member joins');
    const rejoin = async (sk) => { sk.emit('room:leave'); await sleep(150); return emit(sk, 'room:join', { roomId }); };
    const SECRET = 'secret sauce recipe 42';
    const leaks = (x) => JSON.stringify(x).includes('secret sauce');

    ok(!(await emit(ann.s, 'chat:send', { text: 'nope', burnTtl: 15 })).ok, 'invalid burn timer rejected');
    const annGot = once(ann.s, 'chat:message', (m) => m.kind === 'chat' && m.burn);
    const benGot = once(ben.s, 'chat:message', (m) => m.kind === 'chat' && m.burn);
    const gusGot = once(gus.s, 'chat:message', (m) => m.kind === 'chat' && m.burn);
    const sent = await emit(ann.s, 'chat:send', { text: SECRET, burnTtl: 10 });
    ok(sent.ok, 'burn message sent');
    const [am, bm, gm] = await Promise.all([annGot, benGot, gusGot]);
    ok(!leaks(bm) && !leaks(gm) && bm.text === '' && bm.burn.ttlSec === 10 && !bm.burn.mine, 'broadcast to others carries a placeholder, no content');
    ok(am.text === SECRET && am.burn.mine && am.burn.ttlSec === 10, 'sender sees their own message with the burn tag');
    const id = am.id;

    // history / join payload
    const late = await mk('BurnLate');
    const lateJoin = await emit(late.s, 'room:join', { roomId });
    const lateRow = lateJoin.room.history.find((m) => m.id === id);
    ok(lateJoin.ok && lateRow && lateRow.burn && lateRow.text === '' && !leaks(lateJoin), 'join payload / history has no content before reveal');
    const reJoin = await rejoin(ben.s);
    ok(reJoin.ok && !leaks(reJoin), 'recipient re-join history has no content');
    const annJoin = await rejoin(ann.s);
    ok(annJoin.ok && annJoin.room.history.find((m) => m.id === id)?.text === SECRET, 'sender history keeps the content (sender view)');

    // restrictions
    ok(!(await emit(ann.s, 'chat:edit', { messageId: id, text: 'changed' })).ok, 'burn messages cannot be edited');
    ok(!(await emit(ben.s, 'chat:react', { messageId: id, emoji: '👍' })).ok, 'reactions on burn messages are rejected');
    ok(!(await emit(ann.s, 'chat:pin', { messageId: id, pinned: true })).ok, 'pinning a burn message is rejected');
    ok(!(await emit(ben.s, 'chat:thread', { messageId: id })).ok, 'threads cannot open on burn messages');
    await sleep(1100);
    ok(!(await emit(ben.s, 'chat:send', { text: 'reply', parentId: id })).ok, 'no thread replies to burn messages');

    // reveal: members only
    ok(!(await emit(out.s, 'chat:reveal', { messageId: id })).ok, 'non-member cannot reveal');
    const other = await emit(out.s, 'room:create', { name: 'Burn Other', topic: 'x' });
    await emit(out.s, 'room:join', { roomId: other.roomId });
    const cross = await emit(out.s, 'chat:reveal', { messageId: id });
    ok(!cross.ok && !leaks(cross), 'member of another room cannot reveal');
    const r1 = await emit(ben.s, 'chat:reveal', { messageId: id });
    ok(r1.ok && r1.text === SECRET && r1.expiresAt - r1.firstAt === 1000, 'member reveals and gets the content with its timer');
    const r1b = await emit(ben.s, 'chat:reveal', { messageId: id });
    ok(r1b.ok && r1b.firstAt === r1.firstAt, 'repeat reveal within ttl keeps the first-reveal time');
    const rep = await emit(ben.s, 'report', { messageId: id, reason: 'burn test report' });
    ok(rep.ok, 'report allowed while the message is visible');
    await sleep(1100);
    const r2 = await emit(ben.s, 'chat:reveal', { messageId: id });
    ok(!r2.ok && r2.status === 410 && !leaks(r2), 'reveal refused after the ttl');
    ok(!(await emit(ben.s, 'report', { messageId: id, reason: 'again' })).ok, 'report refused once burned for that viewer');
    ok((await emit(late.s, 'chat:reveal', { messageId: id })).ok, 'a later joiner may still reveal (until hard expiry)');

    // last recipient burns it -> content deleted for everyone
    const burnedEv = once(ann.s, 'chat:burned', (p) => p.id === id, 3000);
    const r3 = await emit(gus.s, 'chat:reveal', { messageId: id });
    ok(r3.ok && r3.text === SECRET, 'guest reveals');
    await burnedEv;
    ok(true, 'all recipients burned it -> chat:burned broadcast');
    const afterJoin = await rejoin(ann.s);
    const afterRow = afterJoin.room.history.find((m) => m.id === id);
    ok(afterRow && afterRow.burn.burned && afterRow.text === '' && !leaks(afterJoin), 'history then shows Burned, even to the sender');
    const r4 = await emit(ann.s, 'chat:reveal', { messageId: id });
    ok(!r4.ok && r4.status === 410, 'nothing left to reveal after the burn');
    const reps = (await admin.req('/api/admin/reports?status=open')).json.reports;
    const snap = reps.find((x) => x.messageId === id);
    ok(snap && snap.messageText === SECRET, 'report snapshot keeps the burn content for mods');

    // hard expiry deletes content and the attached image
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('image', new Blob([png], { type: 'image/png' }), 'dot.png');
    const upR = await fetch(`${BASE}/api/rooms/${roomId}/images`, { method: 'POST', headers: { 'cf-connecting-ip': ann.b.ip, 'x-csrf': '1', cookie: ann.b.cookieHeader(), 'x-device-id': ann.b.deviceId }, body: fd });
    const up = await upR.json();
    const imgPath = path.join(DATA, 'uploads', up.url.split('/').pop());
    ok(up.ok && fs.existsSync(imgPath), 'image uploaded for a burn message');
    await sleep(1100);
    const imgMsgP = once(ann.s, 'chat:message', (m) => m.kind === 'chat' && m.burn && m.text.includes(up.url));
    const benImgP = once(ben.s, 'chat:message', (m) => m.kind === 'chat' && m.burn);
    ok((await emit(ann.s, 'chat:send', { text: `![img](${up.url})`, burnTtl: 30 })).ok, 'burn message with an image sent');
    const imgMsg = await imgMsgP;
    const benImg = await benImgP;
    ok(!JSON.stringify(benImg).includes(up.url), 'image URL is not broadcast before reveal');
    const hardEv = once(ann.s, 'chat:burned', (p) => p.id === imgMsg.id, 7000);
    await hardEv;
    ok(!fs.existsSync(imgPath) && (await fetch(BASE + up.url)).status === 404, 'hard expiry deletes the content and the image file');
    const hardJoin = await rejoin(ann.s);
    const hardRow = hardJoin.room.history.find((m) => m.id === imgMsg.id);
    ok(hardRow && hardRow.burn.burned && hardRow.text === '', 'after hard expiry history shows Burned');

    // mods can still delete
    const modB = browser(); await modB.boot();
    await register(modB, 'Burn_Mod', 'burn-mod-pass1');
    const modId = (await admin.req('/api/admin/users?q=Burn_Mod')).json.users.find((u) => u.username === 'Burn_Mod').id;
    ok((await admin.req(`/api/admin/users/${modId}/role`, { role: 'moderator' })).json.ok, 'burn mod promoted');
    const sMod = track(await modB.connect());
    ok((await emit(sMod, 'login', {})).ok && (await emit(sMod, 'room:join', { roomId })).ok, 'burn mod joins');
    await sleep(1100);
    const m3P = once(ann.s, 'chat:message', (m) => m.kind === 'chat' && m.burn && m.text === 'delete me');
    ok((await emit(ann.s, 'chat:send', { text: 'delete me', burnTtl: 60 })).ok, 'third burn message');
    const m3 = await m3P;
    const delEv = once(ben.s, 'chat:deleted', (p) => p.id === m3.id);
    ok((await emit(sMod, 'mod:delete', { messageId: m3.id })).ok, 'a mod can delete a burn message');
    await delEv;
    ok(!(await emit(ben.s, 'chat:reveal', { messageId: m3.id })).ok, 'deleted burn message cannot be revealed');
  }


  // ---------- user-owned chat bots ----------
  {
    const botReq = async (pathname, token, body, method) => {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(BASE + pathname, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      let json = {}; try { json = await r.json(); } catch {}
      return { status: r.status, json };
    };
    const guest = browser(); await guest.boot();
    const denied = await guest.req('/api/bots', { name: 'GuestBot' });
    ok(denied.status === 401, 'guest cannot create a bot');

    const owner = browser(); await owner.boot();
    const reg = await register(owner, 'Bot_Owner', 'bot-owner-password');
    ok(reg.json.ok, 'bot owner account registered');
    const made = await owner.req('/api/bots', { name: 'HelperBot' });
    const token = made.json.token;
    ok(made.status === 200 && made.json.ok && typeof token === 'string' && token.startsWith('bot_') && made.json.bot?.name === 'HelperBot', 'account owner creates a bot and is shown the token once');
    const listed = await owner.req('/api/bots');
    ok(listed.status === 200 && listed.json.bots?.some((b) => b.name === 'HelperBot' && b.revoked === false) && !JSON.stringify(listed.json).includes(token), 'account owner sees their bots and not the token');
    const me = await botReq('/api/bots/me', token);
    ok(me.status === 200 && me.json.ok && me.json.name === 'HelperBot' && me.json.owner === 'Bot_Owner' && !JSON.stringify(me.json).includes(token), 'token works for GET /api/bots/me');
    ok((await botReq('/api/bots/me', 'not-a-real-token')).status === 401, 'unknown token is rejected');
    ok(!serverLog.includes(token), 'bot token is not logged');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(DATA, 'camchat.db'), { readOnly: true });
    const row = db.prepare('SELECT token_hash FROM bots WHERE name = ?').get('HelperBot');
    db.close();
    ok(!!row && row.token_hash !== token && row.token_hash.length === 64, 'only a hash of the bot token is stored');

    const so = track(await owner.connect());
    ok((await emit(so, 'login', {})).ok, 'bot owner logs in');
    const created = await emit(so, 'room:create', { name: 'Bot Room', topic: 'bots' });
    ok(created.ok, 'bot room created');
    const rid = created.roomId;
    ok((await emit(so, 'room:join', { roomId: rid })).ok, 'owner joins the bot room');
    const earlyJoin = await botReq(`/api/bots/rooms/${rid}/join`, token, {});
    const earlyChat = await botReq(`/api/bots/rooms/${rid}/chat`, token, { text: 'too soon' });
    ok(earlyJoin.status === 403 && earlyChat.status === 403, 'post rejected until the room creator allows the bot');
    ok((await botReq(`/api/bots/rooms/${rid}/messages`, token)).status === 403, 'reading is rejected until the room creator allows the bot');

    const sm = track(await mod.connect());
    ok((await emit(sm, 'login', {})).user?.role === 'moderator', 'moderator logs in for bots');
    ok((await emit(sm, 'room:join', { roomId: rid })).ok, 'moderator joins the bot room');
    ok(!(await emit(sm, 'room:bot-allow', { name: 'HelperBot' })).ok, 'a moderator who is not the creator cannot allow a bot');

    const allowed = await emit(so, 'room:bot-allow', { name: 'HelperBot' });
    ok(allowed.ok && allowed.bot?.name === 'HelperBot', 'room creator allows the bot');
    const beforeJoin = await botReq(`/api/bots/rooms/${rid}/messages`, token);
    ok(beforeJoin.status === 200 && beforeJoin.json.messages?.length === 0 && beforeJoin.json.cursor == null, 'an allowed bot can read without joining, and an empty room has a null cursor');
    const seen = await emit(so, 'room:bots');
    ok(seen.ok && seen.bots?.some((b) => b.name === 'HelperBot') && !(await emit(sm, 'room:bots')).ok, 'room creator sees which bots are allowed; a moderator does not');

    const joinedEv = once(so, 'user:joined', (u) => u.nick === 'HelperBot');
    const joined = await botReq(`/api/bots/rooms/${rid}/join`, token, {});
    const appeared = await joinedEv;
    ok(joined.status === 200 && appeared.cam === false && appeared.mic === false && appeared.screen === false && String(appeared.id).startsWith('bot:'), 'allowed bot joins as itself with no cam, mic, or screen');
    const heard = once(so, 'chat:message', (m) => m.kind === 'chat' && m.text === 'hello from bot');
    const posted = await botReq(`/api/bots/rooms/${rid}/chat`, token, { text: 'hello from bot' });
    const msg = await heard;
    ok(posted.status === 200 && msg.from === 'HelperBot' && String(msg.fromId).startsWith('bot:') && msg.from !== 'Bot_Owner', 'allowed bot can chat as itself, not as the owner');
    const emote = await botReq(`/api/bots/rooms/${rid}/chat`, token, { text: 'wave 👋' });
    ok(emote.status === 200, 'allowed bot can send an emoji');
    const gif = await botReq(`/api/bots/rooms/${rid}/gif`, token, { id: 'fixture-1' });
    ok(gif.status === 503, 'bot GIF uses the GIF path and is unavailable when search is not configured');

    const ownerLineWait = once(so, 'chat:message', (m) => m.kind === 'chat' && m.from === 'Bot_Owner' && String(m.text).includes('b******'));
    ok((await emit(so, 'chat:send', { text: 'owner says badword' })).ok, 'owner posts a line the bot can read');
    const ownerLine = await ownerLineWait;
    const fresh = await botReq(`/api/bots/rooms/${rid}/messages`, token);
    ok(fresh.status === 200 && fresh.json.messages?.length === 0 && fresh.json.cursor === ownerLine.id, 'a fresh read returns the newest cursor and does not replay history');
    const tail = await botReq(`/api/bots/rooms/${rid}/messages?limit=2`, token);
    const tailMsgs = tail.json.messages ?? [];
    ok(tail.status === 200 && tailMsgs.length === 2 && tailMsgs[0].text === 'wave 👋' && tailMsgs[1].text === 'owner says b******' && tailMsgs[1].author === 'Bot_Owner' && tailMsgs[1].username === 'Bot_Owner' && tailMsgs[1].isBot === false && tailMsgs[1].bot === null && tail.json.cursor === ownerLine.id && !String(tailMsgs[1].text).includes('<'), 'an explicit limit returns the last lines ascending, masked, with no HTML');
    const pageTexts = ['page-a', 'page-b', 'page-c'];
    const pageWaits = pageTexts.map((text) => once(so, 'chat:message', (m) => m.kind === 'chat' && m.text === text));
    for (const text of pageTexts) ok((await emit(so, 'chat:send', { text })).ok, `owner posts ${text}`);
    const pages = [];
    for (const w of pageWaits) pages.push(await w);
    const page = await botReq(`/api/bots/rooms/${rid}/messages?after=${encodeURIComponent(fresh.json.cursor)}&limit=2`, token);
    ok(page.status === 200 && page.json.messages?.map((m) => m.text).join(',') === 'page-a,page-b' && page.json.cursor === pages[1].id, 'after plus limit pages forward in ascending order');
    ok((await emit(sm, 'mod:delete', { messageId: pages[2].id })).ok, 'mod deletes a line the bot should not see');
    const botHeard = once(so, 'chat:message', (m) => m.kind === 'chat' && m.text === 'bridge line');
    ok((await botReq(`/api/bots/rooms/${rid}/chat`, token, { text: 'bridge line' })).status === 200, 'bot posts a line it will read back');
    await botHeard;
    const next = await botReq(`/api/bots/rooms/${rid}/messages?after=${encodeURIComponent(pages[1].id)}`, token);
    const nextMsgs = next.json.messages ?? [];
    ok(next.status === 200 && nextMsgs.length === 1 && nextMsgs[0].text === 'bridge line' && nextMsgs[0].isBot === true && nextMsgs[0].bot === 'HelperBot' && nextMsgs[0].author === 'HelperBot' && nextMsgs[0].username === null && typeof nextMsgs[0].ts === 'number' && next.json.cursor === nextMsgs[0].id, 'the next page skips a deleted line and flags the bot message');
    ok((await botReq(`/api/bots/rooms/${rid}/messages?limit=101`, token)).status === 400, 'a room read limit above 100 is rejected');
    const readMade = await owner.req('/api/bots', { name: 'ReadBot' });
    const readToken = readMade.json.token;
    ok(readMade.status === 200 && (await emit(so, 'room:bot-allow', { name: 'ReadBot' })).ok, 'room creator allows a second bot for read rate limits');

    let limited = null;
    for (let i = 0; i < 6; i++) limited = await botReq(`/api/bots/rooms/${rid}/chat`, token, { text: `n${i}` });
    ok(limited.status === 429, 'bot posts are rate-limited');

    const rotated = await owner.req(`/api/bots/${made.json.bot.id}/token`, {});
    ok(rotated.json.ok && rotated.json.token && rotated.json.token !== token && !serverLog.includes(rotated.json.token), 'rotating the token shows a new one once and does not log it');
    ok((await botReq('/api/bots/me', token)).status === 401, 'the previous bot token is rejected after rotation');
    ok((await botReq('/api/bots/me', rotated.json.token)).status === 200, 'the new bot token works');

    const pal = browser(); await pal.boot();
    const palReg = await register(pal, 'Bot_Pal', 'bot-pal-password');
    ok(palReg.json.ok, 'call pal registered');
    const sp = track(await pal.connect());
    ok((await emit(sp, 'login', {})).ok, 'call pal logs in');
    ok((await emit(so, 'friends:request', { username: 'Bot_Pal' })).ok, 'owner requests the pal');
    ok((await emit(sp, 'friends:respond', { userId: reg.json.account.id, accept: true })).ok, 'pal accepts');
    const call = await emit(so, 'call:invite', { userId: palReg.json.account.id });
    ok(call.ok && call.roomId, 'private call room created');
    ok((await botReq(`/api/bots/rooms/${call.roomId}/join`, rotated.json.token, {})).status === 403, '1:1 call rooms stay closed to bots');
    ok((await botReq(`/api/bots/rooms/${call.roomId}/chat`, rotated.json.token, { text: 'nope' })).status === 403, 'a bot cannot post in a 1:1 call');
    const privateRead = await botReq(`/api/bots/rooms/${call.roomId}/messages`, readToken);
    const readStatuses = [];
    for (let i = 0; i < 8; i++) readStatuses.push((await botReq(`/api/bots/rooms/${rid}/messages?after=${encodeURIComponent(pages[1].id)}`, readToken)).status);
    const stillOpen = await botReq(`/api/bots/rooms/${rid}/messages?after=${'no-such-message'}`, rotated.json.token);
    ok(privateRead.status === 403, '1:1 call rooms stay closed to bot reads');
    ok(readStatuses.slice(0, 7).every((s) => s === 200) && readStatuses[7] === 429, 'room reads are limited per bot (8/min in tests, 120/min by default)');
    ok(stillOpen.status === 400 && stillOpen.json.error === 'Unknown cursor', 'an unknown cursor is rejected, and one bot hitting the read limit does not block another');
  }

  // ---------- one moderator bot ----------
  {
    const botReq = async (pathname, token, body, method) => {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(BASE + pathname, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      let json = {}; try { json = await r.json(); } catch {}
      return { status: r.status, json };
    };
    const owner = browser(); await owner.boot();
    ok((await register(owner, 'Mod_Bot_Owner', 'mod-bot-owner-1')).json.ok, 'moderator-bot owner registered');
    const madeMod = await owner.req('/api/bots', { name: 'ModBot' });
    const madePlain = await owner.req('/api/bots', { name: 'PlainBot' });
    const modToken = madeMod.json.token;
    const plainToken = madePlain.json.token;
    const modId = madeMod.json.bot.id;
    const plainId = madePlain.json.bot.id;
    ok(madeMod.json.ok && madePlain.json.ok && modToken && plainToken, 'two bots created for the moderator role');

    const anonSet = await browser().req('/api/admin/moderator-bot', { botId: modId });
    const userSet = await bob.req('/api/admin/moderator-bot', { botId: modId });
    const staffSet = await mod.req('/api/admin/moderator-bot', { botId: modId });
    ok(anonSet.status === 401 && userSet.status === 403 && staffSet.status === 403, 'non-admins cannot set the moderator bot');
    ok((await admin.req('/api/admin/moderator-bot')).json.botId === null, 'the role stays empty when a non-admin tries to set it');

    ok((await admin.req('/api/admin/moderator-bot', { botId: plainId })).json.botId === plainId, 'admin designates PlainBot');
    ok((await admin.req('/api/admin/moderator-bot', { botId: modId })).json.botId === modId, 'admin replaces it with ModBot');
    const listed = await admin.req('/api/admin/moderator-bot');
    ok(listed.json.botId === modId && listed.json.bots.filter((b) => b.id === modId || b.id === plainId).length === 2, 'only one bot id is stored, and the dropdown lists existing bots');

    const roomOwner = browser(); await roomOwner.boot();
    ok((await register(roomOwner, 'Mod_Room_Owner', 'mod-room-owner-1')).json.ok, 'room owner for moderator-bot test registered');
    const so = track(await roomOwner.connect());
    ok((await emit(so, 'login', {})).ok, 'room owner logs in');
    const created = await emit(so, 'room:create', { name: 'Mod Target Room', topic: 'no bots allowed' });
    const rid = created.roomId;
    ok(created.ok && rid, 'room created without allowing bots');
    ok((await emit(so, 'room:join', { roomId: rid })).ok, 'owner joins the target room');

    const victim = browser(); await victim.boot();
    ok((await register(victim, 'Mod_Victim', 'mod-victim-password')).json.ok, 'moderation target registered');
    const sv = track(await victim.connect());
    ok((await emit(sv, 'login', {})).ok && (await emit(sv, 'room:join', { roomId: rid })).ok, 'victim joins a room that has not allowed bots');
    ok((await emit(sv, 'chat:send', { text: 'mod me please' })).ok, 'victim sends a line the moderator bot should see');

    const denied = [
      ['/api/bots/moderation/kick', { roomId: rid, username: 'Mod_Victim', reason: 'nope' }],
      ['/api/bots/moderation/ban', { roomId: rid, username: 'Mod_Victim', minutes: 30, reason: 'nope' }],
      ['/api/bots/moderation/site-ban', { username: 'Mod_Victim', reason: 'nope' }],
      ['/api/bots/moderation/unban', { scope: 'room', roomId: rid, username: 'Mod_Victim' }],
      ['/api/bots/moderation/unban', { scope: 'site', username: 'Mod_Victim' }],
      ['/api/bots/moderation/mute', { roomId: rid, username: 'Mod_Victim', minutes: 5 }],
      ['/api/bots/moderation/delete', { messageId: 'nope' }],
    ];
    let plainBlocked = true;
    for (const [path, body] of denied) {
      const r = await botReq(path, plainToken, body);
      if (r.status !== 403) plainBlocked = false;
    }
    const plainRooms = await botReq('/api/bots/moderation/rooms', plainToken);
    const plainMsgs = await botReq(`/api/bots/moderation/rooms/${rid}/messages`, plainToken);
    const plainAll = await botReq('/api/bots/moderation/messages', plainToken);
    ok(plainBlocked && plainRooms.status === 403 && plainMsgs.status === 403 && plainAll.status === 403, 'a regular bot gets 403 on every moderation action');
    ok((await botReq(`/api/bots/rooms/${rid}/join`, plainToken, {})).status === 403, 'the room never allowed the regular bot');

    ok((await botReq('/api/bots/moderation/mute', modToken, { roomId: rid, username: 'Mod_Victim', minutes: 5 })).status === 403, 'the moderator bot cannot mute');
    ok((await botReq('/api/bots/moderation/delete', modToken, { messageId: 'nope' })).status === 403, 'the moderator bot cannot delete messages');
    ok((await botReq(`/api/bots/rooms/${rid}/join`, modToken, {})).status === 403, 'the moderator bot is not allowed to join just because it moderates');

    const feedRooms = await botReq('/api/bots/moderation/rooms', modToken);
    const inRoom = feedRooms.json.rooms?.find((r) => r.id === rid);
    ok(feedRooms.status === 200 && inRoom?.users?.some((u) => u.nick === 'Mod_Victim' && u.id), 'moderator bot sees the room and the victim without joining');
    const feed = await botReq(`/api/bots/moderation/rooms/${rid}/messages`, modToken);
    const line = feed.json.messages?.find((m) => m.text === 'mod me please');
    const allFeed = await botReq('/api/bots/moderation/messages', modToken);
    ok(feed.status === 200 && line?.fromId && line.nick === 'Mod_Victim' && allFeed.json.messages?.some((m) => m.id === line.id), 'moderator bot receives the chat it moderates, including the live socket id');

    const kicked = once(sv, 'room:kicked');
    const kick = await botReq('/api/bots/moderation/kick', modToken, { roomId: rid, userId: line.fromId, reason: 'spam kick' });
    const kickEv = await kicked;
    ok(kick.status === 200 && kickEv.by === 'ModBot' && kickEv.roomId === rid, 'moderator bot kicks a regular user');
    const rejoined = await emit(sv, 'room:join', { roomId: rid });
    ok(!rejoined.ok && /kicked/i.test(rejoined.error || ''), 'the kick uses the room ban, so the user cannot rejoin yet');
    ok((await botReq('/api/bots/moderation/unban', modToken, { scope: 'room', roomId: rid, username: 'Mod_Victim', reason: 'lift kick' })).status === 200, 'moderator bot lifts the room kick');
    ok((await emit(sv, 'room:join', { roomId: rid })).ok, 'victim can rejoin after the room unban');

    ok((await botReq('/api/bots/moderation/kick', modToken, { roomId: rid, username: 'Root_Admin', reason: 'no' })).status === 403, 'moderator bot cannot kick an admin');
    ok((await botReq('/api/bots/moderation/site-ban', modToken, { username: 'Root_Admin', reason: 'no' })).status === 403, 'moderator bot cannot site-ban an admin');
    ok((await botReq('/api/bots/moderation/ban', modToken, { roomId: rid, userId: `bot:${modId}`, minutes: 30, reason: 'self' })).status === 403, 'moderator bot cannot room-ban itself');
    ok((await botReq('/api/bots/moderation/kick', modToken, { roomId: rid, username: 'ModBot' })).status === 403, 'moderator bot cannot kick itself by name');
    ok((await admin.req('/api/admin/me')).json.account?.username === 'Root_Admin', 'the admin account is still signed in after the refused bans');

    const siteBanned = once(sv, 'session:ended');
    const site = await botReq('/api/bots/moderation/site-ban', modToken, { username: 'Mod_Victim', minutes: 30, reason: 'site spam' });
    const ended = await siteBanned;
    ok(site.status === 200 && /banned/i.test(ended.reason || ''), 'moderator bot site-bans a regular user and the live socket ends');
    let blocked = false;
    try { const s = await victim.connect(); s.close(); } catch { blocked = true; }
    ok(blocked, 'the site ban blocks a new connection');
    ok((await botReq('/api/bots/moderation/unban', modToken, { scope: 'site', username: 'Mod_Victim', reason: 'lift site' })).status === 200, 'moderator bot lifts the site ban');
    const sv2 = track(await victim.connect());
    ok((await emit(sv2, 'login', {})).ok && (await emit(sv2, 'room:join', { roomId: rid })).ok, 'unbanned user can connect and rejoin');

    const roomBan = await botReq('/api/bots/moderation/ban', modToken, { roomId: rid, username: 'Mod_Victim', minutes: 30, reason: 'room spam' });
    ok(roomBan.status === 200, 'moderator bot bans a regular user from the room');
    ok(!(await emit(sv2, 'room:join', { roomId: rid })).ok, 'room ban keeps the user out');

    const log = (await admin.req('/api/admin/log')).json.log;
    const kickLog = log.find((l) => l.action === 'kick' && l.actor === 'ModBot' && l.target === 'Mod_Victim');
    const roomLog = log.find((l) => l.action === 'room-ban' && l.actor === 'ModBot' && l.target === 'Mod_Victim');
    const siteLog = log.find((l) => l.action === 'ban' && l.actor === 'ModBot' && l.target === 'Mod_Victim');
    const unbanLog = log.find((l) => l.action === 'unban' && l.actor === 'ModBot' && l.target === 'Mod_Victim');
    ok(!!kickLog && kickLog.roomId === rid && /spam kick/.test(kickLog.details || '') && typeof kickLog.ts === 'number', 'kick is logged with bot, target, room, reason, and time');
    ok(!!roomLog && roomLog.roomId === rid && /room spam/.test(roomLog.details || '') && typeof roomLog.ts === 'number', 'room ban is logged with bot, target, room, reason, and time');
    ok(!!siteLog && siteLog.roomId === rid && /site spam/.test(siteLog.details || '') && typeof siteLog.ts === 'number', 'site ban is logged with bot, target, room, reason, and time');
    ok(!!unbanLog && typeof unbanLog.ts === 'number', 'unban is logged with the bot and the target');

    const cliEnv = { ...env, DATA_DIR: DATA };
    const cliOut = execFileSync(process.execPath, ['dist/server/set-moderator-bot.js', 'PlainBot'], { cwd: ROOT, env: cliEnv, encoding: 'utf8' });
    ok(/PlainBot/.test(cliOut) && (await admin.req('/api/admin/moderator-bot')).json.botId === plainId, 'CLI sets the moderator bot by name and it applies without a restart');
    ok((await botReq('/api/bots/moderation/unban', modToken, { scope: 'room', roomId: rid, username: 'Mod_Victim' })).status === 403, 'the previous moderator bot loses the role immediately');
    ok((await botReq('/api/bots/moderation/unban', plainToken, { scope: 'room', roomId: rid, username: 'Mod_Victim' })).status === 200, 'the newly designated bot can unban');
    let missing = 0;
    try { execFileSync(process.execPath, ['dist/server/set-moderator-bot.js', 'Meowington'], { cwd: ROOT, env: cliEnv, encoding: 'utf8', stdio: 'pipe' }); }
    catch (err) { missing = err.status; }
    ok(missing === 1 && (await admin.req('/api/admin/moderator-bot')).json.botId === plainId, 'CLI refuses an unknown name and leaves the current bot in place');
    execFileSync(process.execPath, ['dist/server/set-moderator-bot.js', '--clear'], { cwd: ROOT, env: cliEnv, encoding: 'utf8' });
    ok((await admin.req('/api/admin/moderator-bot')).json.botId === null, 'CLI can clear the moderator bot');
    ok((await emit(sv2, 'room:join', { roomId: rid })).ok, 'victim can rejoin after the room ban is lifted');

    const watcher = browser(); await watcher.boot();
    ok((await register(watcher, 'Mod_Watch', 'mod-watch-password')).json.ok, 'presence watcher registered');
    const sw = track(await watcher.connect());
    ok((await emit(sw, 'login', {})).ok && (await emit(sw, 'room:join', { roomId: 'lobby' })).ok, 'presence watcher sits in another room');
    ok((await admin.req('/api/admin/moderator-bot', { botId: modId })).json.botId === modId, 'presence test designates ModBot');
    await sleep(50);
    const countOf = (list, id) => list.rooms.find((r) => r.id === id)?.users;
    const beforeList = await emit(so, 'rooms:list');
    const beforeRoom = await emit(so, 'room:join', { roomId: rid });
    const beforeLobby = await emit(sw, 'room:join', { roomId: 'lobby' });
    const humans = (room) => (room?.users || []).filter((u) => !u.modBot);
    const beforePeople = humans(beforeRoom.room).length;
    const beforeLobbyPeople = humans(beforeLobby.room).length;
    const joinedHere = once(so, 'user:joined', (u) => u.modBot === true && u.nick === 'ModBot' && u.id === `bot:${modId}` && u.cam === false && u.mic === false && u.screen === false, 3000);
    const joinedThere = once(sw, 'user:joined', (u) => u.modBot === true && u.nick === 'ModBot', 3000);
    const leftHere = once(so, 'user:left', (p) => p.id === `bot:${modId}`, 4000);
    const leftThere = once(sw, 'user:left', (p) => p.id === `bot:${modId}`, 4000);
    const polled = await botReq('/api/bots/moderation/messages', modToken);
    const ghost = await joinedHere;
    const ghostThere = await joinedThere;
    ok(polled.status === 200 && ghost.modBot && ghostThere.modBot, 'moderator bot appears in every room after an authenticated API call');
    const afterList = await emit(so, 'rooms:list');
    const afterRoom = await emit(so, 'room:join', { roomId: rid });
    const afterLobby = await emit(sw, 'room:join', { roomId: 'lobby' });
    const roomUsers = afterRoom.room.users || [];
    ok(
      countOf(afterList, rid) === countOf(beforeList, rid)
      && countOf(afterList, 'lobby') === countOf(beforeList, 'lobby')
      && humans(afterRoom.room).length === beforePeople
      && humans(afterLobby.room).length === beforeLobbyPeople
      && roomUsers.some((u) => u.modBot && u.nick === 'ModBot')
      && (afterLobby.room.users || []).some((u) => u.modBot && u.nick === 'ModBot'),
      'online and per-room counts stay the same while the moderator bot is listed',
    );
    let regularAppeared = false;
    const onRegular = (u) => { if (u.modBot) regularAppeared = true; };
    so.on('user:joined', onRegular);
    sw.on('user:joined', onRegular);
    const plainMe = await botReq('/api/bots/me', plainToken);
    await sleep(200);
    so.off('user:joined', onRegular);
    sw.off('user:joined', onRegular);
    ok(plainMe.status === 200 && !regularAppeared, 'a regular bot API call never adds it to the people list');
    const [goneHere, goneThere] = await Promise.all([leftHere, leftThere]);
    const quiet = await emit(so, 'room:join', { roomId: rid });
    const quietLobby = await emit(sw, 'room:join', { roomId: 'lobby' });
    ok(
      goneHere.id === `bot:${modId}` && goneThere.id === `bot:${modId}`
      && !(quiet.room.users || []).some((u) => u.modBot)
      && !(quietLobby.room.users || []).some((u) => u.modBot),
      'moderator bot leaves every list after the presence timeout',
    );
    const resumed = once(so, 'user:joined', (u) => u.modBot === true && u.nick === 'ModBot', 3000);
    const resumedThere = once(sw, 'user:joined', (u) => u.modBot === true && u.nick === 'ModBot', 3000);
    ok((await botReq('/api/bots/me', modToken)).status === 200, 'moderator bot calls the API again');
    ok((await resumed).nick === 'ModBot' && (await resumedThere).modBot === true, 'moderator bot reappears when it resumes');
    const dropped = once(so, 'user:left', (p) => p.id === `bot:${modId}`, 3000);
    const droppedThere = once(sw, 'user:left', (p) => p.id === `bot:${modId}`, 3000);
    ok((await admin.req('/api/admin/moderator-bot', { botId: null })).json.botId === null, 'admin clears the moderator bot');
    ok((await dropped).id === `bot:${modId}` && (await droppedThere).id === `bot:${modId}`, 'clearing the moderator bot removes it from every list immediately');
    let stale = false;
    const onStale = (u) => { if (u.modBot) stale = true; };
    so.on('user:joined', onStale);
    ok((await botReq('/api/bots/me', modToken)).status === 200, 'former moderator bot can still call the API');
    await sleep(200);
    so.off('user:joined', onStale);
    const still = await emit(so, 'room:join', { roomId: rid });
    ok(!stale && !(still.room.users || []).some((u) => u.modBot), 'a regular bot never appears after the role is cleared');
  }

  // ---------- room soundboard ----------
  {
    const require = createRequire(import.meta.url);
    const { soundPlayAllowed, SOUND_COOLDOWN_MS } = require('../dist/server/server/sounds.js');
    {
      const {
        classifyRemoteTrack, decideShareAudio,
        NO_SHARE_AUDIO_NOTICE, SYSTEM_AUDIO_STRIPPED_NOTICE, WINDOW_SHARE_NO_AUDIO_NOTICE,
      } = require('../dist/server/shared/shareAudio.js');
      ok(classifyRemoteTrack('audio', ['share-1'], 'share-1') === 'shareAudio', 'share audio: track on the announced share stream is screen audio');
      ok(classifyRemoteTrack('audio', ['local-1'], 'share-1') === 'media', 'share audio: mic on the cam/mic stream stays mic');
      ok(classifyRemoteTrack('video', ['share-1'], 'share-1') === 'media', 'share audio: video is never classified as screen audio');
      ok(classifyRemoteTrack('audio', [], 'share-1') === 'media', 'share audio: stream-less audio (WHIP/RTMP relay) stays media');
      ok(classifyRemoteTrack('audio', ['share-1'], null) === 'media', 'share audio: no announced stream means media');
      ok(/Share tab audio/.test(NO_SHARE_AUDIO_NOTICE), 'share audio: tab-audio notice text');
      const mon = decideShareAudio('monitor', true);
      ok(!mon.keepAudio && mon.notice === SYSTEM_AUDIO_STRIPPED_NOTICE, 'share audio: strip entire-screen system audio');
      ok(!decideShareAudio('monitor', false).keepAudio && !decideShareAudio('monitor', false).notice, 'share audio: monitor without audio stays silent');
      const win = decideShareAudio('window', false);
      ok(!win.keepAudio && win.notice === WINDOW_SHARE_NO_AUDIO_NOTICE, 'share audio: window share explains no audio');
      const tab = decideShareAudio('browser', true);
      ok(tab.keepAudio && !tab.notice, 'share audio: Chrome tab audio is kept');
      const tabSilent = decideShareAudio('browser', false);
      ok(!tabSilent.keepAudio && tabSilent.notice === NO_SHARE_AUDIO_NOTICE, 'share audio: tab without box ticked shows notice');
    }
    ok(soundPlayAllowed(0, 5_000), 'cooldown helper allows a first play');
    ok(!soundPlayAllowed(1_000, 1_000 + SOUND_COOLDOWN_MS - 1), 'cooldown helper rejects a play inside 3 seconds');
    ok(soundPlayAllowed(1_000, 1_000 + SOUND_COOLDOWN_MS), 'cooldown helper allows a play after the window');

    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0); wav.writeUInt32LE(36, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(0, 40);

    const owner = browser(); await owner.boot();
    ok((await register(owner, 'Sound_Owner', 'sound-password-1')).json.ok, 'soundboard owner registered');
    const so = track(await owner.connect());
    ok((await emit(so, 'login', {})).ok, 'soundboard owner logs in');
    const created = await emit(so, 'room:create', { name: 'SoundRoom' });
    ok(created.ok, 'soundboard room created');
    const roomId = created.roomId;
    const joined = await emit(so, 'room:join', { roomId });
    ok(joined.ok && Array.isArray(joined.room.sounds), 'join payload includes the sound list');

    const guest = browser(); await guest.boot();
    ok((await register(guest, 'Sound_Fan', 'sound-password-3')).json.ok, 'soundboard member registers');
    const sg = track(await guest.connect());
    ok((await emit(sg, 'login', {})).ok, 'soundboard member logs in');
    ok((await emit(sg, 'room:join', { roomId })).ok, 'soundboard member joins');

    const sm = track(await mod.connect());
    ok((await emit(sm, 'login', {})).ok, 'soundboard mod logs in');
    ok((await emit(sm, 'room:join', { roomId })).ok, 'soundboard mod joins');

    const heardList = once(sg, 'room:sounds');
    const fd = new FormData();
    fd.append('name', 'Honk');
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'honk.wav');
    const up = await fetch(BASE + `/api/rooms/${roomId}/sounds`, { method: 'POST', headers: { 'cf-connecting-ip': owner.ip, 'x-csrf': '1', cookie: owner.cookieHeader() }, body: fd });
    const upj = await up.json();
    ok(up.ok && upj.sound?.name === 'Honk', 'creator can add a sound');
    const listed = await heardList;
    ok(listed.sounds.some((x) => x.id === upj.sound.id), 'members are told about the new clip');

    const modFd = new FormData();
    modFd.append('name', 'Nope');
    modFd.append('file', new Blob([wav], { type: 'audio/wav' }), 'nope.wav');
    const modUp = await fetch(BASE + `/api/rooms/${roomId}/sounds`, { method: 'POST', headers: { 'cf-connecting-ip': mod.ip, 'x-csrf': '1', cookie: mod.cookieHeader() }, body: modFd });
    ok(modUp.status === 403, 'non-creator cannot add a sound');

    const bad = new FormData();
    bad.append('name', 'Not audio');
    bad.append('file', new Blob([Buffer.from('not-audio')], { type: 'audio/mpeg' }), 'no.mp3');
    const badUp = await fetch(BASE + `/api/rooms/${roomId}/sounds`, { method: 'POST', headers: { 'cf-connecting-ip': owner.ip, 'x-csrf': '1', cookie: owner.cookieHeader() }, body: bad });
    ok(badUp.status === 400, 'bad mime is rejected');

    const big = Buffer.alloc(300 * 1024 + 8);
    wav.copy(big);
    const bigFd = new FormData();
    bigFd.append('name', 'Too big');
    bigFd.append('file', new Blob([big], { type: 'audio/wav' }), 'big.wav');
    const bigUp = await fetch(BASE + `/api/rooms/${roomId}/sounds`, { method: 'POST', headers: { 'cf-connecting-ip': owner.ip, 'x-csrf': '1', cookie: owner.cookieHeader() }, body: bigFd });
    ok(bigUp.status === 400, 'oversize sound is rejected');

    const played = once(so, 'sound:played');
    const play1 = await emit(sg, 'sound:play', { id: upj.sound.id });
    ok(play1.ok, 'a member can play');
    const ev = await played;
    ok(ev.name === 'Honk' && ev.by === 'Sound_Fan', 'the room hears who played which sound');
    const play2 = await emit(sg, 'sound:play', { id: upj.sound.id });
    ok(!play2.ok && play2.status === 429 && /3 seconds/.test(play2.error), 'a second play inside 3 seconds is rejected');
    await sleep(SOUND_COOLDOWN_MS + 100);
    ok((await emit(sg, 'sound:play', { id: upj.sound.id })).ok, 'a play after the window is allowed');

    const outsider = browser(); await outsider.boot();
    await register(outsider, 'Sound_Out', 'sound-password-2');
    const sx = track(await outsider.connect());
    ok((await emit(sx, 'login', {})).ok, 'soundboard outsider logs in');
    ok(!(await emit(sx, 'sound:play', { id: upj.sound.id })).ok, 'an outsider cannot play');
    const sneak = await outsider.req(`/api/rooms/${roomId}/sounds/${upj.sound.id}/file`);
    ok(sneak.status === 403, 'an outsider cannot fetch the file');
    const file = await fetch(BASE + `/api/rooms/${roomId}/sounds/${upj.sound.id}/file`, { headers: { 'cf-connecting-ip': guest.ip, cookie: guest.cookieHeader() } });
    ok(file.status === 200 && (file.headers.get('content-type') || '').includes('audio/wav'), 'a member can fetch the file');
    ok((file.headers.get('cache-control') || '').includes('private'), 'sound file cache is private');

    const del = await owner.req(`/api/rooms/${roomId}/sounds/${upj.sound.id}`, undefined, 'DELETE');
    ok(del.json.ok, 'creator can delete a sound');
    const left = fs.readdirSync(path.join(DATA, 'sounds')).filter((n) => n.startsWith(upj.sound.id));
    ok(left.length === 0, 'the file is removed on delete');
    const gone = await fetch(BASE + `/api/rooms/${roomId}/sounds/${upj.sound.id}/file`, { headers: { cookie: guest.cookieHeader(), 'cf-connecting-ip': guest.ip } });
    ok(gone.status === 404, 'deleted sound file is not served');
  }

  // ---------- public downloads ----------
  {
    const dir = path.join(DATA, 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    const { compareVersions, decideUpdate } = createRequire(import.meta.url)(path.join(ROOT, 'dist/server/shared/updates.js'));
    ok(compareVersions('1.1.0', '1.2.0') < 0 && compareVersions('1.2.0', '1.2.0') === 0, '1.1.0 is older than 1.2.0');
    ok(decideUpdate({ current: '1.1.0', latest: '1.2.0', minVersion: '1.1.0', canApply: true }) === 'install', 'android 1.1.0 can install 1.2.0');
    ok(decideUpdate({ current: '1.2.0', latest: '1.3.0', minVersion: '1.2.0', canApply: true }) === 'install', 'installed windows app can apply a newer build');
    ok(decideUpdate({ current: '1.1.0', latest: '1.2.0', minVersion: '1.2.0', canApply: false }) === 'manual', 'portable zip cannot update itself');
    ok(decideUpdate({ current: '1.0.0', latest: '1.2.0', minVersion: '1.1.0', canApply: true }) === 'manual', 'below the minimum needs a manual install');
    ok(decideUpdate({ current: '1.2.0', latest: '1.2.1', minVersion: '1.2.0', canApply: true }) === 'install', 'windows 1.2.0 installs 1.2.1');
    ok(decideUpdate({ current: '1.2.0', latest: '1.2.1', minVersion: '1.1.0', canApply: true }) === 'install', 'android 1.2.0 installs 1.2.1');
    const apkBody = Buffer.from('fake-apk');
    fs.writeFileSync(path.join(dir, 'zeronoise-1.2.1.apk'), apkBody);
    const apkHash = createHash('sha256').update(apkBody).digest('hex');
    const win = await fetch(BASE + '/download', { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    const winHtml = await win.text();
    ok(win.status === 200 && (win.headers.get('content-type') || '').includes('text/html'), 'download page is html');
    ok(win.headers.get('cache-control') === 'no-store', 'download page is not cached');
    ok(winHtml.includes('data-device="windows"'), 'windows visitor is detected');
    ok(winHtml.includes('data-os="windows" class="card you"'), 'windows card is highlighted');
    ok(!winHtml.includes('data-os="android" class="card you"'), 'android card is not highlighted for windows');
    ok(winHtml.includes('Coming soon'), 'ios is marked coming soon');
    ok(winHtml.includes('Not on this server yet.'), 'missing windows installer is explained');
    ok(winHtml.includes(apkHash), 'android sha256 is shown');
    ok(winHtml.includes('Version 1.2.1'), 'version is shown');
    ok(winHtml.includes('uninstall zeronoise'), 'android steps mention a signature mismatch');
    ok(!/debug/i.test(winHtml), 'download page does not say debug');
    const manifest = await fetch(BASE + '/api/updates');
    const manifestJson = await manifest.json();
    ok(manifest.status === 200 && manifest.headers.get('cache-control') === 'no-store', 'update manifest is not cached');
    ok(manifestJson.android && manifestJson.android.version === '1.2.1' && manifestJson.android.sha256 === apkHash, 'manifest android version and sha256');
    ok(manifestJson.android.url.endsWith('/download/zeronoise-1.2.1.apk'), 'manifest android url');
    ok(manifestJson.windows === null, 'manifest omits a missing windows installer');
    ok(manifestJson.ios && manifestJson.ios.comingSoon === true, 'manifest ios is not downloadable yet');
    const ymlMissing = await fetch(BASE + '/api/updates/win/latest.yml');
    ok(ymlMissing.status === 404 && ymlMissing.headers.get('cache-control') === 'no-store', 'latest.yml is absent until the installer exists');
    const apk = await fetch(BASE + '/download/zeronoise-1.2.1.apk');
    const apkDisp = apk.headers.get('content-disposition') || '';
    ok(apk.status === 200 && Buffer.from(await apk.arrayBuffer()).equals(apkBody), 'apk bytes are served whole');
    ok((apk.headers.get('content-type') || '').startsWith('application/vnd.android.package-archive'), 'apk content type');
    ok(apkDisp.includes('attachment') && apkDisp.includes('filename="zeronoise-1.2.1.apk"'), 'apk content disposition');
    const absent = await fetch(BASE + '/download/zeronoise-1.2.1-setup.exe');
    ok(absent.status === 404, 'missing windows installer is 404');
    const unknown = await fetch(BASE + '/download/package.json');
    ok(unknown.status === 404, 'unknown download name is 404');
    const exeBody = Buffer.from('fake-exe');
    fs.writeFileSync(path.join(dir, 'zeronoise-1.2.1-setup.exe'), exeBody);
    const exeSha512 = createHash('sha512').update(exeBody).digest('base64');
    const yml = await fetch(BASE + '/api/updates/win/latest.yml');
    const ymlText = await yml.text();
    ok(yml.status === 200 && yml.headers.get('cache-control') === 'no-store', 'latest.yml is not cached');
    ok(ymlText.includes('version: 1.2.1') && ymlText.includes(exeSha512), 'latest.yml has version and sha512');
    const withExe = await (await fetch(BASE + '/api/updates')).json();
    ok(withExe.windows && withExe.windows.sha512 === exeSha512 && withExe.windows.version === '1.2.1', 'manifest windows matches the installer');
    fs.writeFileSync(path.join(dir, 'zeronoise-1.2.1-win.zip'), Buffer.from('fake-zip'));
    const zip = await fetch(BASE + '/download/zeronoise-1.2.1-win.zip');
    const zipDisp = zip.headers.get('content-disposition') || '';
    ok(zip.status === 200 && Buffer.from(await zip.arrayBuffer()).toString() === 'fake-zip', 'windows zip bytes are served whole');
    ok((zip.headers.get('content-type') || '').startsWith('application/zip'), 'zip content type');
    ok(zipDisp.includes('attachment') && zipDisp.includes('filename="zeronoise-1.2.1-win.zip"'), 'zip content disposition');
    const phone = await fetch(BASE + '/download', { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' } });
    const phoneHtml = await phone.text();
    ok(phoneHtml.includes('data-device="ios"') && phoneHtml.includes('data-os="ios" class="card you"'), 'iphone visitor is highlighted');
    const android = await fetch(BASE + '/download', { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' } });
    ok((await android.text()).includes('data-os="android" class="card you"'), 'android visitor is highlighted');
    const slash = await fetch(BASE + '/download/');
    ok(slash.status === 200 && (await slash.text()).includes('Get the app'), 'trailing slash still shows the download page');
  }

  // ---------- reconnect grace ----------
  {
    const ba = browser(); await ba.boot();
    await register(ba, 'Grace_A', 'grace-password-1');
    const bb = browser(); await bb.boot();
    await register(bb, 'Grace_B', 'grace-password-1');
    const sa = track(await ba.connect());
    const sb = track(await bb.connect());
    ok((await emit(sa, 'login', {})).ok, 'grace A logs in');
    ok((await emit(sb, 'login', {})).ok, 'grace B logs in');
    const created = await emit(sa, 'room:create', { name: 'GraceRoom', topic: 'blip' });
    ok(created.ok, 'grace room created');
    const roomId = created.roomId;
    ok((await emit(sa, 'room:join', { roomId })).ok, 'grace A joins');
    ok((await emit(sb, 'room:join', { roomId })).ok, 'grace B joins');
    const oldId = sa.id;
    let leftEarly = false;
    sb.on('user:left', (p) => { if (p.id === oldId) leftEarly = true; });
    const moved = once(sb, 'user:moved', (p) => p.from === oldId, 4000);
    sa.disconnect();
    await sleep(400);
    ok(!leftEarly, 'grace: peer stays for a short disconnect');
    const sa2 = track(await ba.connect());
    const login = await emit(sa2, 'login', { resume: true });
    ok(login.ok && login.user.id === sa2.id, 'grace A resumes');
    const mv = await moved;
    ok(mv.to === sa2.id && mv.user.id === sa2.id && mv.user.nick === 'Grace_A', 'grace: peer is told the new socket id');
    const again = await emit(sa2, 'room:join', { roomId });
    ok(again.ok && again.resumed === true, 'grace: rejoin is a resume');
    ok(!leftEarly, 'grace: no leave during resume');
    const ids = (again.room.users || []).map((u) => u.id);
    ok(ids.includes(sa2.id) && !ids.includes(oldId), 'grace: room lists the new id only');
    const parkedId = sa2.id;
    sa2.disconnect();
    const gone = await once(sb, 'user:left', (p) => p.id === parkedId, 5000);
    ok(gone.id === parkedId, 'grace: seat expires after the grace window');
  }

  // ---------- email gate on, and SMTP dialogue ----------
  {
    const portG = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
    const dataG = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-gate-'));
    const mailG = path.join(dataG, 'mail.log');
    const envG = { ...env, PORT: String(portG), DATA_DIR: dataG, EMAIL_VERIFY_REQUIRED: '1', MAIL_CAPTURE_PATH: mailG, ADMIN_USERNAMES: 'Gate_Admin' };
    const child = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, env: envG, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const baseG = `http://127.0.0.1:${portG}`;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      if (log.includes('listening')) break;
      if (child.exitCode !== null) throw new Error('gate server died: ' + log);
    }
    const health = await fetch(baseG + '/api/health').then((r) => r.json());
    ok(health.ok === true && health.mail === true && health.emailVerifyRequired === true && !JSON.stringify(health).includes('RESEND_API_KEY'), 'gate-on health reports mail without secrets');
    let ipn = 20;
    function gbrowser(ip = `203.0.113.${ipn++}`) {
      const jar = new Map();
      const b = {
        ip, jar,
        cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        async req(pathname, body) {
          const headers = { 'cf-connecting-ip': b.ip, 'x-csrf': '1', cookie: b.cookieHeader() };
          if (body !== undefined) headers['content-type'] = 'application/json';
          const r = await fetch(baseG + pathname, { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
          for (const c of r.headers.getSetCookie()) {
            const [kv] = c.split(';'); const i = kv.indexOf('=');
            const k = kv.slice(0, i);
            if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, kv.slice(i + 1));
          }
          let json = null; try { json = await r.json(); } catch { json = {}; }
          return { status: r.status, json: json ?? {} };
        },
        connect() {
          return new Promise((res, rej) => {
            const s = io(baseG, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: b.cookieHeader(), 'cf-connecting-ip': b.ip } });
            s.once('connect', () => res(s));
            s.once('connect_error', (e) => { s.close(); rej(e); });
          });
        },
      };
      return b;
    }
    async function greg(b, username, password = 'password123') {
      const cap = await b.req('/api/auth/captcha');
      const m = /What is (\d+) \+ (\d+)/.exec(cap.json.question || '');
      return b.req('/api/auth/register', { username, password, email: `${username.toLowerCase()}@example.com`, captchaId: cap.json.id, captchaAnswer: String(+m[1] + +m[2]) });
    }
    const user = gbrowser();
    ok((await greg(user, 'Gate_User')).json.ok, 'gate user registers');
    const su = await user.connect();
    ok((await emit(su, 'login', {})).ok, 'gate user logs in');
    const denied = await emit(su, 'room:join', { roomId: 'lobby' });
    ok(!denied.ok && /confirm your email/i.test(denied.error || ''), 'unverified non-admin is blocked when the gate is on');
    const adm = gbrowser();
    ok((await greg(adm, 'Gate_Admin')).json.account.role === 'admin', 'gate admin registers');
    const sa = await adm.connect();
    ok((await emit(sa, 'login', {})).ok, 'gate admin logs in');
    ok((await emit(sa, 'room:join', { roomId: 'lobby' })).ok, 'admin enters a room while unverified');
    execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.prepare('UPDATE users SET email = NULL, email_lower = NULL, email_verified_at = NULL WHERE username = ?').run('Gate_Admin');
    `, path.join(dataG, 'camchat.db')], { stdio: 'ignore' });
    ok((await emit(sa, 'room:join', { roomId: 'lobby' })).ok, 'admin with no email is still not blocked');
    const mails = fs.readFileSync(mailG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const mine = mails.filter((m) => m.to === 'gate_user@example.com').at(-1);
    const six = /code: (\d{6})/.exec(mine.text)[1];
    ok((await user.req('/api/auth/verify-email', { code: six })).json.account.emailVerified === true, 'gate user confirms with the code');
    ok((await emit(su, 'room:join', { roomId: 'lobby' })).ok, 'confirmed user can enter a room');
    su.close(); sa.close();
    child.kill('SIGTERM');
    await sleep(200);
    fs.rmSync(dataG, { recursive: true, force: true });
  }
  {
    const smtpPort = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const lines = [];
    const smtp = net.createServer((sock) => {
      sock.write('220 test ESMTP\r\n');
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line) continue;
          lines.push(line);
          if (/^EHLO/i.test(line)) sock.write('250-test\r\n250-STARTTLS\r\n250 HELP\r\n');
          else if (/^STARTTLS/i.test(line)) sock.write('220 Ready\r\n');
          else sock.write('250 OK\r\n');
        }
      });
    });
    await new Promise((r) => smtp.listen(smtpPort, '127.0.0.1', r));
    const child = spawn(process.execPath, ['-e', `
      delete process.env.MAIL_CAPTURE_PATH;
      delete process.env.RESEND_API_KEY;
      delete process.env.MAIL_FROM;
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = process.argv[1];
      process.env.SMTP_FROM = 'zeronoise <no-reply@mail.example.com>';
      process.env.SMTP_USER = 'mailer';
      process.env.SMTP_PASS = 'smtp-secret';
      process.env.DATA_DIR = process.argv[2];
      const { sendMail } = require(process.argv[3]);
      sendMail('person@example.com', 'Hi', 'hello').then((ok) => { console.log(ok ? 'SENT' : 'FAIL'); process.exit(0); })
        .catch(() => { console.log('FAIL'); process.exit(0); });
    `, String(smtpPort), fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-smtp-')), path.join(ROOT, 'dist/server/server/mail.js')], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    await new Promise((r) => child.once('exit', r));
    smtp.close();
    const starttlsAt = lines.findIndex((l) => l.toUpperCase() === 'STARTTLS');
    const ehloAt = lines.findIndex((l) => /^EHLO/i.test(l));
    const authAt = lines.findIndex((l) => l.toUpperCase() === 'AUTH LOGIN');
    ok(/FAIL/.test(out) && ehloAt >= 0 && starttlsAt > ehloAt && (authAt < 0 || authAt > starttlsAt), 'SMTP on 587 sends STARTTLS before AUTH');
    ok(!out.includes('smtp-secret'), 'SMTP failure log does not include the password');
  }
  {
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-tls-'));
    const cert = path.join(certDir, 'cert.pem');
    const key = path.join(certDir, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    const seen = { auth: false, data: '', from: '' };
    const tlsServer = tls.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (sock) => {
      sock.on('error', () => {});
      sock.write('220 tls ESMTP\r\n');
      let buf = '';
      let dataMode = false;
      const reply = (line) => {
        if (dataMode) {
          seen.data += line + '\n';
          if (line === '.') { dataMode = false; sock.write('250 OK\r\n'); }
          return;
        }
        if (/^EHLO/i.test(line)) sock.write('250 tls\r\n');
        else if (line.toUpperCase() === 'AUTH LOGIN') { seen.auth = true; seen.authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (seen.authStep === 1) { seen.authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (seen.authStep === 2) { seen.authStep = 0; sock.write('235 OK\r\n'); }
        else if (line.startsWith('MAIL FROM:')) { seen.from = line; sock.write('250 OK\r\n'); }
        else if (line.toUpperCase() === 'DATA') { dataMode = true; sock.write('354 Go\r\n'); }
        else if (line.toUpperCase() === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      };
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          reply(line);
        }
      });
    });
    tlsServer.on('error', () => {});
    await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
    const tlsPort = tlsServer.address().port;
    const child = spawn(process.execPath, ['-e', `
      delete process.env.MAIL_CAPTURE_PATH;
      delete process.env.RESEND_API_KEY;
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = process.argv[1];
      process.env.SMTP_IMPLICIT_TLS = '1';
      process.env.SMTP_FROM = 'zeronoise <no-reply@mail.example.com>';
      process.env.SMTP_USER = 'mailer';
      process.env.SMTP_PASS = 'smtp-secret';
      process.env.DATA_DIR = process.argv[2];
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      const { sendMail } = require(process.argv[3]);
      sendMail('person@example.com', 'Hi there', 'hello from zeronoise').then((ok) => { console.log(ok ? 'SENT' : 'FAIL'); process.exit(ok ? 0 : 1); })
        .catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
    `, String(tlsPort), fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-smtp465-')), path.join(ROOT, 'dist/server/server/mail.js')], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, NODE_ENV: 'production', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    await new Promise((r) => child.once('exit', r));
    tlsServer.close();
    ok(/SENT/.test(out) && seen.auth && seen.from.includes('<no-reply@mail.example.com>') && seen.data.includes('hello from zeronoise') && seen.data.includes('zeronoise') && seen.data.includes('text/html'), 'SMTP on 465 uses implicit TLS and sends text plus HTML');
    ok(!out.includes('smtp-secret'), 'implicit TLS send does not log the password');
    fs.rmSync(certDir, { recursive: true, force: true });
  }

  // =====================================================================
  // batch 2: search + bookmarks, events, room roles, web push, link previews, polls, profiles
  // =====================================================================
  {
    fixPng = await createRequire(path.join(ROOT, 'package.json'))('sharp')({ create: { width: 800, height: 400, channels: 3, background: '#3366cc' } }).png().toBuffer();
    const dbFile = path.join(DATA, 'camchat.db');
    const dbq = (sql, ...params) => JSON.parse(execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 3000');
      const st = db.prepare(process.argv[2]);
      const params = JSON.parse(process.argv[3]);
      console.log(JSON.stringify(/^\\s*select/i.test(process.argv[2]) ? st.all(...params) : st.run(...params)));
    `, dbFile, sql, JSON.stringify(params)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    const mk = async (name) => {
      const b = browser(); await b.boot();
      const reg = await register(b, name, `${name.toLowerCase()}-pass-99`);
      const s = track(await b.connect());
      ok((await emit(s, 'login', {})).ok, `${name} logs in`);
      return { b, s, name, id: reg.json.account?.id ?? (await b.req('/api/me')).json.account.id };
    };
    const joinAll = async (roomId, ...ps) => { for (const p of ps) ok((await emit(p.s, 'room:join', { roomId })).ok, `${p.name} joins`); };
    const say = async (p, text, extra = {}) => {
      const got = once(p.s, 'chat:message', (m) => m.fromId === p.s.id && (extra.burnTtl ? true : m.text === text), 3000);
      const r = await emit(p.s, 'chat:send', { text, ...extra });
      if (!r.ok) { got.catch(() => {}); return { error: r.error }; }
      return got;
    };
    const paced = async (fn) => { await sleep(1100); return fn(); };

    // ---------- 3. search + bookmarks ----------
    {
      const a = await mk('Find_Alice');
      const c = await mk('Find_Carol');
      const out = await mk('Find_Out');
      const room = (await emit(a.s, 'room:create', { name: 'Search Room', topic: 's' })).roomId;
      await joinAll(room, a, c);
      const outRoom = (await emit(out.s, 'room:create', { name: 'Elsewhere', topic: 'x' })).roomId;
      await joinAll(outRoom, out);
      const m1 = await say(a, 'the quick brown fox');
      const m2 = await say(a, 'lazy dog jumps over');
      const mb = await say(a, 'secret fox burn', { burnTtl: 10 });
      const md = await say(a, 'fox to be deleted');
      const reply = await paced(() => say(c, 'a reply about the fox', { parentId: m1.id }));
      await emit(a.s, 'chat:delete', { messageId: md.id });
      await say(out, 'fox in another room');
      // 24 more lines straight into SQLite (the per-socket rate limit makes sending them slow)
      const base = Date.now() - 60_000;
      for (let i = 0; i < 24; i++) dbq('INSERT INTO messages (id, room_id, ts, user_id, nick, role, text) VALUES (?,?,?,?,?,?,?)', `pg-${i}`, room, base + i, a.id, a.name, 'user', `pagetest line ${i}`);
      const r1 = await emit(a.s, 'chat:search', { q: 'fox' });
      const texts = (r1.hits || []).map((h) => h.message.text);
      ok(r1.ok && texts.includes('the quick brown fox') && texts.includes('a reply about the fox'), 'search finds matching lines in the room');
      ok(!texts.some((t) => /secret|burn/.test(t)) && !texts.includes('fox to be deleted') && !texts.includes('fox in another room'), 'search excludes burn, deleted and other rooms\' lines');
      ok(r1.hits.find((h) => h.message.text === 'a reply about the fox')?.threadId === m1.id, 'a reply hit carries its thread id');
      ok((await emit(a.s, 'chat:search', { q: 'qui' })).hits?.[0]?.message.id === m1.id, 'prefix match ("qui" finds "quick")');
      ok((await emit(a.s, 'chat:search', { q: 'brown fox' })).hits?.length === 1, 'all words must match');
      const p1 = await emit(c.s, 'chat:search', { q: 'pagetest' });
      ok(p1.ok && p1.hits.length === 20 && p1.hasMore === true && p1.offset === 20, 'search pages 20 at a time');
      const p2 = await emit(c.s, 'chat:search', { q: 'pagetest', offset: p1.offset });
      ok(p2.ok && p2.hits.length === 4 && p2.hasMore === false && !p2.hits.some((h) => p1.hits.some((x) => x.message.id === h.message.id)), 'second page has the rest, no repeats');
      ok(p1.hits[0].message.ts >= p1.hits[19].message.ts, 'newest hits first');
      ok((await emit(out.s, 'chat:search', { q: 'quick' })).hits?.length === 0, 'someone in another room cannot search this room');
      ok((await emit(a.s, 'chat:search', { q: 'f' })).status === 400, 'one-letter query rejected');
      ok((await emit(a.s, 'chat:search', { q: '"); DROP TABLE messages; --' })).ok, 'odd characters are safe');
      const loneB = browser(); await loneB.boot();
      const lone = track(await loneB.connect());
      ok(!(await emit(lone, 'chat:search', { q: 'fox' })).ok, 'a signed-out socket cannot search');
      lone.close();
      // edits and deletes keep the index right
      ok((await emit(a.s, 'chat:edit', { messageId: m2.id, text: 'lazy cat sleeps' })).ok, 'edit a line');
      ok((await emit(a.s, 'chat:search', { q: 'dog' })).hits.length === 0 && (await emit(a.s, 'chat:search', { q: 'cat' })).hits.length === 1, 'search follows edits');
      // context around a hit
      const ctx = await emit(c.s, 'chat:context', { messageId: 'pg-3' });
      ok(ctx.ok && ctx.anchorId === 'pg-3' && ctx.messages.some((m) => m.id === 'pg-3') && ctx.messages.some((m) => m.id === 'pg-0') && ctx.messages.some((m) => m.id === 'pg-10'), 'jump: context around a hit is loaded');
      const ctxR = await emit(c.s, 'chat:context', { messageId: reply.id });
      ok(ctxR.ok && ctxR.anchorId === m1.id && ctxR.threadId === m1.id, 'jump to a reply opens its thread');
      ok((await emit(c.s, 'chat:context', { messageId: mb.id })).status === 404 && (await emit(out.s, 'chat:context', { messageId: m1.id })).status === 404, 'no context for burn lines or other rooms');
      // LIKE fallback (no FTS5) gives the same answers
      const likeOut = execFileSync(process.execPath, ['-e', `
        const db = require('./dist/server/server/db.js');
        db.migrate();
        const repo2 = require('./dist/server/server/repo2.js');
        db.db.exec('PRAGMA foreign_keys = OFF');
        const ins = db.db.prepare('INSERT INTO messages (id, room_id, ts, nick, role, text, burn_ttl, deleted) VALUES (?,?,?,?,?,?,?,?)');
        ins.run('l1', 'lr', 1, 'x', 'user', 'The Quick brown fox', null, 0);
        ins.run('l2', 'lr', 2, 'x', 'user', 'fox burn', 10, 0);
        ins.run('l3', 'lr', 3, 'x', 'user', 'fox gone', null, 1);
        ins.run('l4', 'lr', 4, 'x', 'user', '100% fox_y', null, 0);
        const ids = (q) => repo2.searchRoomMessages('lr', repo2.searchTokens(q), 0, 20).rows.map((r) => r.id).join(',');
        console.log(JSON.stringify({ fts: db.ftsAvailable, fox: ids('fox'), qui: ids('qui'), pct: ids('100%'), none: ids('zebra') }));
      `], { cwd: ROOT, env: { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-like-')), SEARCH_DISABLE_FTS: '1', NODE_ENV: 'development' } }).toString().trim().split('\n').at(-1);
      const like = JSON.parse(likeOut);
      ok(like.fts === false && like.fox === 'l4,l1' && like.qui === 'l1' && like.pct === 'l4' && like.none === '', `LIKE fallback search works without FTS5 (${likeOut})`);
      ok(dbq("SELECT name FROM sqlite_master WHERE name = 'messages_room_ts'").length === 1, 'LIKE fallback is backed by the (room_id, ts) index');

      // bookmarks
      const b1 = await emit(c.s, 'bookmark:toggle', { messageId: m1.id });
      ok(b1.ok && b1.bookmarked === true, 'bookmark a message');
      ok((await emit(c.s, 'bookmark:toggle', { messageId: 'pg-5', on: true })).bookmarked === true, 'bookmark another');
      ok((await emit(c.s, 'bookmark:toggle', { messageId: mb.id })).status === 404, 'burn messages cannot be bookmarked');
      ok((await emit(out.s, 'bookmark:toggle', { messageId: m1.id })).status === 404, 'cannot bookmark a line in a room you are not in');
      let bl = await emit(c.s, 'bookmark:list');
      ok(bl.ok && bl.bookmarks.length === 2 && bl.ids.includes(m1.id) && bl.bookmarks[0].roomName === 'Search Room', 'bookmarks panel lists saved lines with their room');
      ok((await emit(a.s, 'bookmark:list')).bookmarks.length === 0, 'bookmarks are private per user');
      await dbq("UPDATE messages SET deleted = 1 WHERE id = 'pg-5'");
      bl = await emit(c.s, 'bookmark:list');
      ok(bl.bookmarks.length === 1 && bl.ids[0] === m1.id, 'deleted messages drop out of bookmarks');
      ok((await emit(c.s, 'bookmark:toggle', { messageId: m1.id })).bookmarked === false && (await emit(c.s, 'bookmark:list')).bookmarks.length === 0, 'toggle again removes the bookmark');
      for (const p of [a, c, out]) p.s.close();
    }

    // ---------- 4. scheduled events + RSVPs ----------
    {
      const own = await mk('Ev_Owner');
      const mem = await mk('Ev_Member');
      const out = await mk('Ev_Out');
      const rem = new Map();
      for (const p of [own, mem, out]) { rem.set(p, []); p.s.on('event:reminder', (r) => rem.get(p).push(r)); }
      const room = (await emit(own.s, 'room:create', { name: 'Events Room', topic: 'plans' })).roomId;
      await joinAll(room, own, mem);
      const outRoom = (await emit(out.s, 'room:create', { name: 'Ev Out Room', topic: 'x' })).roomId;
      await joinAll(outRoom, out);
      const H = 3_600_000;
      const ev = (title, inMs, extra = {}) => ({ title, startsAt: Date.now() + inMs, ...extra });
      const byMem = await emit(mem.s, 'events:create', ev('Member party', H));
      ok(!byMem.ok && byMem.status === 403, 'a regular member cannot create events');
      const c1 = await emit(own.s, 'events:create', ev('Movie night', 2 * H, { description: 'Bring **snacks**', durationMin: 120 }));
      ok(c1.ok && c1.event.title === 'Movie night' && c1.event.durationMin === 120 && c1.event.createdBy === 'Ev_Owner', 'room owner schedules an event (title, description, start, duration)');
      const list = await emit(mem.s, 'events:list');
      ok(list.ok && list.events.length === 1 && list.canManage === false, 'members see upcoming events without manage controls');
      ok((await emit(own.s, 'events:list')).canManage === true, 'owner sees manage controls');
      ok((await emit(out.s, 'events:list')).events.length === 0, 'other rooms do not see the event');
      ok(!(await emit(out.s, 'events:update', { id: c1.event.id, ...ev('Hijack', H) })).ok && !(await emit(out.s, 'events:cancel', { id: c1.event.id })).ok, 'owner of another room cannot edit or cancel it');
      const changed = once(mem.s, 'events:changed', (p) => p.roomId === room);
      const up = await emit(own.s, 'events:update', { id: c1.event.id, title: 'Movie night!', description: 'Bring snacks', startsAt: c1.event.startsAt + 30 * 60_000, durationMin: 90 });
      ok(up.ok && up.event.title === 'Movie night!', 'owner edits an event');
      await changed; ok(true, 'room is told events changed');
      ok((await emit(own.s, 'events:create', ev('Past', -60_000))).status === 400 && (await emit(own.s, 'events:create', ev('x'.repeat(61), H))).status === 400, 'validation: past start and long titles rejected');
      const r1 = await emit(mem.s, 'events:rsvp', { id: c1.event.id, status: 'going' });
      ok(r1.ok && r1.event.myRsvp === 'going' && r1.event.going === 1, 'RSVP going');
      const r2 = await emit(mem.s, 'events:rsvp', { id: c1.event.id, status: 'maybe' });
      ok(r2.ok && r2.event.myRsvp === 'maybe' && r2.event.maybe === 1 && r2.event.going === 0, 'RSVP maybe');
      const r3 = await emit(mem.s, 'events:rsvp', { id: c1.event.id, status: 'no' });
      ok(r3.ok && r3.event.myRsvp === 'no' && r3.event.notGoing === 1, 'RSVP no');
      ok((await emit(mem.s, 'events:rsvp', { id: c1.event.id, status: 'perhaps' })).status === 400, 'unknown RSVP rejected');
      const summ = (await emit(out.s, 'rooms:list')).rooms.find((r) => r.id === room);
      ok(summ?.eventSoon?.title === 'Movie night!', 'lobby room card carries the event tag');
      // reminders at "15 min" (2.5 s in tests) and at start, once each, plus a chat line each time
      const sys = []; own.s.on('chat:message', (m) => { if (m.kind === 'system' && /^📅/.test(m.text)) sys.push(m.text); });
      const R = await emit(own.s, 'events:create', ev('Quick quiz', 4500));
      ok(R.ok, 'event starting in 4.5 s');
      await emit(mem.s, 'events:rsvp', { id: R.event.id, status: 'going' });
      await emit(out.s, 'events:rsvp', { id: R.event.id, status: 'going' });
      await sleep(3000);
      const live1 = (await emit(out.s, 'rooms:list')).rooms.find((r) => r.id === room);
      await sleep(3000);
      const memR = rem.get(mem).filter((r) => r.eventId === R.event.id).map((r) => r.stage);
      ok(memR.join() === 'soon,start', `Going member gets one "soon" then one "start" reminder (${memR.join()})`);
      ok(rem.get(own).length === 0 && rem.get(out).length === 0, 'people without a Going/Maybe RSVP (or in another room) get none');
      ok(sys.includes('📅 Quick quiz starts in 15 minutes') && sys.includes('📅 Quick quiz is starting!') && sys.filter((t) => /Quick quiz/.test(t)).length === 2, `one reminder chat line at each stage (${sys.join(' | ')})`);
      const liveNow = (await emit(out.s, 'rooms:list')).rooms.find((r) => r.id === room);
      ok(!!live1 && !!liveNow?.eventLive && liveNow.eventLive.title === 'Quick quiz', 'room card shows the event as live once it starts');
      const claimed = dbq('SELECT reminded_soon, reminded_start FROM room_events WHERE id = ?', R.event.id)[0];
      ok(claimed.reminded_soon && claimed.reminded_start, 'sent reminders are recorded in SQLite');
      // across a restart nothing is sent twice
      const R2 = await emit(own.s, 'events:create', ev('Across restart', 6000));
      await emit(mem.s, 'events:rsvp', { id: R2.event.id, status: 'going' });
      await once(mem.s, 'event:reminder', (r) => r.eventId === R2.event.id && r.stage === 'soon', 9000);
      ok(true, '"soon" reminder sent before the restart');
      sockets.forEach((x) => x.close());
      await stopServer();
      await startServer();
      const mem2 = track(await mem.b.connect());
      const own2 = track(await own.b.connect());
      const after = []; mem2.on('event:reminder', (r) => after.push(r));
      const sys2 = []; own2.on('chat:message', (m) => { if (m.kind === 'system' && /^📅/.test(m.text)) sys2.push(m.text); });
      ok((await emit(mem2, 'login', {})).ok && (await emit(own2, 'login', {})).ok, 'members back after restart');
      await emit(own2, 'room:join', { roomId: room }); await emit(mem2, 'room:join', { roomId: room });
      await sleep(Math.max(0, R2.event.startsAt - Date.now()) + 1200);
      ok(!after.some((r) => r.stage === 'soon') && !after.some((r) => r.eventId === R.event.id), 'no reminder is sent twice after a restart');
      ok(after.filter((r) => r.eventId === R2.event.id && r.stage === 'start').length <= 1 && sys2.filter((t) => /Across restart starts in/.test(t)).length === 0, 'no duplicate reminder lines after the restart');
      ok(dbq('SELECT reminded_start FROM room_events WHERE id = ?', R2.event.id)[0].reminded_start, 'start claim recorded after restart');
      ok((await emit(own2, 'events:cancel', { id: c1.event.id })).ok, 'owner cancels an event');
      own2.close(); mem2.close();
    }

    // ---------- 5. room roles ----------
    {
      const o = await mk('Role_Owner');
      const m = await mk('Role_Mod');
      const x = await mk('Role_X');
      const y = await mk('Role_Y');
      const ad = track(await admin.connect());
      ok((await emit(ad, 'login', {})).ok, 'site admin logs in');
      const room = (await emit(o.s, 'room:create', { name: 'Roles Room', topic: 'r' })).roomId;
      await joinAll(room, o, m, x, y);
      ok((await emit(ad, 'room:join', { roomId: room })).ok, 'admin joins');
      const sid = async (p) => p.s.id;
      const xMsg = await say(x, 'x says hi');
      const oMsg = await say(o, 'owner line');
      ok((await emit(m.s, 'chat:pin', { messageId: xMsg.id, pinned: true })).ok === false, 'before appointment a member cannot pin');
      ok((await emit(m.s, 'room:kick', { userId: await sid(x) })).ok === false, 'before appointment a member cannot kick');
      ok((await emit(m.s, 'room:mod', { accountId: y.id, on: true })).status === 403, 'only the owner can appoint mods');
      ok((await emit(o.s, 'room:mod', { accountId: 999999, on: true })).status === 404, 'only registered accounts can be mods');
      const modsEv = once(x.s, 'room:mods', (p) => p.mods.some((u) => u.accountId === m.id));
      const ap = await emit(o.s, 'room:mod', { accountId: m.id, on: true });
      ok(ap.ok && ap.mods.length === 1 && ap.mods[0].username === 'Role_Mod', 'owner appoints a room mod');
      await modsEv; ok(true, 'room is told the mod list changed (for the "mod" tag)');
      const rejoin = await emit(m.s, 'room:join', { roomId: room });
      ok(rejoin.ok && rejoin.room.isRoomMod === true && rejoin.room.mods.some((u) => u.accountId === m.id), 'room state marks the mod');
      ok(dbq('SELECT COUNT(*) AS n FROM room_mods WHERE room_id = ? AND user_id = ?', room, m.id)[0].n === 1, 'mods are stored');
      ok((await emit(m.s, 'chat:pin', { messageId: xMsg.id, pinned: true })).ok, 'room mod pins');
      ok((await emit(m.s, 'chat:pin', { messageId: xMsg.id, pinned: false })).ok, 'room mod unpins');
      const mutedEv = once(x.s, 'room:muted');
      ok((await emit(m.s, 'room:mute', { userId: x.s.id, minutes: 5 })).ok, 'room mod mutes a member');
      await mutedEv;
      const muted = await emit(x.s, 'chat:send', { text: 'can I talk' });
      ok(!muted.ok && /muted in this room/i.test(muted.error || ''), 'room-muted member cannot chat here');
      ok((await emit(m.s, 'room:mute', { userId: o.s.id, minutes: 5 })).status === 403, 'mod cannot mute the owner');
      ok((await emit(m.s, 'chat:delete', { messageId: xMsg.id })).ok, 'room mod deletes someone\'s message');
      ok(!(await emit(m.s, 'chat:delete', { messageId: oMsg.id })).ok, 'room mod cannot delete the owner\'s message');
      const adMsg = await new Promise(async (res) => { const g = once(ad, 'chat:message', (mm) => mm.fromId === ad.id); await emit(ad, 'chat:send', { text: 'staff line' }); res(await g); });
      ok(!(await emit(m.s, 'chat:delete', { messageId: adMsg.id })).ok && !(await emit(o.s, 'chat:delete', { messageId: adMsg.id })).ok, 'room mods and owners cannot delete site staff messages');
      ok((await emit(m.s, 'room:kick', { userId: o.s.id })).ok === false && (await emit(m.s, 'room:kick', { userId: ad.id })).ok === false, 'mod cannot kick the owner or staff');
      ok((await emit(m.s, 'events:create', { title: 'Mod event', startsAt: Date.now() + 3_600_000 })).ok, 'room mod manages events');
      ok((await emit(o.s, 'room:mod', { accountId: y.id, on: true })).ok, 'second mod');
      ok((await emit(m.s, 'room:kick', { userId: y.s.id })).ok === false, 'a mod cannot kick another mod');
      ok((await emit(o.s, 'room:mod', { accountId: y.id, on: false })).ok, 'owner removes the second mod');
      ok((await emit(m.s, 'room:ban', { userId: y.s.id, minutes: 5 })).ok, 'room mod room-bans a member');
      ok(!(await emit(y.s, 'room:join', { roomId: room })).ok, 'room-banned member cannot rejoin');
      ok((await emit(m.s, 'room:kick', { userId: x.s.id })).ok, 'room mod kicks a member');
      const other = (await emit(x.s, 'room:create', { name: 'X Room', topic: 'x' })).roomId;
      await emit(x.s, 'room:join', { roomId: other });
      ok((await emit(x.s, 'chat:send', { text: 'free elsewhere' })).ok, 'room mute is room-scoped');
      ok((await emit(m.s, 'chat:pin', { messageId: oMsg.id, pinned: true })).ok, 'mod pins owner line');
      ok((await emit(o.s, 'room:mod', { accountId: m.id, on: false })).ok, 'owner removes the mod');
      ok((await emit(m.s, 'chat:pin', { messageId: oMsg.id, pinned: false })).ok === false, 'removed mod lost the powers');
      ok((await emit(ad, 'room:mod', { accountId: m.id, on: true })).ok, 'site staff keep their powers (can appoint too)');
      ok((await emit(ad, 'chat:pin', { messageId: oMsg.id, pinned: false })).ok, 'site staff can still pin');
      for (const p of [o, m, x, y]) p.s.close();
      ad.close();
    }

    // ---------- 6. web push ----------
    {
      const key = await (await fetch(BASE + '/api/push/key')).json();
      ok(key.ok && key.enabled === true && typeof key.key === 'string' && key.key.length > 80, 'VAPID public key is served');
      const vf = path.join(DATA, 'vapid.json');
      ok(fs.existsSync(vf) && (fs.statSync(vf).mode & 0o777) === 0o600, 'generated VAPID keys are stored in DATA_DIR with mode 0600');
      const key2 = await (await fetch(BASE + '/api/push/key')).json();
      ok(key2.key === key.key, 'the same key survives restarts (persisted)');
      const mkKeys = () => { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); const auth = randomBytes(16); return { ecdh, auth, p256dh: ecdh.getPublicKey().toString('base64url'), authB64: auth.toString('base64url') }; };
      const decrypt = (k, body) => {
        const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
        const secret = k.ecdh.computeSecret(asPub);
        const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), k.ecdh.getPublicKey(), asPub]);
        const ikm = Buffer.from(hkdfSync('sha256', secret, k.auth, keyInfo, 32));
        const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
        const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
        const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
        const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
        let i = pt.length - 1; while (i > 0 && pt[i] === 0) i--;
        return JSON.parse(pt.subarray(0, i).toString('utf8'));
      };
      const waitPush = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const h = pushHits.find(pred); if (h) return h; await sleep(50); } return null; };
      const a = await mk('Push_Alice');
      const bob = browser(); await bob.boot(); await register(bob, 'Push_Bob', 'push_bob-pass-99');
      const kb = mkKeys();
      ok((await bob.req('/api/push/subscribe', { endpoint: 'https://evil.example.com/push', keys: { p256dh: kb.p256dh, auth: kb.authB64 } })).status === 400, 'unknown push services are refused');
      ok((await bob.req('/api/push/subscribe', { endpoint: `http://127.0.0.1:${port}/api/health`, keys: { p256dh: kb.p256dh, auth: kb.authB64 } })).status === 400, 'loopback push endpoints are refused');
      ok((await bob.req('/api/push/subscribe', { endpoint: `${FIX}/push/ok?u=bob`, keys: { p256dh: 'short', auth: kb.authB64 } })).status === 400, 'bad keys are refused');
      ok((await browser().req('/api/push/subscribe', { endpoint: `${FIX}/push/ok?u=x`, keys: { p256dh: kb.p256dh, auth: kb.authB64 } })).status === 401, 'subscribing needs an account');
      ok((await bob.req('/api/push/subscribe', { endpoint: `${FIX}/push/ok?u=bob`, keys: { p256dh: kb.p256dh, auth: kb.authB64 } })).json.ok, 'opt in: subscription saved');
      ok((await bob.req('/api/push/status')).json.subscriptions === 1, 'per-user subscription stored');
      const room = (await emit(a.s, 'room:create', { name: 'Push Room', topic: 'p' })).roomId;
      await joinAll(room, a);
      await say(a, '@Push_Bob are you there?');
      const h1 = await waitPush((h) => h.path === '/push/ok?u=bob');
      ok(!!h1 && /^vapid t=/.test(h1.headers.authorization || '') && h1.headers['content-encoding'] === 'aes128gcm', 'an @mention of someone with no socket sends an encrypted, VAPID-signed push');
      const p1 = h1 && decrypt(kb, h1.body);
      ok(p1 && /Push_Alice mentioned you/.test(p1.title) && p1.body === '@Push_Bob are you there?', 'mention push decrypts to the right title and text');
      const n0 = pushHits.length;
      await paced(() => say(a, '@Push_Bob burn secret', { burnTtl: 10 }));
      await sleep(600);
      ok(pushHits.length === n0, 'burn messages never push');
      const sb = track(await bob.connect());
      ok((await emit(sb, 'login', {})).ok, 'bob comes online');
      await emit(sb, 'room:join', { roomId: room });
      await say(a, '@Push_Bob online now');
      await sleep(600);
      ok(pushHits.length === n0, 'no push while the recipient has a connected socket');
      const bobSid = sb.id;
      const ws = (await emit(a.s, 'whisper:start', { userIds: [bobSid] }));
      sb.close();
      await sleep(250);
      const pm = await paced(() => emit(a.s, 'pm:send', { toId: bobSid, text: 'private hello' }));
      const h2 = await waitPush((h) => pushHits.indexOf(h) >= n0 && h.path === '/push/ok?u=bob' && /Message from/.test(decrypt(kb, h.body).title));
      ok(pm.ok && !!h2 && decrypt(kb, h2.body).body === 'private hello', 'a DM to a parked (disconnected) user sends a push');
      if (ws.ok) {
        const n1 = pushHits.length;
        const wr = await emit(a.s, 'whisper:send', { whisperId: ws.whisper.id, text: 'psst secret' });
        const h3 = await waitPush((h) => pushHits.indexOf(h) >= n1);
        const p3 = h3 && decrypt(kb, h3.body);
        ok(wr.ok && p3 && /Whisper from Push_Alice/.test(p3.title) && p3.body === 'New message', 'a whisper pushes "New message" without the content');
      } else ok(false, 'whisper:start failed: ' + ws.error);
      await sleep(2200); // let the parked session expire
      // expired subscriptions are removed on 404/410
      const carl = browser(); await carl.boot(); await register(carl, 'Push_Carl', 'push_carl-pass-99');
      const kc = mkKeys();
      ok((await carl.req('/api/push/subscribe', { endpoint: `${FIX}/push/gone?u=carl`, keys: { p256dh: kc.p256dh, auth: kc.authB64 } })).json.ok, 'carl subscribes (endpoint will answer 410)');
      await paced(() => say(a, '@Push_Carl hello'));
      ok(!!(await waitPush((h) => h.path === '/push/gone?u=carl')), 'push attempted');
      await sleep(300);
      ok((await carl.req('/api/push/status')).json.subscriptions === 0, 'a 410 response deletes the subscription');
      // private room: generic text
      const pr = (await emit(a.s, 'room:create', { name: 'Push Locked', topic: 'p', password: 'locked-pass-1' })).roomId;
      await emit(a.s, 'room:join', { roomId: pr, password: 'locked-pass-1' });
      const n2 = pushHits.length;
      await paced(() => say(a, '@Push_Bob the code is 1234'));
      const h4 = await waitPush((h) => pushHits.indexOf(h) >= n2);
      ok(h4 && decrypt(kb, h4.body).body === 'New mention', 'mentions in password rooms push without the message text');
      ok((await bob.req('/api/push/unsubscribe', {})).json.ok && (await bob.req('/api/push/status')).json.subscriptions === 0, 'opt out removes the subscription');
      a.s.close();
    }

    // ---------- 7. link previews ----------
    {
      const a = await mk('Link_Alice');
      const v = await mk('Link_Viewer');
      const out = await mk('Link_Out');
      const room = (await emit(a.s, 'room:create', { name: 'Link Room', topic: 'l' })).roomId;
      await joinAll(room, a, v);
      const outRoom = (await emit(out.s, 'room:create', { name: 'Link Out', topic: 'l' })).roomId;
      await joinAll(outRoom, out);
      const previews = new Map();
      v.s.on('chat:preview', (x) => previews.set(x.messageId, x.preview));
      const previewOf = async (text, extra = {}, ms = 2500) => {
        const msg = await paced(() => say(a, text, extra));
        if (msg.error) return { msg, preview: undefined };
        const t = Date.now();
        while (!previews.has(msg.id) && Date.now() - t < ms) await sleep(50);
        return { msg, preview: previews.get(msg.id) ?? undefined };
      };
      const r1 = await previewOf(`look ${FIX}/page`);
      ok(r1.preview && r1.preview.title === 'Fixture & Page' && r1.preview.description === 'A test page' && r1.preview.siteName === 'FixtureSite' && r1.preview.kind === 'page', 'an allowed page gets a preview card (title, description, site)');
      ok(r1.preview && r1.preview.image === `/api/link-preview/${r1.preview.id}/image`, 'the image goes through the proxy');
      const img = await fetch(BASE + r1.preview.image, { headers: { cookie: v.b.cookieHeader(), 'cf-connecting-ip': v.b.ip } });
      const imgBuf = Buffer.from(await img.arrayBuffer());
      ok(img.status === 200 && img.headers.get('content-type') === 'image/webp' && imgBuf.subarray(8, 12).toString() === 'WEBP', 'proxied image is re-encoded as webp');
      const meta = await createRequire(path.join(ROOT, 'package.json'))('sharp')(imgBuf).metadata();
      ok(meta.width <= 640, 'proxied image is resized');
      ok((await fetch(BASE + r1.preview.image, { headers: { cookie: out.b.cookieHeader(), 'cf-connecting-ip': out.b.ip } })).status === 403, 'someone outside the room cannot load the image');
      const hist = await emit(v.s, 'room:join', { roomId: room });
      ok(hist.ok && hist.room.history.some((m) => m.id === r1.msg.id && m.preview?.id === r1.preview.id), 'previews come back with history');
      ok(dbq('SELECT ok, title FROM link_previews WHERE url = ?', `${FIX}/page`)[0]?.title === 'Fixture & Page', 'preview is cached in the DB');
      const hitsBefore = fixHits.filter((p) => p === '/page').length;
      const r1b = await previewOf(`again ${FIX}/page`);
      ok(r1b.preview?.id === r1.preview.id && fixHits.filter((p) => p === '/page').length === hitsBefore, 'a cached preview is reused within the TTL (no refetch)');
      const r3 = await previewOf(`${FIX}/r1`);
      ok(r3.preview?.title === 'Second page', 'up to 3 redirects are followed (each re-checked)');
      ok(!(await previewOf(`${FIX}/r0`, {}, 1500)).preview, 'a 4th redirect is refused');
      ok(!(await previewOf(`${FIX}/to-meta`, {}, 1500)).preview, 'redirect to the metadata address is blocked');
      ok(!(await previewOf(`${FIX}/to-local`, {}, 1500)).preview, 'redirect to another loopback port is blocked');
      ok(!(await previewOf(`${FIX}/to-v6`, {}, 1500)).preview, 'redirect to IPv6 loopback is blocked');
      ok(!(await previewOf(`http://127.0.0.1:${port}/api/health`, {}, 1500)).preview, 'direct loopback URL is blocked');
      ok(!(await previewOf(`${FIX}/json`, {}, 1500)).preview, 'non-HTML responses get no card');
      const t0 = Date.now();
      ok(!(await previewOf(`${FIX}/slow`, {}, 3000)).preview && Date.now() - t0 < 4500, 'slow pages time out');
      ok(!(await previewOf(`${FIX}/big`, {}, 1500)).preview, 'only the first 512 KB is read');
      const rb = await previewOf(`${FIX}/page2 burn`, { burnTtl: 10 }, 1500);
      ok(!rb.preview, 'burn messages never get a preview');
      // remove / edit
      ok((await emit(v.s, 'chat:preview-remove', { messageId: r1.msg.id })).status === 403, 'only the sender can remove a preview');
      const gone = once(v.s, 'chat:preview', (x) => x.messageId === r1.msg.id && x.preview === null);
      ok((await emit(a.s, 'chat:preview-remove', { messageId: r1.msg.id })).ok, 'sender removes the preview');
      await gone; ok(true, 'room is told the preview is gone');
      ok(dbq('SELECT removed FROM message_previews WHERE message_id = ?', r1.msg.id)[0]?.removed === 1, 'removal is stored');
      const r5 = await previewOf(`${FIX}/page`);
      const cleared = once(v.s, 'chat:preview', (x) => x.messageId === r5.msg.id && x.preview === null);
      ok((await emit(a.s, 'chat:edit', { messageId: r5.msg.id, text: 'no link now' })).ok, 'edit removes the link');
      await cleared; ok(true, 'editing the URL away drops the preview');
      // unit: address checks and the guarded fetch (no allowlist)
      const unit = execFileSync(process.execPath, ['-e', `
        const { isBlockedAddress, safeFetch } = require('./dist/server/server/safeFetch.js');
        const blocked = ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','255.255.255.255','::1','::','fe80::1','fc00::1','fd12::3','::ffff:127.0.0.1','::ffff:10.0.0.1','64:ff9b::a9fe:a9fe','2002:7f00:1::','ff02::1','2001:db8::1','::ffff:7f00:1'].filter((a) => !isBlockedAddress(a));
        const open = ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2a00:1450:4001::64'].filter((a) => isBlockedAddress(a));
        (async () => {
          const tries = ['http://localhost/', 'http://127.0.0.1:${port}/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'ftp://example.com/', 'http://0x7f000001/', 'http://2130706433/', 'http://foo.internal/', 'http://example.com:22/', 'http://user:pw@example.com/'];
          const passed = [];
          for (const u of tries) { try { await safeFetch(u, { timeoutMs: 1000 }); passed.push(u); } catch (e) { if (!e.code) passed.push(u + ' ' + e.message); } }
          console.log(JSON.stringify({ blocked, open, passed }));
        })();
      `], { cwd: ROOT, env: { PATH: process.env.PATH, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-ssrf-')) } }).toString().trim().split('\n').at(-1);
      const u = JSON.parse(unit);
      ok(u.blocked.length === 0, `private, loopback, link-local, metadata and special IPv4/IPv6 ranges are blocked (${u.blocked.join(',')})`);
      ok(u.open.length === 0, `public addresses are allowed (${u.open.join(',')})`);
      ok(u.passed.length === 0, `guarded fetch refuses localhost, loopback, metadata, odd schemes, ports and encodings (${u.passed.join(',')})`);
      // YouTube / Twitch cards (the id alone is enough even when the site can't be reached)
      const yt = await previewOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {}, 7000);
      ok(yt.preview?.kind === 'youtube' && !!yt.preview.image, 'YouTube links get a video card with a thumbnail');
      const tw = await previewOf('https://www.twitch.tv/somechannel', {}, 7000);
      ok(tw.preview?.kind === 'twitch' && !!tw.preview.image, 'Twitch channels get a card with a thumbnail');
      for (const p of [a, v, out]) p.s.close();
    }

    // ---------- 8. polls ----------
    {
      const a = await mk('Poll_Alice');
      const b = await mk('Poll_Bob');
      const c = await mk('Poll_Carol');
      const room = (await emit(a.s, 'room:create', { name: 'Poll Room', topic: 'p' })).roomId;
      await joinAll(room, a, b, c);
      ok((await emit(a.s, 'poll:create', { question: 'Q?', options: ['only one'] })).status === 400, 'a poll needs at least 2 options');
      ok((await emit(a.s, 'poll:create', { question: 'Q?', options: ['1', '2', '3', '4', '5', '6', '7'] })).status === 400, 'at most 6 options');
      ok((await emit(a.s, 'poll:create', { question: 'Q?', options: ['Same', 'same'] })).status === 400, 'options must differ');
      ok((await emit(a.s, 'poll:create', { question: '', options: ['a', 'b'] })).status === 400, 'question required');
      const seen = once(b.s, 'chat:message', (m) => !!m.poll);
      const p = await emit(a.s, 'poll:create', { question: 'Pizza or tacos?', options: ['Pizza', 'Tacos', 'Both'] });
      ok(p.ok && p.poll.options.length === 3 && p.poll.total === 0 && p.poll.closed === false, 'create a poll');
      const pm = await seen;
      ok(pm.poll.id === p.poll.id && pm.text === '📊 Poll: Pizza or tacos?', 'the poll arrives as a chat line with a poll card');
      const upd = once(c.s, 'poll:update', (x) => x.poll.id === p.poll.id && x.poll.total === 1);
      const v1 = await emit(b.s, 'poll:vote', { pollId: p.poll.id, option: 1 });
      ok(v1.ok && v1.poll.myVote === 1 && v1.poll.options[1].votes === 1, 'vote');
      await upd; ok(true, 'live results reach the room');
      const v2 = await emit(b.s, 'poll:vote', { pollId: p.poll.id, option: 0 });
      ok(v2.ok && v2.poll.total === 1 && v2.poll.options[0].votes === 1 && v2.poll.options[1].votes === 0, 'single choice: a new vote replaces the old one');
      ok((await emit(c.s, 'poll:vote', { pollId: p.poll.id, option: 9 })).status === 400, 'bad option rejected');
      ok((await emit(c.s, 'poll:vote', { pollId: p.poll.id, option: 0 })).poll.total === 2, 'second voter');
      ok((await emit(c.s, 'poll:close', { pollId: p.poll.id })).status === 403, 'others cannot close the poll');
      const sys = once(b.s, 'chat:message', (m) => m.kind === 'system' && /Poll closed/.test(m.text));
      const cl = await emit(a.s, 'poll:close', { pollId: p.poll.id });
      ok(cl.ok && cl.poll.closed === true, 'creator closes the poll');
      ok(/Pizza \(2 votes\)/.test((await sys).text), 'the result is announced');
      ok((await emit(b.s, 'poll:vote', { pollId: p.poll.id, option: 1 })).status === 409, 'no votes after close');
      const hist = await emit(b.s, 'room:join', { roomId: room });
      const hm = hist.room.history.find((m) => m.id === pm.id);
      ok(hm?.poll?.closed === true && hm.poll.myVote === 0, 'history carries the poll with my vote');
      // auto-close (1 "minute" = 1 s in tests), mods may close
      const t = await paced(() => emit(a.s, 'poll:create', { question: 'Timed?', options: ['Yes', 'No'], durationMin: 1 }));
      ok(t.ok && t.poll.closesAt > Date.now(), `poll with a duration ${t.error || ''}`);
      await once(c.s, 'poll:update', (x) => x.poll.id === t.poll.id && x.poll.closed, 4000);
      ok(true, 'a timed poll closes by itself');
      const m2 = await paced(() => emit(c.s, 'poll:create', { question: 'Carol asks', options: ['A', 'B'] }));
      ok(m2.ok && (await emit(a.s, 'poll:close', { pollId: m2.poll.id })).ok, 'the room owner can close anyone\'s poll');
      const slash = await paced(() => emit(b.s, 'poll:create', { question: 'Via slash', options: ['x', 'y'], durationMin: 15 }));
      ok(slash.ok && slash.poll.closesAt - Date.now() > 10_000, 'durations are stored');
      // guests vote by device: one vote per device key
      const keys = dbq('SELECT voter_key FROM poll_votes WHERE poll_id = ?', p.poll.id).map((r) => r.voter_key).sort();
      ok(keys.length === 2 && keys.every((k) => /^u:\d+$/.test(k)), 'registered users vote by account (guests would vote by device id)');
      for (const x of [a, b, c]) x.s.close();
    }

    // ---------- 9. profile pages ----------
    {
      const a = await mk('Prof_Alice');
      const b = await mk('Prof_Bob');
      ok((await browser().req('/api/users/Prof_Alice/profile')).status === 401, 'profiles need a signed-in viewer');
      ok((await a.b.req('/api/users/Nobody_Here/profile')).status === 404, 'unknown user is 404');
      const tooLong = await a.b.req('/api/me/bio', { bio: 'x'.repeat(281) }, 'PATCH');
      ok(tooLong.status === 400, 'bio longer than 280 characters is rejected');
      const set = await a.b.req('/api/me/bio', { bio: 'Hi! I like **cams** and _frick_ music\u0007\n\n\n\nsee https://example.com' }, 'PATCH');
      ok(set.json.ok && set.json.bio.includes('**cams**') && !set.json.bio.includes('frick') && !set.json.bio.includes('\u0007') && !set.json.bio.includes('\n\n\n'), 'bio is cleaned, word-filtered and keeps markdown-lite');
      const room = (await emit(a.s, 'room:create', { name: 'Alice Lounge', topic: 'x' })).roomId;
      await emit(a.s, 'room:join', { roomId: room });
      ok((await emit(b.s, 'friends:request', { username: 'Prof_Alice' })).ok, 'bob sends a friend request');
      const pa = await b.b.req('/api/users/prof_alice/profile');
      const pr = pa.json.profile;
      ok(pa.status === 200 && pr.username === 'Prof_Alice' && pr.bio === set.json.bio && typeof pr.joinedAt === 'number' && Array.isArray(pr.badges), 'profile has name, bio, badges and joined date');
      ok(pr.rooms.some((r) => r.id === room && r.name === 'Alice Lounge'), 'profile lists rooms they own');
      ok(pr.friend === 'pending-out' && pr.online === true && pr.socketId === a.s.id, 'profile shows friend status and online state (for Message)');
      ok((await a.b.req('/api/users/Prof_Bob/profile')).json.profile.friend === 'pending-in', 'the other side sees an incoming request');
      ok((await a.b.req('/api/users/Prof_Alice/profile')).json.profile.friend === 'self', 'own profile is marked self');
      ok(!('email' in pr) && !JSON.stringify(pa.json).includes('@example.com'), 'profile never exposes the email');
      ok((await a.b.req('/api/me/bio', { bio: '' }, 'PATCH')).json.bio === '', 'bio can be cleared');
      a.s.close(); b.s.close();
    }

    // ---------- custom room thumbnails ----------
    {
      const sharpLib = createRequire(path.join(ROOT, 'package.json'))('sharp');
      const a = await mk('Thumb_Alice');
      const b = await mk('Thumb_Bob');
      const lob = await mk('Thumb_Lobby');
      const cols = dbq("SELECT name FROM pragma_table_info('rooms')").map((r) => r.name);
      ok(cols.includes('thumb_id') && cols.includes('thumb_at'), 'rooms has thumb_id / thumb_at columns (migration 28)');
      const room = (await emit(a.s, 'room:create', { name: 'Thumb Room', topic: 'pics' })).roomId;
      const upload = async (who, roomId, buf, type, name = 'x.png') => {
        const fd = new FormData();
        fd.append('thumb', new Blob([buf], { type }), name);
        const r = await fetch(BASE + `/api/rooms/${roomId}/thumb`, { method: 'POST', headers: { 'cf-connecting-ip': who.b.ip, 'x-csrf': '1', cookie: who.b.cookieHeader() }, body: fd });
        return { status: r.status, json: await r.json().catch(() => ({})) };
      };
      const jpg = await sharpLib({ create: { width: 1200, height: 900, channels: 3, background: '#cc3366' } }).jpeg().toBuffer();
      const lobbyList = once(lob.s, 'rooms', (list) => list.some((x) => x.id === room && x.thumbUrl), 3000);
      const up = await upload(a, room, jpg, 'image/jpeg', 'cover.jpg');
      ok(up.status === 200 && up.json.ok && /^\/api\/room-thumbs\/[a-f0-9]{32}\.webp$/.test(up.json.thumbUrl), 'owner uploads a thumbnail (random id URL)');
      const live1 = await lobbyList.catch(() => null);
      ok(live1?.find((x) => x.id === room)?.thumbUrl === up.json.thumbUrl, 'lobbies get the new thumbnail live');
      const img = await fetch(BASE + up.json.thumbUrl);
      const bytes = Buffer.from(await img.arrayBuffer());
      const meta = await sharpLib(bytes).metadata();
      ok(img.status === 200 && img.headers.get('content-type') === 'image/webp' && meta.format === 'webp' && meta.width === 640 && meta.height === 360, 'served thumbnail is a 640x360 webp');
      ok(/immutable/.test(img.headers.get('cache-control') || '') && /public/.test(img.headers.get('cache-control') || ''), 'thumbnail URL is cacheable');
      ok(!fs.readdirSync(path.join(DATA, 'room-thumbs')).some((n) => !/^[a-f0-9]{32}\.webp$/.test(n)), 'stored under DATA_DIR/room-thumbs');
      const pub = await fetch(BASE + '/api/rooms').then((r) => r.json());
      ok(pub.rooms.find((x) => x.id === room)?.thumbUrl === up.json.thumbUrl, 'room list carries thumbUrl');
      // joining shows it in room state; members get room:thumb on change
      const st = await emit(b.s, 'room:join', { roomId: room });
      ok(st.ok && st.room.thumbUrl === up.json.thumbUrl, 'room state carries thumbUrl');
      ok((await upload(b, room, jpg, 'image/jpeg')).status === 403, 'another user cannot set the thumbnail');
      ok((await emit(a.s, 'room:join', { roomId: room })).ok && (await emit(a.s, 'room:mod', { accountId: b.id, on: true })).ok, 'owner makes bob a room mod');
      ok((await upload(b, room, jpg, 'image/jpeg')).status === 403, 'room mods cannot change it either (owner/staff only)');
      ok((await b.b.req(`/api/rooms/${room}/thumb`, undefined, 'DELETE')).status === 403, 'another user cannot remove it');
      const anon = browser(); await anon.boot();
      ok((await upload({ b: anon }, room, jpg, 'image/jpeg')).status === 401, 'signed-out upload is refused');
      ok((await upload(a, 'no-such-room', jpg, 'image/jpeg')).status === 404, 'unknown room is 404');
      // replace: new id, old file gone, members told
      const gif = await sharpLib({ create: { width: 300, height: 300, channels: 4, background: '#22aa66ff' } }).gif().toBuffer();
      const evP = once(b.s, 'room:thumb', (x) => !!x.thumbUrl && x.thumbUrl !== up.json.thumbUrl, 3000);
      const up2 = await upload(a, room, gif, 'image/gif', 'anim.gif');
      ok(up2.json.ok && up2.json.thumbUrl !== up.json.thumbUrl, 'a GIF is accepted and gets a new id');
      ok((await evP.catch(() => null))?.thumbUrl === up2.json.thumbUrl, 'room members receive room:thumb');
      ok((await fetch(BASE + up.json.thumbUrl)).status === 404, 'old thumbnail URL stops working after replace');
      ok((await sharpLib(Buffer.from(await (await fetch(BASE + up2.json.thumbUrl)).arrayBuffer())).metadata()).format === 'webp', 'GIF re-encoded to a static webp');
      // bad input
      const badType = await upload(a, room, Buffer.from('%PDF-1.4 hello'), 'application/pdf', 'x.pdf');
      ok(badType.status === 400 && /PNG|JPEG|WebP|GIF/.test(badType.json.error || ''), 'non-image type rejected');
      const garbage = await upload(a, room, Buffer.alloc(200, 7), 'image/png', 'fake.png');
      ok(garbage.status === 400, 'garbage bytes with an image type rejected');
      const tooBig = await upload(a, room, Buffer.alloc(5 * 1024 * 1024 + 10, 1), 'image/jpeg', 'big.jpg');
      ok(tooBig.status === 400 && /too large/i.test(tooBig.json.error || ''), 'over 5 MB rejected');
      ok((await fetch(BASE + up2.json.thumbUrl)).status === 200, 'failed uploads keep the current thumbnail');
      ok((await fetch(BASE + '/api/room-thumbs/' + 'a'.repeat(32) + '.webp')).status === 404 && (await fetch(BASE + '/api/room-thumbs/..%2Fcamchat.db.webp')).status === 404, 'unknown or malformed thumbnail ids are 404');
      // staff may set it on any room
      const staffUp = await upload({ b: admin }, room, jpg, 'image/jpeg');
      ok(staffUp.status === 200 && staffUp.json.ok, 'site staff can set any room thumbnail');
      // remove
      const rmEv = once(lob.s, 'rooms', (list) => list.some((x) => x.id === room && !x.thumbUrl), 3000);
      const rm = await a.b.req(`/api/rooms/${room}/thumb`, undefined, 'DELETE');
      ok(rm.status === 200 && rm.json.ok && rm.json.thumbUrl === null, 'owner removes the thumbnail');
      ok(!!(await rmEv.catch(() => null)), 'lobbies see the removal live');
      ok((await fetch(BASE + staffUp.json.thumbUrl)).status === 404 && dbq('SELECT thumb_id FROM rooms WHERE id = ?', room)[0].thumb_id === null, 'removed: URL 404 and column cleared');
      ok(!(await fetch(BASE + '/api/rooms').then((r) => r.json())).rooms.find((x) => x.id === room).thumbUrl, 'room list falls back to no thumbnail');
      // password room: card is visible to everyone in the lobby, so is its thumbnail
      const pwRoom = (await emit(b.s, 'room:create', { name: 'Thumb Locked', topic: 'pw', password: 'hunter22x' })).roomId;
      const pwUp = await upload(b, pwRoom, jpg, 'image/jpeg');
      ok(pwUp.json.ok && (await emit(lob.s, 'rooms:list')).rooms.find((x) => x.id === pwRoom)?.thumbUrl === pwUp.json.thumbUrl, 'password room thumbnail shows on its (public) lobby card');
      // private 1:1 calls: never listed, no thumbnail allowed, and a forced DB value is not served
      ok((await emit(a.s, 'friends:request', { username: 'Thumb_Lobby' })).ok, 'friend request for call');
      ok((await emit(lob.s, 'friends:respond', { userId: a.id, accept: true })).ok, 'friend accepted');
      const callR = await emit(a.s, 'call:invite', { userId: lob.id });
      const privId = callR.room?.id;
      ok(callR.ok && callR.room.isPrivate, 'private call room created');
      ok((await upload(a, privId, jpg, 'image/jpeg')).status === 403, 'private call rooms cannot get a thumbnail');
      const forced = 'b'.repeat(32);
      fs.writeFileSync(path.join(DATA, 'room-thumbs', `${forced}.webp`), bytes);
      dbq('UPDATE rooms SET thumb_id = ? WHERE id = ?', forced, privId);
      ok((await fetch(BASE + `/api/room-thumbs/${forced}.webp`)).status === 404, 'a private room thumbnail is never served');
      const outsider = await mk('Thumb_Out');
      const lists = [(await emit(outsider.s, 'rooms:list')).rooms, (await fetch(BASE + '/api/rooms').then((r) => r.json())).rooms];
      ok(lists.every((l) => !l.some((x) => x.id === privId) && !JSON.stringify(l).includes(forced)), 'private room and its thumbnail are absent from non-members\' lobby listings');
      dbq('UPDATE rooms SET thumb_id = NULL WHERE id = ?', privId);
      // rate limit: 10 changes per 10 minutes per user
      let last = 0;
      for (let i = 0; i < 11; i++) last = (await b.b.req(`/api/rooms/${pwRoom}/thumb`, undefined, 'DELETE')).status;
      ok(last === 429, 'thumbnail changes are rate limited');
      // deleting the room removes the file
      const pwFile = path.join(DATA, 'room-thumbs', pwUp.json.thumbUrl.split('/').pop());
      ok(!fs.existsSync(pwFile), 'removed thumbnail file is deleted from disk');
      const delRoom = (await emit(a.s, 'room:create', { name: 'Thumb Gone', topic: 'x' })).roomId;
      const dUp = await upload(a, delRoom, jpg, 'image/jpeg');
      const dFile = path.join(DATA, 'room-thumbs', dUp.json.thumbUrl.split('/').pop());
      await emit(a.s, 'room:join', { roomId: delRoom });
      ok(fs.existsSync(dFile) && (await emit(a.s, 'room:delete')).ok, 'owner deletes a room with a thumbnail');
      await sleep(100);
      ok(!fs.existsSync(dFile) && (await fetch(BASE + dUp.json.thumbUrl)).status === 404, 'deleting the room deletes its thumbnail');
      for (const x of [a, b, lob, outsider]) x.s.close();
    }

    // ================= batch 3 =================
    {
      const sharpLib = createRequire(path.join(ROOT, 'package.json'))('sharp');
      radioArtJpg = await sharpLib({ create: { width: 500, height: 500, channels: 3, background: '#aa2288' } }).jpeg().toBuffer();
      const own = await mk('B3_Owner');
      const mod = await mk('B3_Mod');
      const pal = await mk('B3_Pal');
      const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

      // ---------- 1. categories + tags ----------
      ok(/category/i.test((await emit(own.s, 'room:create', { name: 'B3 Bad1', category: 'sports' })).error || ''), 'unknown category rejected at create');
      ok(/2-20/.test((await emit(own.s, 'room:create', { name: 'B3 Bad2', tags: ['a'] })).error || ''), 'one-letter tag rejected');
      ok(/At most 5/.test((await emit(own.s, 'room:create', { name: 'B3 Bad3', tags: ['one', 'two', 'three', 'four', 'five', 'six'] })).error || ''), 'more than 5 tags rejected');
      ok(/other tags/.test((await emit(own.s, 'room:create', { name: 'B3 Bad4', tags: ['frick'] })).error || ''), 'tags are word-filtered');
      ok(/2-20/.test((await emit(own.s, 'room:create', { name: 'B3 Bad5', tags: ['x'.repeat(21)] })).error || ''), 'tag longer than 20 rejected');
      const lobbyP = once(pal.s, 'rooms', (list) => list.some((r) => r.name === 'B3 Lounge'), 3000);
      const cr = await emit(own.s, 'room:create', { name: 'B3 Lounge', topic: 'batch 3', category: 'music', tags: ['#Lo Fi', 'chill', 'CHILL'] });
      ok(cr.ok, 'create room with category + tags');
      const room = cr.roomId;
      const card = (await lobbyP.catch(() => [])).find?.((r) => r.id === room);
      ok(card?.category === 'music' && same(card.tags, ['lo-fi', 'chill']), 'room list broadcast carries category and cleaned, de-duplicated tags');
      const st0 = await emit(own.s, 'room:join', { roomId: room });
      ok(st0.room.category === 'music' && same(st0.room.tags, ['lo-fi', 'chill']), 'room state carries category + tags');
      await emit(mod.s, 'room:join', { roomId: room });
      await emit(pal.s, 'room:join', { roomId: room });
      ok((await emit(own.s, 'room:mod', { accountId: mod.id, on: true })).ok, 'owner appoints a room mod');
      ok((await emit(pal.s, 'room:meta', { category: 'tech', tags: [] })).status === 403, 'others cannot change category/tags');
      ok((await emit(mod.s, 'room:meta', { category: 'tech', tags: [] })).status === 403, 'room mods cannot change category/tags (owner/staff only)');
      const metaEv = once(pal.s, 'room:meta', (x) => x.category === 'tech', 3000);
      const lobbyMeta = once(own.s, 'rooms', () => true, 100).catch(() => null);
      const m1 = await emit(own.s, 'room:meta', { category: 'tech', tags: 'rust, wasm' });
      ok(m1.ok && m1.category === 'tech' && same(m1.tags, ['rust', 'wasm']), 'owner updates category + tags (comma string accepted)');
      ok(same((await metaEv.catch(() => ({}))).tags, ['rust', 'wasm']), 'room members get room:meta');
      await lobbyMeta;
      await sleep(400);
      const pubR = (await fetch(BASE + '/api/rooms').then((r) => r.json())).rooms.find((r) => r.id === room);
      ok(pubR.category === 'tech' && same(pubR.tags, ['rust', 'wasm']), 'public room list shows the new category/tags');
      ok(dbq('SELECT category, tags FROM rooms WHERE id = ?', room)[0].category === 'tech', 'category persisted');
      ok((await emit(own.s, 'room:meta', { category: 'nope' })).status === 400, 'bad category rejected on update');
      const cleared = await emit(own.s, 'room:meta', { category: null, tags: [] });
      await sleep(400);
      const pubC = (await fetch(BASE + '/api/rooms').then((r) => r.json())).rooms.find((r) => r.id === room);
      ok(cleared.ok && !('category' in pubC) && !('tags' in pubC), 'category and tags can be cleared');
      ok((await emit(own.s, 'room:meta', { category: 'music', tags: ['lo-fi', 'chill'] })).ok, 'set back for later checks');

      // ---------- 3a. announcement banner ----------
      ok((await emit(pal.s, 'announce:set', { text: 'hi' })).status === 403, 'others cannot set the announcement');
      ok((await emit(mod.s, 'announce:set', { text: 'x'.repeat(301) })).status === 400, 'announcement over 300 chars rejected');
      const annEv = once(pal.s, 'room:announcement', (x) => !!x.announcement, 3000);
      const an = await emit(mod.s, 'announce:set', { text: '**Movie night** at 9, frick yes' });
      ok(an.ok && an.announcement.text.includes('**Movie night**') && !an.announcement.text.includes('frick') && an.announcement.by === 'B3_Mod', 'room mod sets a markdown-lite, word-filtered announcement');
      ok((await annEv.catch(() => null))?.announcement?.at === an.announcement.at, 'members receive room:announcement (with a version stamp for per-user dismiss)');
      ok((await emit(pal.s, 'room:join', { roomId: room })).room.announcement?.text === an.announcement.text, 'announcement is in room state');
      ok(dbq('SELECT announcement FROM rooms WHERE id = ?', room)[0].announcement === an.announcement.text, 'announcement persisted');
      const an2 = await emit(own.s, 'announce:set', { text: '**Movie night** moved to 10' });
      ok(an2.announcement.at >= an.announcement.at && an2.announcement.text !== an.announcement.text, 'a changed announcement gets a new stamp (shows again after dismiss)');

      // ---------- 3b. scheduled messages ----------
      let palSchedules = 0;
      pal.s.on('room:schedules', () => { palSchedules++; });
      ok((await emit(pal.s, 'schedule:create', { text: 'x', at: Date.now() + 5000, repeat: 'once' })).status === 403, 'others cannot schedule');
      ok((await emit(pal.s, 'schedule:list')).status === 403, 'others cannot list schedules');
      ok((await emit(mod.s, 'schedule:create', { text: 'x', at: Date.now() + 5000, repeat: 'hourly' })).status === 400, 'bad repeat rejected');
      ok((await emit(mod.s, 'schedule:create', { text: 'x', at: Date.now() - 1000, repeat: 'once' })).status === 400, 'past time rejected');
      ok((await emit(mod.s, 'schedule:create', { text: 'x', at: Date.now() + 400 * 86_400_000, repeat: 'once' })).status === 400, 'more than a year ahead rejected');
      ok((await emit(mod.s, 'schedule:create', { text: '   ', at: Date.now() + 5000, repeat: 'once' })).status === 400, 'empty text rejected');
      ok((await emit(mod.s, 'schedule:create', { text: 'x'.repeat(501), at: Date.now() + 5000, repeat: 'once' })).status === 400, 'text over 500 rejected');
      const modSched = once(own.s, 'room:schedules', (x) => x.schedules.length >= 1, 3000);
      const onceMsg = once(pal.s, 'chat:message', (m) => m.announce && m.text === 'Movie starts now!', 5000);
      const s1 = await emit(mod.s, 'schedule:create', { text: 'Movie starts now!', at: Date.now() + 1200, repeat: 'once', tz: 'America/New_York' });
      ok(s1.ok && s1.schedule.repeat === 'once' && s1.schedule.by === 'B3_Mod', 'room mod schedules a one-time message');
      ok(!!(await modSched.catch(() => null)), 'managers get the updated schedule list');
      const am = await onceMsg.catch(() => null);
      ok(am?.announce?.by === 'B3_Mod' && am.kind === 'chat', 'the one-time message posts as an announcement attributed to the scheduler');
      await sleep(300);
      ok(!(await emit(mod.s, 'schedule:list')).schedules.some((x) => x.id === s1.schedule.id), 'a one-time schedule is removed after posting');
      ok(palSchedules === 0, 'non-managers never receive the schedule list');
      const late = await mk('B3_Late');
      const hist = (await emit(late.s, 'room:join', { roomId: room })).room.history;
      ok(hist.some((m) => m.id === am?.id && m.announce?.by === 'B3_Mod'), 'announcement lines keep their style in history');
      // daily repeat ("day" = 1.5 s in tests)
      const dailyTexts = [];
      const onDaily = (m) => { if (m.announce && m.text === 'Daily ping') dailyTexts.push(m.ts); };
      pal.s.on('chat:message', onDaily);
      const s2 = await emit(own.s, 'schedule:create', { text: 'Daily ping', at: Date.now() + 1500, repeat: 'daily' });
      ok(s2.ok, `owner schedules a daily message ${s2.error ?? ''}`);
      await sleep(3900);
      const cnt = dailyTexts.length;
      ok(cnt >= 2 && cnt <= 3, `a daily repeat keeps posting on its slot (${cnt} posts)`);
      const l2 = (await emit(own.s, 'schedule:list')).schedules.find((x) => x.id === s2.schedule.id);
      ok(l2 && l2.nextAt > Date.now() - 300, 'the repeat moved to its next slot');
      ok((await emit(own.s, 'schedule:delete', { id: s2.schedule.id })).ok, 'delete a schedule');
      const after = dailyTexts.length;
      await sleep(1800);
      ok(dailyTexts.length === after, 'a deleted schedule stops posting');
      pal.s.off('chat:message', onDaily);
      ok((await emit(own.s, 'schedule:delete', { id: s2.schedule.id })).status === 404, 'deleting twice is 404');
      // catch-up rules (rows as a restart would find them)
      const t0 = Date.now();
      const ins = (id, text, repeat, nextAt) => dbq('INSERT INTO room_schedules (id, room_id, text, repeat, next_at, tz, created_by_user, created_by_nick, created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, room, text, repeat, nextAt, null, own.id, 'B3_Owner', t0);
      const caught = [];
      const onCatch = (m) => { if (m.announce) caught.push(m.text); };
      pal.s.on('chat:message', onCatch);
      ins('late-ok', 'Late but fine', 'once', t0 - 5 * 60_000);
      ins('late-skip', 'Too late', 'once', t0 - 20 * 60_000);
      ins('rep-late', 'Missed repeat', 'daily', t0 - 30 * 60_000);
      await sleep(900);
      pal.s.off('chat:message', onCatch);
      ok(caught.filter((x) => x === 'Late but fine').length === 1, 'a one-time message under 10 min late posts exactly once');
      ok(!caught.includes('Too late') && dbq('SELECT id FROM room_schedules WHERE id = ?', 'late-skip').length === 0, 'a one-time message over 10 min late is skipped and removed');
      const rep = dbq('SELECT next_at FROM room_schedules WHERE id = ?', 'rep-late')[0];
      ok(!caught.includes('Missed repeat') && rep && rep.next_at > t0, 'a long-missed repeat skips ahead to its next slot without flooding');
      dbq('DELETE FROM room_schedules WHERE room_id = ?', room);
      // at most 20 per room
      for (let i = 0; i < 20; i++) ins(`fill-${i}`, `fill ${i}`, 'once', Date.now() + 3600_000 + i);
      ok((await emit(own.s, 'schedule:create', { text: 'one too many', at: Date.now() + 60_000, repeat: 'once' })).status === 409, 'at most 20 scheduled messages per room');
      dbq('DELETE FROM room_schedules WHERE room_id = ?', room);

      // ---------- 2. Labs FM now playing ----------
      const npHits = () => fixHits.filter((x) => x === '/radio/np').length;
      const h0 = npHits();
      await sleep(800);
      ok(npHits() === h0, 'no upstream polling while nobody listens');
      const hereP = once(own.s, 'radio:room', (x) => x.listening === 1, 3000);
      const rl = await emit(pal.s, 'radio:listen', { on: true });
      ok(rl.ok && rl.np?.title === 'Fixture Song' && rl.np.artist === 'Fixture Artist' && rl.np.listeners === 42 && rl.np.station === '7LFM' && rl.np.offline === false, 'listening returns the parsed now-playing data');
      ok(rl.np.duration === 200 && rl.np.elapsed === 30 && typeof rl.np.serverNow === 'number', 'progress fields included');
      ok(/^\/api\/radio\/art\/[a-f0-9]{24}\.webp$/.test(rl.np.artUrl || '') && !JSON.stringify(rl.np).includes('127.0.0.1'), 'album art is proxied (no upstream URL reaches clients)');
      const artRes = await fetch(BASE + rl.np.artUrl);
      const artMeta = await sharpLib(Buffer.from(await artRes.arrayBuffer())).metadata();
      ok(artRes.status === 200 && artRes.headers.get('content-type') === 'image/webp' && artMeta.format === 'webp' && artMeta.width === 160, 'proxied art is re-encoded webp');
      ok((await fetch(BASE + '/api/radio/art/' + '0'.repeat(24) + '.webp')).status === 404, 'unknown art id is 404');
      ok((await hereP.catch(() => null))?.listening === 1, 'room members see how many here are listening');
      const roomNp = once(own.s, 'radio:np', (x) => x.np.title === 'Second Song', 3000);
      radioFix.title = 'Second Song';
      ok((await roomNp.catch(() => null))?.np?.artist === 'Fixture Artist', 'song changes reach the room live (polling while someone listens)');
      ok((await emit(late.s, 'room:join', { roomId: room })).room.radioHere === 1, 'room state carries the listening count');
      radioFix.art = 'https://evil.example/x.jpg';
      const noArt = await once(pal.s, 'radio:np', (x) => x.np.artUrl === null, 3000).catch(() => null);
      ok(!!noArt, 'art from another host is never fetched');
      radioFix.art = '/radio/art.jpg';
      radioFix.mode = '500';
      const off = await once(pal.s, 'radio:np', (x) => x.np.offline === true, 4000).catch(() => null);
      ok(!!off && off.np.title === 'Second Song', 'upstream errors show the station offline (last song kept)');
      radioFix.mode = 'bad';
      await sleep(700);
      ok((await fetch(BASE + '/api/health')).status === 200, 'malformed upstream JSON does not break the server');
      radioFix.mode = 'ok';
      ok(!!(await once(pal.s, 'radio:np', (x) => x.np.offline === false, 4000).catch(() => null)), 'recovers when the station is back');
      const goneP = once(own.s, 'radio:room', (x) => x.listening === 0, 3000);
      await emit(pal.s, 'radio:listen', { on: false });
      ok(!!(await goneP.catch(() => null)), 'stopping updates the room count');
      await sleep(400);
      const h1 = npHits();
      await sleep(900);
      ok(npHits() === h1, 'polling stops when the last listener stops');
      const g1 = await emit(own.s, 'radio:get');
      const g2 = await emit(own.s, 'radio:get');
      ok(g1.ok && g1.np?.title === 'Second Song' && g2.ok && npHits() - h1 <= 1, 'radio:get serves a cached value (one upstream request at most per interval)');
      const lis2 = await emit(mod.s, 'radio:listen', { on: true });
      mod.s.close();
      await sleep(500);
      const h2 = npHits();
      await sleep(900);
      ok(lis2.ok && npHits() === h2, 'a disconnected listener stops the polling');

      // ---------- 4. clip announcements ----------
      ok((await emit(own.s, 'clip:saved', { userId: pal.s.id })).status === 409, 'cannot clip someone who is not streaming');
      ok((await emit(own.s, 'clip:saved', { userId: 'nobody' })).status === 404, 'unknown stream is 404');
      await emit(pal.s, 'media:state', { cam: true, mic: false });
      await sleep(150);
      const clipMsg = once(pal.s, 'chat:message', (m) => m.kind === 'system' && /clipped/.test(m.text), 3000);
      ok((await emit(own.s, 'clip:saved', { userId: pal.s.id })).ok, 'clip of a streaming user is announced');
      ok((await clipMsg.catch(() => ({}))).text === "B3_Owner clipped B3_Pal's stream", 'room sees "X clipped Y\'s stream"');
      await emit(own.s, 'clip:saved', { userId: pal.s.id });
      await emit(own.s, 'clip:saved', { userId: pal.s.id });
      ok((await emit(own.s, 'clip:saved', { userId: pal.s.id })).status === 429, 'clip announcements are rate limited');
      await emit(pal.s, 'media:state', { cam: false, mic: false });

      // ---------- 5. room stats ----------
      for (const t of ['stat one', 'stat two', 'stat three']) await paced(() => say(own, t));
      await paced(() => say(pal, 'pal says hi'));
      ok((await emit(pal.s, 'stats:get')).status === 403, 'others cannot see stats');
      const mod2 = await mk('B3_Mod2');
      await emit(mod2.s, 'room:join', { roomId: room });
      await emit(own.s, 'room:mod', { accountId: mod2.id, on: true });
      const sg = await emit(mod2.s, 'stats:get');
      ok(sg.ok && sg.stats.d7.messages >= 4 && sg.stats.d30.messages >= sg.stats.d7.messages, 'room mods see message counts');
      ok(sg.stats.d7.peak >= 4 && sg.stats.d7.registered >= 5, 'peak concurrent and unique registered visitors are counted');
      ok(sg.stats.d7.top[0]?.username === 'B3_Owner' && sg.stats.d7.top[0].messages === 3 && sg.stats.d7.top.some((t) => t.username === 'B3_Pal'), 'top chatters by registered name');
      const hr = Math.floor(Date.now() / 3600_000);
      ok(sg.stats.hours.some(([h, m]) => h === hr && m >= 4), 'hourly buckets include this hour');
      ok(!sg.stats.d7.top.some((t) => /B3_Mod$/.test(t.username) && t.messages > 0) && !JSON.stringify(sg.stats).includes('announce'), 'announcements are not counted as anyone\'s chat');
      const day = Math.floor(Date.now() / 86_400_000);
      dbq('INSERT INTO room_stats_hourly (room_id, hour, messages, peak) VALUES (?,?,?,?)', room, (day - 10) * 24 + 5, 7, 9);
      dbq('INSERT INTO room_stats_hourly (room_id, hour, messages, peak) VALUES (?,?,?,?)', room, (day - 40) * 24 + 5, 100, 50);
      dbq('INSERT INTO room_stats_daily (room_id, day, guests) VALUES (?,?,?)', room, day, 4);
      dbq('INSERT INTO room_stats_hourly (room_id, hour, messages, peak) VALUES (?,?,?,?)', room, (day - 100) * 24, 1, 1);
      dbq('INSERT INTO room_visitors (room_id, day, user_id, messages) VALUES (?,?,?,?)', room, day - 100, own.id, 5);
      const sg2 = await emit(own.s, 'stats:get');
      ok(sg2.stats.d30.messages === sg2.stats.d7.messages + 7 && sg2.stats.d30.peak === Math.max(9, sg2.stats.d7.peak), '30-day window includes older buckets; 7-day does not');
      ok(sg2.stats.d30.messages < 100 && !sg2.stats.hours.some(([h]) => h < (day - 29) * 24), 'buckets older than 30 days are outside both windows');
      ok(sg2.stats.d7.guests === 4 && sg2.stats.d7.visitors === sg2.stats.d7.registered + 4, 'guests are a bare per-day count added to visitors');
      execFileSync(process.execPath, ['-e', "require('./dist/server/server/repo3.js').pruneStats()"], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, NODE_ENV: 'development' }, stdio: 'ignore' });
      ok(dbq('SELECT COUNT(*) AS n FROM room_stats_hourly WHERE hour < ?', (day - 90) * 24)[0].n === 0 && dbq('SELECT COUNT(*) AS n FROM room_visitors WHERE day < ?', day - 90)[0].n === 0, 'stats older than 90 days are pruned');
      ok(dbq('SELECT COUNT(*) AS n FROM room_stats_hourly WHERE room_id = ? AND hour = ?', room, (day - 40) * 24 + 5)[0].n === 1, 'stats inside 90 days are kept');
      const cols = dbq("SELECT name FROM pragma_table_info('room_stats_daily')").map((r) => r.name);
      ok(same(cols.sort(), ['day', 'guests', 'room_id']), 'nothing about guests is stored beyond a count');

      // ---------- 6. custom emotes ----------
      const upEmote = async (who, roomId, buf, type, name, fname = 'e.png') => {
        const fd = new FormData();
        if (name !== undefined) fd.append('name', name);
        fd.append('emote', new Blob([buf], { type }), fname);
        const r = await fetch(BASE + `/api/rooms/${roomId}/emotes`, { method: 'POST', headers: { 'cf-connecting-ip': who.b.ip, 'x-csrf': '1', cookie: who.b.cookieHeader() }, body: fd });
        return { status: r.status, json: await r.json().catch(() => ({})) };
      };
      const png = await sharpLib({ create: { width: 300, height: 200, channels: 4, background: '#ffcc00ff' } }).png().toBuffer();
      ok((await upEmote(pal, room, png, 'image/png', 'party')).status === 403, 'others cannot upload emotes');
      ok((await upEmote(mod2, room, png, 'image/png', 'party')).status === 403, 'room mods cannot upload emotes (owner/staff only)');
      const anonE = browser(); await anonE.boot();
      ok((await upEmote({ b: anonE }, room, png, 'image/png', 'party')).status === 401, 'signed-out upload refused');
      ok((await upEmote(own, room, png, 'image/png', 'A!')).status === 400 && (await upEmote(own, room, png, 'image/png', 'x')).status === 400 && (await upEmote(own, room, png, 'image/png', 'y'.repeat(25))).status === 400, 'bad emote names rejected');
      ok((await upEmote(own, room, png, 'image/png', 'frick_face')).status === 400, 'emote names are word-filtered');
      ok((await upEmote(own, room, Buffer.from('%PDF-1.4'), 'application/pdf', 'doc', 'x.pdf')).status === 400, 'non-image type rejected');
      ok((await upEmote(own, room, Buffer.alloc(300, 9), 'image/png', 'junk')).status === 400, 'garbage bytes rejected');
      ok((await upEmote(own, room, Buffer.alloc(600 * 1024, 1), 'image/png', 'huge')).status === 400, 'over 512 KB rejected');
      const emEv = once(pal.s, 'room:emotes', (x) => x.emotes.some((e) => e.name === 'party'), 3000);
      const e1 = await upEmote(own, room, png, 'image/png', ':Party:');
      ok(e1.status === 200 && e1.json.emote.name === 'party' && /^\/api\/room-emotes\/[a-f0-9]{32}\.webp$/.test(e1.json.emote.url) && e1.json.emote.animated === false, 'owner uploads an emote (name normalized, random-id URL)');
      ok(!!(await emEv.catch(() => null)), 'room gets the new emote list live');
      const er = await fetch(BASE + e1.json.emote.url);
      const em = await sharpLib(Buffer.from(await er.arrayBuffer())).metadata();
      ok(er.status === 200 && er.headers.get('content-type') === 'image/webp' && em.format === 'webp' && em.width <= 128 && em.height <= 128 && em.width === 128, 'emote served as webp that fits 128px');
      ok(/immutable/.test(er.headers.get('cache-control') || ''), 'emote URL is cacheable');
      const fr = (c) => sharpLib({ create: { width: 64, height: 64, channels: 4, background: c } }).png().toBuffer();
      const gif = await sharpLib([await fr('#f00'), await fr('#0f0'), await fr('#00f')], { join: { animated: true } }).gif().toBuffer();
      const e2 = await upEmote(own, room, gif, 'image/gif', 'blink', 'b.gif');
      const gm = await sharpLib(Buffer.from(await (await fetch(BASE + e2.json.emote?.url)).arrayBuffer()), { animated: true }).metadata();
      ok(e2.json.emote?.animated === true && gm.format === 'webp' && gm.pages === 3, 'animated GIF stays animated (webp)');
      ok((await upEmote(own, room, png, 'image/png', 'party')).status === 409, 'duplicate emote name rejected');
      const staffE = await upEmote({ b: admin }, room, png, 'image/png', 'staff_pick');
      ok(staffE.status === 200, 'site staff can add emotes');
      const ren = await own.b.req(`/api/rooms/${room}/emotes/${e1.json.emote.id}`, { name: 'party_time' }, 'PATCH');
      ok(ren.status === 200 && ren.json.emote.name === 'party_time' && ren.json.emote.url === e1.json.emote.url, 'rename keeps the same URL');
      ok((await own.b.req(`/api/rooms/${room}/emotes/${e1.json.emote.id}`, { name: 'blink' }, 'PATCH')).status === 409, 'rename collision rejected');
      ok((await own.b.req(`/api/rooms/${room}/emotes/${e1.json.emote.id}`, { name: 'Bad Name' }, 'PATCH')).status === 400, 'rename validated');
      ok((await pal.b.req(`/api/rooms/${room}/emotes/${e1.json.emote.id}`, { name: 'mine' }, 'PATCH')).status === 403, 'others cannot rename');
      const list = await fetch(BASE + `/api/rooms/${room}/emotes`).then((r) => r.json());
      ok(same(list.emotes.map((e) => e.name), ['blink', 'party_time', 'staff_pick']), 'emote list (render data) is sorted by name');
      const ej = await emit(late.s, 'room:join', { roomId: room });
      ok(ej.room.emotes?.some((e) => e.name === 'party_time' && e.url === e1.json.emote.url), 'room state carries emotes for :name: rendering');
      // private calls: no emotes
      ok((await emit(own.s, 'friends:request', { username: 'B3_Pal' })).ok && (await emit(pal.s, 'friends:respond', { userId: own.id, accept: true })).ok, 'friends for a call');
      const callR = await emit(own.s, 'call:invite', { userId: pal.id });
      ok(callR.ok && (await upEmote(own, callR.room.id, png, 'image/png', 'secret')).status === 403 && (await fetch(BASE + `/api/rooms/${callR.room.id}/emotes`)).status === 404, 'private calls cannot have or list emotes');
      // at most 50
      for (let i = 0; i < 47; i++) dbq('INSERT INTO room_emotes (id, room_id, name, animated, created_by, created_at) VALUES (?,?,?,?,?,?)', randomBytes(16).toString('hex'), room, `fill_${i}`, 0, own.id, Date.now());
      ok((await upEmote(own, room, png, 'image/png', 'fiftyone')).status === 409, 'at most 50 emotes per room');
      dbq("DELETE FROM room_emotes WHERE room_id = ? AND name LIKE 'fill_%'", room);
      const del = await own.b.req(`/api/rooms/${room}/emotes/${e2.json.emote.id}`, undefined, 'DELETE');
      ok(del.status === 200 && (await fetch(BASE + e2.json.emote.url)).status === 404 && !fs.existsSync(path.join(DATA, 'room-emotes', `${e2.json.emote.id}.webp`)), 'delete removes the emote and its file');

      // ---------- schedules survive a restart ----------
      ok((await emit(own.s, 'schedule:create', { text: 'in a call', at: Date.now() + 5000, repeat: 'once' })).ok === false && (await emit(own.s, 'stats:get')).ok === false, 'private calls have no schedules or stats');
      await emit(own.s, 'room:join', { roomId: room });
      const sr = await emit(own.s, 'schedule:create', { text: 'After restart', at: Date.now() + 2500, repeat: 'once' });
      ok(sr.ok, 'schedule before restart');
      await stopServer();
      await startServer();
      const own2 = track(await own.b.connect());
      ok((await emit(own2, 'login', {})).ok, 'owner back after restart');
      const restartMsg = once(own2, 'chat:message', (m) => m.announce && m.text === 'After restart', 6000);
      const rj = await emit(own2, 'room:join', { roomId: room });
      ok(rj.ok && rj.room.category === 'music' && same(rj.room.tags, ['lo-fi', 'chill']) && rj.room.announcement?.text === an2.announcement.text && rj.room.emotes.length === 2, 'category, tags, announcement and emotes survive a restart');
      ok(!!(await restartMsg.catch(() => null)), 'a scheduled message still fires after a restart');
      own2.close();
      for (const x of [own, pal, late, mod2]) x.s.close();
    }
  }

  // ================= nightly backups =================
  {
    const { DatabaseSync } = await import('node:sqlite');
    const BK = path.join(DATA, 'backups');
    const FREE = path.join(DATA, 'fake-free-bytes');
    const liveDb = () => new DatabaseSync(path.join(DATA, 'camchat.db'), { readOnly: true });
    const q1 = (sql) => { const d = liveDb(); try { return d.prepare(sql).get(); } finally { d.close(); } };
    const archives = () => fs.readdirSync(BK).filter((n) => /^camchat-\d{8}-\d{6}\.tar\.gz$/.test(n)).sort();
    const status = async (b = admin) => (await b.req('/api/admin/backups')).json;
    const waitIdle = async (b = admin, ms = 20000) => {
      const t = Date.now();
      await sleep(150);
      while (Date.now() - t < ms) { const st = await status(b); if (st.status && !st.status.running) return st; await sleep(400); }
      throw new Error('backup never finished');
    };
    let h = await (await fetch(BASE + '/api/health')).json();
    ok('lastBackupAt' in h && h.lastBackupAt === null && h.lastBackupOk === null, 'health has lastBackupAt / lastBackupOk (null before any backup)');
    ok(!Object.keys(h).some((k) => /backup/i.test(k) && k !== 'lastBackupAt' && k !== 'lastBackupOk'), 'health exposes no other backup info');
    const plain = browser(); await plain.boot(); await register(plain, 'Bk_User', 'bk-password-1');
    ok((await browser().req('/api/admin/backups')).status === 401, 'backups list: anonymous 401');
    ok((await plain.req('/api/admin/backups')).status === 403, 'backups list: non-staff 403');
    ok((await plain.req('/api/admin/backups/run', {})).status === 403, 'back up now: non-staff 403');
    ok((await mod.req('/api/admin/reports')).status === 200, 'Mod_Mary is staff (moderator)');
    ok((await mod.req('/api/admin/backups')).status === 403, 'backups list: moderator 403 (admins only)');
    ok((await mod.req('/api/admin/backups/run', {})).status === 403, 'back up now: moderator 403');
    const adminList = await admin.req('/api/admin/backups');
    ok(adminList.status === 200 && Array.isArray(adminList.json.backups), 'admin can list backups');
    // eight old archives already on disk (the rotation must drop the two oldest after the next good backup)
    fs.mkdirSync(BK, { recursive: true });
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `camchat-20200101-00000${i}.tar.gz`);
    for (const n of seeds) fs.writeFileSync(path.join(BK, n), 'old');
    ok((await plain.req(`/api/admin/backups/${seeds[0]}`)).status === 403, 'download: non-staff 403');
    ok((await mod.req(`/api/admin/backups/${seeds[0]}`)).status === 403, 'download: moderator 403');
    ok((await status()).backups.length === 8, 'admin list shows archives on disk');

    // ---- low disk: abort, delete nothing ----
    fs.writeFileSync(FREE, String(1024 ** 3)); // 1 GB "free"
    // a real room icon (site staff may set one on any room), so room-icons/ has something to back up
    {
      const sharpBk = createRequire(path.join(ROOT, 'package.json'))('sharp');
      const fd = new FormData();
      fd.append('icon', new Blob([await sharpBk({ create: { width: 200, height: 200, channels: 3, background: '#3366cc' } }).png().toBuffer()], { type: 'image/png' }), 'icon.png');
      const res = await fetch(BASE + '/api/rooms/lobby/icon', { method: 'POST', headers: { 'cf-connecting-ip': admin.ip, 'x-csrf': '1', cookie: admin.cookieHeader() }, body: fd });
      ok(res.status === 200, 'staff sets a room icon before the backup');
    }
    let r = await admin.req('/api/admin/backups/run', {});
    ok(r.status === 202 && r.json.started, 'admin starts a backup');
    let st = await waitIdle();
    ok(st.status.lastOk === false && /aborted/.test(st.status.lastError || '') && /2 GB/.test(st.status.lastError), 'under 2 GB free: backup aborts and says why');
    ok(archives().length === 8 && seeds.every((n) => fs.existsSync(path.join(BK, n))), 'an aborted backup deletes nothing');
    h = await (await fetch(BASE + '/api/health')).json();
    ok(h.lastBackupOk === false && typeof h.lastBackupAt === 'number', 'health reports the failed attempt');
    ok(/\[backup\] aborted/.test(serverLog), 'abort is logged');
    // over 30% of free space (a sparse 1 GB upload vs 2.5 GB "free")
    fs.writeFileSync(FREE, String(2.5 * 1024 ** 3));
    const big = path.join(DATA, 'uploads', 'sparse-test.bin');
    fs.mkdirSync(path.dirname(big), { recursive: true });
    const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 1024 ** 3); fs.closeSync(fd);
    await sleep(2600); // manual-run gap (test: 2.5 s; production: 10 min)
    ok((await admin.req('/api/admin/backups/run', {})).status === 202, 'second manual run after the gap');
    st = await waitIdle();
    ok(st.status.lastOk === false && /30%/.test(st.status.lastError || '') && archives().length === 8, 'a backup that would use >30% of free space aborts');
    fs.rmSync(big);
    fs.writeFileSync(FREE, String(500 * 1024 ** 3));

    // ---- a good backup + the one-at-a-time guard + the manual rate limit ----
    await sleep(2600);
    r = await admin.req('/api/admin/backups/run', {});
    const r2 = await admin.req('/api/admin/backups/run', {});
    ok(r.status === 202 && r2.status === 409, 'only one backup at a time (second request -> 409)');
    st = await waitIdle();
    ok(st.status.lastOk === true && st.status.lastError === null, 'backup succeeds');
    ok((await admin.req('/api/admin/backups/run', {})).status === 429, 'back up now is rate-limited');
    const names = archives();
    const newest = names[names.length - 1];
    ok(names.length === 7 && !names.includes(seeds[0]) && !names.includes(seeds[1]) && names.includes(seeds[2]) && !seeds.includes(newest), 'rotation keeps the newest 7');
    ok(st.backups[0].name === newest && st.backups[0].ok === true && st.backups[0].size > 1000, 'list shows name, size, time and ok (newest first)');
    ok((fs.statSync(path.join(BK, newest)).mode & 0o777) === 0o640, 'archive mode is 0640');
    ok(!fs.readdirSync(BK).some((n) => n.startsWith('.tmp-')), 'no temp files left behind');
    ok(/\[backup\] VACUUM INTO took \d+ ms/.test(serverLog) && /\[backup\] ok camchat-/.test(serverLog), 'VACUUM duration and result are logged');
    h = await (await fetch(BASE + '/api/health')).json();
    ok(h.lastBackupOk === true && h.lastBackupAt > Date.now() - 60_000, 'health reports the good backup');

    // ---- download + verify the archive ----
    const verify = async (name, label) => {
      const res = await fetch(BASE + `/api/admin/backups/${name}`, { headers: { cookie: admin.cookieHeader(), 'cf-connecting-ip': admin.ip } });
      ok(res.status === 200 && res.headers.get('content-disposition') === `attachment; filename="${name}"` && res.headers.get('content-type') === 'application/gzip', `${label}: download is an attachment`);
      const buf = Buffer.from(await res.arrayBuffer());
      ok(buf.length === fs.statSync(path.join(BK, name)).size, `${label}: full file streamed`);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'camchat-bk-x-'));
      fs.writeFileSync(path.join(tmp, 'a.tar.gz'), buf);
      fs.mkdirSync(path.join(tmp, 'x'));
      execFileSync('tar', ['-xzf', path.join(tmp, 'a.tar.gz'), '-C', path.join(tmp, 'x')]);
      const X = path.join(tmp, 'x');
      const man = JSON.parse(fs.readFileSync(path.join(X, 'manifest.json'), 'utf8'));
      const sha = createHash('sha256').update(fs.readFileSync(path.join(X, 'camchat.db'))).digest('hex');
      ok(man.db.sha256 === sha && man.db.bytes === fs.statSync(path.join(X, 'camchat.db')).size, `${label}: manifest sha256 matches the DB snapshot`);
      ok(man.build === h.build && man.db.userVersion === q1('PRAGMA user_version').user_version, `${label}: manifest has build and user_version`);
      const snap = new DatabaseSync(path.join(X, 'camchat.db'), { readOnly: true });
      try {
        const tables = snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
        ok(['users', 'rooms', 'messages', 'sessions', 'room_emotes', 'room_schedules', 'room_stats_hourly'].every((t) => tables.includes(t)), `${label}: snapshot opens and has the expected tables`);
        const users = snap.prepare('SELECT COUNT(*) AS n FROM users').get().n;
        ok(users > 5 && users === q1('SELECT COUNT(*) AS n FROM users').n && snap.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'Bk_User'").get().n === 1, `${label}: snapshot has the rows (${users} users)`);
        ok(snap.prepare('SELECT COUNT(*) AS n FROM messages').get().n > 10, `${label}: snapshot has messages`);
      } finally { snap.close(); }
      const count = (d) => { try { return fs.readdirSync(path.join(DATA, d), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length; } catch { return 0; } };
      const countX = (d) => { try { return fs.readdirSync(path.join(X, d), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length; } catch { return 0; } };
      ok(['avatars', 'room-thumbs', 'room-icons', 'room-emotes', 'voice', 'sounds', 'uploads'].every((d) => (man.files[d] ?? 0) === countX(d) && countX(d) === count(d)), `${label}: upload folders included and counted (${JSON.stringify(man.files)})`);
      ok(count('room-emotes') > 0 && count('room-thumbs') > 0, `${label}: there were real uploads to back up`);
      ok(count('room-icons') > 0 && countX('room-icons') === count('room-icons'), `${label}: room icons are in the backup`);
      ok(fs.existsSync(path.join(DATA, 'vapid.json')) === fs.existsSync(path.join(X, 'vapid.json')) && !fs.existsSync(path.join(X, '.session_secret')) && !fs.existsSync(path.join(X, 'backups')), `${label}: vapid.json in, session secret and older backups out`);
      fs.rmSync(tmp, { recursive: true, force: true });
      return man;
    };
    const man1 = await verify(newest, 'system tar');
    ok(man1.reason === 'manual', 'manifest records why it ran');
    // ---- traversal / bad names ----
    for (const bad of ['..%2F..%2Fcamchat.db', '..%2Fcamchat.db', 'state.json', `${newest}.part`, '%2E%2E', 'camchat-2020-01-01.tar.gz', encodeURIComponent(`../backups/${newest}`), encodeURIComponent(`${newest}\0`)]) {
      const res = await admin.req(`/api/admin/backups/${bad}`);
      ok(res.status === 404 || res.status === 400, `bad backup name rejected: ${bad} (${res.status})`);
    }
    ok((await admin.req('/api/admin/backups/..%2F..%2F..%2Fetc%2Fpasswd')).status !== 200, 'no path traversal to system files');
    ok((await admin.req(`/api/admin/backups/camchat-29990101-000000.tar.gz`)).status === 404, 'unknown backup 404');

    // ---- restart: state persists; startup catch-up run (archives > 24 h old) with the pure-Node tar writer; nightly slot ----
    const lastAt = h.lastBackupAt;
    const old = (Date.now() - 2 * 86_400_000) / 1000;
    for (const n of archives()) fs.utimesSync(path.join(BK, n), old, old);
    Object.assign(env, { BACKUP_STARTUP_DELAY_MS: '400', BACKUP_TEST_NODE_TAR: '1', BACKUP_TEST_SLOW_MS: '0' });
    await stopServer();
    await startServer();
    h = await (await fetch(BASE + '/api/health')).json();
    ok(h.lastBackupAt === lastAt && h.lastBackupOk === true, 'last backup status survives a restart');
    let startupName = null;
    for (let i = 0; i < 60 && !startupName; i++) { await sleep(250); startupName = archives().find((n) => !names.includes(n)) ?? null; }
    ok(!!startupName, 'startup run when the newest backup is older than 24 h');
    await waitIdle();
    if (startupName) {
      const man2 = await verify(startupName, 'node tar');
      ok(man2.reason === 'startup', 'startup run is labelled');
    }
    ok(archives().length === 7, 'rotation still keeps 7');
    // nightly slot shortened to 1 s (test-only interval); BACKUP_DISABLED=1 turns the automatic runs off
    Object.assign(env, { BACKUP_TEST_EVERY_MS: '1000', BACKUP_STARTUP_DELAY_MS: '600000', BACKUP_TEST_NODE_TAR: '' });
    await stopServer();
    await startServer();
    const before = archives();
    let nightly = null;
    for (let i = 0; i < 40 && !nightly; i++) { await sleep(250); nightly = archives().find((n) => !before.includes(n)) ?? null; }
    ok(!!nightly && archives().length === 7, 'scheduled (nightly) run fires and rotation holds at 7');
    Object.assign(env, { BACKUP_DISABLED: '1' });
    await stopServer();
    await startServer();
    const frozen = archives().join();
    await sleep(2500);
    ok(archives().join() === frozen && /automatic backups disabled/.test(serverLog), 'BACKUP_DISABLED=1 stops automatic runs');
    for (const k of ['BACKUP_TEST_EVERY_MS', 'BACKUP_STARTUP_DELAY_MS', 'BACKUP_TEST_NODE_TAR', 'BACKUP_DISABLED']) delete env[k];
    env.BACKUP_TEST_SLOW_MS = '600';
  }



  // ================= moderation queue (reports) =================
  {
    const dbFile = path.join(DATA, 'camchat.db');
    const dbq = (sql, ...params) => JSON.parse(execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 3000');
      const st = db.prepare(process.argv[2]);
      const params = JSON.parse(process.argv[3]);
      console.log(JSON.stringify(/^\\s*select/i.test(process.argv[2]) ? st.all(...params) : st.run(...params)));
    `, dbFile, sql, JSON.stringify(params)], { stdio: ['ignore', 'pipe', 'inherit'] }).toString());
    let mqIp = 1;
    const mkU = async (name, connect = true) => {
      const b = browser(`203.0.113.${mqIp++}`); await b.boot();
      const reg = await register(b, name, `${name.toLowerCase()}-pass-99`);
      const id = reg.json.account?.id ?? (await b.req('/api/me')).json.account?.id;
      if (!connect) return { b, name, id };
      const s = track(await b.connect());
      ok((await emit(s, 'login', {})).ok, `${name} logs in`);
      return { b, s, name, id };
    };
    const lastSend = new Map();
    const pace = async (s) => { const w = (lastSend.get(s) ?? 0) + 1100 - Date.now(); if (w > 0) await sleep(w); lastSend.set(s, Date.now()); };
    const say = async (p, text, extra = {}) => {
      await pace(p.s);
      const got = once(p.s, 'chat:message', (m) => m.fromId === p.s.id && (extra.burnTtl ? true : m.text === text), 3000);
      const r = await emit(p.s, 'chat:send', { text, ...extra });
      if (!r.ok) { got.catch(() => {}); throw new Error(`send failed: ${r.error}`); }
      return got;
    };
    const join = async (roomId, ...ps) => { for (const p of ps) ok((await emit(p.s, 'room:join', { roomId })).ok, `${p.name} joins`); };
    const report = (p, payload) => emit(p.s, 'report', payload);
    const queue = async (b, status = 'open', sort = 'count') => (await b.req(`/api/admin/reports?view=queue&status=${status}&sort=${sort}`)).json;
    const itemOf = async (b, key, status = 'open') => (await queue(b, status)).items?.find((i) => i.key === key);
    const act = (b, id, body) => b.req(`/api/admin/reports/${id}/action`, body);
    const logFor = (id) => dbq("SELECT actor, action, target, details FROM mod_log WHERE details LIKE ? ORDER BY id", `%report #${id}%`);
    const mkKeys = () => { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); const auth = randomBytes(16); return { ecdh, auth, p256dh: ecdh.getPublicKey().toString('base64url'), authB64: auth.toString('base64url') }; };
    const decrypt = (k, body) => {
      const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
      const secret = k.ecdh.computeSecret(asPub);
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), k.ecdh.getPublicKey(), asPub]);
      const ikm = Buffer.from(hkdfSync('sha256', secret, k.auth, keyInfo, 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
      const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      let i = pt.length - 1; while (i > 0 && pt[i] === 0) i--;
      return JSON.parse(pt.subarray(0, i).toString('utf8'));
    };
    const waitPush = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const h = pushHits.find(pred); if (h) return h; await sleep(50); } return null; };

    // ---- cast ----
    const aS = track(await admin.connect()); ok((await emit(aS, 'login', {})).ok, 'admin socket logs in');
    const A = { b: admin, s: aS, name: 'Root_Admin' };
    const mS = track(await mod.connect()); ok((await emit(mS, 'login', {})).ok, 'moderator socket logs in');
    const M = { b: mod, s: mS, name: 'Mod_Mary' };
    // a staff member who is away but enabled push
    const staffAway = await mkU('MQ_Staff', false);
    ok((await admin.req(`/api/admin/users/${staffAway.id}/role`, { role: 'moderator' })).json.ok, 'MQ_Staff made a moderator');
    const ks = mkKeys();
    ok((await staffAway.b.req('/api/push/subscribe', { endpoint: `${FIX}/push/ok?u=mqstaff`, keys: { p256dh: ks.p256dh, auth: ks.authB64 } })).json.ok, 'away moderator subscribed to push');
    const O = await mkU('MQ_Owner');
    const RM = await mkU('MQ_RoomMod');
    const T = await mkU('MQ_Target');
    const R1 = await mkU('MQ_Rep1');
    const R2 = await mkU('MQ_Rep2');
    const R3 = await mkU('MQ_Rep3');
    const R4 = await mkU('MQ_Rep4');
    const P = await mkU('MQ_Plain');
    const room = (await emit(O.s, 'room:create', { name: 'MQ Room', topic: 'reports' })).roomId;
    await join(room, O, RM, T, R1, R2, R3, R4, P);
    ok((await emit(O.s, 'room:mod', { accountId: RM.id, on: true })).ok, 'owner appoints a room mod');
    const X = await mkU('MQ_Elsewhere');
    const other = (await emit(X.s, 'room:create', { name: 'MQ Other', topic: 'x' })).roomId;
    await join(other, X);
    const staffCounts = [];
    aS.on('modq:counts', (c) => staffCounts.push(c));
    const roomCounts = [];
    RM.s.on('modq:room-counts', (c) => roomCounts.push(c));
    const notices = new Map();
    for (const p of [T, R1, R2, R3, R4, P]) { notices.set(p, []); p.s.on('user:notice', (n) => notices.get(p).push(n)); }
    const waitNotice = async (p, re, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { const n = notices.get(p).find((x) => re.test(x.text)); if (n) return n; await sleep(50); } return null; };

    // ---- validation ----
    await say(T, 'mq context line one');
    await say(O, 'mq context line two');
    const bad = await say(T, 'mq the bad message');
    await say(P, 'mq context after');
    ok((await report(R1, { messageId: bad.id, category: 'nope' })).error === 'Pick a reason', 'report: unknown category refused');
    ok(/500/.test((await report(R1, { messageId: bad.id, category: 'spam', note: 'x'.repeat(501) })).error || ''), 'report: note over 500 characters refused');
    ok(!(await report(T, { messageId: bad.id, category: 'spam' })).ok, 'report: you cannot report your own message');
    ok(!(await report(R1, { messageId: 'no-such-message', category: 'spam' })).ok, 'report: unknown message refused');

    // ---- first report: snapshot, context, notifications ----
    const nCounts = staffCounts.length;
    const r1 = await report(R1, { messageId: bad.id, category: 'spam', note: 'n'.repeat(500), notify: true });
    ok(r1.ok && typeof r1.reportId === 'number' && !r1.updated, 'report: a reporter files a message report (500-char note ok)');
    await sleep(300);
    ok(staffCounts.slice(nCounts).some((c) => c.fresh && c.counts.open >= 1), 'notify: staff get a live modq:counts event flagged fresh');
    ok(roomCounts.some((c) => c.fresh && c.roomId === room && c.counts.open === 1), 'notify: room mods get live room counts for their room');
    const ph = await waitPush((h) => h.path === '/push/ok?u=mqstaff');
    const pp = ph && decrypt(ks, ph.body);
    ok(pp && pp.title === 'New report' && pp.body === 'New report' && !JSON.stringify(pp).includes('mq the bad'), 'notify: away staff with push get a generic "New report" push');
    const row1 = dbq('SELECT * FROM reports WHERE id = ?', r1.reportId)[0];
    const snap1 = JSON.parse(row1.snapshot);
    ok(row1.category === 'spam' && row1.target_kind === 'message' && row1.target_key === `m:${bad.id}` && row1.reporter_user_id === R1.id && row1.notify_reporter === 1, 'report row stores category, target key, reporter and opt-in');
    ok(snap1.text === 'mq the bad message' && snap1.senderNick === 'MQ_Target' && snap1.senderAccountId === T.id && snap1.roomId === room && snap1.roomName === 'MQ Room', 'snapshot has text, sender and room');
    const ctx1 = JSON.parse(row1.context);
    ok(ctx1.length >= 4 && ctx1.length <= 11 && ctx1.find((c) => c.target)?.text === 'mq the bad message' && ctx1.some((c) => c.text === 'mq context line two') && ctx1.some((c) => c.text === 'mq context after'), 'context is the lines around the message (before and after), target marked');

    // ---- dedupe ----
    const r1b = await report(R1, { messageId: bad.id, category: 'harassment', note: 'changed my mind', notify: true });
    ok(r1b.ok && r1b.updated === true && r1b.reportId === r1.reportId, 'dedupe: same reporter + same target updates the existing report');
    const row1b = dbq('SELECT category, reporter_note FROM reports WHERE id = ?', r1.reportId)[0];
    ok(row1b.category === 'harassment' && row1b.reporter_note === 'changed my mind', 'dedupe: category and note updated in place');
    ok(dbq("SELECT COUNT(*) AS n FROM reports WHERE target_key = ?", `m:${bad.id}`)[0].n === 1, 'dedupe: no second row');

    // ---- snapshot survives an edit ----
    await pace(T.s);
    ok((await emit(T.s, 'chat:edit', { messageId: bad.id, text: 'mq edited to look innocent' })).ok, 'sender edits the reported message');
    let it = await itemOf(M.b, `m:${bad.id}`);
    ok(it && it.snapshot.text === 'mq the bad message' && it.context.find((c) => c.target)?.text === 'mq the bad message', 'snapshot survives an edit (queue shows the text at report time)');

    // ---- grouping + permissions ----
    const r2 = await report(R2, { messageId: bad.id, category: 'hate' });
    ok(r2.ok && r2.reportId !== r1.reportId, 'second reporter files on the same message');
    it = await itemOf(M.b, `m:${bad.id}`);
    ok(it && it.count === 2 && it.reporters === 2 && it.categories.harassment === 1 && it.categories.hate === 1 && it.id === r2.reportId, 'grouping: one item per target with count, reporters and categories');
    ok(it && it.reports.map((r) => r.reporterNick).sort().join() === 'MQ_Rep1,MQ_Rep2', 'staff see who reported');
    ok(it && it.hidden === false, 'two reporters do not auto-hide');
    ok((await P.b.req('/api/admin/reports?view=queue')).status === 403, 'permissions: a plain user cannot read the site queue (403)');
    ok((await P.b.req('/api/admin/reports/counts')).status === 403, 'permissions: a plain user cannot read queue counts (403)');
    ok((await act(P.b, r1.reportId, { action: 'dismiss' })).status === 403, 'permissions: a plain user cannot act (403)');
    ok((await P.b.req(`/api/admin/reports/${r1.reportId}/claim`, {})).status === 403, 'permissions: a plain user cannot claim (403)');
    ok((await emit(P.s, 'modq:counts')).status === 403, 'permissions: modq:counts is staff-only');
    ok((await emit(P.s, 'modq:room:list', {})).status === 403, 'permissions: a plain member cannot list room reports');
    ok((await emit(P.s, 'modq:room:act', { reportId: r1.reportId, action: 'delete' })).status === 403, 'permissions: a plain member cannot act on room reports');
    ok((await emit(M.s, 'modq:counts')).counts?.open >= 1, 'staff can fetch counts over the socket');
    const rl = await emit(RM.s, 'modq:room:list', { status: 'open' });
    const rmItem = rl.items?.find((i) => i.key === `m:${bad.id}`);
    ok(rl.ok && rmItem && rmItem.count === 2 && rl.counts.open >= 1, 'room mod sees reports about their room');
    ok(rmItem && rmItem.reports.every((r) => !('reporterNick' in r) && !('reporterUserId' in r)) && !JSON.stringify(rl).includes('MQ_Rep1') && !JSON.stringify(rl).includes('MQ_Rep2'), 'reporter identity is never shown to room mods');
    const ol = await emit(O.s, 'modq:room:list', {});
    ok(ol.ok && ol.items.some((i) => i.key === `m:${bad.id}`) && !JSON.stringify(ol).includes('MQ_Rep1'), 'room owner sees the reports too, without reporter names');

    // ---- auto-hide at 3 distinct registered reporters ----
    const hiddenEv = once(P.s, 'chat:hidden', (x) => x.id === bad.id && x.hidden === true);
    const r3 = await report(R3, { messageId: bad.id, category: 'sexual' });
    ok(r3.ok, 'third reporter files');
    ok(!!(await hiddenEv.catch(() => null)), 'auto-hide: 3 reporters within 10 min hide the message (room told live)');
    ok(dbq('SELECT report_id FROM hidden_messages WHERE message_id = ?', bad.id)[0]?.report_id === r3.reportId, 'auto-hide is stored with the report id');
    ok(logFor(r3.reportId).some((l) => l.action === 'auto-hide' && l.actor === 'auto-safety'), 'auto-hide is in the action log with the report id');
    const pj = await emit(P.s, 'room:join', { roomId: room });
    const ph1 = pj.room?.history.find((m) => m.id === bad.id);
    ok(ph1 && ph1.hidden === true && ph1.text === '', 'auto-hide: others get a collapsed line without the text');
    const oj = await emit(O.s, 'room:join', { roomId: room });
    const oh1 = oj.room?.history.find((m) => m.id === bad.id);
    ok(oh1 && oh1.hidden === true && oh1.text === 'mq edited to look innocent', 'auto-hide: reviewers still see the text, flagged hidden');
    await pace(T.s);
    ok(!(await emit(T.s, 'chat:edit', { messageId: bad.id, text: 'sneaky' })).ok, 'a hidden message cannot be edited');
    ok((await itemOf(M.b, `m:${bad.id}`))?.hidden === true, 'queue shows the item as hidden');

    // ---- claim ----
    ok((await mod.req(`/api/admin/reports/${r1.reportId}/claim`, {})).json.ok, 'claim: a moderator says "I\'m on it"');
    let qOpen = await queue(admin, 'review');
    it = qOpen.items.find((i) => i.key === `m:${bad.id}`);
    ok(it && it.bucket === 'review' && it.claimedBy === 'Mod_Mary' && qOpen.counts.review >= 1, 'claim: the item moves to "in review" with the claimant');
    const c409 = await admin.req(`/api/admin/reports/${r2.reportId}/claim`, {});
    ok(c409.status === 409 && /Mod_Mary/.test(c409.json.error || ''), 'claim: someone else claiming gets 409 naming the claimant');
    ok((await emit(RM.s, 'modq:room:claim', { reportId: r1.reportId })).status === 409, 'claim: room mods get 409 too');
    const r4 = await report(R4, { messageId: bad.id, category: 'other', note: 'fourth' });
    ok(dbq('SELECT claimed_by FROM reports WHERE id = ?', r4.reportId)[0]?.claimed_by === 'Mod_Mary', 'claim: a new report on a claimed item joins the claim');
    ok((await mod.req(`/api/admin/reports/${r1.reportId}/claim`, { release: true })).json.ok && (await itemOf(admin, `m:${bad.id}`, 'open'))?.claimedBy === null, 'claim: release puts it back in open');
    ok((await mod.req(`/api/admin/reports/${r1.reportId}/claim`, {})).json.ok, 'claim again');

    // ---- dismiss undoes the auto-hide ----
    const unhid = once(P.s, 'chat:hidden', (x) => x.id === bad.id && x.hidden === false);
    let ar = await act(mod, r2.reportId, { action: 'dismiss', note: 'satire, fine' });
    ok(ar.json.ok && ar.json.status === 'dismissed' && ar.json.closed === 4, 'dismiss closes every report on the item');
    const uh = await unhid.catch(() => null);
    ok(uh && uh.message?.text === 'mq edited to look innocent', 'dismiss undoes the auto-hide (message restored live)');
    ok(dbq('SELECT COUNT(*) AS n FROM hidden_messages WHERE message_id = ?', bad.id)[0].n === 0, 'hidden row removed');
    const lg = logFor(r2.reportId);
    ok(lg.some((l) => l.action === 'report:dismissed' && l.actor === 'Mod_Mary' && /satire/.test(l.details)) && lg.some((l) => l.action === 'auto-hide-undo'), 'dismiss and auto-hide undo are in the action log with the report id');
    ok(!!(await waitNotice(R1, /reviewed/)), 'reporter who opted in is told "reviewed"');
    ok(notices.get(R2).length === 0, 'reporters who did not opt in hear nothing');
    it = await itemOf(admin, `m:${bad.id}`, 'dismissed');
    ok(it && it.handledBy === 'Mod_Mary' && it.note === 'satire, fine' && it.resolution === 'dismissed' && it.count === 4, 'dismissed tab keeps the item with the resolution note');
    ok((await act(admin, r1.reportId, { action: 'delete' })).status === 409, 'acting on a handled item: 409');

    // ---- evidence: attachments copied, snapshot survives delete ----
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData(); fd.append('image', new Blob([png], { type: 'image/png' }), 'dot.png');
    const up = await (await fetch(BASE + `/api/rooms/${encodeURIComponent(room)}/images`, { method: 'POST', headers: { 'cf-connecting-ip': T.b.ip, 'x-csrf': '1', cookie: T.b.cookieHeader() }, body: fd })).json();
    ok(up.ok, 'target uploads an image');
    const pic = await say(T, `mq look ${up.url}`);
    const re = await report(R1, { messageId: pic.id, category: 'sexual', notify: true });
    ok(re.ok, 'report on a message with an image');
    const snapE = JSON.parse(dbq('SELECT snapshot FROM reports WHERE id = ?', re.reportId)[0].snapshot);
    const ev = snapE.attachments[0];
    ok(ev && ev.kind === 'image' && ev.ref && ev.evidence === `${re.reportId}-${ev.ref}`, 'snapshot records attachment refs and keeps an evidence copy');
    const evUrl = `/api/admin/reports/${re.reportId}/evidence/${ev?.evidence}`;
    ok((await P.b.req(evUrl)).status === 403, 'evidence: plain users 403');
    const evGet = async () => fetch(BASE + evUrl, { headers: { cookie: mod.cookieHeader(), 'cf-connecting-ip': mod.ip } });
    let evr = await evGet();
    ok(evr.status === 200 && /no-store/.test(evr.headers.get('cache-control') || '') && evr.headers.get('x-content-type-options') === 'nosniff', 'evidence: staff 200, private no-store');
    ok((await mod.req(`/api/admin/reports/${re.reportId}/evidence/..%2F..%2Fcamchat.db`)).status === 404 && (await mod.req(`/api/admin/reports/${re.reportId}/evidence/${r1.reportId}-x.webp`)).status === 404, 'evidence: other names 404');
    const delEv = once(P.s, 'chat:deleted', () => true, 3000).catch(() => null);
    ar = await act(admin, re.reportId, { action: 'delete', note: 'nsfw' });
    ok(ar.json.ok && ar.json.resolution === 'message deleted', 'site action: delete');
    await delEv;
    ok(!dbq('SELECT id FROM messages WHERE id = ? AND deleted = 0', pic.id).length, 'the message is gone');
    ok(logFor(re.reportId).some((l) => l.action === 'delete-message' && l.actor === 'Root_Admin'), 'delete is in the action log with the report id');
    it = await itemOf(admin, `m:${pic.id}`, 'resolved');
    ok(it && it.messageGone && it.snapshot.text === `mq look ${up.url}` && it.resolution === 'message deleted' && it.note === 'nsfw', 'snapshot survives delete (resolved tab)');
    evr = await evGet();
    ok(evr.status === 200 && (await evr.arrayBuffer()).byteLength > 20, 'evidence copy survives delete');
    ok(!!(await waitNotice(R1, /took action/)), 'reporter who opted in is told "we took action"');

    // ---- site actions: mute / warn / kick / ban / resolve / unknown / rank ----
    const MU = await mkU('MQ_Mutee'); await join(room, MU);
    const mm = await say(MU, 'mq mute me');
    const rm = await report(R2, { messageId: mm.id, category: 'spam' });
    const mutedEv = once(MU.s, 'mod:muted', () => true, 3000).catch(() => null);
    ok((await act(mod, rm.reportId, { action: 'mute', minutes: 0 })).status === 400, 'mute needs a duration');
    ar = await act(mod, rm.reportId, { action: 'mute', minutes: 15 });
    ok(ar.json.ok && ar.json.resolution === 'muted 15 min' && !!(await mutedEv), 'site action: mute (duration), target told');
    ok(logFor(rm.reportId).some((l) => l.action === 'mute' && /15 min/.test(l.details)), 'mute is in the action log with the report id');
    await pace(MU.s);
    ok(!(await emit(MU.s, 'chat:send', { text: 'still here?' })).ok, 'the muted user cannot chat');

    const wm = await say(T, 'mq rude line');
    const rw = await report(R3, { messageId: wm.id, category: 'harassment' });
    ok((await act(mod, rw.reportId, { action: 'warn' })).status === 400, 'warn needs text');
    ar = await act(mod, rw.reportId, { action: 'warn', reason: 'Please keep it civil' });
    ok(ar.json.ok && ar.json.resolution === 'warned', 'site action: warn');
    const wn = await waitNotice(T, /keep it civil/);
    ok(wn && wn.kind === 'warn' && /^Warning from the moderators/.test(wn.text), 'warned user gets a system notice live');
    ok(logFor(rw.reportId).some((l) => l.action === 'warn'), 'warn is in the action log with the report id');

    const W = await mkU('MQ_Warned', false);
    const rwo = await report(R4, { accountId: W.id, category: 'impersonation', note: 'pretends to be staff' });
    ok(rwo.ok && dbq('SELECT target_kind, target_user_id FROM reports WHERE id = ?', rwo.reportId)[0].target_kind === 'user', 'report a user by account (profile card)');
    ar = await act(admin, rwo.reportId, { action: 'warn', reason: 'Do not impersonate staff' });
    ok(ar.json.ok && /next sign-in/.test(ar.json.resolution), 'warn an offline user: stored for later');
    const wS = track(await W.b.connect());
    const wGot = once(wS, 'user:notice', (n) => /impersonate/.test(n.text), 3000).catch(() => null);
    ok((await emit(wS, 'login', {})).ok, 'warned user signs in');
    ok(!!(await wGot), 'the stored warning is delivered at sign-in');
    ok(dbq('SELECT COUNT(*) AS n FROM user_notices WHERE user_id = ? AND delivered_at IS NULL', W.id)[0].n === 0, 'notice marked delivered');

    const K = await mkU('MQ_Kicky'); await join(room, K);
    const rk = await report(R1, { userId: K.s.id, category: 'harassment' });
    ok(rk.ok && dbq('SELECT target_key FROM reports WHERE id = ?', rk.reportId)[0].target_key === `u:${K.id}`, 'report a user from the people list');
    const kicked = once(K.s, 'room:kicked', () => true, 3000).catch(() => null);
    ar = await act(mod, rk.reportId, { action: 'kick' });
    ok(ar.json.ok && /kicked/.test(ar.json.resolution) && !!(await kicked), 'site action: kick');
    ok(logFor(rk.reportId).some((l) => l.action === 'kick'), 'kick is in the action log with the report id');

    const B = await mkU('MQ_Banned'); await join(room, B);
    const bm = await say(B, 'mq hateful line');
    const rb = await report(R2, { messageId: bm.id, category: 'hate' });
    ar = await act(admin, rb.reportId, { action: 'ban', minutes: 60, reason: 'Hate speech' });
    ok(ar.json.ok && ar.json.resolution === 'banned (60 min)', 'site action: ban (duration, reason)');
    ok(dbq("SELECT COUNT(*) AS n FROM bans WHERE reason = 'Hate speech'")[0].n >= 1, 'ban stored');
    ok(logFor(rb.reportId).some((l) => l.action === 'ban' && /Hate speech/.test(l.details)), 'ban is in the action log with the report id');
    const B2 = await mkU('MQ_Banned2'); await join(room, B2);
    const bm2 = await say(B2, 'mq spam forever');
    const rb2 = await report(R3, { messageId: bm2.id, category: 'spam' });
    ar = await act(admin, rb2.reportId, { action: 'ban', minutes: null });
    ok(ar.json.ok && ar.json.resolution === 'banned (permanent)' && logFor(rb2.reportId).some((l) => l.action === 'ban' && /Reported: Spam/.test(l.details)), 'site action: permanent ban (default reason from the category)');

    await join(room, A);
    const am = await say(A, 'mq admin says hi');
    const ra = await report(R4, { messageId: am.id, category: 'other', note: 'admin abuse' });
    ok((await act(mod, ra.reportId, { action: 'mute', minutes: 5 })).status === 403, 'rank: a moderator cannot punish an admin (403)');
    ok((await act(mod, ra.reportId, { action: 'frobnicate' })).status === 400, 'unknown action: 400');
    ok((await act(mod, 999999, { action: 'dismiss' })).status === 404, 'unknown report: 404');
    ar = await act(mod, ra.reportId, { action: 'resolve', note: 'no rule broken' });
    ok(ar.json.ok && ar.json.status === 'resolved' && logFor(ra.reportId).some((l) => l.action === 'report:resolved' && /no rule broken/.test(l.details)), 'resolve without action, logged with the note');
    aS.emit('room:leave');

    // ---- room level: owners / room mods act with room powers ----
    const RD = await mkU('MQ_RoomDel'); await join(room, RD);
    const rdm = await say(RD, 'mq delete me please');
    const rrd = await report(R1, { messageId: rdm.id, category: 'spam' });
    ok((await emit(RM.s, 'modq:room:act', { reportId: rrd.reportId, action: 'warn', reason: 'x' })).status === 403, 'room: warn is for site staff (403)');
    ok((await emit(RM.s, 'modq:room:claim', { reportId: rrd.reportId })).ok, 'room: a room mod can claim');
    let rr = await emit(RM.s, 'modq:room:act', { reportId: rrd.reportId, action: 'delete', note: 'gone' });
    ok(rr.ok && rr.resolution === 'message deleted', 'room: delete');
    ok(logFor(rrd.reportId).some((l) => l.action === 'delete-message' && l.actor === 'MQ_RoomMod'), 'room delete is logged with the report id');
    const rmu = await say(RD, 'mq room mute me');
    const rrm = await report(R2, { messageId: rmu.id, category: 'spam' });
    rr = await emit(RM.s, 'modq:room:act', { reportId: rrm.reportId, action: 'mute', minutes: 10 });
    ok(rr.ok && rr.resolution === 'room-muted 10 min' && logFor(rrm.reportId).some((l) => l.action === 'room-mute'), 'room: room mute (logged)');
    const RK = await mkU('MQ_RoomKick'); await join(room, RK);
    const rkm = await say(RK, 'mq kick me from the room');
    const rrk = await report(R3, { messageId: rkm.id, category: 'harassment' });
    const rkEv = once(RK.s, 'room:kicked', () => true, 3000).catch(() => null);
    rr = await emit(RM.s, 'modq:room:act', { reportId: rrk.reportId, action: 'kick' });
    ok(rr.ok && !!(await rkEv) && logFor(rrk.reportId).some((l) => l.action === 'kick' && l.actor === 'MQ_RoomMod'), 'room: kick (logged)');
    const RBN = await mkU('MQ_RoomBan'); await join(room, RBN);
    const rbm = await say(RBN, 'mq ban me from the room');
    const rrb = await report(R4, { messageId: rbm.id, category: 'hate' });
    rr = await emit(O.s, 'modq:room:act', { reportId: rrb.reportId, action: 'ban', minutes: 60, reason: 'Not here' });
    ok(rr.ok && rr.resolution === 'room-banned (60 min)' && logFor(rrb.reportId).some((l) => l.action === 'room-ban' && l.actor === 'MQ_Owner'), 'room: the owner bans from the room (logged)');
    ok(!(await emit(RBN.s, 'room:join', { roomId: room })).ok, 'room-banned user cannot rejoin');
    const owm = await say(O, 'mq owner line');
    const rowr = await report(R1, { messageId: owm.id, category: 'other', note: 'owner is rude' });
    ok((await emit(RM.s, 'modq:room:act', { reportId: rowr.reportId, action: 'delete' })).status === 403, "room: a room mod cannot delete the owner's message");
    const xm = await say(X, 'mq elsewhere');
    const rx = await report(R2, { messageId: xm.id, category: 'spam' });
    ok((await emit(RM.s, 'modq:room:act', { reportId: rx.reportId, action: 'delete' })).status === 403, "room: another room's report is refused (403)");
    ok((await emit(RM.s, 'modq:room:claim', { reportId: rx.reportId })).status === 403, "room: cannot claim another room's report");
    const rlAll = await emit(RM.s, 'modq:room:list', { status: 'open' });
    ok(rlAll.ok && rlAll.items.length >= 1 && rlAll.items.every((i) => i.roomId === room && i.kind === 'message'), 'room list holds only message reports from this room');
    const ru = await report(R3, { accountId: T.id, category: 'harassment' });
    ok((await emit(RM.s, 'modq:room:act', { reportId: ru.reportId, action: 'kick' })).status === 403, 'room: user reports are for site staff (403)');
    const rlRes = await emit(RM.s, 'modq:room:list', { status: 'resolved' });
    ok(rlRes.ok && rlRes.items.some((i) => i.key === `m:${rdm.id}` && i.handledBy === 'MQ_RoomMod' && i.note === 'gone'), 'room resolved tab shows the handled item');

    // ---- whisper + burn: only what the reporter saw, marked private ----
    const wStart = await emit(R1.s, 'whisper:start', { userIds: [T.s.id] });
    ok(wStart.ok, 'reporter opens a whisper with the target');
    const wMsg = once(R1.s, 'whisper:message', (m) => m.whisperId === wStart.whisper.id && m.from === 'MQ_Target', 3000);
    ok((await emit(T.s, 'whisper:send', { whisperId: wStart.whisper.id, text: 'mq whisper threat' })).ok, 'target whispers');
    const wm1 = await wMsg;
    ok(!(await report(P, { whisperMessageId: wm1.id, category: 'harassment' })).ok, 'whisper: someone who did not receive it cannot report it');
    const rwh = await report(R1, { whisperMessageId: wm1.id, category: 'harassment' });
    ok(rwh.ok, 'whisper: a recipient reports it');
    const wRow = dbq('SELECT private_kind, target_kind, message_text, target_user_id FROM reports WHERE id = ?', rwh.reportId)[0];
    ok(wRow.private_kind === 'whisper' && wRow.target_kind === 'whisper' && wRow.message_text === 'mq whisper threat' && wRow.target_user_id === T.id, 'whisper: stored with the text, marked private');
    it = await itemOf(admin, `w:${wm1.id}`);
    ok(it && it.snapshot.private === 'whisper' && it.snapshot.text === 'mq whisper threat', 'whisper: staff see it in the queue, marked');
    ok(!(await emit(RM.s, 'modq:room:list', {})).items.some((i) => i.kind === 'whisper') && !JSON.stringify(await emit(O.s, 'modq:room:list', {})).includes('whisper threat'), 'whisper: never shown to room mods or owners');
    const burn = await say(T, 'mq burn secret', { burnTtl: 30 });
    ok((await report(R2, { messageId: burn.id, category: 'harassment' })).error === 'Reveal the message before reporting it', 'burn: cannot report a burn message you have not seen');
    ok((await emit(R2.s, 'chat:reveal', { messageId: burn.id })).ok, 'burn: reporter reveals it');
    const rbu = await report(R2, { messageId: burn.id, category: 'harassment' });
    ok(rbu.ok && dbq('SELECT private_kind, message_text FROM reports WHERE id = ?', rbu.reportId)[0].private_kind === 'burn', 'burn: reportable once seen, marked burn');
    it = await itemOf(admin, `m:${burn.id}`);
    ok(it && it.snapshot.text === 'mq burn secret' && it.snapshot.private === 'burn', 'burn: staff see the text');
    const rmBurn = (await emit(RM.s, 'modq:room:list', {})).items.find((i) => i.key === `m:${burn.id}`);
    ok(rmBurn && rmBurn.snapshot.text === null && !JSON.stringify(rmBurn).includes('burn secret'), 'burn: room mods do not see burn content');

    // ---- room reports ----
    ok(/own room/.test((await report(O, { roomId: room, category: 'spam' })).error || ''), 'room report: the owner cannot report their own room');
    const rro = await report(P, { roomId: room, category: 'sexual', note: 'topic is nsfw' });
    ok(rro.ok, 'room report: a member reports the room');
    it = await itemOf(admin, `r:${room}`);
    ok(it && it.kind === 'room' && it.targetNick === 'MQ_Owner' && it.roomName === 'MQ Room', 'room report shows in the staff queue');
    ok(!(await emit(O.s, 'modq:room:list', {})).items.some((i) => i.kind === 'room'), 'room reports are not shown to the room itself');

    // ---- auto-hide window: reports older than 10 minutes do not count ----
    dbq('INSERT INTO messages (id, room_id, ts, user_id, nick, role, text) VALUES (?,?,?,?,?,?,?)', 'mq-win-1', other, Date.now() - 1000, X.id, X.name, 'user', 'window line');
    const w1 = await report(R1, { messageId: 'mq-win-1', category: 'spam' });
    const w2 = await report(R2, { messageId: 'mq-win-1', category: 'spam' });
    dbq('UPDATE reports SET created_at = ? WHERE id IN (?, ?)', Date.now() - 11 * 60_000, w1.reportId, w2.reportId);
    const w3 = await report(R3, { messageId: 'mq-win-1', category: 'spam' });
    await sleep(200);
    ok(w3.ok && dbq('SELECT COUNT(*) AS n FROM hidden_messages WHERE message_id = ?', 'mq-win-1')[0].n === 0, 'auto-hide: reports older than 10 minutes do not count toward the threshold');

    // ---- rate limit: 10 per hour per user ----
    const RL = await mkU('MQ_RateLim');
    const base = Date.now() - 60_000;
    for (let i = 0; i < 12; i++) dbq('INSERT INTO messages (id, room_id, ts, user_id, nick, role, text) VALUES (?,?,?,?,?,?,?)', `mq-rl-${i}`, other, base + i, X.id, X.name, 'user', `rate line ${i}`);
    const rlRes2 = [];
    for (let i = 0; i < 11; i++) rlRes2.push(await report(RL, { messageId: `mq-rl-${i}`, category: 'spam' }));
    ok(rlRes2.slice(0, 10).every((r) => r.ok) && !rlRes2[10].ok && /lot of reports/.test(rlRes2[10].error || ''), 'rate limit: the 11th report in an hour is refused');
    const again = await report(RL, { messageId: 'mq-rl-0', category: 'hate' });
    ok(again.ok && again.updated, 'rate limit: updating an existing report still works');

    // ---- grouping counts + sorting ----
    const qc = await queue(admin, 'open', 'count');
    ok(qc.items.length === qc.counts.open && qc.items.every((x, i, a) => i === 0 || a[i - 1].count >= x.count), 'sort by count: biggest groups first; tab count matches');
    const qo = await queue(admin, 'open', 'oldest');
    ok(qo.items.length === qc.items.length && qo.items.every((x, i, a) => i === 0 || a[i - 1].firstAt <= x.firstAt), 'sort by age: oldest first');
    const counts = (await admin.req('/api/admin/reports/counts')).json.counts;
    ok(['open', 'review', 'resolved', 'dismissed'].every((k) => typeof counts[k] === 'number') && counts.resolved >= 10 && counts.dismissed >= 1, 'counts for every tab');
    ok((await admin.req('/api/admin/reports?status=open')).json.reports?.length >= 1, 'legacy flat list still works');
    aS.close(); mS.close();
  }


  // ================= smarter lobby: friends online now, active now, jump back in =================
  {
    sockets.forEach((x) => x.close());
    env.ACTIVITY_TICK_MS = '1500';
    await stopServer();
    await startServer();
    const TICK = 1500;
    const dbFile = path.join(DATA, 'camchat.db');
    const dbq = (sql, ...params) => JSON.parse(execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 3000');
      const st = db.prepare(process.argv[2]);
      const params = JSON.parse(process.argv[3]);
      console.log(JSON.stringify(/^\\s*select/i.test(process.argv[2]) ? st.all(...params) : st.run(...params)));
    `, dbFile, sql, JSON.stringify(params)], { stdio: ['ignore', 'pipe', 'inherit'] }).toString());
    let lbIp = 1;
    const mkU = async (name) => {
      const b = browser(`192.0.2.${lbIp++}`); await b.boot();
      const reg = await register(b, name, `${name.toLowerCase()}-pass-99`);
      const id = reg.json.account?.id ?? (await b.req('/api/me')).json.account?.id;
      const s = track(await b.connect());
      ok((await emit(s, 'login', {})).ok, `${name} logs in`);
      return { b, s, name, id };
    };
    const lastSend = new Map();
    const pace = async (s) => { const w = (lastSend.get(s) ?? 0) + 1100 - Date.now(); if (w > 0) await sleep(w); lastSend.set(s, Date.now()); };
    const say = async (p, text) => {
      await pace(p.s);
      const got = once(p.s, 'chat:message', (m) => m.fromId === p.s.id && m.text === text, 3000);
      const r = await Promise.race([emit(p.s, 'chat:send', { text }), sleep(4000).then(() => ({ ok: false, error: `no ack (connected=${p.s.connected})` }))]);
      if (!r.ok) { got.catch(() => {}); throw new Error(`send failed: ${r.error}`); }
      return got;
    };
    const joinR = async (p, roomId, extra = {}) => emit(p.s, 'room:join', { roomId, ...extra });
    const leave = async (p) => { p.s.emit('room:leave'); await sleep(150); };
    const befriend = async (a, b) => {
      ok((await emit(a.s, 'friends:request', { username: b.name })).ok, `${a.name} asks ${b.name}`);
      ok((await emit(b.s, 'friends:respond', { userId: a.id, accept: true })).ok, `${b.name} accepts ${a.name}`);
    };
    const friendsOf = async (p) => (await emit(p.s, 'lobby:friends')).friends;
    const recentOf = async (p) => (await emit(p.s, 'lobby:recent')).rooms;
    const A = await mkU('Lb_Alice');
    const F = await mkU('Lb_Fred');
    const G = await mkU('Lb_Gina');
    const N = await mkU('Lb_Nosy');
    const O = await mkU('Lb_Owner');
    const evs = new Map();
    for (const p of [A, F, G, N]) { evs.set(p, []); p.s.on('lobby:friend', (e) => evs.get(p).push(e)); }
    const waitEv = async (p, pred, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { const e = evs.get(p).find(pred); if (e) return e; await sleep(30); } return null; };

    // ---- friends online now ----
    ok((await friendsOf(A)).length === 0, 'friends row: nobody before any friendship');
    await befriend(A, F);
    await befriend(F, G);
    let fl = await friendsOf(A);
    ok(fl.length === 1 && fl[0].userId === F.id && fl[0].username === 'Lb_Fred' && fl[0].room === null && typeof fl[0].socketId === 'string', 'friends row: an online friend shows with no room while in the lobby');
    const pub = (await emit(O.s, 'room:create', { name: 'Lb Public', topic: 'p' })).roomId;
    ok((await joinR(O, pub)).ok, 'owner opens a public room');
    evs.get(A).length = 0;
    ok((await joinR(F, pub)).ok, 'friend joins the public room');
    let ev = await waitEv(A, (e) => e.userId === F.id && e.entry?.room?.id === pub);
    ok(!!ev && ev.entry.room.name === 'Lb Public', 'friends row: live update with the room when a friend joins a public room');
    fl = await friendsOf(A);
    ok(fl[0]?.room?.id === pub, 'friends row: list shows which room');
    ok((await friendsOf(N)).length === 0 && evs.get(N).length === 0, 'friends row data only goes to friends (a stranger gets nothing)');
    ok(!evs.get(G).some((e) => e.userId === A.id) && !(await friendsOf(G)).some((f) => f.userId === A.id), 'a friend of a friend sees nothing of the viewer');
    // privacy toggle
    ok((await emit(F.s, 'presence:get')).showRoom === true, 'privacy: "show which room I\'m in" defaults to on');
    evs.get(A).length = 0;
    const off = await emit(F.s, 'presence:set', { showRoom: false });
    ok(off.ok && off.showRoom === false && dbq('SELECT show_room FROM users WHERE id = ?', F.id)[0].show_room === 0, 'privacy: toggle off is stored');
    ev = await waitEv(A, (e) => e.userId === F.id);
    ok(ev && ev.entry && ev.entry.room === null, 'privacy: friends are told at once; room hidden, still online');
    fl = await friendsOf(A);
    ok(fl.length === 1 && fl[0].room === null && !JSON.stringify(fl).includes(pub), 'privacy: the room id never reaches friends while hidden');
    ok((await emit(F.s, 'presence:set', { showRoom: true })).showRoom === true && (await friendsOf(A))[0]?.room?.id === pub, 'privacy: toggle back on shows the room again');
    // password room
    await leave(F);
    const pw = (await emit(F.s, 'room:create', { name: 'Lb Secret', topic: 's', password: 'hunter22x' })).roomId;
    ok((await joinR(F, pw, { password: 'hunter22x' })).ok, 'friend enters a password room');
    await sleep(200);
    fl = await friendsOf(A);
    ok(fl.length === 1 && fl[0].room === null && !JSON.stringify(fl).includes(pw) && !evs.get(A).some((e) => e.entry?.room?.id === pw), 'privacy: password rooms are never revealed');
    await leave(F);
    // private call
    const callR = await emit(F.s, 'call:invite', { userId: G.id });
    ok(callR.ok, 'friend starts a private call');
    await sleep(200);
    fl = await friendsOf(A);
    ok(fl.length === 1 && fl[0].room === null && !JSON.stringify(fl).includes(callR.roomId) && !evs.get(A).some((e) => e.entry?.room?.id === callR.roomId), 'privacy: private calls are never revealed');
    ok(dbq('SELECT COUNT(*) AS n FROM recent_rooms WHERE room_id = ?', callR.roomId)[0].n === 0, 'jump back in: private calls are not recorded');
    await emit(G.s, 'call:respond', { roomId: callR.roomId, accept: false });
    await sleep(150);
    ok((await joinR(F, pub)).ok, 'friend back in the public room');
    // blocks, both ways
    evs.get(F).length = 0;
    const bset = await emit(A.s, 'blocks:set', { usernames: ['lb_fred', 'no_such_user_x'] });
    ok(bset.ok && bset.usernames.length === 1 && bset.usernames[0] === 'Lb_Fred', 'blocks: the block list is stored (unknown names dropped)');
    ok((await emit(A.s, 'blocks:get')).usernames.join() === 'Lb_Fred', 'blocks: list comes back on another device');
    ok((await friendsOf(A)).length === 0, 'blocks: the blocker no longer sees the blocked friend');
    ok(!(await friendsOf(F)).some((f) => f.userId === A.id), 'blocks: the blocked friend no longer sees the blocker');
    ev = await waitEv(F, (e) => e.userId === A.id);
    ok(ev && ev.entry === null, 'blocks: the blocked friend is told to drop the blocker');
    evs.get(F).length = 0;
    await leave(A); ok((await joinR(A, pub)).ok, 'blocker moves rooms'); await sleep(200);
    ok(!evs.get(F).some((e) => e.userId === A.id && e.entry), 'blocks: no presence updates to someone you blocked');
    await leave(A);
    ok((await emit(A.s, 'blocks:set', { usernames: [] })).usernames.length === 0 && (await friendsOf(A)).length === 1, 'blocks: unblocking restores the row');
    ok((await emit(F.s, 'blocks:set', { usernames: ['Lb_Alice'] })).ok && (await friendsOf(A)).length === 0, 'blocks: being blocked hides them too (other direction)');
    await emit(F.s, 'blocks:set', { usernames: [] });
    ok((await friendsOf(A)).length === 1, 'blocks: cleared both ways');
    // offline
    evs.get(A).length = 0;
    G.s.close();
    await sleep(300);
    ok(!(await friendsOf(F)).some((f) => f.userId === G.id), 'friends row: a friend who goes offline drops off');

    // ---- active now: score, ordering, throttle ----
    const L = await mkU('Lb_Lobbyist');
    const W = await mkU('Lb_Talker');
    const quiet = (await emit(W.s, 'room:create', { name: 'Lb Quiet', topic: 'q' })).roomId;
    const busy = (await emit(O.s, 'room:create', { name: 'Lb Busy', topic: 'b' })).roomId;
    await leave(O);
    ok((await joinR(W, quiet)).ok, 'one person in the quiet room');
    ok((await joinR(O, busy)).ok && (await joinR(N, busy)).ok, 'two people in the busy room');
    for (let i = 0; i < 4; i++) await say(i % 2 ? N : O, `lb busy line ${i}`);
    const roomEv = [];
    L.s.on('rooms', (list) => roomEv.push({ t: Date.now(), list }));
    await sleep(TICK + 400);
    let list = (await emit(L.s, 'rooms:list')).rooms;
    let qR = list.find((r) => r.id === quiet), bR = list.find((r) => r.id === busy);
    ok(bR?.activity === 6 && bR.active === true, `activity: people + messages in 10 min + live = 2 + 4 + 0 (${bR?.activity}), 🔥 active`);
    ok(qR?.activity === 1 && !qR.active, `activity: a quiet room scores 1 and is not active (${qR?.activity})`);
    ok(bR.activity > qR.activity, 'activity ordering: the busy room outranks the quiet one');
    // throttle: burst of messages, scores change at most once per tick
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) await say(i % 2 ? N : O, `lb burst ${i}`);
    await sleep(TICK + 400);
    const changes = [];
    let prev = 6;
    for (const e of roomEv) { const v = e.list.find((r) => r.id === busy)?.activity; if (v != null && v !== prev) { changes.push(e.t); prev = v; } }
    const gaps = changes.slice(1).map((t, i) => t - changes[i]);
    ok(prev === 10, `activity: the burst is counted (${prev})`);
    ok(changes.length >= 1 && changes.length <= Math.ceil((Date.now() - t0) / TICK) + 1 && gaps.every((g) => g >= TICK - 200), `activity throttle: score changes at most once per tick (${changes.length} changes, gaps ${gaps.join(',')})`);
    const fresh = Date.now();
    await say(O, 'lb one more');
    const immediate = (await emit(L.s, 'rooms:list')).rooms.find((r) => r.id === busy).activity;
    const settled = await (async () => { await sleep(TICK + 400); return (await emit(L.s, 'rooms:list')).rooms.find((r) => r.id === busy).activity; })();
    ok(settled === 11 && (immediate === 10 || Date.now() - fresh >= TICK), `activity: a new message shows up on the next tick, not per request (${immediate} -> ${settled})`);
    ok(roomEv.every((e, i) => i === 0 || e.t - roomEv[i - 1].t >= 200), 'room list broadcasts stay debounced');

    // ---- jump back in ----
    for (const p of [A]) await leave(p);
    ok((await joinR(A, quiet)).ok, 'Alice visits the quiet room'); await leave(A);
    ok((await joinR(A, busy)).ok, 'Alice visits the busy room'); await leave(A);
    let rec = await recentOf(A);
    ok(rec.length >= 2 && rec[0].id === busy && rec[1].id === quiet && rec[0].visitedAt >= rec[1].visitedAt, 'jump back in: most recent first');
    ok(rec[0].name === 'Lb Busy' && rec[0].unread === 0 && rec[0].mentions === 0 && typeof rec[0].users === 'number', 'jump back in: name, people, last visit, nothing unread right after leaving');
    await say(W, 'hello quiet room');
    await say(W, 'hey @Lb_Alice come back');
    rec = await recentOf(A);
    const q1 = rec.find((r) => r.id === quiet);
    ok(q1 && q1.unread === 2 && q1.mentions === 1, `jump back in: unread and mention counts since the visit (${q1?.unread}/${q1?.mentions})`);
    ok((await joinR(A, quiet)).ok, 'Alice returns'); await leave(A);
    rec = await recentOf(A);
    ok(rec[0].id === quiet && rec[0].unread === 0 && dbq('SELECT COUNT(*) AS n FROM recent_rooms WHERE user_id = ? AND room_id = ?', A.id, quiet)[0].n === 1, 'jump back in: a revisit moves it to the front (deduped, counts reset)');
    ok((await recentOf(N)).every((r) => r.id !== quiet), 'jump back in is per account');
    // shown limit + rooms that no longer exist
    for (let u = 0; u < 3; u++) {
      const maker = await mkU(`Lb_Maker${u}`);
      for (let k = 0; k < 3; k++) ok((await emit(maker.s, 'room:create', { name: `Lb Spare ${u}${k}`, topic: 'spare' })).ok, `spare room ${u}${k}`);
    }
    const real = (await emit(L.s, 'rooms:list')).rooms.filter((r) => !r.passwordRequired && r.id !== quiet && r.id !== busy).slice(0, 10).map((r) => r.id);
    const base = Date.now() - 60_000;
    real.forEach((id, i) => dbq('INSERT OR REPLACE INTO recent_rooms (user_id, room_id, visited_at) VALUES (?,?,?)', N.id, id, base + i * 10));
    dbq('INSERT OR REPLACE INTO recent_rooms (user_id, room_id, visited_at) VALUES (?,?,?)', N.id, 'gone-room-xyz', Date.now());
    const nrec = await recentOf(N);
    ok(real.length >= 9 && nrec.length === 8 && !nrec.some((r) => r.id === 'gone-room-xyz') && nrec.filter((r) => r.id !== busy)[0].id === real[real.length - 1], `jump back in: last 8 shown, rooms that no longer exist skipped (${nrec.length})`);
    // prune to 20 per account
    for (let i = 0; i < 25; i++) dbq('INSERT OR REPLACE INTO recent_rooms (user_id, room_id, visited_at) VALUES (?,?,?)', A.id, `old-${i}`, 1000 + i);
    await leave(A); ok((await joinR(A, quiet)).ok, 'a visit triggers the prune'); await leave(A);
    const kept = dbq('SELECT room_id FROM recent_rooms WHERE user_id = ? ORDER BY visited_at DESC', A.id).map((r) => r.room_id);
    ok(kept.length === 20 && kept[0] === quiet && !kept.includes('old-0') && kept.includes('old-24'), `jump back in: pruned to 20 per account, oldest dropped (${kept.length})`);
    // removal
    ok((await emit(A.s, 'lobby:recent:remove', { roomId: busy })).ok && !(await recentOf(A)).some((r) => r.id === busy), 'jump back in: ✕ removes a room');
    ok(dbq('SELECT COUNT(*) AS n FROM recent_rooms WHERE user_id = ? AND room_id = ?', A.id, busy)[0].n === 0, 'removal is stored');
    // banned rooms are skipped
    ok((await joinR(A, busy)).ok, 'Alice visits the busy room again');
    await sleep(100);
    ok((await emit(O.s, 'room:ban', { userId: A.s.id, minutes: 10, reason: 'lobby test' })).ok, 'the owner bans Alice from the room');
    await sleep(300);
    ok(dbq('SELECT COUNT(*) AS n FROM recent_rooms WHERE user_id = ? AND room_id = ?', A.id, busy)[0].n === 1 && !(await recentOf(A)).some((r) => r.id === busy), 'jump back in: rooms you are banned from are skipped');
    // deleted rooms disappear
    ok((await emit(W.s, 'room:delete')).ok, 'the quiet room is deleted');
    await sleep(300);
    ok(!(await recentOf(A)).some((r) => r.id === quiet) && dbq('SELECT COUNT(*) AS n FROM recent_rooms WHERE room_id = ?', quiet)[0].n === 0, 'jump back in: deleted rooms are removed');
    // across devices: the list is stored server-side, so another browser for the same account sees it
    const before = (await recentOf(A)).map((r) => r.id).join();
    const A2b = browser(`192.0.2.${lbIp++}`); await A2b.boot();
    ok((await A2b.req('/api/auth/login', { username: 'Lb_Alice', password: 'lb_alice-pass-99' })).json.ok, 'Alice signs in on another device');
    const A2s = track(await A2b.connect()); await emit(A2s, 'login', {});
    const other = (await emit(A2s, 'lobby:recent')).rooms.map((r) => r.id).join();
    ok(other.length > 0 && other === before, 'jump back in works across devices (stored server-side)');

    // ================= add-on: custom room icons (room rail / header / lobby) =================
    {
      const sharpLib = createRequire(path.join(ROOT, 'package.json'))('sharp');
      const cols = dbq("SELECT name FROM pragma_table_info('rooms')").map((r) => r.name);
      ok(cols.includes('icon_id') && cols.includes('icon_at') && cols.includes('thumb_id'), 'rooms has icon_id / icon_at columns, separate from the thumbnail');
      const io1 = await mkU('Icon_Owner'); const io2 = await mkU('Icon_Other'); const iol = await mkU('Icon_Lobby');
      const room = (await emit(io1.s, 'room:create', { name: 'Icon Room', topic: 'icons' })).roomId;
      const up = async (who, roomId, buf, type, name = 'i.png') => {
        const fd = new FormData();
        fd.append('icon', new Blob([buf], { type }), name);
        const r = await fetch(BASE + `/api/rooms/${roomId}/icon`, { method: 'POST', headers: { 'cf-connecting-ip': who.b.ip, 'x-csrf': '1', cookie: who.b.cookieHeader() }, body: fd });
        return { status: r.status, json: await r.json().catch(() => ({})) };
      };
      const del = (who, roomId) => who.b.req(`/api/rooms/${roomId}/icon`, undefined, 'DELETE');
      const jpg = await sharpLib({ create: { width: 800, height: 500, channels: 3, background: '#ff8800' } }).jpeg().toBuffer();
      const listEv = once(iol.s, 'rooms', (l) => l.some((x) => x.id === room && x.iconUrl), 3000);
      const u1 = await up(io1, room, jpg, 'image/jpeg', 'logo.jpg');
      ok(u1.status === 200 && /^\/api\/room-icons\/[a-f0-9]{32}\.webp$/.test(u1.json.iconUrl || ''), 'owner uploads a room icon (random id URL)');
      ok((await listEv.catch(() => null))?.find((x) => x.id === room)?.iconUrl === u1.json.iconUrl, 'room-list broadcast carries the icon live');
      const res = await fetch(BASE + u1.json.iconUrl);
      const meta = await sharpLib(Buffer.from(await res.arrayBuffer())).metadata();
      ok(res.status === 200 && res.headers.get('content-type') === 'image/webp' && meta.format === 'webp' && meta.width === 128 && meta.height === 128, 'served icon is a 128x128 webp (cover crop of a 800x500 jpeg)');
      ok(/public/.test(res.headers.get('cache-control') || '') && /immutable/.test(res.headers.get('cache-control') || ''), 'icon URL is cacheable');
      ok(fs.existsSync(path.join(DATA, 'room-icons', u1.json.iconUrl.split('/').pop())), 'stored under DATA_DIR/room-icons');
      ok((await fetch(BASE + '/api/rooms').then((r) => r.json())).rooms.find((x) => x.id === room)?.iconUrl === u1.json.iconUrl && !(await fetch(BASE + '/api/rooms').then((r) => r.json())).rooms.find((x) => x.id === room)?.thumbUrl, 'room list carries iconUrl, thumbnail untouched');
      const st = await emit(io2.s, 'room:join', { roomId: room });
      ok(st.ok && st.room.iconUrl === u1.json.iconUrl, 'room state carries iconUrl');
      // permissions
      ok((await up(io2, room, jpg, 'image/jpeg')).status === 403 && (await del(io2, room)).status === 403, 'non-owner cannot set or remove the icon');
      ok((await emit(io1.s, 'room:join', { roomId: room })).ok && (await emit(io1.s, 'room:mod', { accountId: io2.id, on: true })).ok, 'owner makes a room mod');
      ok((await up(io2, room, jpg, 'image/jpeg')).status === 403, 'room mods cannot change the icon (owner/staff only)');
      const anon = browser(`192.0.2.${lbIp++}`); await anon.boot();
      ok((await up({ b: anon }, room, jpg, 'image/jpeg')).status === 401, 'signed-out upload is refused');
      ok((await up(io1, 'no-such-room', jpg, 'image/jpeg')).status === 404, 'unknown room is 404');
      // replace with a GIF -> first frame, new id, old URL gone, members told
      const gif = await sharpLib({ create: { width: 64, height: 300, channels: 4, background: '#11cc88ff' } }).gif().toBuffer();
      const ev = once(io2.s, 'room:icon', (x) => !!x.iconUrl && x.iconUrl !== u1.json.iconUrl, 3000);
      const u2 = await up(io1, room, gif, 'image/gif', 'a.gif');
      ok(u2.json.ok && u2.json.iconUrl !== u1.json.iconUrl, 'replace: a GIF is accepted and gets a new id');
      ok((await ev.catch(() => null))?.iconUrl === u2.json.iconUrl, 'room members receive room:icon');
      ok((await fetch(BASE + u1.json.iconUrl)).status === 404 && !fs.existsSync(path.join(DATA, 'room-icons', u1.json.iconUrl.split('/').pop())), 'replace: old URL 404 and old file deleted');
      const m2 = await sharpLib(Buffer.from(await (await fetch(BASE + u2.json.iconUrl)).arrayBuffer())).metadata();
      ok(m2.format === 'webp' && m2.width === 128 && m2.height === 128 && !(m2.pages > 1), 'GIF re-encoded to a static 128x128 webp');
      // validation
      const bt = await up(io1, room, Buffer.from('%PDF-1.4 x'), 'application/pdf', 'x.pdf');
      ok(bt.status === 400 && /PNG|JPEG|WebP|GIF/.test(bt.json.error || ''), 'non-image type rejected');
      ok((await up(io1, room, Buffer.alloc(300, 9), 'image/png', 'f.png')).status === 400, 'garbage bytes rejected');
      const big = await up(io1, room, Buffer.alloc(2 * 1024 * 1024 + 10, 1), 'image/png', 'big.png');
      ok(big.status === 400 && /too large/i.test(big.json.error || ''), 'over 2 MB rejected');
      ok((await fetch(BASE + u2.json.iconUrl)).status === 200, 'failed uploads keep the current icon');
      ok((await fetch(BASE + '/api/room-icons/' + 'c'.repeat(32) + '.webp')).status === 404 && (await fetch(BASE + '/api/room-icons/..%2Fcamchat.db.webp')).status === 404, 'unknown or malformed icon ids are 404');
      // staff
      const su = await up({ b: admin }, room, jpg, 'image/jpeg');
      ok(su.status === 200 && su.json.ok, 'site staff can set any room icon');
      // remove
      const rmEv = once(iol.s, 'rooms', (l) => l.some((x) => x.id === room && !x.iconUrl), 3000);
      const rm = await del(io1, room);
      ok(rm.status === 200 && rm.json.iconUrl === null && !!(await rmEv.catch(() => null)), 'owner removes the icon; lobbies see it live');
      ok((await fetch(BASE + su.json.iconUrl)).status === 404 && dbq('SELECT icon_id FROM rooms WHERE id = ?', room)[0].icon_id === null, 'removed: URL 404 and column cleared');
      ok((await del({ b: admin }, 'lobby')).status === 200 && !(await emit(iol.s, 'rooms:list')).rooms.find((x) => x.id === 'lobby').iconUrl, 'staff can remove an icon (the backup test one)');
      // jump back in carries the icon
      const u3 = await up(io1, room, jpg, 'image/jpeg');
      await leave(io2);
      ok((await emit(io2.s, 'lobby:recent')).rooms.find((r) => r.id === room)?.iconUrl === u3.json.iconUrl, 'jump back in rows carry the icon');
      // private calls: no icon allowed, a forced value never served or listed
      ok((await emit(io1.s, 'friends:request', { username: 'Icon_Lobby' })).ok && (await emit(iol.s, 'friends:respond', { userId: io1.id, accept: true })).ok, 'friends for a call');
      await leave(io1);
      const call = await emit(io1.s, 'call:invite', { userId: iol.id });
      ok(call.ok && call.room?.isPrivate, 'private call room created');
      ok((await up(io1, call.room.id, jpg, 'image/jpeg')).status === 403, 'private calls cannot get an icon');
      const forced = 'd'.repeat(32);
      fs.copyFileSync(path.join(DATA, 'room-icons', u3.json.iconUrl.split('/').pop()), path.join(DATA, 'room-icons', `${forced}.webp`));
      dbq('UPDATE rooms SET icon_id = ? WHERE id = ?', forced, call.room.id);
      ok((await fetch(BASE + `/api/room-icons/${forced}.webp`)).status === 404, 'a private call icon is never served');
      ok(!JSON.stringify((await emit(io2.s, 'rooms:list')).rooms).includes(forced), 'and never listed');
      dbq('UPDATE rooms SET icon_id = NULL WHERE id = ?', call.room.id);
      fs.unlinkSync(path.join(DATA, 'room-icons', `${forced}.webp`));
      await emit(iol.s, 'call:respond', { roomId: call.room.id, accept: false });
      // shared rate limit with thumbnails: thumbnail changes count against icon changes
      const r2 = (await emit(io2.s, 'room:create', { name: 'Icon Limits', topic: 'x' })).roomId;
      for (let i = 0; i < 6; i++) await io2.b.req(`/api/rooms/${r2}/thumb`, undefined, 'DELETE');
      let lastS = 0;
      for (let i = 0; i < 5; i++) lastS = (await del(io2, r2)).status;
      ok(lastS === 429, 'icon changes share the thumbnail rate limit');
      // deleting the room deletes the file
      const f3 = path.join(DATA, 'room-icons', u3.json.iconUrl.split('/').pop());
      ok((await emit(io1.s, 'room:join', { roomId: room })).ok && fs.existsSync(f3) && (await emit(io1.s, 'room:delete')).ok, 'owner deletes a room with an icon');
      await sleep(100);
      ok(!fs.existsSync(f3) && (await fetch(BASE + u3.json.iconUrl)).status === 404, 'deleting the room deletes its icon');
    }
    delete env.ACTIVITY_TICK_MS;
  }


  // ================= invite links + share preview cards =================
  {
    sockets.forEach((x) => x.close());
    const sharpLib = createRequire(path.join(ROOT, 'package.json'))('sharp');
    const dbFile = path.join(DATA, 'camchat.db');
    const dbq = (sql, ...params) => JSON.parse(execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 3000');
      const st = db.prepare(process.argv[2]);
      const params = JSON.parse(process.argv[3]);
      console.log(JSON.stringify(/^\\s*select/i.test(process.argv[2]) ? st.all(...params) : st.run(...params)));
    `, dbFile, sql, JSON.stringify(params)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    let ivIp = 1;
    const mkI = async (name) => {
      const b = browser(`100.64.7.${ivIp++}`); await b.boot();
      const reg = await register(b, name, `${name.toLowerCase()}-pass-99`);
      const id = reg.json.account?.id ?? (await b.req('/api/me')).json.account?.id;
      const s = track(await b.connect());
      ok((await emit(s, 'login', {})).ok, `${name} logs in`);
      return { b, s, name, id };
    };
    const inv = (who, roomId, body = {}) => who.b.req(`/api/rooms/${roomId}/invites`, { expires: '1d', maxUses: null, ...body });
    const redeem = (who, code) => who.b.req(`/api/invites/${code}/redeem`, {});
    const look = async (code) => (await fetch(BASE + `/api/invites/${code}`, { headers: { 'cf-connecting-ip': '100.64.9.1' } }).then((r) => r.json())).invite;
    const page = async (p) => { const r = await fetch(BASE + p, { headers: { 'user-agent': 'Discordbot/2.0', 'cf-connecting-ip': '100.64.9.2' } }); return { status: r.status, cc: r.headers.get('cache-control'), type: r.headers.get('content-type') || '', html: await r.text() }; };
    const meta = (html, prop) => { const m = new RegExp(`<meta (?:property|name)="${prop.replace(/[.:]/g, (c) => `\\${c}`)}" content="([^"]*)"`).exec(html); return m ? m[1] : null; };
    const cols = dbq("SELECT name FROM pragma_table_info('rooms')").map((r) => r.name);
    const tables = dbq("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    ok(cols.includes('mods_can_invite') && tables.includes('room_invites') && tables.includes('room_invite_uses'), 'invite tables and the rooms.mods_can_invite column exist');

    const O = await mkI('Iv_Owner'); const X = await mkI('Iv_Other'); const M = await mkI('Iv_Mod'); const U = await mkI('Iv_User'); const V = await mkI('Iv_Visitor');
    const R = (await emit(O.s, 'room:create', { name: 'Invite Lounge', topic: 'Say "hi" <b>here</b>', category: 'music', tags: ['lofi', 'chill'] })).roomId;
    const PR = (await emit(O.s, 'room:create', { name: 'Secret Den', topic: 'hidden topic text', password: 'sekrit-pw-1' })).roomId;
    ok(!!R && !!PR, 'owner opens a public and a password room');
    ok((await emit(O.s, 'room:join', { roomId: R })).ok && (await emit(O.s, 'room:mod', { accountId: M.id, on: true })).ok, 'owner makes a room mod');

    // ---- create + code format + uniqueness ----
    const c1 = await inv(O, R);
    ok(c1.status === 200 && /^[A-Za-z0-9]{12}$/.test(c1.json.invite.code) && c1.json.url.endsWith(`/i/${c1.json.invite.code}`), 'owner creates an invite: 12-char base62 code, /i/<code> URL');
    ok(c1.json.invite.expiresAt > Date.now() + 23 * 3600_000 && c1.json.invite.maxUses === null && c1.json.invite.uses === 0, 'defaults: 1 day, unlimited');
    const codes = new Set([c1.json.invite.code]);
    for (const [e, mu] of [['30m', 1], ['1h', 5], ['7d', 10], ['never', 25], ['1d', 100]]) {
      const r = await inv(O, R, { expires: e, maxUses: mu });
      ok(r.status === 200 && r.json.invite.maxUses === mu && (e === 'never' ? r.json.invite.expiresAt === null : r.json.invite.expiresAt > Date.now()), `expiry ${e} / max uses ${mu} accepted`);
      codes.add(r.json.invite.code);
    }
    ok(codes.size === 6 && dbq('SELECT COUNT(DISTINCT code) AS n FROM room_invites WHERE room_id = ?', R)[0].n === 6, 'codes are unique');
    ok((await inv(O, R, { expires: '2d' })).status === 400 && (await inv(O, R, { maxUses: 7 })).status === 400, 'only the listed expiries and max uses are accepted');
    const logs = dbq("SELECT details FROM mod_log WHERE action = 'invite-create' AND room_id = ?", R);
    ok(logs.length === 6 && logs.every((l) => !l.details.includes(c1.json.invite.code)), 'creation goes to the action log (code shortened)');

    // ---- permissions ----
    ok((await inv(X, R)).status === 403, 'a non-owner cannot create invites');
    const anon = browser('100.64.8.1'); await anon.boot();
    ok((await anon.req(`/api/rooms/${R}/invites`, { expires: '1d', maxUses: null })).status === 401, 'signed-out cannot create invites');
    ok((await inv(M, R)).status === 403 && (await M.b.req(`/api/rooms/${R}/invites`)).status === 403, 'a room mod cannot while the setting is off (default)');
    ok((await M.b.req(`/api/rooms/${R}/invite-settings`, { modsCanInvite: true }, 'PATCH')).status === 403, 'room mods cannot change the setting');
    const setEv = once(M.s, 'room:inviteSettings', (p) => p.modsCanInvite === true, 3000);
    await emit(M.s, 'room:join', { roomId: R });
    ok((await O.b.req(`/api/rooms/${R}/invite-settings`, { modsCanInvite: true }, 'PATCH')).json.modsCanInvite === true, 'owner turns on "room mods can create invites"');
    ok(!!(await setEv.catch(() => null)), 'the room hears the setting change');
    const mInv = await inv(M, R);
    ok(mInv.status === 200, 'the room mod can create invites now');
    ok((await inv(M, R, { skipPassword: true })).status === 403, 'room mods cannot make password-skipping links');
    ok((await M.b.req(`/api/rooms/${R}/invites/${c1.json.invite.code}`, undefined, 'DELETE')).status === 403, "room mods cannot revoke the owner's links");
    const mList = await M.b.req(`/api/rooms/${R}/invites`);
    ok(mList.json.invites.find((i) => i.code === mInv.json.invite.code)?.canRevoke === true && mList.json.invites.find((i) => i.code === c1.json.invite.code)?.canRevoke === false && mList.json.canSkipPassword === false, 'mods see the list; revoke only their own');
    const sInv = await admin.req(`/api/rooms/${PR}/invites`, { expires: '1d', maxUses: null, skipPassword: true });
    ok(sInv.status === 200 && sInv.json.invite.skipPassword === true, 'site staff can create (and skip the password) on any room');
    ok((await O.b.req(`/api/rooms/${R}/invite-settings`, { modsCanInvite: false }, 'PATCH')).json.modsCanInvite === false && (await inv(M, R)).status === 403, 'turning it off stops room mods again');
    ok((await emit(O.s, 'friends:request', { username: 'Iv_Other' })).ok && (await emit(X.s, 'friends:respond', { userId: O.id, accept: true })).ok, 'friends for a private call');
    O.s.emit('room:leave'); await sleep(150);
    const call = await emit(O.s, 'call:invite', { userId: X.id });
    ok(call.ok && (await inv(O, call.room.id)).status === 403, 'private calls cannot have invite links');

    // ---- landing lookup (signed out) ----
    const pub = await look(c1.json.invite.code);
    ok(pub.status === 'ok' && pub.room.name === 'Invite Lounge' && pub.room.topic.includes('Say') && typeof pub.room.users === 'number' && pub.room.category === 'music', 'anyone with the link sees the room (public room: topic, category, online)');
    ok(!JSON.stringify(pub).includes('Iv_Owner') && !('createdBy' in pub) && !('code' in pub), 'the landing info does not expose the creator or other codes');
    ok((await look('ZZZZZZZZZZZZ')).status === 'notfound' && (await look('bad!')).status === 'notfound', 'unknown or malformed codes are notfound');
    const plain = await inv(O, PR);
    const lockedInfo = await look(plain.json.invite.code);
    ok(lockedInfo.status === 'ok' && lockedInfo.room.name === 'Secret Den' && lockedInfo.room.passwordRequired && !('topic' in lockedInfo.room) && !('users' in lockedInfo.room), 'password room via a normal link: name only (no topic / online)');
    const bypassInfo = await look(sInv.json.invite.code);
    ok(bypassInfo.room.topic === 'hidden topic text' && bypassInfo.skipPassword === true, 'a password-skipping link shows the details');

    // ---- signed-out flow keeps the code through sign-up + email confirmation ----
    const nb = browser('100.64.8.2'); await nb.boot();
    const so = await redeem({ b: nb }, c1.json.invite.code);
    ok(so.status === 401 && so.json.needAuth === true && so.json.code === c1.json.invite.code, 'signed out: redeem asks for sign-in and hands the code back');
    const cap = await captchaFor(nb);
    const nreg = await nb.req('/api/auth/register', { username: 'Iv_Newbie', password: 'iv-newbie-pass-1', email: 'iv_newbie@example.com', invite: c1.json.invite.code, ...cap });
    ok(nreg.json.ok, 'sign-up with the invite code attached');
    const vmail = readMail().filter((m) => m.to === 'iv_newbie@example.com').pop();
    ok(vmail && new RegExp(`/verify-email\\?token=[\\w-]+&invite=${c1.json.invite.code}`).test(vmail.text), 'the confirmation link carries the invite on to after the email step');
    const nsock = track(await nb.connect()); await emit(nsock, 'login', {});
    const nr = await redeem({ b: nb }, c1.json.invite.code);
    ok(nr.status === 200 && nr.json.roomId === R && nr.json.firstUse === true, 'after sign-up the invite redeems into the room');
    ok((await emit(nsock, 'room:join', { roomId: nr.json.roomId, invite: c1.json.invite.code })).ok, 'and the new account joins');
    ok((await nb.req('/api/auth/verify-email/send', { invite: c1.json.invite.code })).status === 200 && new RegExp(`&invite=${c1.json.invite.code}`).test(readMail().filter((m) => m.to === 'iv_newbie@example.com').pop().text), 'a resent confirmation link keeps the invite too');

    // ---- one use per account, max uses ----
    const again = await redeem({ b: nb }, c1.json.invite.code);
    ok(again.json.ok && again.json.firstUse === false && dbq('SELECT uses FROM room_invites WHERE code = ?', c1.json.invite.code)[0].uses === 1, 'the same account opening it again is not counted twice');
    const one = await inv(O, R, { maxUses: 1 });
    ok((await redeem(U, one.json.invite.code)).json.ok, 'a 1-use link works once');
    const full = await redeem(V, one.json.invite.code);
    ok(full.status === 410 && full.json.status === 'used', 'a second person gets "used up"');
    ok((await redeem(U, one.json.invite.code)).json.ok && (await look(one.json.invite.code)).status === 'used', 'the person who used it can still use it; others see used');
    // ---- expiry ----
    const ex = await inv(O, R, { expires: '30m' });
    dbq('UPDATE room_invites SET expires_at = ? WHERE code = ?', Date.now() - 1000, ex.json.invite.code);
    const exR = await redeem(U, ex.json.invite.code);
    ok(exR.status === 410 && exR.json.status === 'expired' && (await look(ex.json.invite.code)).status === 'expired', 'expired links are refused');
    // ---- revocation ----
    const rv = await inv(O, R);
    ok((await redeem(V, rv.json.invite.code)).json.ok, 'a link works before revocation');
    ok((await O.b.req(`/api/rooms/${R}/invites/${rv.json.invite.code}`, undefined, 'DELETE')).json.ok, 'owner revokes it');
    const rvR = await redeem(V, rv.json.invite.code);
    ok(rvR.status === 410 && rvR.json.status === 'revoked' && (await look(rv.json.invite.code)).status === 'revoked', 'revoked links stop working, even for someone who used them');
    ok(dbq("SELECT COUNT(*) AS n FROM mod_log WHERE action = 'invite-revoke' AND room_id = ?", R)[0].n === 1, 'revocation goes to the action log');
    ok(!(await O.b.req(`/api/rooms/${R}/invites`)).json.invites.some((i) => i.code === rv.json.invite.code), 'revoked links leave the Info-tab list');

    // ---- password bypass only when the link allows it ----
    const pr1 = await redeem(U, plain.json.invite.code);
    ok(pr1.json.ok && pr1.json.passwordRequired === true && pr1.json.skipPassword === false, 'a normal link to a password room redeems but says a password is needed');
    const noPw = await emit(U.s, 'room:join', { roomId: PR, invite: plain.json.invite.code });
    ok(!noPw.ok && /password/i.test(noPw.error), 'joining with a normal link still asks for the password');
    ok((await emit(V.s, 'room:join', { roomId: PR, invite: sInv.json.invite.code })).ok === false, 'a skip-password code without redeeming it does nothing');
    ok((await redeem(V, sInv.json.invite.code)).json.skipPassword === true && (await emit(V.s, 'room:join', { roomId: PR, invite: sInv.json.invite.code })).ok, 'after redeeming a skip-password link, the room opens with no password');
    V.s.emit('room:leave'); await sleep(150);
    ok((await emit(V.s, 'room:join', { roomId: R, invite: sInv.json.invite.code })).ok && (V.s.emit('room:leave'), await sleep(150), true), 'a code for another room is just ignored');
    const ownSkip = await inv(O, PR, { skipPassword: true });
    ok(ownSkip.json.invite.skipPassword === true, 'the owner can make a password-skipping link');
    ok((await redeem(X, ownSkip.json.invite.code)).json.ok, 'someone redeems it');
    await O.b.req(`/api/rooms/${PR}/invites/${ownSkip.json.invite.code}`, undefined, 'DELETE');
    ok(!(await emit(X.s, 'room:join', { roomId: PR, invite: ownSkip.json.invite.code })).ok, 'once revoked it no longer skips the password');

    // ---- bans are never bypassed ----
    ok((await emit(O.s, 'room:join', { roomId: R })).ok && (await emit(U.s, 'room:join', { roomId: R })).ok, 'owner and a user in the room');
    ok((await emit(O.s, 'room:ban', { userId: U.s.id, minutes: 60, reason: 'invite test' })).ok, 'owner bans the user from the room');
    await sleep(200);
    const banLink = await inv(O, R);
    const bR = await redeem(U, banLink.json.invite.code);
    ok(bR.status === 403 && bR.json.banned === true && dbq('SELECT uses FROM room_invites WHERE code = ?', banLink.json.invite.code)[0].uses === 0, 'a banned account cannot redeem (and is not counted)');
    ok(!(await emit(U.s, 'room:join', { roomId: R, invite: banLink.json.invite.code })).ok, 'and cannot join with the code either');
    const banPw = await admin.req(`/api/rooms/${PR}/invites`, { expires: '1d', maxUses: null, skipPassword: true });
    ok((await emit(O.s, 'room:join', { roomId: PR, password: 'sekrit-pw-1' })).ok && (await redeem(X, banPw.json.invite.code)).json.ok && (await emit(X.s, 'room:join', { roomId: PR, invite: banPw.json.invite.code })).ok, 'a user enters the password room through a skip link');
    ok((await emit(O.s, 'room:ban', { userId: X.s.id, minutes: 60 })).ok, 'and gets banned there');
    await sleep(200);
    ok((await redeem(X, banPw.json.invite.code)).status === 403 && !(await emit(X.s, 'room:join', { roomId: PR, invite: banPw.json.invite.code })).ok, 'a skip-password link never bypasses a ban');

    // ---- "Copy invite link" default ----
    const d1 = await O.b.req(`/api/rooms/${R}/invites/default`, {});
    const d2 = await O.b.req(`/api/rooms/${R}/invites/default`, {});
    ok(d1.json.created === true && d1.json.invite.isDefault && d1.json.invite.maxUses === null && d1.json.invite.expiresAt > Date.now() + 23 * 3600_000, 'quick link: 1 day, unlimited');
    ok(d2.json.created === false && d2.json.invite.code === d1.json.invite.code, 'the quick link is reused while it is good');
    await O.b.req(`/api/rooms/${R}/invites/${d1.json.invite.code}`, undefined, 'DELETE');
    const d3 = await O.b.req(`/api/rooms/${R}/invites/default`, {});
    ok(d3.json.created === true && d3.json.invite.code !== d1.json.invite.code, 'after revoking, a new quick link is made');

    // ---- rate limits ----
    const RL = await mkI('Iv_Spammer');
    const rlRoom = (await emit(RL.s, 'room:create', { name: 'Iv Limits', topic: 'x' })).roomId;
    let lastC = 0;
    for (let i = 0; i < 21; i++) lastC = (await inv(RL, rlRoom)).status;
    ok(lastC === 429, 'invite creation is rate limited');
    let lastR = 0;
    for (let i = 0; i < 31; i++) lastR = (await redeem(V, c1.json.invite.code)).status;
    ok(lastR === 429, 'redemption is rate limited');

    // ---- share previews: Open Graph meta in the SPA shell ----
    const root = await page('/');
    ok(root.status === 200 && /no-cache/.test(root.cc || '') && root.type.includes('text/html') && root.html.includes('id="root"'), 'the root page is still the SPA shell, no-cache');
    ok(meta(root.html, 'og:title') === 'zeronoise' && /^https?:\/\/.+\/og-image\.png$/.test(meta(root.html, 'og:image')) && meta(root.html, 'twitter:card') === 'summary_large_image' && (root.html.match(/<title>/g) || []).length === 1, 'root has the default site card (absolute og:image, Twitter card, one title)');
    const pubP = await page(`/?room=${R}`);
    const pubImg = meta(pubP.html, 'og:image');
    ok(meta(pubP.html, 'og:title') === 'Join Invite Lounge on zeronoise' && meta(pubP.html, 'twitter:title') === 'Join Invite Lounge on zeronoise', 'public room: "Join <room> on zeronoise"');
    const desc = meta(pubP.html, 'og:description');
    ok(/^Say &quot;hi&quot; /.test(desc) && !/<b>|&lt;b/.test(desc) && /Music/.test(desc) && /#lofi/.test(desc) && /online now/.test(desc) && !pubP.html.includes('<b>here'), 'description: topic (escaped), category, tags, people online');
    ok(new RegExp(`^https?://[^/]+/api/og/room/${R}\\.jpg\\?v=[\\w-]+$`).test(pubImg) && pubP.html.includes('id="root"') && /no-cache/.test(pubP.cc || ''), 'og:image points at the generated card; the page stays the no-cache SPA shell');
    const imgPath = pubImg.replace(/^https?:\/\/[^/]+/, '');
    const im1 = await fetch(BASE + imgPath);
    const buf1 = Buffer.from(await im1.arrayBuffer());
    const m1 = await sharpLib(buf1).metadata();
    ok(im1.status === 200 && im1.headers.get('content-type') === 'image/jpeg' && m1.format === 'jpeg' && m1.width === 1200 && m1.height === 630, 'card image: 1200x630 JPEG');
    ok(/public/.test(im1.headers.get('cache-control') || '') && /max-age=300/.test(im1.headers.get('cache-control') || ''), 'card image is cacheable (5 min)');
    const et = im1.headers.get('etag');
    const im2 = await fetch(BASE + imgPath);
    ok(im2.headers.get('etag') === et && (await fetch(BASE + imgPath, { headers: { 'if-none-match': et } })).status === 304, 'card is cached server-side (same ETag, 304 on revalidate)');
    // a change to the room (icon) rebuilds the card and changes the image URL version
    const fd = new FormData();
    fd.append('icon', new Blob([await sharpLib({ create: { width: 200, height: 200, channels: 3, background: '#7b3fe4' } }).png().toBuffer()], { type: 'image/png' }), 'i.png');
    ok((await fetch(BASE + `/api/rooms/${R}/icon`, { method: 'POST', headers: { 'cf-connecting-ip': O.b.ip, 'x-csrf': '1', cookie: O.b.cookieHeader() }, body: fd })).status === 200, 'owner sets a room icon');
    const pubP2 = await page(`/?room=${R}`);
    const img2 = meta(pubP2.html, 'og:image');
    const im3 = await fetch(BASE + img2.replace(/^https?:\/\/[^/]+/, ''));
    ok(img2 !== pubImg && im3.headers.get('etag') !== et, 'changing the icon regenerates the card (new URL version and bytes)');
    // password room
    const pwP = await page(`/?room=${PR}`);
    ok(meta(pwP.html, 'og:title') === 'Join Secret Den on zeronoise' && !pwP.html.includes('hidden topic text') && !/online now/.test(meta(pwP.html, 'og:description')), 'password room: name only, no topic or online count');
    const pwImg = await fetch(BASE + meta(pwP.html, 'og:image').replace(/^https?:\/\/[^/]+/, ''));
    ok(pwImg.status === 200 && pwImg.headers.get('content-type') === 'image/jpeg', 'password room gets a name-only card');
    // private call + unknown room: nothing about the room at all
    const callP = await page(`/?room=${call.room.id}`);
    ok(meta(callP.html, 'og:title') === 'zeronoise' && /\/og-image\.png$/.test(meta(callP.html, 'og:image')) && !callP.html.includes(call.room.id), 'private call: generic site card, room not mentioned');
    const callImg = await fetch(BASE + `/api/og/room/${call.room.id}.jpg`, { redirect: 'manual' });
    ok(callImg.status === 302 && /og-image\.png$/.test(callImg.headers.get('location') || ''), 'a private call card falls back to the site image');
    ok(meta((await page('/?room=no-such-room')).html, 'og:title') === 'zeronoise', 'unknown room: site card');
    // invite pages
    const ip1 = await page(`/i/${c1.json.invite.code}`);
    ok(ip1.status === 200 && ip1.html.includes('id="root"') && meta(ip1.html, 'og:title') === 'Join Invite Lounge on zeronoise' && new RegExp(`/api/og/invite/${c1.json.invite.code}\\.jpg\\?v=`).test(meta(ip1.html, 'og:image')) && meta(ip1.html, 'og:url').endsWith(`/i/${c1.json.invite.code}`), '/i/<code>: SPA shell with the room card');
    const ipPlain = await page(`/i/${plain.json.invite.code}`);
    ok(!ipPlain.html.includes('hidden topic text') && !/online now/.test(meta(ipPlain.html, 'og:description')), 'invite to a password room (no skip): name only');
    const ipSkip = await page(`/i/${sInv.json.invite.code}`);
    ok(/hidden topic text/.test(meta(ipSkip.html, 'og:description')) && /online now/.test(meta(ipSkip.html, 'og:description')), 'invite that skips the password: full details');
    const skipImg = await fetch(BASE + meta(ipSkip.html, 'og:image').replace(/^https?:\/\/[^/]+/, ''));
    ok(skipImg.status === 200 && (await sharpLib(Buffer.from(await skipImg.arrayBuffer())).metadata()).width === 1200, 'the skip-password invite card renders');
    const ipDead = await page(`/i/${ex.json.invite.code}`);
    ok(/no longer valid/.test(meta(ipDead.html, 'og:title')) && !ipDead.html.includes('Invite Lounge'), 'expired invite: generic "no longer valid" card');
    ok((await fetch(BASE + `/api/og/invite/${rv.json.invite.code}.jpg`, { redirect: 'manual' })).status === 302, 'a revoked invite card falls back to the site image');
    ok((await page('/some/client/route')).html.includes('id="root"'), 'other client routes still get the plain shell');

    // ---- deleting the room drops its links ----
    ok((await emit(O.s, 'room:join', { roomId: R })).ok && (await emit(O.s, 'room:delete')).ok, 'owner deletes the room');
    await sleep(150);
    ok(dbq('SELECT COUNT(*) AS n FROM room_invites WHERE room_id = ?', R)[0].n === 0 && (await look(c1.json.invite.code)).status === 'notfound', 'deleting a room removes its invite links');
    await emit(X.s, 'call:respond', { roomId: call.room.id, accept: false });
  }

  // ================= video quality: saved preset + receive preferences =================
  {
    const dbFile = path.join(DATA, 'camchat.db');
    const ucols = JSON.parse(execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      console.log(JSON.stringify(db.prepare("SELECT name FROM pragma_table_info('users')").all().map((r) => r.name)));
    `, dbFile], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    ok(ucols.includes('video_quality'), 'users.video_quality column exists');
    let vqIp = 1;
    const mkV = async (name) => {
      const b = browser(`100.64.10.${vqIp++}`); await b.boot();
      await register(b, name, `${name.toLowerCase()}-pass-99`);
      const s = track(await b.connect());
      ok((await emit(s, 'login', {})).ok, `${name} logs in`);
      return { b, s, name };
    };
    const anonV = browser('100.64.10.99'); await anonV.boot();
    ok((await anonV.req('/api/me/video-quality', { videoQuality: 'low' }, 'PATCH')).status === 401, 'signed-out cannot save a video quality');
    const A = await mkV('Vq_Alice'); const B = await mkV('Vq_Bob');
    ok((await A.b.req('/api/me')).json.account.videoQuality === null, 'a new account has no saved video quality');
    ok((await A.b.req('/api/me/video-quality', { videoQuality: 'ultra' }, 'PATCH')).status === 400, 'unknown preset rejected');
    ok((await A.b.req('/api/me/video-quality', {}, 'PATCH')).status === 400, 'missing preset rejected');
    const saved = await A.b.req('/api/me/video-quality', { videoQuality: 'saver' }, 'PATCH');
    ok(saved.status === 200 && saved.json.videoQuality === 'saver', 'account saves the Data saver preset');
    ok((await A.b.req('/api/me')).json.account.videoQuality === 'saver', '/api/me returns the saved preset');
    ok((await B.b.req('/api/me')).json.account.videoQuality === null, 'presets are per account');
    // the receive preference rides on rtc:signal, only between members of one room, validated
    const VR = (await emit(A.s, 'room:create', { name: 'Quality Corner' })).roomId;
    ok(!!VR && (await emit(A.s, 'room:join', { roomId: VR })).ok && (await emit(B.s, 'room:join', { roomId: VR })).ok, 'two people in one room');
    const got = [];
    A.s.on('rtc:signal', (p) => got.push(p));
    B.s.emit('rtc:signal', { to: A.s.id, data: { type: 'pref', video: 'paused' } });
    B.s.emit('rtc:signal', { to: A.s.id, data: { type: 'pref', video: 'low', extra: 'x'.repeat(50) } });
    B.s.emit('rtc:signal', { to: A.s.id, data: { type: 'pref', video: 'off' } });
    B.s.emit('rtc:signal', { to: A.s.id, data: { type: 'pref' } });
    await sleep(400);
    const prefs = got.filter((p) => p.data?.type === 'pref');
    ok(prefs.length === 2 && prefs[0].from === B.s.id && prefs[0].data.video === 'paused' && prefs[1].data.video === 'low', 'a viewer\'s pause / lower preference reaches the sender');
    ok(prefs.every((p) => Object.keys(p.data).sort().join() === 'type,video'), 'only the validated fields are relayed');
    const C = await mkV('Vq_Carol');
    const before = got.length;
    C.s.emit('rtc:signal', { to: A.s.id, data: { type: 'pref', video: 'paused' } });
    await sleep(300);
    ok(got.length === before, 'someone outside the room cannot send a preference');
    B.s.emit('rtc:signal', { to: A.s.id, data: { type: 'description', description: { type: 'offer', sdp: 'v=0' } } });
    await sleep(300);
    ok(got.some((p) => p.data?.type === 'description'), 'ordinary signaling still relays');
  }

  // ================= batch 4a: stage mode, edit window + history, pins (cap 5) =================
  {
    const dbFile = path.join(DATA, 'camchat.db');
    const dbq = (sql, ...params) => JSON.parse(execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 3000');
      const st = db.prepare(process.argv[2]);
      const params = JSON.parse(process.argv[3]);
      console.log(JSON.stringify(/^\\s*select/i.test(process.argv[2]) ? st.all(...params) : st.run(...params)));
    `, dbFile, sql, JSON.stringify(params)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    const rcols = dbq("SELECT name FROM pragma_table_info('rooms')").map((r) => r.name);
    ok(rcols.includes('stage_mode') && rcols.includes('stage_cap'), 'rooms.stage_mode / stage_cap columns exist');
    ok(dbq("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_edits'").length === 1, 'message_edits table exists');
    let ip4 = 1;
    const mk4 = async (name) => {
      const b = browser(`100.64.20.${ip4++}`); await b.boot();
      await register(b, name, `${name.toLowerCase()}-pass-99`);
      const s = track(await b.connect());
      const l = await emit(s, 'login', {});
      ok(l.ok, `${name} logs in`);
      return { b, s, name, id: s.id };
    };
    const O = await mk4('Stg_Owner'); const A = await mk4('Stg_Ann'); const B = await mk4('Stg_Ben');
    const SR = (await emit(O.s, 'room:create', { name: 'Stage Hall' })).roomId;
    const jo = await emit(O.s, 'room:join', { roomId: SR });
    ok(jo.ok && jo.room.stage && jo.room.stage.on === false && jo.room.stage.cap === 6, 'room state carries stage (off, default cap 6)');
    ok((await emit(A.s, 'room:join', { roomId: SR })).ok && (await emit(B.s, 'room:join', { roomId: SR })).ok, 'audience joins');
    ok((await emit(A.s, 'media:state', { cam: true, mic: false, screen: false })).ok, 'before stage mode anyone can go on cam');
    ok(!(await emit(A.s, 'stage:set', { on: true })).ok, 'a member cannot turn stage mode on');
    const demoted = once(A.s, 'stage:demoted');
    const camGone = once(B.s, 'user:updated', (u) => u.id === A.s.id && !u.cam);
    const stOn = once(B.s, 'stage:state', (p) => p.on);
    const set = await emit(O.s, 'stage:set', { on: true, cap: 3 });
    ok(set.ok && set.stage.on && set.stage.cap === 3, 'owner turns stage mode on (cap 3)');
    ok(!!(await demoted) && !!(await camGone), 'turning it on moves a publishing audience member off cam');
    const st1 = await stOn;
    ok(st1.speakers.includes(O.s.id) && !st1.speakers.includes(A.s.id), 'owner is a speaker, others are audience');
    ok(dbq('SELECT stage_mode, stage_cap FROM rooms WHERE id = ?', SR)[0].stage_mode === 1 && dbq('SELECT stage_cap FROM rooms WHERE id = ?', SR)[0].stage_cap === 3, 'stage mode and cap are saved on the room');
    const rej = await emit(A.s, 'media:state', { cam: false, mic: true, screen: false });
    ok(!rej.ok && /Stage mode/.test(rej.error), 'audience cannot turn the mic on');
    ok(!(await emit(A.s, 'media:state', { cam: false, mic: false, screen: true })).ok, 'audience cannot share a screen');
    ok((await emit(A.s, 'media:state', { cam: false, mic: false, screen: false })).ok, 'audience can still report everything off');
    ok((await emit(O.s, 'media:state', { cam: true, mic: true, screen: false })).ok, 'a speaker can publish');
    // signalling: drop audience descriptions that send media
    const sendSdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n';
    const recvSdp = sendSdp.replace('a=sendonly', 'a=recvonly');
    const stoppedSdp = sendSdp.replace('m=video 9', 'm=video 0');
    const gotO = [];
    O.s.on('rtc:signal', (p) => gotO.push(p));
    A.s.emit('rtc:signal', { to: O.s.id, data: { type: 'description', description: { type: 'offer', sdp: sendSdp } } });
    A.s.emit('rtc:signal', { to: O.s.id, data: { type: 'description', description: { type: 'offer', sdp: sendSdp.replace('a=sendonly', 'a=sendrecv') } } });
    A.s.emit('rtc:signal', { to: O.s.id, data: { type: 'description', description: { type: 'answer', sdp: recvSdp } } });
    A.s.emit('rtc:signal', { to: O.s.id, data: { type: 'description', description: { type: 'offer', sdp: stoppedSdp } } });
    A.s.emit('rtc:signal', { to: O.s.id, data: { type: 'candidate', candidate: { candidate: '', sdpMid: '0' } } });
    await sleep(400);
    const descs = gotO.filter((p) => p.from === A.s.id && p.data.type === 'description').map((p) => p.data.description.sdp);
    ok(descs.length === 2 && descs.includes(recvSdp) && descs.includes(stoppedSdp), 'server drops audience offers that send media, relays receive-only / stopped ones');
    ok(gotO.some((p) => p.from === A.s.id && p.data.type === 'candidate'), 'audience ICE candidates still relay');
    // hands
    ok(!(await emit(O.s, 'stage:hand', { up: true })).ok, 'a speaker has no hand to raise');
    const handSeen = once(O.s, 'stage:state', (p) => p.hands.some((h) => h.id === A.s.id));
    ok((await emit(A.s, 'stage:hand', { up: true })).ok && (await emit(A.s, 'stage:hand', { up: true })).ok, 'audience raises a hand (twice is fine)');
    const hs = await handSeen;
    ok(hs.hands.length === 1 && hs.hands[0].nick === 'Stg_Ann', 'staff see the hand queue (one entry)');
    ok(!(await emit(B.s, 'stage:invite', { userId: A.s.id })).ok, 'a member cannot bring someone up');
    const upSeen = once(A.s, 'stage:state', (p) => p.speakers.includes(A.s.id));
    ok((await emit(O.s, 'stage:invite', { userId: A.s.id })).ok, 'owner brings the hand up');
    const up = await upSeen;
    ok(up.hands.length === 0, 'approving clears the hand');
    ok((await emit(A.s, 'media:state', { cam: false, mic: true, screen: false })).ok, 'an invited speaker can use the mic');
    gotO.length = 0;
    A.s.emit('rtc:signal', { to: O.s.id, data: { type: 'description', description: { type: 'offer', sdp: sendSdp } } });
    await sleep(300);
    ok(gotO.some((p) => p.data.type === 'description'), 'an invited speaker\'s offers relay');
    // cap
    ok((await emit(O.s, 'stage:set', { cap: 2 })).ok, 'owner lowers the cap to 2');
    await emit(B.s, 'stage:hand', { up: true });
    const full = await emit(O.s, 'stage:invite', { userId: B.s.id });
    ok(!full.ok && /full/i.test(full.error), 'bringing up a third speaker over the cap is refused');
    ok((await emit(O.s, 'stage:down', { userId: B.s.id })).ok, 'owner lowers a hand');
    // move down
    const down = once(A.s, 'stage:demoted');
    const micGone = once(B.s, 'user:updated', (u) => u.id === A.s.id && !u.mic);
    ok((await emit(O.s, 'stage:down', { userId: A.s.id })).ok, 'owner moves a speaker down');
    ok(!!(await down) && !!(await micGone), 'the moved speaker is told and their mic flag drops');
    ok(!(await emit(A.s, 'media:state', { cam: false, mic: true, screen: false })).ok, 'after moving down the mic is refused again');
    const ownerDown = await emit(O.s, 'stage:down', { userId: O.s.id });
    ok(!ownerDown.ok, 'the owner cannot be moved to the audience');
    await sleep(1000);
    await emit(O.s, 'stage:invite', { userId: A.s.id });
    const selfDown = once(A.s, 'stage:demoted');
    ok((await emit(A.s, 'stage:down', { userId: A.s.id })).ok && !!(await selfDown), 'a speaker can leave the stage');
    ok(!(await emit(B.s, 'stage:down', { userId: A.s.id })).ok, 'a member cannot move others');
    ok((await emit(O.s, 'stage:set', { cap: 99 })).ok && dbq('SELECT stage_cap FROM rooms WHERE id = ?', SR)[0].stage_cap === 8, 'cap is clamped to 8');
    // a late joiner sees the stage; leaving clears the hand
    const C = await mk4('Stg_Cid');
    const jc = await emit(C.s, 'room:join', { roomId: SR });
    ok(jc.ok && jc.room.stage.on && jc.room.stage.speakers.includes(O.s.id) && !jc.room.stage.speakers.includes(C.s.id), 'a new member joins as audience');
    await emit(C.s, 'stage:hand', { up: true });
    const cleared = once(O.s, 'stage:state', (p) => !p.hands.some((h) => h.id === C.s.id));
    C.s.emit('room:leave');
    ok(!!(await cleared), 'leaving the room drops a raised hand');
    await sleep(1000);
    const off = await emit(O.s, 'stage:set', { on: false });
    ok(off.ok && !off.stage.on, 'owner turns stage mode off');
    ok((await emit(A.s, 'media:state', { cam: false, mic: true, screen: false })).ok, 'with stage mode off everyone can publish again');
    ok(!(await emit(A.s, 'stage:hand', { up: true })).ok, 'no hands when stage mode is off');

    // ---- edits: 10 minute window, history for staff ----
    const msgOf = (s, text) => once(s, 'chat:message', (m) => m.kind === 'chat' && m.text === text);
    let w = msgOf(A.s, 'first draft');
    ok((await emit(O.s, 'chat:send', { text: 'first draft' })).ok, 'owner posts');
    const m1 = await w;
    ok((await emit(O.s, 'chat:edit', { messageId: m1.id, text: 'second draft' })).ok && (await emit(O.s, 'chat:edit', { messageId: m1.id, text: 'final text' })).ok, 'author edits twice');
    ok((await emit(O.s, 'chat:edit', { messageId: m1.id, text: 'final text' })).ok, 'an edit with no change is accepted');
    ok(dbq('SELECT COUNT(*) AS n FROM message_edits WHERE message_id = ?', m1.id)[0].n === 2, 'each real edit keeps the replaced version (no-op edits add nothing)');
    const hist = await emit(O.s, 'chat:history', { messageId: m1.id });
    ok(hist.ok && hist.versions.length === 2 && hist.versions[0].text === 'first draft' && hist.versions[1].text === 'second draft' && hist.current.text === 'final text', 'owner reads the edit history in order');
    ok(hist.versions[0].at === m1.ts, 'the original version is stamped with the send time');
    const nope = await emit(A.s, 'chat:history', { messageId: m1.id });
    ok(!nope.ok, 'a member cannot read edit history');
    w = msgOf(O.s, 'old line');
    await emit(A.s, 'chat:send', { text: 'old line' });
    const m2 = await w;
    dbq('UPDATE messages SET ts = ts - ? WHERE id = ?', 11 * 60_000, m2.id);
    const late = await emit(A.s, 'chat:edit', { messageId: m2.id, text: 'too late' });
    ok(!late.ok && /10 minutes/.test(late.error), 'editing after 10 minutes is refused');
    await sleep(5200);
    ok((await emit(O.s, 'chat:delete', { messageId: m1.id })).ok, 'author deletes the edited message');
    await sleep(200);
    ok(dbq('SELECT COUNT(*) AS n FROM message_edits WHERE message_id = ?', m1.id)[0].n === 0, 'deleting a message drops its edit history');
    // burn: no history, no pin
    w = once(A.s, 'chat:message', (m) => m.kind === 'chat' && !!m.burn);
    await emit(O.s, 'chat:send', { text: 'burn me', burnTtl: 10 });
    const mb = await w;
    ok(!(await emit(O.s, 'chat:history', { messageId: mb.id })).ok && !(await emit(O.s, 'chat:pin', { messageId: mb.id, pinned: true })).ok, 'burn messages have no history and cannot be pinned');

    // ---- pins: at most 5 new pins; legacy rooms keep up to 10 visible ----
    const ids = [];
    await sleep(5200);
    for (let i = 0; i < 7; i++) {
      const t = `pin me ${i}`;
      const ww = msgOf(A.s, t);
      await emit(O.s, 'chat:send', { text: t });
      ids.push((await ww).id);
      if (i % 4 === 3) await sleep(5200);
    }
    await sleep(1000);
    let pinOk = 0;
    for (let i = 0; i < 5; i++) if ((await emit(O.s, 'chat:pin', { messageId: ids[i], pinned: true })).ok) pinOk++;
    ok(pinOk === 5, 'owner pins 5 messages');
    const sixth = await emit(O.s, 'chat:pin', { messageId: ids[5], pinned: true });
    ok(!sixth.ok && /at most 5/.test(sixth.error), 'a 6th pin is refused');
    ok(!(await emit(A.s, 'chat:pin', { messageId: ids[5], pinned: true })).ok, 'members cannot pin');
    dbq('INSERT INTO message_pins (message_id, room_id, pinned_by, pinned_at) VALUES (?,?,?,?)', ids[5], SR, 'Stg_Owner', Date.now());
    dbq('INSERT INTO message_pins (message_id, room_id, pinned_by, pinned_at) VALUES (?,?,?,?)', ids[6], SR, 'Stg_Owner', Date.now());
    B.s.emit('room:leave');
    await sleep(200);
    const jb = await emit(B.s, 'room:join', { roomId: SR });
    ok(jb.ok && jb.room.pins.length === 7, 'a room pinned under the old limit still shows all its pins');
    ok((await emit(O.s, 'chat:pin', { messageId: ids[0], pinned: false })).ok, 'owner unpins');
    ok(!(await emit(O.s, 'chat:pin', { messageId: ids[0], pinned: true })).ok, 'still over 5: re-pinning waits until the room is under the cap');
  }


  // ================= nine features: search filters, whisper search, notifications, themes, bot log, status, away =================
  {
    const dbFile = path.join(DATA, 'camchat.db');
    const dbq = (sql, ...params) => JSON.parse(execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 3000');
      const st = db.prepare(process.argv[2]);
      const params = JSON.parse(process.argv[3]);
      console.log(JSON.stringify(/^\\s*select/i.test(process.argv[2]) ? st.all(...params) : st.run(...params)));
    `, dbFile, sql, JSON.stringify(params)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    ok(dbq("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('room_notify','push_quiet') ORDER BY name").length === 2, 'migration 37: room_notify + push_quiet tables');
    const rc = dbq("SELECT name FROM pragma_table_info('rooms')").map((r) => r.name);
    ok(rc.includes('theme_banner_id') && rc.includes('theme_accent') && rc.includes('welcome_text'), 'migration 37: rooms theme columns');
    let ip9 = 1;
    const mk9 = async (name) => {
      const b = browser(`100.64.90.${ip9++}`); await b.boot();
      await register(b, name, `${name.toLowerCase()}-pass-99`);
      const s = track(await b.connect());
      ok((await emit(s, 'login', {})).ok, `${name} logs in`);
      return { b, s, name };
    };
    const O = await mk9('Nf_Owner'); const A = await mk9('Nf_Ann'); const C = await mk9('Nf_Cid');
    const R = (await emit(O.s, 'room:create', { name: 'Nine Room' })).roomId;
    const R2 = (await emit(C.s, 'room:create', { name: 'Other Nine' })).roomId;
    for (const p of [O, A]) ok((await emit(p.s, 'room:join', { roomId: R })).ok, `${p.name} joins`);
    ok((await emit(C.s, 'room:join', { roomId: R2 })).ok, 'Cid stays in his own room');
    const say9 = async (p, text) => { for (let i = 0; i < 6; i++) { const r = await emit(p.s, 'chat:send', { text }); if (r.ok) return r; await sleep(1100); } return { ok: false }; };
    await say9(O, 'zebra crossing from owner');
    await say9(A, 'zebra crossing from ann');
    await sleep(1100);
    await say9(A, 'plain words only');
    // ---- search ----
    const all = await emit(O.s, 'chat:search', { q: 'zebra' });
    ok(all.ok && all.hits.length === 2, 'search finds both zebra lines');
    const fromAnn = await emit(O.s, 'chat:search', { q: 'zebra', from: 'nf_ann' });
    ok(fromAnn.ok && fromAnn.hits.length === 1 && fromAnn.hits[0].message.from === 'Nf_Ann', 'filter by person (case-insensitive)');
    const byPerson = await emit(O.s, 'chat:search', { q: '', from: 'Nf_Ann' });
    ok(byPerson.ok && byPerson.hits.length === 2, 'person filter alone (no words) lists that person\'s lines');
    const future = await emit(O.s, 'chat:search', { q: 'zebra', after: Date.now() + 60_000 });
    ok(future.ok && future.hits.length === 0, 'after a future date: nothing');
    const before = await emit(O.s, 'chat:search', { q: 'zebra', before: Date.now() - 3600_000 });
    ok(before.ok && before.hits.length === 0, 'before an hour ago: nothing');
    const win = await emit(O.s, 'chat:search', { q: 'zebra', after: Date.now() - 3600_000, before: Date.now() + 60_000 });
    ok(win.ok && win.hits.length === 2, 'date window around now finds them');
    ok(!(await emit(O.s, 'chat:search', { q: '' })).ok, 'no words and no filter is refused');
    const other = await emit(C.s, 'chat:search', { q: 'zebra' });
    ok(other.ok && other.hits.length === 0, 'search only covers the room you are in (no leak to other rooms)');
    // ---- whisper search ----
    const ws = await emit(O.s, 'whisper:start', { userIds: [A.s.id] });
    ok(ws.ok, 'whisper started');
    if (ws.ok) {
      await sleep(400);
      ok((await emit(O.s, 'whisper:send', { whisperId: ws.whisper.id, text: 'secret giraffe plan' })).ok, 'whisper sent');
      await sleep(400);
      const wa = await emit(A.s, 'whisper:search', { q: 'giraffe' });
      ok(wa.ok && wa.hits.length === 1 && wa.hits[0].text === 'secret giraffe plan', 'a whisper member finds the whisper');
      const wf = await emit(A.s, 'whisper:search', { q: 'giraffe', from: 'Nf_Ann' });
      ok(wf.ok && wf.hits.length === 0, 'whisper search person filter');
      ok((await emit(C.s, 'room:join', { roomId: R })).ok, 'Cid joins the room');
      await sleep(300);
      const wc = await emit(C.s, 'whisper:search', { q: 'giraffe' });
      ok(wc.ok && wc.hits.length === 0, 'someone outside the whisper finds nothing');
      const rs = await emit(C.s, 'chat:search', { q: 'giraffe' });
      ok(rs.ok && rs.hits.length === 0, 'whispers never show up in room search');
    }
    // ---- notifications ----
    const g0 = await emit(A.s, 'notify:get');
    ok(g0.ok && g0.level === 'mentions' && g0.quiet === null, 'default: mentions only, no quiet hours');
    ok(!(await emit(A.s, 'notify:set', { level: 'loud' })).ok, 'unknown level refused');
    ok((await emit(A.s, 'notify:set', { level: 'mute' })).ok && (await emit(A.s, 'notify:get')).level === 'mute', 'mute saved');
    ok(!(await emit(A.s, 'notify:quiet', { start: 1440, end: 5, tz: 'UTC' })).ok, 'bad quiet time refused');
    ok(!(await emit(A.s, 'notify:quiet', { start: 60, end: 120, tz: 'Mars/Base' })).ok, 'bad timezone refused');
    const q1 = await emit(A.s, 'notify:quiet', { start: 22 * 60, end: 7 * 60, tz: 'America/New_York' });
    ok(q1.ok && q1.quiet.start === 1320 && q1.quiet.end === 420, 'quiet hours saved (across midnight)');
    ok((await emit(A.s, 'notify:get')).quiet?.tz === 'America/New_York', 'quiet hours read back');
    ok((await emit(A.s, 'notify:quiet', null)).ok && (await emit(A.s, 'notify:get')).quiet === null, 'quiet hours cleared');
    // push behaviour with a parked registered user
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
    ok((await A.b.req('/api/push/subscribe', { endpoint: `${FIX}/push/ok?u=nfann`, keys })).json.ok, 'Ann subscribes to push');
    const hitsFor = () => pushHits.filter((h) => h.path === '/push/ok?u=nfann').length;
    const awaySeen = once(O.s, 'user:updated', (u) => u.nick === 'Nf_Ann' && u.away === true, 3000).then(() => true, () => false);
    A.s.close();
    ok(await awaySeen, 'a parked (disconnected) user is marked away for the room, so their tile goes at once');
    await sleep(300);
    let n = hitsFor();
    await say9(O, '@Nf_Ann muted mention');
    await sleep(700);
    ok(hitsFor() === n, 'muted room: even a mention does not push');
    dbq("UPDATE room_notify SET level = 'all' WHERE room_id = ?", R);
    await sleep(1100);
    await say9(O, 'ordinary line for everyone');
    await sleep(800);
    ok(hitsFor() === n + 1, 'Everything: an ordinary message pushes');
    n = hitsFor();
    dbq('INSERT OR REPLACE INTO push_quiet (user_id, start_min, end_min, tz, updated_at) SELECT id, 0, 1439, ?, ? FROM users WHERE username = ?', 'UTC', Date.now(), 'Nf_Ann');
    await sleep(1100);
    await say9(O, '@Nf_Ann in quiet hours');
    await sleep(700);
    ok(hitsFor() === n, 'quiet hours: no push');
    dbq("DELETE FROM push_quiet"); dbq("DELETE FROM room_notify WHERE room_id = ?", R);
    await sleep(1100);
    await say9(O, 'plain line, mentions-only now');
    await say9(O, '@Nf_Ann back to normal');
    await sleep(800);
    ok(hitsFor() === n + 1, 'mentions only: the mention pushes, the plain line does not');
    const A2s = track(await A.b.connect()); ok((await emit(A2s, 'login', {})).ok, 'Ann comes back');
    // ---- themes ----
    const th0 = await emit(O.s, 'room:theme:set', { accent: '#000000' });
    ok(!th0.ok && /too dark/.test(th0.error), 'unreadable accent refused');
    ok(!(await emit(O.s, 'room:theme:set', { accent: 'red; background:url(x)' })).ok, 'non-hex accent refused');
    ok(!(await emit(O.s, 'room:theme:set', { welcome: 'x'.repeat(501) })).ok, 'welcome over 500 chars refused');
    ok(!(await emit(C.s, 'room:theme:set', { accent: '#39ff14' })).ok, 'a member cannot change the theme');
    const thSeen = once(C.s, 'room:theme', (p) => p.theme.accent === '#39ff14');
    const th1 = await emit(O.s, 'room:theme:set', { accent: '#39FF14', welcome: '  Welcome to <b>nine</b>  ' });
    ok(th1.ok && th1.theme.accent === '#39ff14' && th1.theme.welcome === 'Welcome to <b>nine</b>', 'owner sets accent + pinned welcome (plain text, trimmed)');
    ok(!!(await thSeen.catch(() => null)), 'room members get the new theme live');
    const rj = await emit(C.s, 'room:join', { roomId: R });
    ok(rj.ok && rj.room.theme?.accent === '#39ff14' && /Welcome/.test(rj.room.theme.welcome), 'room state carries the theme for joiners');
    const sharpLib = createRequire(path.join(ROOT, 'package.json'))('sharp');
    const img = await sharpLib({ create: { width: 1600, height: 500, channels: 3, background: '#3366cc' } }).png().toBuffer();
    const up = async (who, roomId, method = 'POST') => {
      const fd = new FormData(); fd.append('thumb', new Blob([img], { type: 'image/png' }), 'b.png');
      const r = await fetch(BASE + `/api/rooms/${roomId}/banner`, { method, headers: { 'cf-connecting-ip': who.b.ip, 'x-csrf': '1', cookie: who.b.cookieHeader() }, body: method === 'POST' ? fd : undefined });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    ok((await up(C, R)).status === 403, 'a member cannot upload a banner');
    const bu = await up(O, R);
    ok(bu.status === 200 && /^\/api\/room-banners\/[a-f0-9]{32}\.webp$/.test(bu.json.bannerUrl || ''), 'owner uploads a banner');
    const bimg = await fetch(BASE + bu.json.bannerUrl);
    const meta = await sharpLib(Buffer.from(await bimg.arrayBuffer())).metadata();
    ok(bimg.status === 200 && meta.format === 'webp' && meta.width === 1200 && meta.height === 300, 'banner served as 1200x300 webp');
    ok((await emit(C.s, 'room:join', { roomId: R })).room.theme?.bannerUrl === bu.json.bannerUrl, 'banner in room state');
    ok((await up(O, R, 'DELETE')).status === 200 && (await fetch(BASE + bu.json.bannerUrl)).status === 404, 'owner removes the banner');
    // ---- bot actions next to reports ----
    const oid = dbq('SELECT id FROM users WHERE username = ?', 'Nf_Owner')[0].id;
    dbq('INSERT INTO bots (owner_user_id, name, name_lower, created_at) VALUES (?,?,?,?)', oid, 'Meowington', 'meowington', Date.now());
    dbq('INSERT INTO mod_log (ts, actor, actor_user_id, action, target, room_id, details) VALUES (?,?,?,?,?,?,?)', Date.now(), 'Meowington', null, 'kick', 'spammer', R, 'flood');
    dbq('INSERT INTO mod_log (ts, actor, actor_user_id, action, target, room_id, details) VALUES (?,?,?,?,?,?,?)', Date.now(), 'Meowington', oid, 'kick', 'x', R, 'person named like the bot');
    const bl = await emit(O.s, 'modq:botlog', { scope: 'room' });
    ok(bl.ok && bl.actions.length === 1 && bl.actions[0].actor === 'Meowington' && bl.actions[0].target === 'spammer', 'room owner sees the moderator bot\'s actions (not people)');
    ok(!(await emit(C.s, 'modq:botlog', { scope: 'room' })).ok, 'a member cannot read the bot log');
    ok(!(await emit(O.s, 'modq:botlog', { scope: 'site' })).ok, 'site bot log is staff only');
    // ---- public status ----
    const sj = await fetch(BASE + '/api/status');
    const sb = await sj.json();
    ok(sj.status === 200 && sb.ok === true && sb.db === true && Number.isInteger(sb.uptimeSec) && 'package' in sb && 'commit' in sb && 'lastBackupAt' in sb, '/api/status: health, uptime, package, commit, last backup');
    const allowed = ['ok', 'db', 'uptimeSec', 'startedAt', 'package', 'commit', 'releasedAt', 'lastBackupAt', 'lastBackupOk', 'checkedAt', 'lastRestoreCheckAt', 'lastRestoreCheckOk'];
    ok(Object.keys(sb).every((k) => allowed.includes(k)), '/api/status has only public fields (no users, rooms, mail, env)');
    const sh = await fetch(BASE + '/status');
    const html = await sh.text();
    ok(sh.status === 200 && /text\/html/.test(sh.headers.get('content-type') || '') && /Uptime/.test(html) && (html.match(/<script/gi) || []).length === 1 && html.includes('<script src="/theme-boot.js"></script>') && !sh.headers.get('set-cookie'), '/status page: HTML, only the theme boot script, no cookie');
    ok(!/SESSION_SECRET|test-turn-secret|@example\.com|Nf_Owner/.test(html + JSON.stringify(sb)), 'status shows no secrets or user data');
    for (const p of [O, C]) p.s.close();
  }

  // ================= interface themes =================
  {
    const dbFile = path.join(DATA, 'camchat.db');
    const { DatabaseSync } = await import('node:sqlite');
    const d = new DatabaseSync(dbFile, { readOnly: true });
    const ucols = d.prepare("SELECT name FROM pragma_table_info('users')").all().map((r) => r.name);
    const uv = d.prepare('PRAGMA user_version').get().user_version;
    const tabs = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const scols = d.prepare("SELECT name FROM pragma_table_info('room_schedules')").all().map((r) => r.name);
    d.close();
    ok(ucols.includes('ui_theme') && uv >= 38, `migration 38: users.ui_theme (user_version ${uv})`);
    // batch A (39) and batch B (40) only add tables / columns
    if (uv >= 39) ok(['room_reads', 'mention_inbox', 'whisper_messages', 'whisper_members'].every((t) => tabs.includes(t)), `migration 39: read markers, mentions inbox, whispers (user_version ${uv})`);
    if (uv >= 40) ok(tabs.includes('room_filters') && ucols.includes('link_previews') && scols.includes('kind'), `migration 40: room filters, link preview toggle, schedule kind (user_version ${uv})`);
    const th = await import(path.join(ROOT, 'dist/server/shared/uiTheme.js'));
    ok(JSON.stringify(th.UI_THEMES) === JSON.stringify(['dark', 'dark-red', 'dark-green', 'dark-orange']) && th.UI_THEME_DEFAULT === 'dark', 'four themes, Dark is the default');
    for (const t of th.UI_THEMES) {
      const p = th.UI_PALETTES[t];
      const pairs = [[p.text, p.bg], [p.text, p.panel], [p.text, p.panel2], [p.muted, p.bg], [p.muted, p.panel2], [p.accent, p.panel2], [p.accent2, p.panel2], [p.primaryText, p.primaryBg], [p.bg, p.accent]];
      const worst = Math.min(...pairs.map(([a, b]) => th.contrast(a, b)));
      ok(worst >= 4.5, `${t}: every text pair meets WCAG AA (worst ${worst.toFixed(2)}:1)`);
    }
    const dk = th.UI_PALETTES.dark;
    ok(dk.bg === '#0b1220' && dk.text === '#e7eef8' && dk.accent === '#39ff14' && dk.panel === '#162033', 'Dark keeps the original colours');
    const css = fs.readdirSync(path.join(ROOT, 'dist/client/assets')).filter((n) => n.endsWith('.css')).map((n) => fs.readFileSync(path.join(ROOT, 'dist/client/assets', n), 'utf8')).join('\n');
    for (const t of th.UI_THEMES.filter((x) => x !== 'dark')) {
      const p = th.UI_PALETTES[t];
      ok(css.includes(`[data-ui-theme=${t}]`) || css.includes(`[data-ui-theme="${t}"]`), `${t} CSS block shipped`);
      ok([p.bg, p.text, p.accent, p.primaryBg].every((c) => css.toLowerCase().includes(c)), `${t} CSS matches shared/uiTheme.ts`);
    }
    ok(!/rgb\(57 255 20 \//.test(fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8')), 'no hard-coded green glow left (all follow --accent-rgb)');
    const boot = await fetch(BASE + '/theme-boot.js');
    const bootJs = await boot.text();
    ok(boot.status === 200 && /javascript/.test(boot.headers.get('content-type') || '') && bootJs.includes("localStorage.getItem('zn.uiTheme')") && bootJs.includes('data-ui-theme'), '/theme-boot.js is served');
    for (const t of th.UI_THEMES) ok(bootJs.includes(`'${t}': '${th.UI_PALETTES[t].bg}'`), `boot script knows ${t}`);
    const shell = await (await fetch(BASE + '/')).text();
    const bi = shell.indexOf('<script src="/theme-boot.js"></script>');
    ok(bi > 0 && bi < shell.indexOf('</head>') && bi < shell.indexOf('type="module"'), 'app shell runs the theme boot script in <head>, before the app (no flash)');
    const docs = await (await fetch(BASE + '/docs/bots')).text();
    ok(docs.includes('<script src="/theme-boot.js"></script>') && docs.includes('html[data-ui-theme="dark-red"]') && docs.indexOf('theme-boot.js') < docs.indexOf('</head>'), '/docs/bots follows the theme');
    const st = await (await fetch(BASE + '/status')).text();
    ok(st.includes('html[data-ui-theme="dark-orange"]') && st.includes('var(--bg)'), '/status follows the theme');
    ok((await fetch(BASE + '/docs', { redirect: 'manual' })).headers.get('location') === '/docs/bots', '/docs goes to /docs/bots');
    // per-account choice
    const anon = browser(); await anon.boot();
    ok((await anon.req('/api/me/ui-theme', { uiTheme: 'dark-red' }, 'PATCH')).status === 401, 'signed-out visitors cannot save on the server (localStorage only)');
    const u = browser(`100.64.91.1`); await u.boot();
    await register(u, 'Theme_User', 'theme-user-pass-99');
    ok((await u.req('/api/me')).json.account?.uiTheme === null, 'new account: no theme saved (keeps the browser choice)');
    ok((await u.req('/api/me/ui-theme', { uiTheme: 'pink' }, 'PATCH')).status === 400, 'unknown theme refused');
    ok((await u.req('/api/me/ui-theme', { uiTheme: '<script>' }, 'PATCH')).status === 400, 'junk refused');
    ok((await u.req('/api/me/ui-theme', { uiTheme: 'dark-green' }, 'PATCH')).json.uiTheme === 'dark-green', 'account saves Dark/Green');
    ok((await u.req('/api/me')).json.account?.uiTheme === 'dark-green', 'saved theme comes back with the account');
    ok((await u.req('/api/me/ui-theme', { uiTheme: 'dark' }, 'PATCH')).json.ok && (await u.req('/api/me')).json.account?.uiTheme === 'dark', 'switching back to Dark is saved too');
    const pub = await u.req('/api/users/Theme_User/profile');
    ok(!JSON.stringify(pub.json).includes('uiTheme'), 'the theme is private (not in public profiles)');
  }

} catch (e) {
  failed++;
  console.log('FAIL  exception:', e.stack || e.message);
} finally {
  sockets.forEach((s) => s.close());
  await stopServer();
  fixture.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
