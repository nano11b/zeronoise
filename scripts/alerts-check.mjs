/**
 * Batch F9 + F10: uptime endpoint, error-spike and crash-restart alert emails, daily backup restore check.
 * Several server runs on one data dir (mail is captured to a file).   npm run build && node scripts/alerts-check.mjs [shots]
 */
import './lib/reap.mjs';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'zn-alerts'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, x = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && x ? ` (${x})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-alerts-'));
const MAIL = path.join(DATA, 'mail.log');
const mails = () => { try { return fs.readFileSync(MAIL, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
let BASE, srv, log = '';
async function start(env = {}) {
  const port = await freePort(); BASE = `http://127.0.0.1:${port}`; log = '';
  srv = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: MAIL, BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'AlAdmin',
      CAMCHAT_TEST_CRASH_HOOKS: '1', ALERT_ERRORS_THRESHOLD: '5', ALERT_EMAILS: 'ops@example.com', OPS_RUN_GAP_MS: '1', BACKUP_STARTUP_DELAY_MS: '600000', ...env } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300 && !log.includes('listening'); i++) await sleep(100);
}
const stop = (sig = 'SIGTERM') => new Promise((r) => { srv.once('exit', r); srv.kill(sig); });
function jar() {
  const m = new Map(); const header = () => [...m].map(([k, v]) => `${k}=${v}`).join('; ');
  return { header, async req(p, body) {
    const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'x-csrf': '1', cookie: header(), 'x-forwarded-for': '10.99.0.1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); m.set(kv.slice(0, i), kv.slice(i + 1)); }
    const j = await r.json().catch(() => ({})); j.http = r.status; return j;
  } };
}
async function adminJar(register) {
  const j = jar(); await j.req('/api/me');
  if (register) {
    const cap = await j.req('/api/auth/captcha'); const mm = /What is (\d+) \+ (\d+)/.exec(cap.question || '');
    const r = await j.req('/api/auth/register', { username: 'AlAdmin', password: 'pw-AlAdmin-secret-1', email: 'aladmin@example.com', ...(mm ? { captchaId: cap.id, captchaAnswer: String(+mm[1] + +mm[2]) } : { captchaToken: 'test' }) });
    if (!r.ok) throw new Error(r.error);
  } else await j.req('/api/auth/login', { username: 'AlAdmin', password: 'pw-AlAdmin-secret-1' });
  return j;
}
let browser;
try {
  // ---- run 1: uptime endpoint, error spike
  await start();
  const up = await fetch(BASE + '/api/uptime');
  ok(up.status === 200 && (await up.text()) === 'OK' && /no-store/.test(up.headers.get('cache-control') || ''), 'F9: /api/uptime answers 200 OK, uncached');
  ok((await fetch(BASE + '/api/uptime', { method: 'HEAD' })).status === 200, 'F9: HEAD /api/uptime works (cheap pings)');
  const admin = await adminJar(true);
  ok(mails().filter((m) => /Restarted after a crash/.test(m.subject)).length === 0, 'F9: a first start sends no crash alert');
  for (let i = 0; i < 6; i++) await fetch(BASE + '/api/test/throw');
  await sleep(500);
  const spike = mails().find((m) => /Error spike/.test(m.subject));
  ok(!!spike && spike.to === 'ops@example.com' && /test\/throw/.test(spike.text), 'F9: an error spike emails the admins', JSON.stringify(mails().map((m) => m.subject)));
  for (let i = 0; i < 6; i++) await fetch(BASE + '/api/test/throw');
  await sleep(300);
  ok(mails().filter((m) => /Error spike/.test(m.subject)).length === 1, 'F9: alerts have a cooldown (no flood)');
  const ops = await admin.req('/api/admin/ops');
  ok(ops.ok && ops.alerts.some((a) => a.kind === 'error-spike' && a.sent === 1), 'F9: admin panel lists the alert', JSON.stringify(ops.alerts?.[0]));
  // ---- F10: restore check
  const sk = await admin.req('/api/admin/ops/restore-check', {});
  ok(sk.ok && sk.check.status === 'skipped', 'F10: with no backup yet the check is skipped (no alarm)');
  await admin.req('/api/admin/backups/run', {});
  for (let i = 0; i < 100; i++) { const b = await admin.req('/api/admin/backups'); if (!b.status?.running && b.backups?.length) break; await sleep(200); }
  const rc = await admin.req('/api/admin/ops/restore-check', {});
  ok(rc.ok && rc.check.status === 'ok' && rc.check.detail.integrity === 'ok' && rc.check.detail.sha256 === 'match' && rc.check.detail.counts.users[0] >= 1, 'F10: latest backup restores and passes integrity_check, checksum and row counts', JSON.stringify(rc.check));
  const tmpls = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('zn-restore-check-'));
  ok(tmpls.length === 0, 'F10: the temp restore is cleaned up');
  const st = await (await fetch(BASE + '/api/status')).json();
  ok(st.lastRestoreCheckOk === true && st.lastRestoreCheckAt > 0, 'F10: /api/status reports the check');
  ok(/Backup restore check<\/th><td class="ok">OK/.test(await (await fetch(BASE + '/status')).text()), 'F10: /status shows it');
  // a broken newer archive: garbage database, manifest that does not match
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-badbk-'));
  fs.writeFileSync(path.join(bad, 'camchat.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192, 7)]));
  fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify({ format: 1, db: { sha256: 'x', userVersion: 44 } }));
  execFileSync('tar', ['-czf', path.join(DATA, 'backups', 'camchat-29990101-000000.tar.gz'), '-C', bad, 'camchat.db', 'manifest.json']);
  const before = mails().length;
  const rf = await admin.req('/api/admin/ops/restore-check', {});
  await sleep(400);
  ok(rf.ok && rf.check.status === 'failed' && rf.check.detail.problems.length > 0, 'F10: a broken backup fails the check', JSON.stringify(rf.check?.detail));
  ok(mails().slice(before).some((m) => /restore check failed/i.test(m.subject)), 'F10: failure emails the admins');
  ok((await (await fetch(BASE + '/api/status')).json()).lastRestoreCheckOk === false && /FAILED/.test(await (await fetch(BASE + '/status')).text()), 'F10: /status shows the failure');
  // screenshots of the admin Backups tab (failure state, then fixed)
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [1366, 390]) {
    const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
    await page.setViewport(width < 800 ? { width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width, height: 800 });
    await page.setCookie(...admin.header().split('; ').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE }; }));
    await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.admin-tabs [data-tab="backups"]', { timeout: 15000 });
    await page.evaluate(() => document.querySelector('.admin-tabs [data-tab="backups"]')?.click());
    const s1 = await page.waitForSelector('[data-testid="restore-check-state"][data-status="failed"]', { timeout: 8000 }).catch(() => null);
    ok(!!s1 && !!(await page.$('[data-testid="ops-alerts"]')), `${width}: admin Backups tab shows the failed check and the alerts`);
    await s1?.evaluate((e) => e.scrollIntoView({ block: 'start' }));
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}: no sideways scroll`);
    await sleep(400); await page.screenshot({ path: path.join(OUT, `f9-f10-admin-ops-${width}.png`) });
    await page.goto(BASE + '/status', { waitUntil: 'domcontentloaded' }); await sleep(300);
    await page.screenshot({ path: path.join(OUT, `f10-status-${width}.png`) });
    await ctx.close();
  }
  fs.renameSync(path.join(DATA, 'backups', 'camchat-29990101-000000.tar.gz'), path.join(bad, 'moved-aside.tar.gz'));
  // ---- crash: kill -9, then the next start emails about it
  await stop('SIGKILL');
  await start({ RESTORE_CHECK_NODE_TAR: '1' });
  await sleep(500);
  const crash = mails().filter((m) => /Restarted after a crash/.test(m.subject));
  ok(crash.length === 1 && /unclean exit/.test(crash[0].text), 'F9: a restart after a crash emails the admins', JSON.stringify(mails().map((m) => m.subject)));
  const a2 = await adminJar(false);
  const rn = await a2.req('/api/admin/ops/restore-check', {});
  ok(rn.check?.status === 'ok' && rn.check.detail.extractor === 'node', 'F10: built-in extractor works when tar is unavailable', JSON.stringify(rn.check?.detail));
  await stop('SIGTERM');
  await start();
  await sleep(500);
  ok(mails().filter((m) => /Restarted after a crash/.test(m.subject)).length === 1, 'F9: a normal stop/start sends no crash alert');
  await stop('SIGTERM');
} catch (e) { console.error(e); failed++; try { await stop(); } catch { /* */ } }
if (browser) await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
