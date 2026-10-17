/**
 * Batch E3: TOTP secrets encrypted at rest. Three server runs on one data dir:
 *  1) no key: TOTP enabled, plaintext stored, admin warning on;  2) key added: boot seals + scrubs, codes still work,
 *  passkey-less marker logic intact, warning off;  3) key removed: TOTP fails closed, recovery code still signs in.
 *   npm run build && node scripts/secretbox-check.mjs
 */
import './lib/reap.mjs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, n, x = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && x ? ` (${x})` : ''}`); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-secretbox-'));
const KEY = crypto.randomBytes(36).toString('base64');
let BASE, srv, log = '';
async function start(env) {
  const port = await freePort(); BASE = `http://127.0.0.1:${port}`; log = '';
  srv = spawn(process.execPath, ['dist/server/server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CAMCHAT_SECRET_KEY: '', ...env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, TRUST_PROXY: 'loopback', EMAIL_VERIFY_REQUIRED: '0', MAIL_CAPTURE_PATH: path.join(DATA, 'mail.log'), BACKUP_DISABLED: '1', REGISTRATIONS_PER_IP_PER_HOUR: '500', CONTACT_EMAIL: '', ADMIN_USERNAMES: 'SbAdmin' } });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 300 && !log.includes('listening'); i++) await sleep(100);
}
const stop = () => new Promise((r) => { srv.once('exit', r); srv.kill('SIGTERM'); });
let ipN = 0;
function jar() {
  const m = new Map(); const xff = `10.88.0.${++ipN}`;
  const header = () => [...m].map(([k, v]) => `${k}=${v}`).join('; ');
  return { async req(p, body) {
    const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'x-csrf': '1', cookie: header(), 'x-forwarded-for': xff, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); m.set(kv.slice(0, i), kv.slice(i + 1)); }
    const j = await r.json().catch(() => ({})); j.http = r.status; return j;
  } };
}
const b32d = (str) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out = []; for (const c of str.replace(/[^A-Z2-7]/g, '')) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const totpAt = (s, step) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(step)); const h = crypto.createHmac('sha1', b32d(s)).update(m).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0'); };
const step = () => Math.floor(Date.now() / 30000);
async function register(nick) {
  const j = jar(); await j.req('/api/me');
  const cap = await j.req('/api/auth/captcha'); const m = /What is (\d+) \+ (\d+)/.exec(cap.question || '');
  const r = await j.req('/api/auth/register', { username: nick, password: `pw-${nick}-secret-1`, email: `${nick.toLowerCase()}@example.com`, ...(m ? { captchaId: cap.id, captchaAnswer: String(+m[1] + +m[2]) } : { captchaToken: 'test' }) });
  if (!r.ok) throw new Error(`register ${nick}: ${r.error}`);
  return j;
}
const signIn = async (nick) => { const j = jar(); await j.req('/api/me'); const r = await j.req('/api/auth/login', { username: nick, password: `pw-${nick}-secret-1` }); return { j, r }; };
const rows = () => { const d = new DatabaseSync(path.join(DATA, 'camchat.db')); const r = d.prepare('SELECT u.username, t.secret, t.secret_enc, t.marker, t.enabled_at FROM user_totp t JOIN users u ON u.id = t.user_id').all(); const s = d.prepare("SELECT id, mfa_pending FROM sessions WHERE mfa_pending = 1").all(); d.close(); return { t: Object.fromEntries(r.map((x) => [x.username, x])), pend: s }; };
let secret, codes, lastStep = 0;
const freshCode = async () => { while (step() <= lastStep) await sleep(1000); lastStep = step(); return totpAt(secret, lastStep); };
try {
  // ---- run 1: no key
  await start({});
  const admin = await register('SbAdmin');
  const st0 = await admin.req('/api/admin/security-status');
  ok(st0.ok && st0.keySet === false, 'no key: status reports encryption off', JSON.stringify(st0));
  const u = await register('SbUser');
  const s1 = await u.req('/api/me/2fa/setup', {}); secret = s1.secret;
  const en = await u.req('/api/me/2fa/enable', { code: await freshCode() }); codes = en.recoveryCodes || [];
  ok(en.ok && codes.length > 0, 'no key: TOTP turns on');
  ok(rows().t.SbUser?.secret === secret && !rows().t.SbUser?.secret_enc, 'no key: stored as before (plaintext, current behaviour)');
  const a1 = await signIn('SbUser');
  ok(a1.r.mfa || a1.r.mfaRequired || a1.r.needs2fa || a1.r.http === 200, 'no key: password step ok');
  const pend = rows().pend; ok(pend.length >= 1 && pend.every((p) => p.id.startsWith('mfa:')), 'pending sign-in stored under mfa: prefix (rollback build cannot use it)', JSON.stringify(pend));
  ok((await a1.j.req('/api/me')).account == null, 'pending session is not signed in');
  const v1 = await a1.j.req('/api/auth/2fa', { code: await freshCode() });
  ok(v1.ok && (await a1.j.req('/api/me')).account?.username === 'SbUser', 'no key: TOTP code completes sign-in');
  await stop();
  // ---- run 2: key added
  await start({ CAMCHAT_SECRET_KEY: KEY });
  ok(/encrypted 1 TOTP secret/.test(log), 'key added: boot seals the existing secret', log.split('\n').filter((l) => l.includes('2fa')).join(' | '));
  const r2 = rows().t.SbUser;
  ok(r2.secret === 'ENCRYPTED' && /^v1:/.test(r2.secret_enc || '') && !fs.readFileSync(path.join(DATA, 'camchat.db')).includes(secret), 'key added: no plaintext seed left in the DB row', JSON.stringify(r2));
  const st2 = await (await signIn('SbAdmin')).j.req('/api/admin/security-status');
  ok(st2.keySet === true && st2.encrypted === 1 && st2.plaintext === 0 && st2.unreadable === 0, 'key added: status ok, warning off', JSON.stringify(st2));
  const a2 = await signIn('SbUser'); const v2 = await a2.j.req('/api/auth/2fa', { code: await freshCode() });
  ok(v2.ok, 'key added: TOTP still verifies (decrypted)', v2.error);
  const nu = await register('SbNew'); const sN = await nu.req('/api/me/2fa/setup', {});
  ok(/^v1:/.test(rows().t.SbNew?.secret_enc || '') && rows().t.SbNew.secret === 'ENCRYPTED', 'key set: new enrolments are sealed from the start');
  const sv = secret; secret = sN.secret; const enN = await nu.req('/api/me/2fa/enable', { code: totpAt(secret, step()) }); secret = sv;
  ok(enN.ok, 'key set: enrolment with a sealed secret completes', enN.error);
  await stop();
  // ---- run 3: key gone (e.g. env lost): fail closed
  await start({});
  ok(/cannot be read/.test(log), 'key missing: startup warns');
  const st3 = await (await signIn('SbAdmin')).j.req('/api/admin/security-status');
  ok(st3.keySet === false && st3.unreadable === 2, 'key missing: admin status counts unreadable secrets', JSON.stringify(st3));
  const a3 = await signIn('SbUser'); const v3 = await a3.j.req('/api/auth/2fa', { code: await freshCode() });
  ok(!v3.ok && (await a3.j.req('/api/me')).account == null, 'key missing: TOTP fails closed (no bypass)');
  const v3b = await a3.j.req('/api/auth/2fa', { code: codes[0] });
  ok(v3b.ok, 'key missing: recovery code still signs in', v3b.error);
  await stop();
  // ---- run 4: wrong key
  await start({ CAMCHAT_SECRET_KEY: crypto.randomBytes(36).toString('base64') });
  ok(/different key/.test(log), 'wrong key: startup warns');
  const a4 = await signIn('SbUser'); const v4 = await a4.j.req('/api/auth/2fa', { code: await freshCode() });
  ok(!v4.ok, 'wrong key: TOTP fails closed');
  await stop();
} catch (e) { console.error(e); failed++; try { await stop(); } catch { /* */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
