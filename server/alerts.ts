/**
 * Batch F9: uptime and error alerts by email (the existing Resend/SMTP sender), to admins.
 *  - error spike: N guarded errors (socket/http/timer) within a window -> one email, then a cooldown
 *  - crash restart: the previous run did not exit cleanly (crash, OOM kill, power loss) -> email at boot
 *  - backup restore check failures (F10) go through raise() too
 * A server that is down cannot email anyone: pair this with an outside pinger on /api/uptime (deploy/UPTIME.md).
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR, PUBLIC_URL } from './env';
import { q } from './db';
import { brandedHtml, sendMail } from './mail';
import { BRAND_NAME } from '../shared/config';

const env = process.env;
export const ERROR_THRESHOLD = Math.max(1, Number(env.ALERT_ERRORS_THRESHOLD) || 25);
export const ERROR_WINDOW_MS = Math.max(1000, Number(env.ALERT_ERRORS_WINDOW_MS) || 5 * 60_000);
const COOLDOWN_MS = Math.max(0, Number(env.ALERT_COOLDOWN_MS ?? '') >= 0 && env.ALERT_COOLDOWN_MS ? Number(env.ALERT_COOLDOWN_MS) : 30 * 60_000);
const RUN_FILE = path.join(DATA_DIR, 'run-state.json');
const errors: number[] = [];
const lastByKind = new Map<string, number>();
let lastSource = '';

export type AlertKind = 'error-spike' | 'crash-restart' | 'restore-check' | 'test';
export interface AlertRow { id: number; kind: string; at: number; subject: string; detail: string; recipients: number; sent: number }

function recipients(): string[] {
  const extra = (env.ALERT_EMAILS || '').split(',').map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+$/.test(s));
  const admins = (q("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND email_verified_at IS NOT NULL").all() as { email: string }[]).map((r) => r.email);
  return [...new Set([...extra, ...admins].map((e) => e.toLowerCase()))].slice(0, 20);
}
export const recipientCount = () => recipients().length;

/** Record an alert and email the admins (no more than one per kind per cooldown, except tests). */
export function raise(kind: AlertKind, subject: string, detail: string): boolean {
  const now = Date.now();
  if (kind !== 'test' && now - (lastByKind.get(kind) ?? 0) < COOLDOWN_MS) return false;
  lastByKind.set(kind, now);
  const to = recipients();
  const id = Number((q('INSERT INTO ops_alerts (kind, at, subject, detail, recipients, sent) VALUES (?,?,?,?,?,0) RETURNING id').get(kind, now, subject, detail.slice(0, 2000), to.length) as { id: number }).id);
  console.warn(`[alert] ${kind}: ${subject} (${to.length} recipient(s))`);
  const where = PUBLIC_URL ? `${PUBLIC_URL}/status` : '/status';
  const text = `${detail}\n\nTime: ${new Date(now).toISOString()}\nStatus page: ${where}\n\nYou get this because you are a ${BRAND_NAME} admin.`;
  void Promise.all(to.map((t) => sendMail(t, `[${BRAND_NAME}] ${subject}`, text, brandedHtml(subject, [detail, `Time: ${new Date(now).toISOString()}`, `Status page: ${where}`]))))
    .then((r) => { try { q('UPDATE ops_alerts SET sent = ? WHERE id = ?').run(r.filter(Boolean).length, id); } catch { /* shutting down */ } })
    .catch(() => {});
  return true;
}
/** Called for every guarded error (see guard.ts hooks). */
export function noteError(source: string) {
  const now = Date.now();
  errors.push(now); lastSource = source;
  while (errors.length && now - errors[0] > ERROR_WINDOW_MS) errors.shift();
  if (errors.length >= ERROR_THRESHOLD) {
    const n = errors.length; const mins = Math.round(ERROR_WINDOW_MS / 60_000) || 1;
    if (raise('error-spike', `Error spike: ${n} errors in ${mins} min`, `${n} server errors in the last ${mins} minute(s) (alert threshold ${ERROR_THRESHOLD}). Latest: ${lastSource}. Check the service log: journalctl -u camchat -n 200`)) errors.length = 0;
  }
}
export const errorsInWindow = () => { const now = Date.now(); return errors.filter((t) => now - t <= ERROR_WINDOW_MS).length; };

interface RunState { pid: number; startedAt: number; clean: boolean; fatal?: string }
const readRun = (): RunState | null => { try { return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')); } catch { return null; } };
const writeRun = (s: RunState) => { try { fs.writeFileSync(RUN_FILE, JSON.stringify(s), { mode: 0o640 }); } catch { /* read-only data dir: no crash detection */ } };
let current: RunState | null = null;
/** At startup: was the last run cut short? Then start a new run record. */
export function bootCheck(startedAt: number) {
  const prev = readRun();
  current = { pid: process.pid, startedAt, clean: false };
  writeRun(current);
  if (prev && !prev.clean) {
    const ran = Math.round((startedAt - prev.startedAt) / 60_000);
    raise('crash-restart', 'Restarted after a crash', `The server restarted after an unclean exit. The previous run (pid ${prev.pid}) started ${new Date(prev.startedAt).toISOString()} and ended without a normal shutdown after about ${ran} min.${prev.fatal ? ` Last fatal error: ${prev.fatal}` : ' (no fatal error was logged: likely killed, out of memory, or a power loss)'}`);
  }
}
export function markCleanExit() { if (current) writeRun({ ...current, clean: true }); }
export function noteFatal(text: string) { if (current) writeRun({ ...current, clean: false, fatal: text.slice(0, 300) }); }
export const recentAlerts = (n = 20) => q('SELECT * FROM ops_alerts ORDER BY id DESC LIMIT ?').all(n) as unknown as AlertRow[];
