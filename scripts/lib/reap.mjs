// batch H9: test servers must never outlive the test script.
// Importing this first makes every child_process.spawn() child get killed when the script exits,
// crashes, or is stopped by the suite runner's timeout (SIGTERM) / Ctrl-C.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const kids = new Set();
const origSpawn = cp.spawn;
cp.spawn = function (...args) {
  const child = origSpawn.apply(this, args);
  kids.add(child);
  child.once('exit', () => kids.delete(child));
  return child;
};
syncBuiltinESMExports();

function reap() { for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* already gone */ } } kids.clear(); }
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { reap(); process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1)); });
process.on('uncaughtException', (e) => { console.error('crashed:', e); reap(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('crashed (unhandled rejection):', e); reap(); process.exit(1); });
