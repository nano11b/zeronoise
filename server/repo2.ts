/** Batch 2 data access: search, bookmarks, events, room roles, push, link previews, polls, profiles. */
import { db, ftsAvailable, q } from './db';
import type { Ident, MsgRow } from './repo';
import { userKey } from './repo';

const now = () => Date.now();
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

// ---------------- search ----------------
/** Up to 8 word tokens (letters, digits, underscore). */
export function searchTokens(raw: string): string[] {
  const text = String(raw ?? '').normalize('NFKC').slice(0, 200);
  return [...new Set((text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.slice(0, 40)))].slice(0, 8);
}
/**
 * Newest first. Burn messages, deleted rows and voice notes are never returned.
 * FTS5 when available (prefix match on every token), else LIKE on each token (the room_id index narrows the scan).
 */
export interface SearchFilter { from?: string | null; after?: number | null; before?: number | null }
/** Extra WHERE terms for a search filter (alias `m`). */
function filterSql(f: SearchFilter): { sql: string; args: (string | number)[] } {
  const parts: string[] = []; const args: (string | number)[] = [];
  if (f.from) { parts.push('lower(m.nick) = ?'); args.push(f.from.toLowerCase()); }
  if (f.after != null) { parts.push('m.ts >= ?'); args.push(f.after); }
  if (f.before != null) { parts.push('m.ts < ?'); args.push(f.before); }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
}
/** Room history search. Tokens may be empty when a filter is set (then newest lines matching the filter). */
export function searchRoomMessages(roomId: string, tokens: string[], offset: number, limit: number, filter: SearchFilter = {}): { rows: MsgRow[]; hasMore: boolean } {
  const f = filterSql(filter);
  if (!tokens.length && !f.sql) return { rows: [], hasMore: false };
  const base = 'm.room_id = ? AND m.deleted = 0 AND m.burn_ttl IS NULL AND m.voice_id IS NULL';
  let rows: MsgRow[];
  if (!tokens.length) {
    rows = q(`SELECT m.* FROM messages m WHERE ${base}${f.sql} ORDER BY m.ts DESC, m.rowid DESC LIMIT ? OFFSET ?`)
      .all(roomId, ...f.args, limit + 1, offset) as unknown as MsgRow[];
  } else if (ftsAvailable) {
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
    rows = q(`SELECT m.* FROM messages_fts f CROSS JOIN messages m ON m.rowid = f.rowid
      WHERE messages_fts MATCH ? AND f.room_id = ? AND ${base}${f.sql}
      ORDER BY m.ts DESC, m.rowid DESC LIMIT ? OFFSET ?`).all(match, roomId, roomId, ...f.args, limit + 1, offset) as unknown as MsgRow[];
  } else {
    const likes = tokens.map(() => "m.text LIKE ? ESCAPE '\\'").join(' AND ');
    const args = tokens.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    rows = q(`SELECT m.* FROM messages m WHERE ${base} AND ${likes}${f.sql}
      ORDER BY m.ts DESC, m.rowid DESC LIMIT ? OFFSET ?`).all(roomId, ...args, ...f.args, limit + 1, offset) as unknown as MsgRow[];
  }
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}
/** Top-level lines around a message, oldest first. */
export function messageContext(roomId: string, anchor: { ts: number; rowid: number }, before: number, after: number): MsgRow[] {
  const older = q(`SELECT * FROM messages WHERE room_id = ? AND deleted = 0 AND parent_id IS NULL AND (ts < ? OR (ts = ? AND rowid <= ?))
    ORDER BY ts DESC, rowid DESC LIMIT ?`).all(roomId, anchor.ts, anchor.ts, anchor.rowid, before + 1) as unknown as MsgRow[];
  const newer = q(`SELECT * FROM messages WHERE room_id = ? AND deleted = 0 AND parent_id IS NULL AND (ts > ? OR (ts = ? AND rowid > ?))
    ORDER BY ts ASC, rowid ASC LIMIT ?`).all(roomId, anchor.ts, anchor.ts, anchor.rowid, after) as unknown as MsgRow[];
  return [...older.reverse(), ...newer];
}

// ---------------- bookmarks ----------------
export function setBookmark(userId: number, messageId: string, roomId: string, on: boolean): boolean {
  if (on) q('INSERT OR IGNORE INTO message_bookmarks (user_id, message_id, room_id, created_at) VALUES (?,?,?,?)').run(userId, messageId, roomId, now());
  else q('DELETE FROM message_bookmarks WHERE user_id = ? AND message_id = ?').run(userId, messageId);
  return on;
}
export function isBookmarked(userId: number, messageId: string): boolean {
  return !!q('SELECT 1 FROM message_bookmarks WHERE user_id = ? AND message_id = ?').get(userId, messageId);
}
/** Live bookmarks only: deleted, burned and pruned messages drop out. Newest save first. */
export function listBookmarks(userId: number, limit = 200): (MsgRow & { saved_at: number; room_name: string })[] {
  return q(`SELECT m.*, b.created_at AS saved_at, r.name AS room_name FROM message_bookmarks b
    JOIN messages m ON m.id = b.message_id JOIN rooms r ON r.id = m.room_id
    WHERE b.user_id = ? AND m.deleted = 0 AND m.burn_ttl IS NULL ORDER BY b.created_at DESC LIMIT ?`).all(userId, limit) as unknown as (MsgRow & { saved_at: number; room_name: string })[];
}
export function bookmarkedIds(userId: number, messageIds: string[]): Set<string> {
  if (!messageIds.length) return new Set();
  const rows = q(`SELECT message_id FROM message_bookmarks WHERE user_id = ? AND message_id IN (${placeholders(messageIds.length)})`).all(userId, ...messageIds) as { message_id: string }[];
  return new Set(rows.map((r) => r.message_id));
}
export function bookmarkHolders(messageIds: string[]): { user_id: number; message_id: string }[] {
  if (!messageIds.length) return [];
  return q(`SELECT user_id, message_id FROM message_bookmarks WHERE message_id IN (${placeholders(messageIds.length)})`).all(...messageIds) as { user_id: number; message_id: string }[];
}

// ---------------- scheduled room events ----------------
/** batch MC2: recurrence fields (set after insert / update so the older column list stays untouched) */
export function setEventRecur(id: string, v: { recur: string | null; recur_until: number | null; recur_tz: string | null; series_id: string | null }) {
  q('UPDATE room_events SET recur = ?, recur_until = ?, recur_tz = ?, series_id = ? WHERE id = ?').run(v.recur, v.recur_until, v.recur_tz, v.series_id, id);
}
/** claim "next occurrence created" once; true only for the first caller */
export function claimSpawn(id: string): boolean {
  return Number(q('UPDATE room_events SET spawned_next = 1 WHERE id = ? AND spawned_next IS NULL').run(id).changes) === 1;
}
/** carry going / maybe answers over to the next occurrence, so reminders keep reaching them */
export function copyRsvps(fromId: string, toId: string, at = now()) {
  q(`INSERT OR IGNORE INTO event_rsvps (event_id, user_id, status, updated_at) SELECT ?, user_id, status, ? FROM event_rsvps WHERE event_id = ? AND status IN ('going','maybe')`).run(toId, at, fromId);
}
export interface EventRow { id: string; room_id: string; title: string; description: string; starts_at: number; duration_min: number | null; created_by_user: number | null; created_by_nick: string; created_at: number; updated_at: number; reminded_soon: number | null; reminded_start: number | null; recur?: string | null; recur_until?: number | null; recur_tz?: string | null; series_id?: string | null; spawned_next?: number | null }
export function insertEvent(e: Omit<EventRow, 'created_at' | 'updated_at' | 'reminded_soon' | 'reminded_start'>, at = now()) {
  q('INSERT INTO room_events (id, room_id, title, description, starts_at, duration_min, created_by_user, created_by_nick, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(e.id, e.room_id, e.title, e.description, e.starts_at, e.duration_min, e.created_by_user, e.created_by_nick, at, at);
}
/** Edit; a changed start re-arms reminders. */
export function updateEvent(id: string, v: { title: string; description: string; starts_at: number; duration_min: number | null }, at = now()) {
  q(`UPDATE room_events SET title = ?, description = ?, duration_min = ?, updated_at = ?,
       reminded_soon = CASE WHEN starts_at = ? THEN reminded_soon ELSE NULL END,
       reminded_start = CASE WHEN starts_at = ? THEN reminded_start ELSE NULL END,
       starts_at = ? WHERE id = ?`).run(v.title, v.description, v.duration_min, at, v.starts_at, v.starts_at, v.starts_at, id);
}
export function deleteEvent(id: string) { q('DELETE FROM room_events WHERE id = ?').run(id); }
export function deleteRoomEvents(roomId: string) { q('DELETE FROM room_events WHERE room_id = ?').run(roomId); }
/** A room was deleted: drop its events (+ RSVPs), moderators and room mutes. */
export function deleteRoomData(roomId: string) {
  q('DELETE FROM event_rsvps WHERE event_id IN (SELECT id FROM room_events WHERE room_id = ?)').run(roomId);
  deleteRoomEvents(roomId);
  q('DELETE FROM room_mods WHERE room_id = ?').run(roomId);
  q('DELETE FROM room_mutes WHERE room_id = ?').run(roomId);
}
export function eventById(id: string): EventRow | undefined { return q('SELECT * FROM room_events WHERE id = ?').get(id) as EventRow | undefined; }
/** Upcoming or still running (start + duration/1h > now), soonest first. */
export function roomEvents(roomId: string, at = now()): EventRow[] {
  return q('SELECT * FROM room_events WHERE room_id = ? AND starts_at + COALESCE(duration_min, 60) * 60000 > ? ORDER BY starts_at').all(roomId, at) as unknown as EventRow[];
}
export function upcomingEventCount(roomId: string, at = now()): number {
  return (q('SELECT COUNT(*) AS n FROM room_events WHERE room_id = ? AND starts_at > ?').get(roomId, at) as { n: number }).n;
}
/** Next event per room starting within the window (for the lobby tag). */
export function eventsSoon(at: number, windowMs: number): { room_id: string; title: string; starts_at: number }[] {
  return q(`SELECT e.room_id, e.title, e.starts_at FROM room_events e
    WHERE e.starts_at > ? AND e.starts_at <= ? AND e.starts_at = (SELECT MIN(starts_at) FROM room_events x WHERE x.room_id = e.room_id AND x.starts_at > ?)`)
    .all(at, at + windowMs, at) as { room_id: string; title: string; starts_at: number }[];
}
/** Events running now (one per room, the earliest start). */
export function eventsLive(at: number): { room_id: string; title: string; starts_at: number }[] {
  return q(`SELECT room_id, title, MIN(starts_at) AS starts_at FROM room_events
    WHERE starts_at <= ? AND starts_at + COALESCE(duration_min, 60) * 60000 > ? GROUP BY room_id`).all(at, at) as { room_id: string; title: string; starts_at: number }[];
}
/** Events that may have a reminder due (not yet fully reminded, starting before `until`). */
export function eventsPendingReminder(until: number): EventRow[] {
  return q('SELECT * FROM room_events WHERE reminded_start IS NULL AND starts_at <= ?').all(until) as unknown as EventRow[];
}
/** Atomically claim a reminder stage; true only for the first caller (survives restarts). */
export function claimReminder(id: string, stage: 'soon' | 'start', at = now()): boolean {
  const col = stage === 'soon' ? 'reminded_soon' : 'reminded_start';
  return Number(q(`UPDATE room_events SET ${col} = ? WHERE id = ? AND ${col} IS NULL`).run(at, id).changes) === 1;
}
export function pruneEvents(before: number): number {
  return Number(q('DELETE FROM room_events WHERE starts_at + COALESCE(duration_min, 60) * 60000 < ?').run(before).changes);
}
export function setRsvp(eventId: string, userId: number, status: 'going' | 'maybe' | 'no' | null, at = now()) {
  if (!status) { q('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?').run(eventId, userId); return; }
  q('INSERT INTO event_rsvps (event_id, user_id, status, updated_at) VALUES (?,?,?,?) ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at')
    .run(eventId, userId, status, at);
}
export function rsvpsFor(eventIds: string[]): { event_id: string; user_id: number; status: 'going' | 'maybe' | 'no'; username: string; has_avatar: number; chat_color: string | null }[] {
  if (!eventIds.length) return [];
  return q(`SELECT r.event_id, r.user_id, r.status, u.username, u.has_avatar, u.chat_color FROM event_rsvps r JOIN users u ON u.id = r.user_id
    WHERE r.event_id IN (${placeholders(eventIds.length)}) ORDER BY r.updated_at`).all(...eventIds) as any[];
}
export function reminderTargets(eventId: string): number[] {
  return (q("SELECT user_id FROM event_rsvps WHERE event_id = ? AND status IN ('going','maybe')").all(eventId) as { user_id: number }[]).map((r) => r.user_id);
}

// ---------------- room moderators + room mutes ----------------
export function allRoomMods(): { room_id: string; user_id: number }[] {
  return q('SELECT room_id, user_id FROM room_mods').all() as { room_id: string; user_id: number }[];
}
export function roomModList(roomId: string): { user_id: number; username: string }[] {
  return q('SELECT m.user_id, u.username FROM room_mods m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY u.username_lower').all(roomId) as { user_id: number; username: string }[];
}
export function setRoomMod(roomId: string, userId: number, on: boolean, by: string) {
  if (on) q('INSERT OR IGNORE INTO room_mods (room_id, user_id, added_by, created_at) VALUES (?,?,?,?)').run(roomId, userId, by, now());
  else q('DELETE FROM room_mods WHERE room_id = ? AND user_id = ?').run(roomId, userId);
}
export const ROOM_MODS_MAX = 20;
export function addRoomMute(roomId: string, i: Ident, by: string, minutes: number): number {
  const until = now() + minutes * 60_000;
  q('INSERT INTO room_mutes (room_id, user_key, ip, device_id, nick, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(roomId, userKey(i), i.ip, i.deviceIds[0] ?? null, i.nick, by, now(), until);
  return until;
}
/** Account (or guest name) and any of its devices. */
export function activeRoomMuteUntil(roomId: string, i: Ident): number | null {
  const devs = i.deviceIds.filter(Boolean);
  const devSql = devs.length ? ` OR device_id IN (${placeholders(devs.length)})` : '';
  const r = q(`SELECT MAX(expires_at) AS until FROM room_mutes WHERE room_id = ? AND expires_at > ? AND (user_key = ?${devSql})`)
    .get(roomId, now(), userKey(i), ...devs) as { until: number | null };
  return r.until ?? null;
}

// ---------------- web push ----------------
export interface PushSubRow { id: number; user_id: number; endpoint: string; p256dh: string; auth: string; created_at: number; last_ok_at: number | null }
export const PUSH_SUBS_PER_USER = 10;
export function savePushSub(userId: number, endpoint: string, p256dh: string, auth: string) {
  q(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`).run(userId, endpoint, p256dh, auth, now());
  // keep the newest few per user
  q(`DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT ?)`).run(userId, userId, PUSH_SUBS_PER_USER);
}
export function deletePushSub(endpoint: string, userId?: number): boolean {
  if (userId != null) return Number(q('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId).changes) > 0;
  return Number(q('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes) > 0;
}
export function pushSubsFor(userId: number): PushSubRow[] {
  return q('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id').all(userId) as unknown as PushSubRow[];
}
export function pushOk(id: number) { q('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?').run(now(), id); }

// ---------------- link previews ----------------
export interface PreviewRow { url: string; id: string; ok: number; kind: string; title: string | null; description: string | null; image_url: string | null; site_name: string | null; fetched_at: number }
export function previewByUrl(url: string): PreviewRow | undefined { return q('SELECT * FROM link_previews WHERE url = ?').get(url) as PreviewRow | undefined; }
export function previewById(id: string): PreviewRow | undefined { return q('SELECT * FROM link_previews WHERE id = ?').get(id) as PreviewRow | undefined; }
export function savePreview(r: PreviewRow) {
  q(`INSERT INTO link_previews (url, id, ok, kind, title, description, image_url, site_name, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET ok = excluded.ok, kind = excluded.kind, title = excluded.title, description = excluded.description,
       image_url = excluded.image_url, site_name = excluded.site_name, fetched_at = excluded.fetched_at`)
    .run(r.url, r.id, r.ok, r.kind, r.title, r.description, r.image_url, r.site_name, r.fetched_at);
}
export function attachPreview(messageId: string, previewId: string) {
  q('INSERT INTO message_previews (message_id, preview_id, removed) VALUES (?,?,0) ON CONFLICT(message_id) DO UPDATE SET preview_id = excluded.preview_id, removed = 0').run(messageId, previewId);
}
export function detachPreview(messageId: string) { q('DELETE FROM message_previews WHERE message_id = ?').run(messageId); }
export function removePreview(messageId: string): boolean {
  return Number(q('UPDATE message_previews SET removed = 1 WHERE message_id = ? AND removed = 0').run(messageId).changes) > 0;
}
/** Shown (not removed, successfully fetched) previews for these messages. */
export function previewsForMessages(ids: string[]): Map<string, PreviewRow> {
  const out = new Map<string, PreviewRow>();
  if (!ids.length) return out;
  const rows = q(`SELECT mp.message_id, p.* FROM message_previews mp JOIN link_previews p ON p.id = mp.preview_id
    WHERE mp.removed = 0 AND p.ok = 1 AND mp.message_id IN (${placeholders(ids.length)})`).all(...ids) as unknown as (PreviewRow & { message_id: string })[];
  for (const r of rows) out.set(r.message_id, r);
  return out;
}
/** Is this preview attached (and shown) on a message in this room? Used to authorize the image proxy. */
export function previewRoomIds(previewId: string): string[] {
  return (q(`SELECT DISTINCT m.room_id FROM message_previews mp JOIN messages m ON m.id = mp.message_id
    WHERE mp.preview_id = ? AND mp.removed = 0 AND m.deleted = 0`).all(previewId) as { room_id: string }[]).map((r) => r.room_id);
}

// ---------------- polls ----------------
export interface PollRow { id: string; room_id: string; message_id: string; question: string; options: string; created_by_user: number | null; created_by_key: string; created_by_nick: string; created_at: number; closes_at: number | null; closed_at: number | null }
export function insertPoll(r: Omit<PollRow, 'closed_at'>) {
  q('INSERT INTO polls (id, room_id, message_id, question, options, created_by_user, created_by_key, created_by_nick, created_at, closes_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.room_id, r.message_id, r.question, r.options, r.created_by_user, r.created_by_key, r.created_by_nick, r.created_at, r.closes_at);
}
export function pollById(id: string): PollRow | undefined { return q('SELECT * FROM polls WHERE id = ?').get(id) as PollRow | undefined; }
export function pollsForMessages(ids: string[]): Map<string, PollRow> {
  const out = new Map<string, PollRow>();
  if (!ids.length) return out;
  for (const r of q(`SELECT * FROM polls WHERE message_id IN (${placeholders(ids.length)})`).all(...ids) as unknown as PollRow[]) out.set(r.message_id, r);
  return out;
}
export function pollCounts(pollId: string, n: number): number[] {
  const counts = Array.from({ length: n }, () => 0);
  for (const r of q('SELECT option, COUNT(*) AS c FROM poll_votes WHERE poll_id = ? GROUP BY option').all(pollId) as { option: number; c: number }[])
    if (r.option >= 0 && r.option < n) counts[r.option] = r.c;
  return counts;
}
export function myPollVote(pollId: string, voterKeys: string[]): number | null {
  const keys = voterKeys.filter(Boolean);
  if (!keys.length) return null;
  const r = q(`SELECT option FROM poll_votes WHERE poll_id = ? AND voter_key IN (${placeholders(keys.length)}) ORDER BY created_at DESC LIMIT 1`).get(pollId, ...keys) as { option: number } | undefined;
  return r ? r.option : null;
}
/** One vote per voter; voting again changes it. */
export function castPollVote(pollId: string, voterKey: string, option: number) {
  q('INSERT INTO poll_votes (poll_id, voter_key, option, created_at) VALUES (?,?,?,?) ON CONFLICT(poll_id, voter_key) DO UPDATE SET option = excluded.option, created_at = excluded.created_at')
    .run(pollId, voterKey, option, now());
}
export function closePoll(id: string, at = now()): boolean {
  return Number(q('UPDATE polls SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(at, id).changes) > 0;
}
export function duePolls(at = now()): PollRow[] {
  return q('SELECT * FROM polls WHERE closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= ?').all(at) as unknown as PollRow[];
}
export function nextPollClose(): number | null {
  const r = q('SELECT MIN(closes_at) AS t FROM polls WHERE closed_at IS NULL AND closes_at IS NOT NULL').get() as { t: number | null };
  return r.t ?? null;
}

// ---------------- profiles ----------------
export interface ProfileRow { id: number; username: string; role: string; chat_color: string | null; chat_effect: string | null; has_avatar: number; bio: string | null; created_at: number }
export function profileByName(username: string): ProfileRow | undefined {
  return q('SELECT id, username, role, chat_color, chat_effect, has_avatar, bio, created_at FROM users WHERE username_lower = ?').get(String(username).toLowerCase()) as ProfileRow | undefined;
}
export function setBio(userId: number, bio: string | null) { q('UPDATE users SET bio = ? WHERE id = ?').run(bio, userId); }
export function bioOf(userId: number): string { return ((q('SELECT bio FROM users WHERE id = ?').get(userId) as { bio: string | null } | undefined)?.bio) ?? ''; }
/** Public, persistent rooms this account owns. */
export function publicRoomsOwned(userId: number): { id: string; name: string }[] {
  return q('SELECT id, name FROM rooms WHERE owner_user_id = ? AND persistent = 1 AND is_private = 0 ORDER BY created_at').all(userId) as { id: string; name: string }[];
}

// ---------------- maintenance ----------------
export function prune2(at = now()): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    q('DELETE FROM message_bookmarks WHERE message_id NOT IN (SELECT id FROM messages)').run();
    q('DELETE FROM message_previews WHERE message_id NOT IN (SELECT id FROM messages)').run();
    q('DELETE FROM link_previews WHERE fetched_at < ? AND id NOT IN (SELECT preview_id FROM message_previews)').run(at - 7 * 86400_000);
    q('DELETE FROM polls WHERE message_id NOT IN (SELECT id FROM messages)').run();
    q('DELETE FROM room_mutes WHERE expires_at < ?').run(at - 86400_000);
    q('DELETE FROM poll_votes WHERE poll_id NOT IN (SELECT id FROM polls)').run();
    q('DELETE FROM room_mods WHERE room_id NOT IN (SELECT id FROM rooms)').run();
    q('DELETE FROM room_events WHERE room_id NOT IN (SELECT id FROM rooms)').run();
    q('DELETE FROM event_rsvps WHERE event_id NOT IN (SELECT id FROM room_events)').run();
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
