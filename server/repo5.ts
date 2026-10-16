/** Batch A data access: read markers, mentions inbox, persistent whispers. */
import { q, tx } from './db';

const now = () => Date.now();

// ---------------- read markers (migration 39) ----------------
export function readTs(userId: number, roomId: string): number | null {
  const r = q('SELECT read_ts FROM room_reads WHERE user_id = ? AND room_id = ?').get(userId, roomId) as { read_ts: number } | undefined;
  return r ? r.read_ts : null;
}
/** Move the marker forward only (never back). */
export function markRead(userId: number, roomId: string, ts = now()) {
  q(`INSERT INTO room_reads (user_id, room_id, read_ts) VALUES (?,?,?)
    ON CONFLICT(user_id, room_id) DO UPDATE SET read_ts = MAX(read_ts, excluded.read_ts)`).run(userId, roomId, ts);
}
export function readRows(userId: number): { room_id: string; read_ts: number }[] {
  return q('SELECT room_id, read_ts FROM room_reads WHERE user_id = ?').all(userId) as { room_id: string; read_ts: number }[];
}
export function forgetRoomReads(roomId: string) {
  q('DELETE FROM room_reads WHERE room_id = ?').run(roomId);
}

// ---------------- mentions inbox ----------------
export type MentionKind = 'mention' | 'reply';
export interface MentionRow { id: number; message_id: string; room_id: string; kind: string; from_nick: string; ts: number; read_at: number | null; text: string | null; deleted: number | null }
export const MENTION_KEEP = 200;
export function addMention(userId: number, messageId: string, roomId: string, kind: MentionKind, fromNick: string, ts: number): boolean {
  const r = q('INSERT OR IGNORE INTO mention_inbox (user_id, message_id, room_id, kind, from_nick, ts) VALUES (?,?,?,?,?,?)')
    .run(userId, messageId, roomId, kind, fromNick, ts);
  if (r.changes) {
    // keep the newest MENTION_KEEP per account
    q(`DELETE FROM mention_inbox WHERE user_id = ? AND id NOT IN (SELECT id FROM mention_inbox WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT ${MENTION_KEEP})`).run(userId, userId);
  }
  return r.changes > 0;
}
export function listMentions(userId: number, limit = 100): MentionRow[] {
  return q(`SELECT i.id, i.message_id, i.room_id, i.kind, i.from_nick, i.ts, i.read_at, m.text, m.deleted
    FROM mention_inbox i LEFT JOIN messages m ON m.id = i.message_id
    WHERE i.user_id = ? ORDER BY i.ts DESC, i.id DESC LIMIT ?`).all(userId, limit) as unknown as MentionRow[];
}
export function unreadMentionCount(userId: number): number {
  return (q(`SELECT COUNT(*) AS n FROM mention_inbox i LEFT JOIN messages m ON m.id = i.message_id
    WHERE i.user_id = ? AND i.read_at IS NULL AND m.id IS NOT NULL AND m.deleted = 0`).get(userId) as { n: number }).n;
}
export function setMentionRead(userId: number, ids: number[] | 'all', read: boolean) {
  const at = read ? now() : null;
  if (ids === 'all') { q('UPDATE mention_inbox SET read_at = ? WHERE user_id = ?').run(at, userId); return; }
  tx(() => { for (const id of ids.slice(0, 200)) q('UPDATE mention_inbox SET read_at = ? WHERE user_id = ? AND id = ?').run(at, userId, id); });
}
/** Opening a room reads its mentions up to `ts`. */
export function readMentionsInRoom(userId: number, roomId: string, ts = now()) {
  q('UPDATE mention_inbox SET read_at = ? WHERE user_id = ? AND room_id = ? AND read_at IS NULL AND ts <= ?').run(now(), userId, roomId, ts);
}
export function forgetRoomMentions(roomId: string) {
  q('DELETE FROM mention_inbox WHERE room_id = ?').run(roomId);
}

// ---------------- persistent whispers ----------------
/** Whisper lines are kept 30 days, then pruned. Only member accounts can ever read them back. */
export const WHISPER_KEEP_MS = 30 * 24 * 3600_000;
export interface WhisperRow { id: string; whisper_id: string; room_id: string; ts: number; from_user_id: number | null; from_nick: string; text: string }
export function saveWhisper(m: WhisperRow, memberIds: number[]) {
  if (!memberIds.length) return;
  tx(() => {
    q('INSERT OR IGNORE INTO whisper_messages (id, whisper_id, room_id, ts, from_user_id, from_nick, text) VALUES (?,?,?,?,?,?,?)')
      .run(m.id, m.whisper_id, m.room_id, m.ts, m.from_user_id, m.from_nick, m.text);
    for (const uid of new Set(memberIds)) q('INSERT OR IGNORE INTO whisper_members (message_id, user_id) VALUES (?,?)').run(m.id, uid);
  });
}
/** Whisper lines this account was part of in a room, newest first. Filtering by text happens in the caller. */
export function whispersFor(userId: number, roomId: string, after: number | null, before: number | null, limit = 2000): WhisperRow[] {
  return q(`SELECT w.id, w.whisper_id, w.room_id, w.ts, w.from_user_id, w.from_nick, w.text FROM whisper_messages w
    JOIN whisper_members x ON x.message_id = w.id AND x.user_id = ?
    WHERE w.room_id = ? AND w.ts > ? AND w.ts < ? ORDER BY w.ts DESC LIMIT ?`)
    .all(userId, roomId, Math.max(after ?? 0, now() - WHISPER_KEEP_MS), before ?? 1e15, limit) as unknown as WhisperRow[];
}
export function pruneWhispers(keepMs = WHISPER_KEEP_MS): number {
  const cut = now() - keepMs;
  return tx(() => {
    q('DELETE FROM whisper_members WHERE message_id IN (SELECT id FROM whisper_messages WHERE ts < ?)').run(cut);
    return Number(q('DELETE FROM whisper_messages WHERE ts < ?').run(cut).changes);
  });
}
/** Account deletion: drop their membership; lines nobody can read any more go too. */
export function forgetWhisperUser(userId: number) {
  tx(() => {
    q('DELETE FROM whisper_members WHERE user_id = ?').run(userId);
    q('DELETE FROM whisper_messages WHERE id NOT IN (SELECT message_id FROM whisper_members)').run();
  });
}
export function forgetMentionUser(userId: number) {
  q('DELETE FROM mention_inbox WHERE user_id = ?').run(userId);
  q('DELETE FROM room_reads WHERE user_id = ?').run(userId);
}
