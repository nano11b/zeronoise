/** Batch B data access: room filters, link-preview preference, admin stats. */
import { q } from './db';
import type { LinkMode, RoomFilters } from '../shared/filters';
import { isLinkMode } from '../shared/filters';

const now = () => Date.now();

// ---------------- room filters (migration 40) ----------------
const cache = new Map<string, RoomFilters>();
export function filtersFor(roomId: string): RoomFilters {
  const hit = cache.get(roomId);
  if (hit) return hit;
  const r = q('SELECT words, links, allow_domains FROM room_filters WHERE room_id = ?').get(roomId) as { words: string; links: string; allow_domains: string } | undefined;
  const f: RoomFilters = r
    ? { words: r.words ? r.words.split('\n').filter(Boolean) : [], links: isLinkMode(r.links) ? r.links : 'off', allow: r.allow_domains ? r.allow_domains.split('\n').filter(Boolean) : [] }
    : { words: [], links: 'off', allow: [] };
  cache.set(roomId, f);
  return f;
}
export function setFilters(roomId: string, words: string[], links: LinkMode, allow: string[], by: string) {
  q(`INSERT INTO room_filters (room_id, words, links, allow_domains, updated_at, updated_by) VALUES (?,?,?,?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET words = excluded.words, links = excluded.links, allow_domains = excluded.allow_domains, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(roomId, words.join('\n'), links, allow.join('\n'), now(), by);
  cache.delete(roomId);
}
export function forgetRoomFilters(roomId: string) {
  q('DELETE FROM room_filters WHERE room_id = ?').run(roomId);
  cache.delete(roomId);
}

// ---------------- link preview preference ----------------
export function linkPreviewsOn(userId: number): boolean {
  const r = q('SELECT link_previews FROM users WHERE id = ?').get(userId) as { link_previews: number } | undefined;
  return r ? r.link_previews !== 0 : true;
}
export function setLinkPreviews(userId: number, on: boolean) {
  q('UPDATE users SET link_previews = ? WHERE id = ?').run(on ? 1 : 0, userId);
}

// ---------------- admin stats (from the per-room stats tables, migration 29) ----------------
const DAY = 86_400_000;
const HOUR = 3_600_000;
export interface AdminStats {
  days: { day: number; users: number; guests: number; messages: number }[];
  rooms: { roomId: string; name: string; messages: number; visitors: number; peak: number }[];
  hours: { hour: number; messages: number; peak: number }[];
  totals: { users: number; messages: number; activeToday: number };
}
/** Daily active accounts (distinct across rooms) and guests, busiest rooms, peak hours (UTC hour of day, or shifted by tzOffsetMin). */
export function adminStats(days = 14, tzOffsetMin = 0, at = now()): AdminStats {
  const today = Math.floor(at / DAY);
  const from = today - days + 1;
  const users = new Map<number, number>();
  for (const r of q('SELECT day, COUNT(DISTINCT user_id) AS n FROM room_visitors WHERE day >= ? GROUP BY day').all(from) as { day: number; n: number }[]) users.set(r.day, r.n);
  const guests = new Map<number, number>();
  for (const r of q('SELECT day, SUM(guests) AS n FROM room_stats_daily WHERE day >= ? GROUP BY day').all(from) as { day: number; n: number }[]) guests.set(r.day, r.n);
  const msgs = new Map<number, number>();
  for (const r of q('SELECT hour / 24 AS day, SUM(messages) AS n FROM room_stats_hourly WHERE hour >= ? GROUP BY hour / 24').all(from * 24) as { day: number; n: number }[]) msgs.set(r.day, r.n);
  const dayRows = [];
  for (let d = from; d <= today; d++) dayRows.push({ day: d * DAY, users: users.get(d) ?? 0, guests: guests.get(d) ?? 0, messages: msgs.get(d) ?? 0 });
  const rooms = (q(`SELECT h.room_id AS roomId, COALESCE(r.name, h.room_id) AS name, SUM(h.messages) AS messages, MAX(h.peak) AS peak,
      (SELECT COUNT(DISTINCT v.user_id) FROM room_visitors v WHERE v.room_id = h.room_id AND v.day >= ?) AS visitors
    FROM room_stats_hourly h LEFT JOIN rooms r ON r.id = h.room_id
    WHERE h.hour >= ? GROUP BY h.room_id ORDER BY messages DESC, peak DESC LIMIT 10`).all(from, from * 24) as AdminStats['rooms']);
  const hourAgg = new Array(24).fill(0).map((_, hour) => ({ hour, messages: 0, peak: 0 }));
  const shift = Math.round(tzOffsetMin / 60);
  for (const r of q('SELECT hour, SUM(messages) AS m, MAX(peak) AS p FROM room_stats_hourly WHERE hour >= ? GROUP BY hour').all(from * 24) as { hour: number; m: number; p: number }[]) {
    const h = (((r.hour + shift) % 24) + 24) % 24;
    hourAgg[h].messages += r.m;
    hourAgg[h].peak = Math.max(hourAgg[h].peak, r.p);
  }
  const totals = {
    users: (q('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n,
    messages: dayRows.reduce((s, d) => s + d.messages, 0),
    activeToday: users.get(today) ?? 0,
  };
  void HOUR;
  return { days: dayRows, rooms, hours: hourAgg, totals };
}
