/**
 * Batch F10: daily backup restore check. Restores the newest backup's database into a temp directory, runs
 * PRAGMA integrity_check, compares the checksum and schema version with the backup manifest, and sanity-checks
 * row counts against the live database. Result on /status and in the admin panel; failures email the admins.
 * Never touches the live data; the temp copy is removed afterwards.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { q } from './db';
import { BACKUP_DIR, BACKUP_HOUR, BACKUP_MINUTE, BACKUP_DISABLED, listBackups } from './backup';
import { raise } from './alerts';

const env = process.env;
const TEST_EVERY_MS = Number(env.RESTORE_CHECK_EVERY_MS) || 0;
export const RESTORE_CHECK_DISABLED = env.RESTORE_CHECK_DISABLED === '1';
/** tables whose row counts must roughly match live (live may have grown since the backup) */
const SANITY_TABLES = ['users', 'rooms', 'messages', 'room_visitors'];
export interface CheckRow { id: number; at: number; backup: string | null; ok: number; status: 'ok' | 'failed' | 'skipped'; ms: number; detail: string }
let running: Promise<CheckRow> | null = null;
let nextAt: number | null = null;

function sysTarExtract(archive: string, dir: string): Promise<void> {
  return new Promise((res, rej) => execFile('tar', ['-xzf', archive, '-C', dir, 'camchat.db', 'manifest.json'], { timeout: 10 * 60_000 }, (e) => (e ? rej(e) : res())));
}
/** Fallback when there is no tar: stream-gunzip and pull the two entries out of the ustar stream. */
function nodeExtract(archive: string, dir: string): Promise<void> {
  return new Promise((res, rej) => {
    const want = new Set(['camchat.db', 'manifest.json']);
    let buf = Buffer.alloc(0); let left = 0; let pad = 0; let out: fs.WriteStream | null = null; let done = false;
    const gz = fs.createReadStream(archive).pipe(zlib.createGunzip());
    gz.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (left > 0) { const n = Math.min(left, buf.length); if (out && n) out.write(buf.subarray(0, n)); buf = buf.subarray(n); left -= n; if (left > 0) return; if (out) { out.end(); out = null; } continue; }
        if (pad > 0) { const n = Math.min(pad, buf.length); buf = buf.subarray(n); pad -= n; if (pad > 0) return; continue; }
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512); buf = buf.subarray(512);
        if (h.every((b) => b === 0)) { done = true; return; }
        const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '').replace(/^\.\//, '');
        const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
        left = size; pad = (512 - (size % 512)) % 512;
        out = want.has(name) ? fs.createWriteStream(path.join(dir, name), { mode: 0o600 }) : null;
        if (size === 0 && out) { out.end(); out = null; }
      }
    });
    gz.on('end', () => { void done; res(); });
    gz.on('error', rej);
  });
}
const sha256 = (f: string) => new Promise<string>((res, rej) => { const h = createHash('sha256'); fs.createReadStream(f).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const count = (d: DatabaseSync, t: string) => { try { return Number((d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n); } catch { return -1; } };

async function doCheck(reason: string): Promise<CheckRow> {
  const t0 = Date.now();
  const latest = listBackups()[0];
  const save = (status: CheckRow['status'], backup: string | null, detail: Record<string, unknown>) =>
    q('INSERT INTO backup_checks (at, backup, ok, status, ms, detail) VALUES (?,?,?,?,?,?) RETURNING *').get(Date.now(), backup, status === 'ok' ? 1 : 0, status, Date.now() - t0, JSON.stringify({ reason, ...detail })) as unknown as CheckRow;
  if (!latest) return save('skipped', null, { note: BACKUP_DISABLED ? 'backups are turned off' : 'no backup yet' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-restore-check-'));
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  try {
    const archive = path.join(BACKUP_DIR, latest.name);
    if (env.RESTORE_CHECK_NODE_TAR === '1') await nodeExtract(archive, tmp);
    else { try { await sysTarExtract(archive, tmp); } catch { await nodeExtract(archive, tmp); } }
    detail.extractor = env.RESTORE_CHECK_NODE_TAR === '1' ? 'node' : 'tar';
    const dbf = path.join(tmp, 'camchat.db');
    if (!fs.existsSync(dbf)) throw new Error('the archive has no camchat.db');
    let manifest: { db?: { sha256?: string; userVersion?: number } } = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')); } catch { problems.push('manifest.json missing or unreadable'); }
    const sum = await sha256(dbf);
    detail.sha256 = sum === manifest.db?.sha256 ? 'match' : 'MISMATCH';
    if (manifest.db?.sha256 && sum !== manifest.db.sha256) problems.push('database checksum does not match the manifest');
    const ro = new DatabaseSync(dbf, { readOnly: true });
    try {
      const ic = (ro.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check);
      detail.integrity = ic.length === 1 && ic[0] === 'ok' ? 'ok' : ic.slice(0, 5);
      if (detail.integrity !== 'ok') problems.push(`integrity_check: ${ic.slice(0, 3).join('; ')}`);
      const uv = Number((ro.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      detail.userVersion = uv;
      if (manifest.db?.userVersion != null && uv !== manifest.db.userVersion) problems.push(`schema version ${uv} differs from the manifest (${manifest.db.userVersion})`);
      const live = q('PRAGMA user_version').get() as { user_version: number };
      if (uv > Number(live.user_version)) problems.push(`backup schema ${uv} is newer than live ${live.user_version}`);
      const counts: Record<string, [number, number]> = {};
      for (const t of SANITY_TABLES) {
        const b = count(ro, t); const l = Number((q(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n);
        counts[t] = [b, l];
        if (b < 0) problems.push(`table ${t} is missing in the backup`);
        else if (l > 0 && b === 0 && (t === 'users' || t === 'rooms')) problems.push(`${t}: backup is empty but live has ${l}`);
        else if (l >= 20 && b < l * 0.5) problems.push(`${t}: backup has ${b} rows, live has ${l} (less than half)`);
      }
      detail.counts = counts;
    } finally { ro.close(); }
  } catch (e) {
    problems.push(`restore failed: ${(e as Error).message}`.slice(0, 300));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const row = save(problems.length ? 'failed' : 'ok', latest.name, { ...detail, problems });
  if (problems.length) raise('restore-check', 'Backup restore check failed', `The daily restore check of ${latest.name} failed:\n- ${problems.join('\n- ')}\nThe live site is not affected, but this backup may not be usable. See Admin > Backups.`);
  else console.log(`[restore-check] ${latest.name} ok in ${row.ms} ms`);
  return row;
}
export function runRestoreCheck(reason: 'daily' | 'manual'): Promise<CheckRow> {
  if (running) return running;
  running = doCheck(reason).finally(() => { running = null; });
  return running;
}
export const restoreCheckRunning = () => !!running;
export const recentChecks = (n = 10) => q('SELECT * FROM backup_checks ORDER BY id DESC LIMIT ?').all(n) as unknown as CheckRow[];
export const lastCheck = () => q("SELECT * FROM backup_checks WHERE status <> 'skipped' ORDER BY id DESC LIMIT 1").get() as unknown as CheckRow | undefined;
export const restoreSchedule = () => ({ nextAt, disabled: RESTORE_CHECK_DISABLED || (BACKUP_DISABLED && !TEST_EVERY_MS), schedule: TEST_EVERY_MS ? `every ${TEST_EVERY_MS} ms (test)` : 'daily, 30 min after the nightly backup' });
/** 30 minutes after the nightly backup (server local time), every day. */
export function initRestoreChecks() {
  if (RESTORE_CHECK_DISABLED || (BACKUP_DISABLED && !TEST_EVERY_MS)) return;
  const plan = () => {
    let wait = TEST_EVERY_MS;
    if (!wait) {
      const now = new Date(); const t = new Date(now); t.setHours(BACKUP_HOUR, BACKUP_MINUTE + 30, 0, 0);
      if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
      wait = t.getTime() - now.getTime();
    }
    nextAt = Date.now() + wait;
    setTimeout(() => { void runRestoreCheck('daily').catch((e) => console.error('[restore-check]', e)).finally(plan); }, wait).unref();
  };
  plan();
}
