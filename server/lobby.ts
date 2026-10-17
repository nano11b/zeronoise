/**
 * Smarter lobby storage: the server copy of each account's block list, the "show my room to friends"
 * flag (users.show_room), and recently visited rooms (pruned to LOBBY.recentKept per account).
 */
import { q, tx } from './db';
import { LOBBY } from '../shared/lobby';

const now = () => Date.now();

// ---------------- presence privacy ----------------
export function showRoom(userId: number): boolean {
  const r = q('SELECT show_room FROM users WHERE id = ?').get(userId) as { show_room: number | null } | undefined;
  return r ? r.show_room !== 0 : false;
}
export function setShowRoom(userId: number, on: boolean) {
  q('UPDATE users SET show_room = ? WHERE id = ?').run(on ? 1 : 0, userId);
}

// ---------------- block list (server copy of the client's list) ----------------
export function blockedIds(userId: number): number[] {
  return (q('SELECT blocked_id FROM user_blocks WHERE user_id = ?').all(userId) as { blocked_id: number }[]).map((r) => r.blocked_id);
}
export function blockedUsernames(userId: number): string[] {
  return (q('SELECT u.username FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY b.created_at')
    .all(userId) as { username: string }[]).map((r) => r.username);
}
/** Replace the list. Returns the account ids now blocked. */
export function setBlocks(userId: number, ids: number[]): number[] {
  const want = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0 && id !== userId))].slice(0, LOBBY.blocksMax);
  return tx(() => {
    q('DELETE FROM user_blocks WHERE user_id = ?').run(userId);
    for (const id of want) q('INSERT OR IGNORE INTO user_blocks (user_id, blocked_id, created_at) VALUES (?,?,?)').run(userId, id, now());
    return want;
  });
}
/** Either side blocked the other. */
/** batch W10: add one block (server side), keeping the rest of the list. */
export function addBlock(userId: number, blockedId: number) {
  q('INSERT OR IGNORE INTO user_blocks (user_id, blocked_id, created_at) VALUES (?,?,?)').run(userId, blockedId, now());
}
export function blockedEitherWay(a: number, b: number): boolean {
  return !!q('SELECT 1 FROM user_blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?) LIMIT 1').get(a, b, b, a);
}

// ---------------- recently visited rooms ----------------
export function touchRecent(userId: number, roomId: string, at = now()) {
  tx(() => {
    q('INSERT INTO recent_rooms (user_id, room_id, visited_at) VALUES (?,?,?) ON CONFLICT(user_id, room_id) DO UPDATE SET visited_at = excluded.visited_at')
      .run(userId, roomId, at);
    q(`DELETE FROM recent_rooms WHERE user_id = ? AND room_id NOT IN (
         SELECT room_id FROM recent_rooms WHERE user_id = ? ORDER BY visited_at DESC LIMIT ${LOBBY.recentKept})`).run(userId, userId);
  });
}
export function recentRows(userId: number): { room_id: string; visited_at: number }[] {
  return q(`SELECT room_id, visited_at FROM recent_rooms WHERE user_id = ? ORDER BY visited_at DESC LIMIT ${LOBBY.recentKept}`)
    .all(userId) as { room_id: string; visited_at: number }[];
}
export function removeRecent(userId: number, roomId: string): boolean {
  return q('DELETE FROM recent_rooms WHERE user_id = ? AND room_id = ?').run(userId, roomId).changes > 0;
}
export function forgetRoom(roomId: string) {
  q('DELETE FROM recent_rooms WHERE room_id = ?').run(roomId);
}
export function recentCount(userId: number): number {
  return (q('SELECT COUNT(*) AS n FROM recent_rooms WHERE user_id = ?').get(userId) as { n: number }).n;
}

/** Messages from others since `since` (capped at 99) and how many @mention `username`. */
export function unreadSince(roomId: string, since: number, userId: number, username: string): { unread: number; mentions: number } {
  const unread = (q(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE room_id = ? AND ts > ? AND deleted = 0 AND (user_id IS NULL OR user_id <> ?) LIMIT 99)`)
    .get(roomId, since, userId) as { n: number }).n;
  if (!unread) return { unread: 0, mentions: 0 };
  const cands = q(`SELECT text FROM messages WHERE room_id = ? AND ts > ? AND deleted = 0 AND burn_ttl IS NULL AND (user_id IS NULL OR user_id <> ?) AND text LIKE ? LIMIT 200`)
    .all(roomId, since, userId, `%@${username}%`) as { text: string }[];
  const re = new RegExp(`(^|[^\\w])@${username.replace(/[^\w]/g, '')}(?![\\w])`, 'i');
  return { unread, mentions: cands.filter((c) => re.test(c.text)).length };
}
