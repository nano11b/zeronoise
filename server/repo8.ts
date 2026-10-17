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

// ---------------- ban appeals (migration 42) ----------------
export interface AppealRow {
  id: number; ban_id: number; user_id: number | null; username: string | null; ip: string; device_id: string | null; text: string;
  created_at: number; status: 'open' | 'approved' | 'denied'; decided_by: string | null; decided_at: number | null; decision_note: string | null;
}
export function appealForBan(banId: number): AppealRow | undefined {
  return q('SELECT * FROM ban_appeals WHERE ban_id = ?').get(banId) as AppealRow | undefined;
}
export function appealById(id: number): AppealRow | undefined {
  return q('SELECT * FROM ban_appeals WHERE id = ?').get(id) as AppealRow | undefined;
}
/** one appeal per ban: returns null when this ban already has one */
export function insertAppeal(a: { banId: number; userId: number | null; username: string | null; ip: string; deviceId: string | null; text: string }): AppealRow | null {
  const r = q(`INSERT INTO ban_appeals (ban_id, user_id, username, ip, device_id, text, created_at, status) VALUES (?,?,?,?,?,?,?, 'open')
    ON CONFLICT(ban_id) DO NOTHING RETURNING id`).get(a.banId, a.userId, a.username, a.ip, a.deviceId, a.text, now()) as { id: number } | undefined;
  return r ? appealById(r.id)! : null;
}
export function decideAppeal(id: number, status: 'approved' | 'denied', by: string, note: string | null): boolean {
  return Number(q(`UPDATE ban_appeals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'open'`).run(status, by, now(), note, id).changes) > 0;
}
export function listAppeals(status: 'open' | 'approved' | 'denied' | 'all' = 'open', limit = 200): (AppealRow & { reason: string | null; expires_at: number | null; ban_kind: string | null })[] {
  return q(`SELECT a.*, b.reason, b.expires_at, b.kind AS ban_kind FROM ban_appeals a LEFT JOIN bans b ON b.id = a.ban_id
    ${status === 'all' ? '' : 'WHERE a.status = ?'} ORDER BY a.created_at DESC LIMIT ?`).all(...(status === 'all' ? [limit] : [status, limit])) as never;
}

// ---------------- two-factor (migration 42) ----------------
export interface TotpRow { user_id: number; secret: string; enabled_at: number | null; last_step: number; created_at: number }
export const totpOf = (userId: number) => q('SELECT * FROM user_totp WHERE user_id = ?').get(userId) as TotpRow | undefined;
export const mfaEnabled = (userId: number) => !!totpOf(userId)?.enabled_at;
/** Start (or restart) enrolment with a fresh secret. Never touches an enabled one. */
export function startTotp(userId: number, secret: string): boolean {
  const cur = totpOf(userId);
  if (cur?.enabled_at) return false;
  q('INSERT INTO user_totp (user_id, secret, enabled_at, last_step, created_at) VALUES (?,?,NULL,0,?) ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, last_step = 0')
    .run(userId, secret, now());
  return true;
}
export function enableTotp(userId: number, step: number, codeHashes: string[]) {
  tx(() => {
    q('UPDATE user_totp SET enabled_at = ?, last_step = ? WHERE user_id = ?').run(now(), step, userId);
    q('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now(), userId);
    for (const h of codeHashes) q('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?,?)').run(userId, h);
  });
}
/** Replay guard: a step is good only once and only moving forward. */
export function useStep(userId: number, step: number): boolean {
  return Number(q('UPDATE user_totp SET last_step = ? WHERE user_id = ? AND last_step < ?').run(step, userId, step).changes) > 0;
}
export function useRecoveryCode(userId: number, hash: string): boolean {
  return Number(q('UPDATE user_recovery_codes SET used_at = ? WHERE id = (SELECT id FROM user_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL LIMIT 1)').run(now(), userId, hash).changes) > 0;
}
export const recoveryLeft = (userId: number) => (q('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }).n;
export function replaceRecoveryCodes(userId: number, hashes: string[]) {
  tx(() => {
    q('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now(), userId);
    for (const h of hashes) q('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?,?)').run(userId, h);
  });
}
/** Turn off (non-admins only; checked by the caller). Rows are kept as disabled, codes marked used: nothing deleted. */
export function disableTotp(userId: number) {
  tx(() => {
    q('UPDATE user_totp SET enabled_at = NULL WHERE user_id = ?').run(userId);
    q('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now(), userId);
  });
}

// ---------------- personal data export (batch D) ----------------
export const EXPORT_MAX_MESSAGES = 100_000;
const rows = (sql: string, ...a: (string | number | null)[]) => { try { return q(sql).all(...a) as Record<string, unknown>[]; } catch { return []; } };
const one = (sql: string, ...a: (string | number | null)[]) => { try { return (q(sql).get(...a) as Record<string, unknown> | undefined) ?? null; } catch { return null; } };
/** Everything we keep about one account that is theirs to take. Secrets (password hash, 2FA secret, recovery codes, push keys, IPs) are left out. */
export function exportData(userId: number) {
  const u = one('SELECT * FROM users WHERE id = ?', userId);
  if (!u) return null;
  const links = (() => { try { return JSON.parse(String(u.profile_links ?? '[]')); } catch { return []; } })();
  const profile = {
    username: u.username, role: u.role, createdAt: u.created_at, lastLoginAt: u.last_login_at,
    email: u.email ?? null, emailVerifiedAt: u.email_verified_at ?? null,
    signIn: { password: !!u.password_hash, google: !!u.google_sub, discord: !!u.discord_id, tiktok: !!u.tiktok_open_id, twoFactor: !!one('SELECT 1 AS x FROM user_totp WHERE user_id = ? AND enabled_at IS NOT NULL', userId) },
    chatColor: u.chat_color ?? null, chatEffect: u.chat_effect ?? null, hasAvatar: !!u.has_avatar, bio: u.bio ?? null,
    bannerId: u.banner_id ?? null, links, nowPlaying: u.now_playing ?? null, shownBadges: u.shown_badges ?? null,
    xp: u.xp ?? 0, level: levelFor(Number(u.xp ?? 0)),
    badges: rows('SELECT badge, earned_at AS earnedAt FROM user_badges WHERE user_id = ? ORDER BY earned_at', userId),
    stats: rows('SELECT stat, value FROM user_stats WHERE user_id = ?', userId),
    friends: rows(`SELECT CASE WHEN f.user_id = ? THEN p.username ELSE o.username END AS username, f.status, f.created_at AS since
      FROM friendships f JOIN users p ON p.id = f.peer_id JOIN users o ON o.id = f.user_id WHERE f.user_id = ? OR f.peer_id = ?`, userId, userId, userId),
  };
  const settings = {
    showRoom: u.show_room ?? null, videoQuality: u.video_quality ?? null, uiTheme: u.ui_theme ?? null, linkPreviews: u.link_previews ?? null, levelHidden: !!u.xp_hidden,
    roomNotifications: rows('SELECT room_id AS roomId, level, updated_at AS updatedAt FROM room_notify WHERE user_id = ?', userId),
    quietHours: one('SELECT start_min AS startMin, end_min AS endMin, tz FROM push_quiet WHERE user_id = ?', userId),
    blocked: rows('SELECT u.username, b.created_at AS since FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?', userId),
    bookmarks: rows('SELECT message_id AS messageId, room_id AS roomId, created_at AS createdAt FROM message_bookmarks WHERE user_id = ?', userId),
    eventRsvps: rows('SELECT event_id AS eventId, status, updated_at AS updatedAt FROM event_rsvps WHERE user_id = ?', userId),
  };
  // burn-after-reading lines are meant to vanish, so they are not exported
  const messages = rows(`SELECT m.id, m.room_id AS roomId, r.name AS roomName, m.ts, m.nick, m.text, m.parent_id AS parentId, m.edited_at AS editedAt,
      CASE WHEN m.voice_id IS NOT NULL THEN 1 ELSE 0 END AS voiceNote
    FROM messages m LEFT JOIN rooms r ON r.id = m.room_id WHERE m.user_id = ? AND m.deleted = 0 AND m.burn_ttl IS NULL ORDER BY m.ts LIMIT ?`, userId, EXPORT_MAX_MESSAGES);
  const whispers = rows(`SELECT w.id, w.room_id AS roomId, r.name AS roomName, w.ts, w.from_nick AS fromNick, CASE WHEN w.from_user_id = ? THEN 1 ELSE 0 END AS sentByYou, w.text
    FROM whisper_messages w JOIN whisper_members wm ON wm.message_id = w.id AND wm.user_id = ? LEFT JOIN rooms r ON r.id = w.room_id ORDER BY w.ts LIMIT ?`, userId, userId, EXPORT_MAX_MESSAGES);
  return { profile, settings, messages, whispers, truncated: messages.length >= EXPORT_MAX_MESSAGES || whispers.length >= EXPORT_MAX_MESSAGES };
}
