/**
 * Set or clear the site moderator bot. Run on the server as the service user, after the
 * process that owns DATA_DIR has started at least once (so the database exists):
 *   node dist/server/set-moderator-bot.js Meowington
 *   node dist/server/set-moderator-bot.js --clear
 * Uses DATA_DIR (default ./data). The running server picks the change up on the next request.
 */
import { migrate } from './server/db';
import * as repo from './server/repo';

migrate();

const arg = process.argv[2];
if (!arg || arg === '--help' || arg === '-h') {
  console.error('Usage: node dist/server/set-moderator-bot.js <bot name>');
  console.error('       node dist/server/set-moderator-bot.js --clear');
  console.error('Uses DATA_DIR (default ./data). Run as the service user.');
  process.exit(2);
}

if (arg === '--clear' || arg.toLowerCase() === 'none') {
  const prevId = repo.moderatorBotId();
  const prev = prevId ? repo.botById(prevId) : undefined;
  repo.setModeratorBotId(null);
  repo.logAction('cli', null, 'moderator-bot', prev?.name ?? null, null, 'cleared');
  console.log('Moderator bot cleared.');
  process.exit(0);
}

const bot = repo.botByName(arg);
if (!bot) {
  console.error(`No bot named "${arg}". Create it in the profile panel first, then run this again.`);
  process.exit(1);
}
repo.setModeratorBotId(bot.id);
repo.logAction('cli', null, 'moderator-bot', bot.name, null, 'set');
console.log(`Moderator bot is now ${bot.name}.`);
process.exit(0);
