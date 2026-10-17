/** Batch C data access: profiles 2.0 (banner, links, now playing, mutuals), room discovery. */
import { q } from './db';
import type { ProfileLink } from '../shared/profile2';
import { NOW_PLAYING_TTL_MS } from '../shared/profile2';

const now = () => Date.now();

// ---------------- profiles 2.0 (migration 41) ----------------
export interface Profile2 { bannerId: string | null; links: ProfileLink[]; nowPlaying: string | null; nowPlayingAt: number | null }
export function profile2Of(userId: number): Profile2 {
  const r = q('SELECT banner_id, profile_links, now_playing, now_playing_at FROM users WHERE id = ?').get(userId) as
    { banner_id: string | null; profile_links: string | null; now_playing: string | null; now_playing_at: number | null } | undefined;
  let links: ProfileLink[] = [];
  try { const j = JSON.parse(r?.profile_links ?? '[]'); if (Array.isArray(j)) links = j.filter((x) => x && typeof x.url === 'string' && typeof x.label === 'string'); } catch { /* bad row */ }
  const fresh = !!r?.now_playing && !!r.now_playing_at && now() - r.now_playing_at < NOW_PLAYING_TTL_MS;
  return { bannerId: r?.banner_id ?? null, links, nowPlaying: fresh ? r!.now_playing : null, nowPlayingAt: fresh ? r!.now_playing_at : null };
}
export function setBanner(userId: number, id: string | null) { q('UPDATE users SET banner_id = ? WHERE id = ?').run(id, userId); }
export function setProfileLinks(userId: number, links: ProfileLink[]) { q('UPDATE users SET profile_links = ? WHERE id = ?').run(links.length ? JSON.stringify(links) : null, userId); }
export function setNowPlaying(userId: number, text: string | null) { q('UPDATE users SET now_playing = ?, now_playing_at = ? WHERE id = ?').run(text, text ? now() : null, userId); }
export function bannerOwner(id: string): number | null {
  return ((q('SELECT id FROM users WHERE banner_id = ?').get(id) as { id: number } | undefined)?.id) ?? null;
}

/** accepted friends of both a and b (never includes a or b) */
export function mutualFriends(a: number, b: number, limit = 12): { id: number; username: string; hasAvatar: boolean }[] {
  const sql = `
    WITH fa AS (SELECT CASE WHEN user_id = ? THEN peer_id ELSE user_id END AS id FROM friendships WHERE status = 'accepted' AND (user_id = ? OR peer_id = ?)),
         fb AS (SELECT CASE WHEN user_id = ? THEN peer_id ELSE user_id END AS id FROM friendships WHERE status = 'accepted' AND (user_id = ? OR peer_id = ?))
    SELECT u.id, u.username, u.has_avatar FROM users u WHERE u.id IN (SELECT id FROM fa INTERSECT SELECT id FROM fb) AND u.id NOT IN (?, ?)
    ORDER BY u.username_lower LIMIT ?`;
  return (q(sql).all(a, a, a, b, b, b, a, b, limit) as { id: number; username: string; has_avatar: number }[]).map((r) => ({ id: r.id, username: r.username, hasAvatar: !!r.has_avatar }));
}
/** public, open rooms both people visited (recent rooms list) - never private calls or password rooms */
export function mutualRooms(a: number, b: number, limit = 8): { id: string; name: string }[] {
  return q(`SELECT r.id, r.name FROM recent_rooms x JOIN recent_rooms y ON y.room_id = x.room_id AND y.user_id = ?
    JOIN rooms r ON r.id = x.room_id WHERE x.user_id = ? AND r.is_private = 0 AND (r.password_hash IS NULL OR r.password_hash = '')
    ORDER BY MAX(x.visited_at, y.visited_at) DESC LIMIT ?`).all(b, a, limit) as { id: string; name: string }[];
}

// ---------------- room discovery ----------------
const HOUR = 3_600_000;
/** accounts that visited each room in the last 30 days (the "members" count on the browse page) */
export function roomMemberCounts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of q('SELECT room_id, COUNT(*) AS n FROM recent_rooms WHERE visited_at >= ? GROUP BY room_id').all(now() - 30 * 24 * HOUR) as { room_id: string; n: number }[]) out.set(r.room_id, r.n);
  return out;
}
/** messages per room in the last 24 h and the 24 h before that (trend) */
export function roomMessageTrend(): Map<string, { day: number; prev: number }> {
  const h = Math.floor(now() / HOUR);
  const out = new Map<string, { day: number; prev: number }>();
  for (const r of q('SELECT room_id, SUM(CASE WHEN hour > ? THEN messages ELSE 0 END) AS d, SUM(CASE WHEN hour <= ? THEN messages ELSE 0 END) AS p FROM room_stats_hourly WHERE hour > ? GROUP BY room_id')
    .all(h - 24, h - 24, h - 48) as { room_id: string; d: number; p: number }[]) out.set(r.room_id, { day: r.d, prev: r.p });
  return out;
}
