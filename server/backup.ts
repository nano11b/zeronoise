/**
 * Nightly in-app backups, done by the running server (no root, no cron).
 *
 * Each run: a consistent SQLite snapshot (VACUUM INTO) plus the user upload folders and vapid.json,
 * packed into DATA_DIR/backups/camchat-YYYYMMDD-HHMMSS.tar.gz (server local time). The archive is
 * written under a temp name, checked (full gunzip pass), chmod 0640, then renamed. Newest 7 kept.
 * Restore is manual: deploy/RESTORE-BACKUP.md.
 */
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import zlib from 'zlib';
import { DatabaseSync } from 'node:sqlite';
import { db, DB_PATH } from './db';
import { DATA_DIR } from './env';
import { guardTimer } from './guard';
import { live } from './live';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
/** The only names the admin API will ever touch. */
export const BACKUP_NAME_RE = /^camchat-\d{8}-\d{6}\.tar\.gz$/;
export const BACKUP_KEEP = 7;
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const MAX_FREE_FRACTION = 0.3;
/** User data worth keeping. Link-preview images and radio art are caches; downloads/ holds re-uploadable app installers. */
export const BACKUP_DIRS = ['avatars', 'room-thumbs', 'room-icons', 'room-emotes', 'voice', 'sounds', 'uploads', 'report-evidence'] as const;
export const BACKUP_FILES = ['vapid.json'] as const;

const env = process.env;
const intIn = (v: string | undefined, lo: number, hi: number, d: number) => {
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  if (Number.isInteger(n) && n >= lo && n <= hi) return n;
  console.warn(`[backup] ignoring bad value ${JSON.stringify(v)} (want ${lo}-${hi}); using ${d}`);
  return d;
};
export const BACKUP_HOUR = intIn(env.BACKUP_HOUR, 0, 23, 4);
export const BACKUP_MINUTE = intIn(env.BACKUP_MINUTE, 0, 59, 15);
export const BACKUP_DISABLED = env.BACKUP_DISABLED === '1';
const STARTUP_DELAY_MS = Math.max(0, Number(env.BACKUP_STARTUP_DELAY_MS) || 10 * 60_000);
/** test-only: replace the nightly slot with a fixed interval */
const TEST_EVERY_MS = Number(env.BACKUP_TEST_EVERY_MS) || 0;
/** test-only: hold each run open this long (to test the one-at-a-time guard) */
const TEST_SLOW_MS = Number(env.BACKUP_TEST_SLOW_MS) || 0;
/** test-only: file whose content is the "free bytes" to assume (low-disk path) */
const TEST_FREE_FILE = env.BACKUP_TEST_FREE_FILE || '';
/** test-only: force the pure-Node tar writer */
const FORCE_NODE_TAR = env.BACKUP_TEST_NODE_TAR === '1';

export type BackupReason = 'nightly' | 'startup' | 'manual';
export interface BackupInfo { name: string; size: number; createdAt: number; ok: boolean }
export interface BackupResult { ok: boolean; name?: string; size?: number; error?: string; busy?: boolean; aborted?: boolean }
interface State { lastAt: number | null; lastOk: boolean | null; lastError: string | null; lastName: string | null; verified: Record<string, boolean> }

const STATE_FILE = path.join(BACKUP_DIR, 'state.json');
let state: State = { lastAt: null, lastOk: null, lastError: null, lastName: null, verified: {} };
let running: Promise<BackupResult> | null = null;
let nextAt: number | null = null;

function ensureDir() { fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o750 }); }
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<State>;
    state = {
      lastAt: typeof j.lastAt === 'number' ? j.lastAt : null,
      lastOk: typeof j.lastOk === 'boolean' ? j.lastOk : null,
      lastError: typeof j.lastError === 'string' ? j.lastError : null,
      lastName: typeof j.lastName === 'string' ? j.lastName : null,
      verified: j.verified && typeof j.verified === 'object' ? j.verified as Record<string, boolean> : {},
    };
  } catch {
    // no state yet: fall back to the newest archive on disk
    const newest = listArchivesSync()[0];
    if (newest) state = { ...state, lastAt: newest.createdAt, lastOk: true, lastName: newest.name };
  }
}
function saveState() {
  try {
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o640 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('[backup] could not save state', (e as Error).message); }
}
function record(ok: boolean, name: string | null, error: string | null) {
  state.lastAt = Date.now();
  state.lastOk = ok;
  state.lastError = error;
  if (name) state.lastName = name;
  saveState();
}

function listArchivesSync(): BackupInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(BACKUP_DIR); } catch { return []; }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    try {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      if (st.isFile()) out.push({ name, size: st.size, createdAt: st.mtimeMs, ok: state.verified[name] !== false && st.size > 0 });
    } catch { /* raced with rotation */ }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}
export const listBackups = (): BackupInfo[] => listArchivesSync();
/** Absolute path for a backup name, or null. Only exact pattern matches inside BACKUP_DIR. */
export function backupPath(name: unknown): string | null {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) return null;
  const p = path.join(BACKUP_DIR, name);
  if (path.dirname(p) !== BACKUP_DIR) return null;
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}
export const backupHealth = () => ({ lastBackupAt: state.lastAt, lastBackupOk: state.lastOk });
export const backupStatus = () => ({
  running: !!running, lastAt: state.lastAt, lastOk: state.lastOk, lastError: state.lastError,
  nextAt, disabled: BACKUP_DISABLED, keep: BACKUP_KEEP, schedule: TEST_EVERY_MS ? `every ${TEST_EVERY_MS} ms (test)` : `${String(BACKUP_HOUR).padStart(2, '0')}:${String(BACKUP_MINUTE).padStart(2, '0')}`,
});
export const backupRunning = () => !!running;

// ---------------- helpers ----------------
const p2 = (n: number) => String(n).padStart(2, '0');
function stampName(d: Date) {
  return `camchat-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.tar.gz`;
}
async function freeBytes(): Promise<number> {
  if (TEST_FREE_FILE) {
    try { const n = Number((await fs.promises.readFile(TEST_FREE_FILE, 'utf8')).trim()); if (Number.isFinite(n)) return n; } catch { /* fall through */ }
  }
  const s = await fs.promises.statfs(DATA_DIR);
  return Number(s.bavail) * Number(s.bsize);
}
/** Files (relative to DATA_DIR) under the backed-up folders; async, never follows symlinks. */
async function walk(rel: string, out: { rel: string; size: number }[]) {
  let ents: fs.Dirent[];
  try { ents = await fs.promises.readdir(path.join(DATA_DIR, rel), { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(r, out);
    else if (e.isFile()) {
      try { out.push({ rel: r, size: (await fs.promises.stat(path.join(DATA_DIR, r))).size }); } catch { /* deleted meanwhile */ }
    }
  }
}
async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), async function* (src) { for await (const c of src) h.update(c as Buffer); });
  return h.digest('hex');
}
async function rmrf(p: string) { await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {}); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- tar writers ----------------
function systemTar(out: string, staging: string, dirs: string[], files: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-czf', out, '--warning=no-file-changed', '--ignore-failed-read', '-C', staging, 'manifest.json', 'camchat.db'];
    const rest = [...dirs, ...files];
    if (rest.length) args.push('-C', DATA_DIR, ...rest);
    let err = '';
    const p = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => { if (err.length < 2000) err += String(d); });
    p.on('error', reject);
    // GNU tar: 1 = "some files differ" (changed while read) - the archive is still complete
    p.on('close', (code) => (code === 0 || code === 1 ? resolve() : reject(new Error(`tar exited ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

/** Minimal ustar writer (fallback when no system tar): entries streamed through gzip. */
function ustarHeader(name: string, size: number, mode: number, mtime: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(512);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const i = name.lastIndexOf('/', 154);
    if (i <= 0 || Buffer.byteLength(name.slice(i + 1)) > 100) throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, i); base = name.slice(i + 1);
  }
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  h.write(base, 0, 100, 'utf8');
  h.write(oct(mode & 0o7777, 8), 100, 'ascii');
  h.write(oct(0, 8), 108, 'ascii');
  h.write(oct(0, 8), 116, 'ascii');
  h.write(oct(size, 12), 124, 'ascii');
  h.write(oct(Math.floor(mtime / 1000), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}
async function* tarEntries(entries: { abs: string; name: string }[], dirNames: string[]): AsyncGenerator<Buffer> {
  const now = Date.now();
  for (const d of dirNames) yield ustarHeader(`${d}/`, 0, 0o750, now, '5');
  for (const e of entries) {
    let fh: fs.promises.FileHandle;
    try { fh = await fs.promises.open(e.abs, 'r'); } catch { continue; } // deleted since listing
    try {
      const st = await fh.stat();
      if (!st.isFile()) continue;
      const size = st.size;
      yield ustarHeader(e.name, size, st.mode, st.mtimeMs, '0');
      let left = size;
      const buf = Buffer.alloc(64 * 1024);
      while (left > 0) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, left), null);
        if (!bytesRead) { yield Buffer.alloc(left); left = 0; break; } // shrank meanwhile: pad to the promised size
        yield Buffer.from(buf.subarray(0, bytesRead));
        left -= bytesRead;
      }
      const pad = (512 - (size % 512)) % 512;
      if (pad) yield Buffer.alloc(pad);
    } finally { await fh.close(); }
  }
  yield Buffer.alloc(1024);
}
async function nodeTar(out: string, staging: string, dirs: string[], files: string[]) {
  const entries: { abs: string; name: string }[] = [
    { abs: path.join(staging, 'manifest.json'), name: 'manifest.json' },
    { abs: path.join(staging, 'camchat.db'), name: 'camchat.db' },
  ];
  const subdirs = new Set<string>();
  for (const d of dirs) {
    const list: { rel: string; size: number }[] = [];
    await walk(d, list);
    subdirs.add(d);
    for (const f of list) {
      const parts = f.rel.split('/');
      for (let i = 1; i < parts.length - 1; i++) subdirs.add(parts.slice(0, i + 1).join('/'));
      entries.push({ abs: path.join(DATA_DIR, f.rel), name: f.rel });
    }
  }
  for (const f of files) entries.push({ abs: path.join(DATA_DIR, f), name: f });
  await pipeline(Readable.from(tarEntries(entries, [...subdirs].sort())), zlib.createGzip({ level: 6 }), fs.createWriteStream(out, { mode: 0o640 }));
}
/** Full gunzip pass: catches truncated or corrupt archives (CRC + length are checked by zlib). */
async function verifyGzip(file: string): Promise<number> {
  let n = 0;
  await pipeline(fs.createReadStream(file), zlib.createGunzip(), async function* (src) { for await (const c of src) n += (c as Buffer).length; });
  return n;
}

// ---------------- the run ----------------
export function runBackup(reason: BackupReason): Promise<BackupResult> {
  if (running) return Promise.resolve({ ok: false, busy: true, error: 'A backup is already running' });
  running = doBackup(reason).catch((e) => {
    const msg = (e as Error)?.message || String(e);
    console.error('[backup] failed', msg);
    record(false, null, msg.slice(0, 300));
    return { ok: false, error: msg } as BackupResult;
  }).finally(() => { running = null; });
  return running;
}

async function doBackup(reason: BackupReason): Promise<BackupResult> {
  ensureDir();
  const started = Date.now();
  // ---- disk space guard (nothing is deleted on abort) ----
  const dirs = BACKUP_DIRS.filter((d) => { try { return fs.statSync(path.join(DATA_DIR, d)).isDirectory(); } catch { return false; } });
  const files = BACKUP_FILES.filter((f) => { try { return fs.statSync(path.join(DATA_DIR, f)).isFile(); } catch { return false; } });
  const listed: Record<string, { rel: string; size: number }[]> = {};
  let estimate = 0;
  for (const f of [DB_PATH, `${DB_PATH}-wal`]) { try { estimate += fs.statSync(f).size; } catch { /* no wal */ } }
  for (const d of dirs) { listed[d] = []; await walk(d, listed[d]); for (const f of listed[d]) estimate += f.size; }
  for (const f of files) estimate += fs.statSync(path.join(DATA_DIR, f)).size;
  const free = await freeBytes();
  if (free < MIN_FREE_BYTES || estimate > free * MAX_FREE_FRACTION) {
    const msg = free < MIN_FREE_BYTES
      ? `only ${(free / 1024 ** 3).toFixed(2)} GB free under DATA_DIR (need 2 GB)`
      : `backup (~${(estimate / 1024 ** 2).toFixed(1)} MB) would use more than 30% of the ${(free / 1024 ** 2).toFixed(0)} MB free`;
    console.error(`[backup] aborted (${reason}): ${msg}`);
    record(false, null, `aborted: ${msg}`);
    return { ok: false, aborted: true, error: `Backup aborted: ${msg}` };
  }

  let d = new Date();
  let name = stampName(d);
  while (fs.existsSync(path.join(BACKUP_DIR, name))) { d = new Date(d.getTime() + 1000); name = stampName(d); }
  const tag = randomBytes(6).toString('hex');
  const staging = path.join(BACKUP_DIR, `.tmp-${tag}`);
  const part = path.join(BACKUP_DIR, `.tmp-${tag}.tar.gz.part`);
  await fs.promises.mkdir(staging, { mode: 0o750 });
  try {
    // ---- consistent DB snapshot (synchronous by design; usually well under a second) ----
    const snap = path.join(staging, 'camchat.db');
    const t0 = Date.now();
    db.prepare('VACUUM INTO ?').run(snap);
    const vacuumMs = Date.now() - t0;
    console.log(`[backup] VACUUM INTO took ${vacuumMs} ms`);
    const ro = new DatabaseSync(snap, { readOnly: true });
    let userVersion = 0;
    let tables = 0;
    try {
      userVersion = Number((ro.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      tables = Number((ro.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n);
    } finally { ro.close(); }
    const dbSha = await sha256File(snap);
    const dbBytes = (await fs.promises.stat(snap)).size;
    if (TEST_SLOW_MS) await sleep(TEST_SLOW_MS);

    const counts: Record<string, number> = {};
    let total = 0;
    for (const dname of dirs) { counts[dname] = listed[dname].length; total += listed[dname].length; }
    const manifest = {
      format: 1, app: 'camchat', name, reason, createdAt: Date.now(), build: live.buildId || null,
      db: { file: 'camchat.db', userVersion, tables, bytes: dbBytes, sha256: dbSha, vacuumMs },
      files: counts, extraFiles: files, totalFiles: total + files.length,
      skipped: ['downloads (app installers)', 'link-preview and radio caches', '.session_secret'],
    };
    await fs.promises.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o640 });

    // ---- archive ----
    let how = 'system tar';
    if (FORCE_NODE_TAR) { how = 'node tar'; await nodeTar(part, staging, dirs, files); }
    else {
      try { await systemTar(part, staging, dirs, files); }
      catch (e) {
        console.warn(`[backup] system tar unavailable or failed (${(e as Error).message}); using the built-in writer`);
        await rmrf(part);
        how = 'node tar';
        await nodeTar(part, staging, dirs, files);
      }
    }
    await verifyGzip(part);
    await fs.promises.chmod(part, 0o640);
    const final = path.join(BACKUP_DIR, name);
    await fs.promises.rename(part, final);
    const size = (await fs.promises.stat(final)).size;
    state.verified[name] = true;

    // ---- rotation (only after a good backup) ----
    const all = listArchivesSync();
    for (const old of all.slice(BACKUP_KEEP)) {
      await fs.promises.unlink(path.join(BACKUP_DIR, old.name)).catch(() => {});
      delete state.verified[old.name];
    }
    for (const k of Object.keys(state.verified)) if (!all.some((a) => a.name === k)) delete state.verified[k];
    record(true, name, null);
    console.log(`[backup] ok ${name} (${reason}, ${how}) ${(size / 1024 ** 2).toFixed(1)} MB, ${total + files.length} files, ${Date.now() - started} ms`);
    return { ok: true, name, size };
  } finally {
    await rmrf(staging);
    await rmrf(part);
  }
}

// ---------------- scheduling ----------------
function nextNightly(from = new Date()): Date {
  const n = new Date(from);
  n.setHours(BACKUP_HOUR, BACKUP_MINUTE, 0, 0);
  if (n.getTime() <= from.getTime() + 1000) n.setDate(n.getDate() + 1);
  return n;
}
let schedTimer: NodeJS.Timeout | null = null;
function armNightly() {
  const wait = TEST_EVERY_MS ? TEST_EVERY_MS : Math.min(nextNightly().getTime() - Date.now(), 2 ** 31 - 1);
  nextAt = Date.now() + wait;
  schedTimer = setTimeout(guardTimer('backup nightly', async () => {
    try { await runBackup('nightly'); } finally { armNightly(); }
  }), wait);
  schedTimer.unref();
}

/** Start the schedule (call once at boot). Leftover temp files from a crash are removed. */
export function initBackups() {
  ensureDir();
  try {
    for (const n of fs.readdirSync(BACKUP_DIR)) if (n.startsWith('.tmp-')) fs.rmSync(path.join(BACKUP_DIR, n), { recursive: true, force: true });
  } catch { /* ignore */ }
  loadState();
  if (BACKUP_DISABLED) { console.log('[backup] automatic backups disabled (BACKUP_DISABLED=1)'); return; }
  armNightly();
  setTimeout(guardTimer('backup startup', async () => {
    const newest = listArchivesSync()[0];
    if (!newest || Date.now() - newest.createdAt > 24 * 3600_000) await runBackup('startup');
  }), STARTUP_DELAY_MS).unref();
}
