/** Batch 3 data access: room meta, announcements, schedules, stats, emotes. */
import { q, tx } from './db';
import { DAY_MS, HOUR_MS, STATS_KEEP_DAYS } from '../shared/batch3';

const now = () => Date.now();

// ---------------- 1. category + tags ----------------
export function setRoomMeta(roomId: string, category: string | null, tags: string[]) {
  q('UPDATE rooms SET category = ?, tags = ? WHERE id = ?').run(category, tags.length ? JSON.stringify(tags) : null, roomId);
}
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 5) : []; } catch { return []; }
}

// ---------------- 3. announcement ----------------
export function setAnnouncement(roomId: string, text: string | null, by: string | null) {
  q('UPDATE rooms SET announcement = ?, announcement_at = ?, announcement_by = ? WHERE id = ?').run(text, text ? now() : null, text ? by : null, roomId);
}

// ---------------- 3. scheduled messages ----------------
export interface ScheduleRow {
  id: string; room_id: string; text: string; repeat: 'once' | 'daily' | 'weekly'; next_at: number; tz: string | null;
  created_by_user: number | null; created_by_nick: string; created_at: number; last_posted_at: number | null;
}
export function schedulesForRoom(roomId: string): ScheduleRow[] {
  return q('SELECT * FROM room_schedules WHERE room_id = ? ORDER BY next_at').all(roomId) as unknown as ScheduleRow[];
}
export function scheduleCount(roomId: string): number {
  return Number((q('SELECT COUNT(*) AS n FROM room_schedules WHERE room_id = ?').get(roomId) as { n: number }).n);
}
export function scheduleById(id: string): ScheduleRow | undefined {
  return q('SELECT * FROM room_schedules WHERE id = ?').get(id) as unknown as ScheduleRow | undefined;
}
export function insertSchedule(r: Omit<ScheduleRow, 'last_posted_at'>) {
  q('INSERT INTO room_schedules (id, room_id, text, repeat, next_at, tz, created_by_user, created_by_nick, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.room_id, r.text, r.repeat, r.next_at, r.tz, r.created_by_user, r.created_by_nick, r.created_at);
}
export function deleteSchedule(id: string): boolean {
  return Number(q('DELETE FROM room_schedules WHERE id = ?').run(id).changes) > 0;
}
export function dueSchedules(at: number): ScheduleRow[] {
  return q('SELECT * FROM room_schedules WHERE next_at <= ? ORDER BY next_at LIMIT 200').all(at) as unknown as ScheduleRow[];
}
export function advanceSchedule(id: string, nextAt: number, postedAt: number | null) {
  if (postedAt != null) q('UPDATE room_schedules SET next_at = ?, last_posted_at = ? WHERE id = ?').run(nextAt, postedAt, id);
  else q('UPDATE room_schedules SET next_at = ? WHERE id = ?').run(nextAt, id);
}
export function markAnnounce(messageId: string, roomId: string, scheduleId: string | null, by: string) {
  q('INSERT OR IGNORE INTO announce_messages (message_id, room_id, schedule_id, by_nick) VALUES (?,?,?,?)').run(messageId, roomId, scheduleId, by);
}
export function announceFor(messageId: string): string | null {
  const r = q('SELECT by_nick FROM announce_messages WHERE message_id = ?').get(messageId) as { by_nick: string } | undefined;
  return r?.by_nick ?? null;
}

// ---------------- 5. stats ----------------
export const hourOf = (ms: number) => Math.floor(ms / HOUR_MS);
export const dayOf = (ms: number) => Math.floor(ms / DAY_MS);
export function statMessage(roomId: string, userId: number | null, at = now()) {
  q('INSERT INTO room_stats_hourly (room_id, hour, messages, peak) VALUES (?,?,1,0) ON CONFLICT(room_id, hour) DO UPDATE SET messages = messages + 1').run(roomId, hourOf(at));
  if (userId != null) {
    q('INSERT INTO room_visitors (room_id, day, user_id, messages) VALUES (?,?,?,1) ON CONFLICT(room_id, day, user_id) DO UPDATE SET messages = messages + 1').run(roomId, dayOf(at), userId);
  }
}
export function statPeak(roomId: string, n: number, at = now()) {
  if (n <= 0) return;
  q('INSERT INTO room_stats_hourly (room_id, hour, messages, peak) VALUES (?,?,0,?) ON CONFLICT(room_id, hour) DO UPDATE SET peak = MAX(peak, excluded.peak)').run(roomId, hourOf(at), n);
}
export function statVisitor(roomId: string, userId: number, at = now()) {
  q('INSERT OR IGNORE INTO room_visitors (room_id, day, user_id, messages) VALUES (?,?,?,0)').run(roomId, dayOf(at), userId);
}
/** guests are only ever a per-day count (uniqueness is checked in memory, nothing about them is stored) */
export function statGuest(roomId: string, at = now()) {
  q('INSERT INTO room_stats_daily (room_id, day, guests) VALUES (?,?,1) ON CONFLICT(room_id, day) DO UPDATE SET guests = guests + 1').run(roomId, dayOf(at));
}
export function statsHours(roomId: string, fromHour: number): [number, number, number][] {
  return (q('SELECT hour, messages, peak FROM room_stats_hourly WHERE room_id = ? AND hour >= ? ORDER BY hour').all(roomId, fromHour) as { hour: number; messages: number; peak: number }[])
    .map((r) => [Number(r.hour), Number(r.messages), Number(r.peak)]);
}
export function statsWindow(roomId: string, days: number, at = now()) {
  const fromDay = dayOf(at) - (days - 1);
  const fromHour = fromDay * 24;
  const h = q('SELECT COALESCE(SUM(messages), 0) AS m, COALESCE(MAX(peak), 0) AS p FROM room_stats_hourly WHERE room_id = ? AND hour >= ?').get(roomId, fromHour) as { m: number; p: number };
  const reg = q('SELECT COUNT(DISTINCT user_id) AS n FROM room_visitors WHERE room_id = ? AND day >= ?').get(roomId, fromDay) as { n: number };
  const g = q('SELECT COALESCE(SUM(guests), 0) AS n FROM room_stats_daily WHERE room_id = ? AND day >= ?').get(roomId, fromDay) as { n: number };
  const top = q(`SELECT u.username AS username, SUM(v.messages) AS messages FROM room_visitors v JOIN users u ON u.id = v.user_id
    WHERE v.room_id = ? AND v.day >= ? GROUP BY v.user_id HAVING SUM(v.messages) > 0 ORDER BY messages DESC, u.username LIMIT 10`).all(roomId, fromDay) as { username: string; messages: number }[];
  const registered = Number(reg.n), guests = Number(g.n);
  return {
    days, peak: Number(h.p), messages: Number(h.m), registered, guests, visitors: registered + guests,
    top: top.map((t) => ({ username: t.username, messages: Number(t.messages) })),
  };
}
export function pruneStats(at = now()): number {
  const cutDay = dayOf(at) - STATS_KEEP_DAYS;
  return tx(() => {
    let n = 0;
    n += Number(q('DELETE FROM room_stats_hourly WHERE hour < ?').run(cutDay * 24).changes);
    n += Number(q('DELETE FROM room_stats_daily WHERE day < ?').run(cutDay).changes);
    n += Number(q('DELETE FROM room_visitors WHERE day < ?').run(cutDay).changes);
    n += Number(q('DELETE FROM announce_messages WHERE message_id NOT IN (SELECT id FROM messages)').run().changes);
    return n;
  });
}

// ---------------- 6. emotes ----------------
export interface EmoteRow { id: string; room_id: string; name: string; animated: number; created_by: number | null; created_at: number }
export function emotesForRoom(roomId: string): EmoteRow[] {
  return q('SELECT * FROM room_emotes WHERE room_id = ? ORDER BY name').all(roomId) as unknown as EmoteRow[];
}
export function emoteById(id: string): EmoteRow | undefined {
  return q('SELECT * FROM room_emotes WHERE id = ?').get(id) as unknown as EmoteRow | undefined;
}
export function emoteCount(roomId: string): number {
  return Number((q('SELECT COUNT(*) AS n FROM room_emotes WHERE room_id = ?').get(roomId) as { n: number }).n);
}
export function emoteNameTaken(roomId: string, name: string, exceptId?: string): boolean {
  return !!q('SELECT 1 FROM room_emotes WHERE room_id = ? AND name = ? AND id != ?').get(roomId, name, exceptId ?? '');
}
export function insertEmote(r: EmoteRow) {
  q('INSERT INTO room_emotes (id, room_id, name, animated, created_by, created_at) VALUES (?,?,?,?,?,?)').run(r.id, r.room_id, r.name, r.animated, r.created_by, r.created_at);
}
export function renameEmote(id: string, name: string) { q('UPDATE room_emotes SET name = ? WHERE id = ?').run(name, id); }
export function deleteEmote(id: string) { q('DELETE FROM room_emotes WHERE id = ?').run(id); }
export function allEmoteIds(): Set<string> {
  return new Set((q('SELECT id FROM room_emotes').all() as { id: string }[]).map((r) => r.id));
}

/** room removed: rows without a cascading FK */
export function deleteRoomData3(roomId: string) {
  q('DELETE FROM room_schedules WHERE room_id = ?').run(roomId);
  q('DELETE FROM room_emotes WHERE room_id = ?').run(roomId);
  q('DELETE FROM room_stats_hourly WHERE room_id = ?').run(roomId);
  q('DELETE FROM room_stats_daily WHERE room_id = ?').run(roomId);
  q('DELETE FROM room_visitors WHERE room_id = ?').run(roomId);
  q('DELETE FROM announce_messages WHERE room_id = ?').run(roomId);
}
