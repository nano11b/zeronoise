// Promote (or change the role of) a registered account.
//   npm run make-admin -- <username> [--role admin|moderator|user]
// Uses DATA_DIR (default ./data). On the server run it as the service user, e.g.
//   sudo -u camchat env DATA_DIR=/var/lib/camchat node /opt/camchat/scripts/make-admin.mjs <username>
// The user gets the new role the next time they connect (reload the page).
import path from 'node:path';
import fs from 'node:fs';
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');

const args = process.argv.slice(2);
const roleIdx = args.indexOf('--role');
const role = roleIdx >= 0 ? args[roleIdx + 1] : 'admin';
const username = args.find((a, i) => !a.startsWith('--') && (roleIdx < 0 || i !== roleIdx + 1));
if (!username || !['admin', 'moderator', 'user'].includes(role)) {
  console.error('Usage: npm run make-admin -- <username> [--role admin|moderator|user]');
  process.exit(2);
}
const dbPath = path.join(path.resolve(process.env.DATA_DIR || './data'), 'camchat.db');
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Set DATA_DIR, and start the server once first.`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
const u = db.prepare('SELECT id, username, role FROM users WHERE username_lower = ?').get(username.toLowerCase());
if (!u) {
  console.error(`No registered user "${username}". Register the account on the site first.`);
  process.exit(1);
}
db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
db.prepare('INSERT INTO mod_log (ts, actor, action, target, details) VALUES (?,?,?,?,?)').run(Date.now(), 'cli', 'role', u.username, `${u.role} -> ${role}`);
console.log(`${u.username}: ${u.role} -> ${role}. Reload the page to pick up the new role.`);
