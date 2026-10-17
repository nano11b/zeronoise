// Turn off two-factor sign-in for one account (lost phone and no recovery codes).
//   sudo -u camchat env DATA_DIR=/var/lib/camchat node /opt/camchat/scripts/reset-2fa.mjs <username>
// Server shell access is the trust boundary: this is the owner's escape hatch, so no admin is ever locked out.
// Nothing is deleted: the secret row is marked disabled, passkeys are marked removed and unused recovery codes are marked used.
// Sessions still waiting for a code are cleared to signed-out (they must sign in again).
import path from 'node:path';
import fs from 'node:fs';
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');
const username = process.argv[2];
if (!username) { console.error('Usage: node scripts/reset-2fa.mjs <username>'); process.exit(2); }
const dbPath = path.join(path.resolve(process.env.DATA_DIR || './data'), 'camchat.db');
if (!fs.existsSync(dbPath)) { console.error(`No database at ${dbPath}. Set DATA_DIR.`); process.exit(1); }
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_totp'").get();
if (!has) { console.log('This database has no two-factor table yet (older release). Nothing to do.'); process.exit(0); }
const u = db.prepare('SELECT id, username FROM users WHERE username_lower = ?').get(username.toLowerCase());
if (!u) { console.error(`No registered user "${username}".`); process.exit(1); }
const t = db.prepare('SELECT enabled_at FROM user_totp WHERE user_id = ?').get(u.id);
const hasPk = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_passkeys'").get();
const pk = hasPk ? db.prepare('SELECT COUNT(*) AS n FROM user_passkeys WHERE user_id = ? AND removed_at IS NULL').get(u.id).n : 0;
if (!t?.enabled_at && !pk) { console.log(`${u.username}: two-factor is already off.`); process.exit(0); }
const now = Date.now();
if (pk) db.prepare('UPDATE user_passkeys SET removed_at = ? WHERE user_id = ? AND removed_at IS NULL').run(now, u.id);
if (t?.enabled_at) db.prepare('UPDATE user_totp SET enabled_at = NULL WHERE user_id = ?').run(u.id);
db.prepare('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, u.id);
db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ? AND mfa_pending = 1').run(now, u.id);
db.prepare('INSERT INTO mod_log (ts, actor, action, target, details) VALUES (?,?,?,?,?)').run(now, 'cli', '2fa-reset', u.username, 'reset-2fa.mjs');
console.log(`${u.username}: two-factor turned off. They can sign in with their password or Discord/Google and set it up again.`);
