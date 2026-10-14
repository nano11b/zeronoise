// Delete registered accounts whose username matches a LIKE pattern (default zz_test_%).
//   npm run delete-test-users -- [pattern]
//   DATA_DIR=/var/lib/camchat node scripts/delete-test-users.mjs 'zz_test_%'
// On the Debian server (as root or the camchat user):
//   sudo -u camchat env DATA_DIR=/var/lib/camchat node /opt/camchat/scripts/delete-test-users.mjs
import path from 'node:path';
import fs from 'node:fs';
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');

const pattern = (process.argv[2] || 'zz_test_%').toLowerCase();
if (!pattern.includes('%') && !pattern.includes('_')) {
  console.error('Refusing a pattern without % or _ wildcards (too dangerous). Example: zz_test_%');
  process.exit(2);
}
const dbPath = path.join(path.resolve(process.env.DATA_DIR || './data'), 'camchat.db');
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Set DATA_DIR.`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
const list = db.prepare('SELECT id, username FROM users WHERE username_lower LIKE ?').all(pattern);
if (!list.length) {
  console.log(`No users matching LIKE '${pattern}'.`);
  process.exit(0);
}
console.log(`Will delete ${list.length} user(s): ${list.map((u) => u.username).join(', ')}`);
if (process.env.CONFIRM !== '1' && process.argv[3] !== '--yes') {
  console.log('Re-run with --yes (or CONFIRM=1) to proceed.');
  process.exit(3);
}
db.exec('BEGIN');
try {
  for (const u of list) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    try { db.prepare('DELETE FROM friendships WHERE user_id = ? OR peer_id = ?').run(u.id, u.id); } catch {}
    try { db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id); } catch {}
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    db.prepare('INSERT INTO mod_log (ts, actor, action, target, details) VALUES (?,?,?,?,?)')
      .run(Date.now(), 'cli', 'delete-test-user', u.username, pattern);
  }
  db.exec('COMMIT');
  console.log(`Deleted ${list.length} account(s).`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error(e);
  process.exit(1);
}
