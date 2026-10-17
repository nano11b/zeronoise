/** Batch D data access: XP and levels, ban appeals, two-factor sign-in, data export. */
import { createHash } from 'crypto';
import { q, tx } from './db';
import { levelFor, XP_DAILY_CAP } from '../shared/xp';

const now = () => Date.now();
const dayOf = (ms: number) => Math.floor(ms / 86_400_000);

// ---------------- XP (migration 42) ----------------
export interface XpRow { xp: number; hidden: boolean; today: number; day: number; lastAt: number; lastKey: string | null }
export function xpOf(userId: number): XpRow {
  const r = q('SELECT xp, xp_hidden, xp_day, xp_today, xp_last_at, xp_last_key FROM users WHERE id = ?').get(userId) as
    { xp: number; xp_hidden: number; xp_day: number | null; xp_today: number; xp_last_at: number | null; xp_last_key: string | null } | undefined;
  const d = dayOf(now());
  return { xp: r?.xp ?? 0, hidden: !!r?.xp_hidden, today: r && r.xp_day === d ? r.xp_today : 0, day: d, lastAt: r?.xp_last_at ?? 0, lastKey: r?.xp_last_key ?? null };
}
/** shown level, or undefined when hidden / never earned */
export function shownLevel(row: { xp?: number | null; xp_hidden?: number | null } | undefined): number | undefined {
  if (!row || row.xp_hidden || !row.xp) return undefined;
  return levelFor(row.xp);
}
/**
 * Award XP if the anti-spam rules allow it. Returns the new total and whether the level went up, or null when nothing was awarded.
 * cooldownMs already includes the room's slow mode.
 */
export function tryAwardXp(userId: number, amount: number, key: string, cooldownMs: number, at = now()): { xp: number; level: number; leveledUp: boolean; reason?: undefined } | { reason: string } {
  return tx(() => {
    const cur = xpOf(userId);
    if (cur.lastKey && cur.lastKey === key) return { reason: 'duplicate' };
    if (at - cur.lastAt < cooldownMs) return { reason: 'cooldown' };
    const room = Math.max(0, XP_DAILY_CAP - cur.today);
    const add = Math.min(amount, room);
    if (add <= 0) return { reason: 'daily cap' };
    const xp = cur.xp + add;
    q('UPDATE users SET xp = ?, xp_day = ?, xp_today = ?, xp_last_at = ?, xp_last_key = ? WHERE id = ?').run(xp, cur.day, cur.today + add, at, key, userId);
    return { xp, level: levelFor(xp), leveledUp: levelFor(xp) > levelFor(cur.xp) };
  });
}
export function setXpHidden(userId: number, hidden: boolean) { q('UPDATE users SET xp_hidden = ? WHERE id = ?').run(hidden ? 1 : 0, userId); }
export const hashKey = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
