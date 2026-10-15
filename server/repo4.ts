import { q } from './db';
import type { NotifyLevel, QuietHours } from '../shared/notify';
import { isNotifyLevel } from '../shared/notify';

const now = () => Date.now();

// ---------------- per-room notification level (migration 37) ----------------
export function notifyLevel(userId: number, roomId: string): NotifyLevel {
  const r = q('SELECT level FROM room_notify WHERE user_id = ? AND room_id = ?').get(userId, roomId) as { level: string } | undefined;
  return r && isNotifyLevel(r.level) ? r.level : 'mentions';
}
export function setNotifyLevel(userId: number, roomId: string, level: NotifyLevel) {
  if (level === 'mentions') q('DELETE FROM room_notify WHERE user_id = ? AND room_id = ?').run(userId, roomId);
  else q(`INSERT INTO room_notify (user_id, room_id, level, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id, room_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`).run(userId, roomId, level, now());
}
/** Accounts that want a push for every line in this room. */
export function notifyAllUsers(roomId: string): number[] {
  return (q("SELECT user_id FROM room_notify WHERE room_id = ? AND level = 'all'").all(roomId) as { user_id: number }[]).map((r) => r.user_id);
}
export function mutedRooms(userId: number): string[] {
  return (q("SELECT room_id FROM room_notify WHERE user_id = ? AND level = 'mute'").all(userId) as { room_id: string }[]).map((r) => r.room_id);
}
export function forgetRoomNotify(roomId: string) {
  q('DELETE FROM room_notify WHERE room_id = ?').run(roomId);
}

// ---------------- push quiet hours ----------------
export function quietHours(userId: number): QuietHours | null {
  const r = q('SELECT start_min, end_min, tz FROM push_quiet WHERE user_id = ?').get(userId) as { start_min: number; end_min: number; tz: string } | undefined;
  return r ? { start: r.start_min, end: r.end_min, tz: r.tz } : null;
}
export function setQuietHours(userId: number, qh: QuietHours | null) {
  if (!qh || qh.start === qh.end) { q('DELETE FROM push_quiet WHERE user_id = ?').run(userId); return; }
  q(`INSERT INTO push_quiet (user_id, start_min, end_min, tz, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET start_min = excluded.start_min, end_min = excluded.end_min, tz = excluded.tz, updated_at = excluded.updated_at`)
    .run(userId, qh.start, qh.end, qh.tz, now());
}

// ---------------- room theme (migration 37) ----------------
export interface RoomTheme { bannerId: string | null; accent: string | null; welcome: string | null }
export function roomTheme(roomId: string): RoomTheme {
  const r = q('SELECT theme_banner_id, theme_accent, welcome_text FROM rooms WHERE id = ?').get(roomId) as { theme_banner_id: string | null; theme_accent: string | null; welcome_text: string | null } | undefined;
  return { bannerId: r?.theme_banner_id ?? null, accent: r?.theme_accent ?? null, welcome: r?.welcome_text ?? null };
}
export function setRoomTheme(roomId: string, t: Partial<RoomTheme>) {
  const cur = roomTheme(roomId);
  const next = { ...cur, ...t };
  q('UPDATE rooms SET theme_banner_id = ?, theme_accent = ?, welcome_text = ? WHERE id = ?').run(next.bannerId, next.accent, next.welcome, roomId);
  return next;
}
export function roomByBannerId(id: string): { id: string; is_private: number } | undefined {
  return q('SELECT id, is_private FROM rooms WHERE theme_banner_id = ?').get(id) as { id: string; is_private: number } | undefined;
}
/** Banner files in use (they share the thumbnail folder, so the orphan sweep must keep them). */
export function allBannerIds(): string[] {
  return (q('SELECT theme_banner_id AS id FROM rooms WHERE theme_banner_id IS NOT NULL').all() as { id: string }[]).map((r) => r.id);
}

// ---------------- moderator-bot actions, shown in the mod queue next to user reports ----------------
export interface BotActionRow { id: number; ts: number; actor: string; action: string; target: string | null; roomId: string | null; details: string | null }
/** Moderation log lines written by a bot (actor is a bot name, no account). `roomId` limits to one room. */
export function botActions(roomId: string | null, limit = 50): BotActionRow[] {
  const sql = `SELECT id, ts, actor, action, target, room_id, details FROM mod_log
    WHERE actor_user_id IS NULL AND actor IN (SELECT name FROM bots) ${roomId ? 'AND room_id = ?' : ''}
    ORDER BY ts DESC, id DESC LIMIT ?`;
  const rows = (roomId ? q(sql).all(roomId, limit) : q(sql).all(limit)) as { id: number; ts: number; actor: string; action: string; target: string | null; room_id: string | null; details: string | null }[];
  return rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, target: r.target, roomId: r.room_id, details: r.details }));
}
