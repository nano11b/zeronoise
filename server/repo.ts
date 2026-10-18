import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { publicChatEffect } from '../shared/colors';
import { LIMITS, RESERVED_NAMES } from '../shared/config';
import type { AdminBan, AdminLogEntry, AdminReport, AdminUser, BanKind, Role } from '../shared/types';
import { q, tx } from './db';
import { ADMIN_USERNAMES, SESSION_DAYS, SESSION_SECRET } from './env';

export type AccountRole = Exclude<Role, 'guest'>;
export interface Account {
  id: number; username: string; role: AccountRole; chatColor: string | null; chatEffect: string | null; hasAvatar: boolean;
  email: string | null; emailVerified: boolean;
}
/** Who someone is, for ban / mute / room-ban matching. */
export interface Ident { userId: number | null; nick: string; ip: string; deviceIds: string[] }
export const userKey = (i: { userId: number | null; nick: string }) => (i.userId ? `u:${i.userId}` : `g:${i.nick.toLowerCase()}`);

const now = () => Date.now();
const ROLES: AccountRole[] = ['admin', 'moderator', 'user'];
export const isRole = (r: unknown): r is AccountRole => ROLES.includes(r as AccountRole);

// ---------------- users ----------------
export interface UserRow {
  id: number; username: string; role: AccountRole; password_hash: string | null; google_sub: string | null; discord_id: string | null;
  tiktok_open_id: string | null;
  created_at: number; last_login_at: number | null; chat_color: string | null; chat_effect: string | null; has_avatar: number;
  email: string | null; email_lower: string | null; email_verified_at: number | null;
  /** batch D (migration 42) */
  xp?: number; xp_hidden?: number;
}
/** Saved camera quality preset, or null. */
export function videoQualityOf(id: number): string | null {
  const r = q('SELECT video_quality FROM users WHERE id = ?').get(id) as { video_quality: string | null } | undefined;
  return r?.video_quality ?? null;
}
export function setVideoQuality(id: number, v: string | null) {
  q('UPDATE users SET video_quality = ? WHERE id = ?').run(v, id);
}
/** Saved interface theme, or null (Dark). */
export function uiThemeOf(id: number): string | null {
  const r = q('SELECT ui_theme FROM users WHERE id = ?').get(id) as { ui_theme: string | null } | undefined;
  return r?.ui_theme ?? null;
}
export function setUiTheme(id: number, v: string | null) {
  q('UPDATE users SET ui_theme = ? WHERE id = ?').run(v, id);
}
const toAccount = (r: UserRow): Account => ({
  id: r.id, username: r.username, role: r.role, chatColor: r.chat_color ?? null, chatEffect: publicChatEffect(r.chat_effect), hasAvatar: !!r.has_avatar,
  email: r.email ?? null, emailVerified: !!r.email_verified_at,
});

export function userByName(name: string): UserRow | undefined {
  return q('SELECT * FROM users WHERE username_lower = ?').get(name.toLowerCase()) as UserRow | undefined;
}
/** batch H7: fetch many users at once (history pages) */
export function usersByIds(ids: number[]): Map<number, UserRow> {
  const out = new Map<number, UserRow>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 400) {
    const part = uniq.slice(i, i + 400);
    if (!part.length) continue;
    for (const r of q(`SELECT * FROM users WHERE id IN (${part.map(() => '?').join(',')})`).all(...part) as unknown as UserRow[]) out.set(r.id, r);
  }
  return out;
}
export function userById(id: number): UserRow | undefined {
  return q('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}
export function userByGoogle(sub: string): UserRow | undefined {
  return q('SELECT * FROM users WHERE google_sub = ?').get(sub) as UserRow | undefined;
}
export function userByDiscord(discordId: string): UserRow | undefined {
  return q('SELECT * FROM users WHERE discord_id = ?').get(discordId) as UserRow | undefined;
}
export function userByTikTok(openId: string): UserRow | undefined {
  return q('SELECT * FROM users WHERE tiktok_open_id = ?').get(openId) as UserRow | undefined;
}
export function accountById(id: number): Account | null {
  const r = userById(id);
  return r ? toAccount(r) : null;
}
export function createUser(username: string, passwordHash: string | null, googleSub: string | null, ip: string, discordId: string | null = null, email: string | null = null, tiktokOpenId: string | null = null): Account {
  const role: AccountRole = ADMIN_USERNAMES.includes(username.toLowerCase()) ? 'admin' : 'user';
  const emailLower = email ? email.toLowerCase() : null;
  const r = q('INSERT INTO users (username, username_lower, password_hash, google_sub, discord_id, role, created_at, last_login_at, last_ip, email, email_lower, email_verified_at, tiktok_open_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *')
    .get(username, username.toLowerCase(), passwordHash, googleSub, discordId, role, now(), now(), ip, email, emailLower, null, tiktokOpenId) as unknown as UserRow;
  return toAccount(r);
}
export function userByEmail(email: string): UserRow | undefined {
  return q('SELECT * FROM users WHERE email_lower = ?').get(email.trim().toLowerCase()) as UserRow | undefined;
}
/** Save an address. Verified is cleared unless `verified` is true. Outstanding confirmations are dropped. */
export function setEmail(id: number, email: string, verified: boolean): 'ok' | 'taken' {
  const trimmed = email.trim();
  const lower = trimmed.toLowerCase();
  const other = q('SELECT id FROM users WHERE email_lower = ? AND id != ?').get(lower, id) as { id: number } | undefined;
  if (other) return 'taken';
  q('UPDATE users SET email = ?, email_lower = ?, email_verified_at = ? WHERE id = ?').run(trimmed, lower, verified ? now() : null, id);
  q('DELETE FROM email_tokens WHERE user_id = ? AND used_at IS NULL').run(id);
  return 'ok';
}
export function markEmailVerified(id: number, emailLower: string): boolean {
  const r = q('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_lower = ?').run(now(), id, emailLower);
  q('DELETE FROM email_tokens WHERE user_id = ? AND used_at IS NULL').run(id);
  return r.changes > 0;
}
/** Records a login and applies ADMIN_USERNAMES bootstrap. */
export function touchLogin(id: number, ip: string): Account | null {
  const u = userById(id);
  if (!u) return null;
  if (ADMIN_USERNAMES.includes(u.username.toLowerCase()) && u.role !== 'admin') q('UPDATE users SET role = ? WHERE id = ?').run('admin', id);
  q('UPDATE users SET last_login_at = ?, last_ip = ? WHERE id = ?').run(now(), ip, id);
  return accountById(id);
}
export function setRole(id: number, role: AccountRole) {
  q('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}
export function setChatColor(id: number, color: string | null) {
  q('UPDATE users SET chat_color = ? WHERE id = ?').run(color, id);
}
export function setChatEffect(id: number, effect: string | null) {
  q('UPDATE users SET chat_effect = ? WHERE id = ?').run(effect, id);
}
export function setHasAvatar(id: number, has: boolean) {
  q('UPDATE users SET has_avatar = ? WHERE id = ?').run(has ? 1 : 0, id);
}
export function adminCount(): number {
  return (q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
}
export function promoteBootstrapAdmins() {
  for (const name of ADMIN_USERNAMES) {
    const r = q("UPDATE users SET role = 'admin' WHERE username_lower = ? AND role != 'admin'").run(name);
    if (r.changes) console.log(`[admin] ${name} promoted to admin via ADMIN_USERNAMES`);
  }
}
/** Registered usernames and RESERVED_NAMES can't be used by guests. */
export function isNameReserved(nick: string): boolean {
  const k = nick.toLowerCase();
  return RESERVED_NAMES.includes(k) || !!q('SELECT 1 FROM users WHERE username_lower = ?').get(k);
}
export function searchUsers(term: string, limit = 50): AdminUser[] {
  const like = `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = q(`SELECT u.*, EXISTS(SELECT 1 FROM bans b WHERE b.kind = 'account' AND b.value = CAST(u.id AS TEXT) AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > ?)) AS banned
    FROM users u WHERE u.username_lower LIKE ? ESCAPE '\\' OR IFNULL(u.email_lower, '') LIKE ? ESCAPE '\\' ORDER BY (u.role = 'user'), u.username_lower LIMIT ?`).all(now(), like, like, limit) as unknown as (UserRow & { banned: number })[];
  return rows.map((r) => ({
    id: r.id, username: r.username, role: r.role, createdAt: r.created_at, lastLoginAt: r.last_login_at,
    google: !!r.google_sub, discord: !!r.discord_id, tiktok: !!r.tiktok_open_id, banned: !!r.banned, chatColor: r.chat_color ?? null,
    chatEffect: publicChatEffect(r.chat_effect), hasAvatar: !!r.has_avatar,
    email: r.email ?? null, emailVerified: !!r.email_verified_at,
  }));
}

// ---------------- sessions ----------------
const tokenId = (token: string) => createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
export function createSession(userId: number, ip: string, ua: string, passkeyVerified = false): { token: string; maxAgeSec: number } {
  const token = randomBytes(32).toString('base64url');
  const maxAgeSec = SESSION_DAYS * 86400;
  // batch D: an account with two-factor turned on gets a session that is not signed in until the code step passes.
  const mfa = !passkeyVerified && (q('SELECT 1 AS x FROM user_totp WHERE user_id = ? AND enabled_at IS NOT NULL').get(userId)
    || q('SELECT 1 AS x FROM user_passkeys WHERE user_id = ? AND removed_at IS NULL').get(userId)) ? 1 : 0;
  // batch E: a pending session is stored under "mfa:<id>": a --keep-db rollback build (which ignores mfa_pending)
  // cannot find it, so the person is simply signed out there instead of skipping the second step.
  q('INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent, mfa_pending) VALUES (?,?,?,?,?,?,?)')
    .run(mfa ? `mfa:${tokenId(token)}` : tokenId(token), userId, now(), mfa ? now() + 10 * 60_000 : now() + maxAgeSec * 1000, ip, ua.slice(0, 200), mfa);
  return { token, maxAgeSec };
}
export function sessionAccount(token: string | undefined): Account | null {
  if (!token || token.length > 100) return null;
  const r = q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND s.mfa_pending = 0').get(tokenId(token), now()) as UserRow | undefined;
  return r ? toAccount(r) : null;
}
/** A session still waiting for its two-factor code (10-minute window). */
export function pendingMfaUser(token: string | undefined): { id: number; username: string; role: Role } | null {
  if (!token || token.length > 100) return null;
  return (q('SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND s.mfa_pending = 1').get(`mfa:${tokenId(token)}`, now()) as { id: number; username: string; role: Role } | undefined) ?? null;
}
/** Code accepted: the session becomes a normal, full-length one. */
export function completeMfa(token: string) {
  q('UPDATE sessions SET mfa_pending = 0, id = ?, expires_at = ? WHERE id = ? AND mfa_pending = 1').run(tokenId(token), now() + SESSION_DAYS * 86400 * 1000, `mfa:${tokenId(token)}`);
}
export function deleteSession(token: string | undefined) {
  if (token) q('DELETE FROM sessions WHERE id IN (?, ?)').run(tokenId(token), `mfa:${tokenId(token)}`);
}
/** batch E startup: move batch-D style pending rows (plain id) under "mfa:" too, and keep passkey markers in step */
export function hardenPendingSessions(): number {
  return Number(q(`UPDATE sessions SET id = 'mfa:' || id WHERE mfa_pending = 1 AND id NOT LIKE 'mfa:%'`).run().changes);
}

// ---------------- bans ----------------
interface BanRow { id: number; kind: BanKind; value: string; label: string | null; reason: string; created_by: string; created_at: number; expires_at: number | null }
const toBan = (r: BanRow): AdminBan => ({ id: r.id, kind: r.kind, value: r.value, label: r.label, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at });
export function addBan(kind: BanKind, value: string, label: string | null, reason: string, by: string, minutes: number | null): number {
  const exp = minutes ? now() + minutes * 60_000 : null;
  const r = q('INSERT INTO bans (kind, value, label, reason, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?) RETURNING id')
    .get(kind, value, label, reason.slice(0, LIMITS.banReasonMax), by, now(), exp) as { id: number };
  return r.id;
}
/** Active site ban matching any of the identity's account / IP / device ids. Staff are exempt from IP/device bans. */
export function activeBan(i: { userId: number | null; ip: string; deviceIds: string[]; staff?: boolean }): AdminBan | null {
  const keys: [BanKind, string][] = [];
  if (i.userId) keys.push(['account', String(i.userId)]);
  if (!i.staff) {
    if (i.ip && i.ip !== 'unknown') keys.push(['ip', i.ip]);
    for (const d of i.deviceIds) keys.push(['device', d]);
  }
  for (const [kind, value] of keys) {
    const r = q('SELECT * FROM bans WHERE kind = ? AND value = ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY expires_at IS NULL DESC, expires_at DESC LIMIT 1')
      .get(kind, value, now()) as BanRow | undefined;
    if (r) return toBan(r);
  }
  return null;
}
export function banMessage(b: AdminBan): string {
  const until = b.expiresAt ? `until ${new Date(b.expiresAt).toUTCString()}` : 'permanently';
  return `You are banned ${until}. Reason: ${b.reason}`;
}
export function listActiveBans(): AdminBan[] {
  return (q('SELECT * FROM bans WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 500').all(now()) as unknown as BanRow[]).map(toBan);
}
export function liftBan(id: number, by: string): boolean {
  return q('UPDATE bans SET lifted_at = ?, lifted_by = ? WHERE id = ? AND lifted_at IS NULL').run(now(), by, id).changes > 0;
}

// ---------------- mutes & room bans ----------------
function identMatch(i: Ident, withIp: boolean): { sql: string; args: (string | number)[] } {
  const parts = ['user_key = ?'];
  const args: (string | number)[] = [userKey(i)];
  for (const d of i.deviceIds) { parts.push('device_id = ?'); args.push(d); }
  if (withIp && i.ip !== 'unknown') { parts.push('ip = ?'); args.push(i.ip); }
  return { sql: `(${parts.join(' OR ')})`, args };
}
export function addMute(i: Ident, by: string, minutes: number): number {
  const until = now() + minutes * 60_000;
  q('INSERT INTO mutes (user_key, ip, device_id, nick, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(userKey(i), i.ip, i.deviceIds[0] ?? null, i.nick, by, now(), until);
  return until;
}
export function activeMuteUntil(i: Ident): number | null {
  const m = identMatch(i, false);
  const r = q(`SELECT MAX(expires_at) AS until FROM mutes WHERE expires_at > ? AND ${m.sql}`).get(now(), ...m.args) as { until: number | null };
  return r.until ?? null;
}
export function addRoomBan(roomId: string, i: Ident, reason: string, by: string, minutes: number | null) {
  q('INSERT INTO room_bans (room_id, user_key, ip, device_id, nick, reason, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(roomId, userKey(i), i.ip, i.deviceIds[0] ?? null, i.nick, reason.slice(0, LIMITS.banReasonMax), by, now(), minutes ? now() + minutes * 60_000 : null);
}
export function activeRoomBan(roomId: string, i: Ident): { id: number; reason: string | null; expires_at: number | null } | null {
  // room bans match account/guest name + device (IP too for guests, who can trivially rename)
  const m = identMatch(i, !i.userId);
  return (q(`SELECT id, reason, expires_at FROM room_bans WHERE room_id = ? AND (expires_at IS NULL OR expires_at > ?) AND ${m.sql} LIMIT 1`)
    .get(roomId, now(), ...m.args) as { id: number; reason: string | null; expires_at: number | null } | undefined) ?? null;
}
/** batch E: an approved appeal ends the room ban by expiring it (the row is kept) */
export function expireRoomBan(id: number): boolean {
  return Number(q('UPDATE room_bans SET expires_at = ? WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)').run(now(), id, now()).changes) > 0;
}

// ---------------- rooms & messages ----------------
export interface RoomRow {
  id: string; name: string; topic: string; owner_user_id: number | null; owner_nick: string | null;
  permanent: number; persistent: number; created_at: number;
  locked: number; slow_mode_sec: number; is_private: number;
  /** bcrypt hash; null/absent = open room */
  password_hash: string | null;
  /** custom lobby thumbnail id (migration 28); absent on old rows */
  thumb_id?: string | null;
  thumb_at?: number | null;
  /** stage mode (migration 35); absent on old rows */
  stage_mode?: number | null;
  stage_cap?: number | null;
  /** custom room icon id (migration 34); absent on old rows */
  icon_id?: string | null;
  icon_at?: number | null;
  /** batch 3 (migration 29); absent on old rows */
  category?: string | null;
  tags?: string | null;
  announcement?: string | null;
  announcement_at?: number | null;
  announcement_by?: string | null;
  /** batch C: audio-only voice room */
  voice?: number;
}
export function allRooms(): RoomRow[] { return q('SELECT * FROM rooms ORDER BY created_at').all() as unknown as RoomRow[]; }
export function insertRoom(r: Omit<RoomRow, 'created_at' | 'locked' | 'slow_mode_sec' | 'is_private' | 'password_hash'> & Partial<Pick<RoomRow, 'locked' | 'slow_mode_sec' | 'is_private' | 'password_hash'>>) {
  q('INSERT INTO rooms (id, name, name_lower, topic, owner_user_id, owner_nick, permanent, persistent, created_at, locked, slow_mode_sec, is_private, password_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.name, r.name.toLowerCase(), r.topic, r.owner_user_id, r.owner_nick, r.permanent, r.persistent, now(),
      r.locked ?? 0, r.slow_mode_sec ?? 0, r.is_private ?? 0, r.password_hash ?? null);
}
export function setRoomThumb(id: string, thumbId: string | null) {
  q('UPDATE rooms SET thumb_id = ?, thumb_at = ? WHERE id = ?').run(thumbId, thumbId ? now() : null, id);
}
export function roomByThumbId(thumbId: string): RoomRow | undefined {
  return q('SELECT * FROM rooms WHERE thumb_id = ?').get(thumbId) as unknown as RoomRow | undefined;
}
export function setRoomIcon(id: string, iconId: string | null) {
  q('UPDATE rooms SET icon_id = ?, icon_at = ? WHERE id = ?').run(iconId, iconId ? now() : null, id);
}
export function roomByIconId(iconId: string): RoomRow | undefined {
  return q('SELECT * FROM rooms WHERE icon_id = ?').get(iconId) as unknown as RoomRow | undefined;
}
export function roomRowById(id: string): RoomRow | undefined {
  return q('SELECT * FROM rooms WHERE id = ?').get(id) as unknown as RoomRow | undefined;
}
export function setRoomPassword(id: string, hash: string | null) {
  q('UPDATE rooms SET password_hash = ? WHERE id = ?').run(hash, id);
}
export function setRoomLocked(id: string, locked: boolean) { q('UPDATE rooms SET locked = ? WHERE id = ?').run(locked ? 1 : 0, id); }
export function setRoomSlowMode(id: string, sec: number) { q('UPDATE rooms SET slow_mode_sec = ? WHERE id = ?').run(Math.max(0, Math.min(sec, 300)), id); }
/** Soft-delete messages in the window and return their ids (so live clients can drop them). */
export function purgeRoomMessages(roomId: string, sinceTs: number): string[] {
  const ids = (q('SELECT id FROM messages WHERE room_id = ? AND ts >= ? AND deleted = 0').all(roomId, sinceTs) as unknown as { id: string }[]).map((r) => r.id);
  if (ids.length) {
    q('UPDATE messages SET deleted = 1 WHERE room_id = ? AND ts >= ? AND deleted = 0').run(roomId, sinceTs);
    q(`DELETE FROM message_pins WHERE message_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  return ids;
}
export function roomNameTaken(name: string) { return !!q('SELECT 1 FROM rooms WHERE name_lower = ?').get(name.toLowerCase()); }
export function roomsOwnedBy(userId: number): number { return (q('SELECT COUNT(*) AS n FROM rooms WHERE owner_user_id = ? AND persistent = 1').get(userId) as { n: number }).n; }
export function setRoomTopic(id: string, topic: string) { q('UPDATE rooms SET topic = ? WHERE id = ?').run(topic, id); }
export function deleteRoom(id: string) { q('DELETE FROM rooms WHERE id = ?').run(id); }
export function deleteEphemeralRooms() { return q('DELETE FROM rooms WHERE persistent = 0').run().changes; }
export function ephemeralRoomIds(): string[] {
  return (q('SELECT id FROM rooms WHERE persistent = 0').all() as { id: string }[]).map((r) => r.id);
}

export interface SoundRow { id: string; room_id: string; name: string; mime: string; ext: string; created_at: number }
export function listSounds(roomId: string): SoundRow[] {
  return q('SELECT id, room_id, name, mime, ext, created_at FROM room_sounds WHERE room_id = ? ORDER BY created_at, id').all(roomId) as unknown as SoundRow[];
}
export function countSounds(roomId: string): number {
  return (q('SELECT COUNT(*) AS n FROM room_sounds WHERE room_id = ?').get(roomId) as { n: number }).n;
}
export function soundById(roomId: string, id: string): SoundRow | undefined {
  return q('SELECT id, room_id, name, mime, ext, created_at FROM room_sounds WHERE room_id = ? AND id = ?').get(roomId, id) as SoundRow | undefined;
}
export function insertSound(row: SoundRow): SoundRow {
  q('INSERT INTO room_sounds (id, room_id, name, mime, ext, created_at) VALUES (?,?,?,?,?,?)')
    .run(row.id, row.room_id, row.name, row.mime, row.ext, row.created_at);
  return row;
}
export function deleteSound(roomId: string, id: string): boolean {
  return q('DELETE FROM room_sounds WHERE room_id = ? AND id = ?').run(roomId, id).changes > 0;
}

export interface MsgRow {
  id: string; room_id: string; ts: number; user_id: number | null; nick: string; role: string | null; text: string;
  ip: string | null; device_id: string | null; deleted: number;
  parent_id: string | null; edited_at: number | null;
  bot_id: number | null;
  voice_id: string | null; voice_ms: number | null;
  burn_ttl: number | null; burned_at: number | null; burn_recipients: string | null;
}
export function insertMessage(m: Omit<MsgRow, 'deleted' | 'parent_id' | 'edited_at' | 'bot_id' | 'voice_id' | 'voice_ms' | 'burn_ttl' | 'burned_at' | 'burn_recipients'> & { parent_id?: string | null; bot_id?: number | null; voice_id?: string | null; voice_ms?: number | null; burn_ttl?: number | null; burn_recipients?: string[] | null }) {
  q('INSERT INTO messages (id, room_id, ts, user_id, nick, role, text, ip, device_id, parent_id, edited_at, bot_id, voice_id, voice_ms, burn_ttl, burned_at, burn_recipients) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(m.id, m.room_id, m.ts, m.user_id, m.nick, m.role, m.text, m.ip, m.device_id, m.parent_id ?? null, null, m.bot_id ?? null,
      m.voice_id ?? null, m.voice_ms ?? null, m.burn_ttl ?? null, null, m.burn_recipients ? JSON.stringify(m.burn_recipients) : null);
}
/** Newest id in the room, including a deleted row, or null when the room has no messages. */
export function newestMessageId(roomId: string): string | null {
  const row = q('SELECT id FROM messages WHERE room_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1').get(roomId) as { id: string } | undefined;
  return row?.id ?? null;
}
/** Position of a message id in this room. A deleted row is still a valid cursor. */
export function messageAnchor(roomId: string, id: string): { ts: number; rowid: number } | undefined {
  const row = q('SELECT ts, rowid AS rid FROM messages WHERE room_id = ? AND id = ?').get(roomId, id) as { ts: number; rid: number | bigint } | undefined;
  if (!row) return undefined;
  return { ts: Number(row.ts), rowid: Number(row.rid) };
}
/**
 * Non-deleted messages in ascending order. A null anchor is the last `limit` lines.
 * An anchor returns lines strictly after that (ts, rowid).
 */
export function messagesAfter(roomId: string, anchor: { ts: number; rowid: number } | null, limit: number): MsgRow[] {
  if (!anchor) {
    const rows = q('SELECT * FROM messages WHERE room_id = ? AND deleted = 0 ORDER BY ts DESC, rowid DESC LIMIT ?').all(roomId, limit) as unknown as MsgRow[];
    return rows.reverse();
  }
  return q(`SELECT * FROM messages WHERE room_id = ? AND deleted = 0 AND (ts > ? OR (ts = ? AND rowid > ?))
    ORDER BY ts ASC, rowid ASC LIMIT ?`).all(roomId, anchor.ts, anchor.ts, anchor.rowid, limit) as unknown as MsgRow[];
}
export function recentMessages(roomId: string, n: number, includeDeleted = false, topLevelOnly = false): MsgRow[] {
  const rows = q(`SELECT * FROM messages WHERE room_id = ? ${includeDeleted ? '' : 'AND deleted = 0'} ${topLevelOnly ? 'AND parent_id IS NULL' : ''} ORDER BY ts DESC, rowid DESC LIMIT ?`).all(roomId, n) as unknown as MsgRow[];
  return rows.reverse();
}
export function messageById(id: string): MsgRow | undefined { return q('SELECT * FROM messages WHERE id = ?').get(id) as MsgRow | undefined; }
export function markMessageDeleted(id: string) { q('UPDATE messages SET deleted = 1 WHERE id = ?').run(id); q('DELETE FROM message_edits WHERE message_id = ?').run(id); }
/** Keep the version being replaced (staff can read the history). */
export function recordEdit(m: { id: string; room_id: string; text: string }, editedAt: number, editorUserId: number | null) {
  q('INSERT INTO message_edits (message_id, room_id, text, edited_at, editor_user_id) VALUES (?, ?, ?, ?, ?)').run(m.id, m.room_id, m.text, editedAt, editorUserId);
}
/** Earlier versions, oldest first: `at` is when that version was written (the send time, then each edit). */
export function editHistory(m: { id: string; ts: number }): { text: string; at: number }[] {
  const rows = q('SELECT text, edited_at FROM message_edits WHERE message_id = ? ORDER BY edited_at, id').all(m.id) as unknown as { text: string; edited_at: number }[];
  return rows.map((r, i) => ({ text: r.text, at: i === 0 ? m.ts : rows[i - 1].edited_at }));
}
/** History rows whose message is gone or deleted (retention, purges, room deletion). */
export function pruneEdits(): number {
  return Number(q('DELETE FROM message_edits WHERE message_id NOT IN (SELECT id FROM messages WHERE deleted = 0)').run().changes);
}
export function setRoomVoice(id: string, on: boolean) { q('UPDATE rooms SET voice = ? WHERE id = ?').run(on ? 1 : 0, id); }
export function setRoomStage(id: string, on: boolean, cap: number) {
  q('UPDATE rooms SET stage_mode = ?, stage_cap = ? WHERE id = ?').run(on ? 1 : 0, cap, id);
}
export function editMessage(id: string, text: string, editedAt: number) {
  q('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(text, editedAt, id);
}
/** Soft-delete a message and its direct replies. Returns every id that was cleared. */
export function deleteMessageTree(id: string): string[] {
  const kids = (q('SELECT id FROM messages WHERE parent_id = ? AND deleted = 0').all(id) as unknown as { id: string }[]).map((r) => r.id);
  const ids = [id, ...kids];
  const del = q('UPDATE messages SET deleted = 1 WHERE id = ?');
  const unpin = q('DELETE FROM message_pins WHERE message_id = ?');
  const edits = q('DELETE FROM message_edits WHERE message_id = ?');
  for (const mid of ids) { del.run(mid); unpin.run(mid); edits.run(mid); }
  return ids;
}
export function threadMessages(parentId: string, n: number): MsgRow[] {
  return q('SELECT * FROM messages WHERE parent_id = ? AND deleted = 0 ORDER BY ts ASC, rowid ASC LIMIT ?').all(parentId, n) as unknown as MsgRow[];
}
export function replyCount(parentId: string): number {
  return (q('SELECT COUNT(*) AS n FROM messages WHERE parent_id = ? AND deleted = 0').get(parentId) as { n: number }).n;
}
export function replyCounts(ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = q(`SELECT parent_id, COUNT(*) AS n FROM messages WHERE deleted = 0 AND parent_id IN (${ids.map(() => '?').join(',')}) GROUP BY parent_id`).all(...ids) as unknown as { parent_id: string; n: number }[];
  for (const r of rows) out.set(r.parent_id, r.n);
  return out;
}
const MENTION_RE = /@([A-Za-z][A-Za-z0-9_-]{1,19})/g;
/** Account ids named by @username (case-insensitive). Unknown names are skipped. */
export function mentionIds(text: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(MENTION_RE)) {
    const u = userByName(m[1]);
    if (u && !seen.has(u.id)) { seen.add(u.id); ids.push(u.id); }
  }
  return ids;
}
export function pinMessage(messageId: string, roomId: string, by: string) {
  q('INSERT INTO message_pins (message_id, room_id, pinned_by, pinned_at) VALUES (?,?,?,?) ON CONFLICT(message_id) DO NOTHING')
    .run(messageId, roomId, by, now());
}
export function unpinMessage(messageId: string) { q('DELETE FROM message_pins WHERE message_id = ?').run(messageId); }
export function isPinned(messageId: string): boolean { return !!q('SELECT 1 FROM message_pins WHERE message_id = ?').get(messageId); }
export function pinCount(roomId: string): number { return (q('SELECT COUNT(*) AS n FROM message_pins WHERE room_id = ?').get(roomId) as { n: number }).n; }
export function pinsForRoom(roomId: string, limit: number): MsgRow[] {
  return q(`SELECT m.* FROM message_pins p JOIN messages m ON m.id = p.message_id
    WHERE p.room_id = ? AND m.deleted = 0 ORDER BY p.pinned_at DESC LIMIT ?`).all(roomId, limit) as unknown as MsgRow[];
}

export interface ReactionCountRow { emoji: string; count: number; mine: boolean }
/** Toggle one reaction. Returns whether it is now present. */
export function toggleReaction(messageId: string, userKey: string, emoji: string): boolean {
  const existing = q('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_key = ? AND emoji = ?').get(messageId, userKey, emoji);
  if (existing) {
    q('DELETE FROM message_reactions WHERE message_id = ? AND user_key = ? AND emoji = ?').run(messageId, userKey, emoji);
    return false;
  }
  q('INSERT INTO message_reactions (message_id, user_key, emoji, created_at) VALUES (?,?,?,?)').run(messageId, userKey, emoji, now());
  return true;
}
export function reactionsFor(messageIds: string[], viewerKey: string): Map<string, ReactionCountRow[]> {
  const map = new Map<string, ReactionCountRow[]>();
  if (!messageIds.length) return map;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = q(`SELECT message_id, emoji, COUNT(*) AS n, SUM(CASE WHEN user_key = ? THEN 1 ELSE 0 END) AS mine
    FROM message_reactions WHERE message_id IN (${placeholders}) GROUP BY message_id, emoji`).all(viewerKey, ...messageIds) as unknown as { message_id: string; emoji: string; n: number; mine: number }[];
  for (const r of rows) {
    const list = map.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, count: Number(r.n), mine: Number(r.mine) > 0 });
    map.set(r.message_id, list);
  }
  return map;
}

// ---------------- reports ----------------
export function createReport(r: {
  reporterUserId: number | null; reporterNick: string; reporterIp: string;
  targetUserId: number | null; targetNick: string | null; targetIp: string | null; targetDevice: string | null;
  roomId: string | null; messageId: string | null; messageText: string | null; reason: string; context: { ts: number; from: string; text: string }[];
}): number {
  const row = q(`INSERT INTO reports (created_at, reporter_user_id, reporter_nick, reporter_ip, target_user_id, target_nick, target_ip, target_device, room_id, message_id, message_text, reason, context)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(now(), r.reporterUserId, r.reporterNick, r.reporterIp, r.targetUserId, r.targetNick, r.targetIp, r.targetDevice,
    r.roomId, r.messageId, r.messageText, r.reason.slice(0, LIMITS.reportReasonMax), JSON.stringify(r.context)) as { id: number };
  return row.id;
}
interface ReportRow { id: number; created_at: number; status: AdminReport['status']; reporter_nick: string; target_user_id: number | null; target_nick: string | null; target_ip: string | null; target_device: string | null; room_id: string | null; message_id: string | null; message_text: string | null; reason: string; context: string; handled_by: string | null; handled_at: number | null }
const toReport = (r: ReportRow): AdminReport => ({
  id: r.id, createdAt: r.created_at, status: r.status, reporterNick: r.reporter_nick, targetNick: r.target_nick, targetUserId: r.target_user_id,
  roomId: r.room_id, messageId: r.message_id, messageText: r.message_text, reason: r.reason, context: JSON.parse(r.context || '[]'),
  handledBy: r.handled_by, handledAt: r.handled_at, hasIp: !!r.target_ip, hasDevice: !!r.target_device,
});
export function listReports(status: string): AdminReport[] {
  const rows = status === 'all'
    ? q('SELECT * FROM reports ORDER BY created_at DESC LIMIT 200').all()
    : q('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status);
  return (rows as unknown as ReportRow[]).map(toReport);
}
export function reportRow(id: number) { return q('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined; }
export function setReportStatus(id: number, status: 'resolved' | 'dismissed' | 'open', by: string, note: string | null): boolean {
  return q('UPDATE reports SET status = ?, handled_by = ?, handled_at = ?, note = ? WHERE id = ?').run(status, by, now(), note, id).changes > 0;
}

// ---------------- moderation log ----------------
type LogListener = (e: { actor: string; action: string; target: string | null; roomId: string | null; details: string | null }) => void;
let logListener: LogListener | null = null;
/** webhooks: the room 'mod' event follows the moderation log */
export function onLogAction(fn: LogListener) { logListener = fn; }
export function logAction(actor: string, actorUserId: number | null, action: string, target: string | null, roomId: string | null, details?: string | null) {
  q('INSERT INTO mod_log (ts, actor, actor_user_id, action, target, room_id, details) VALUES (?,?,?,?,?,?,?)')
    .run(now(), actor, actorUserId, action, target, roomId, details ?? null);
  if (logListener) try { logListener({ actor, action, target, roomId, details: details ?? null }); } catch { /* never break the log */ }
}
export function listLog(limit = 200, beforeId: number | null = null): AdminLogEntry[] {
  return ((beforeId ? q('SELECT id, ts, actor, action, target, room_id, details FROM mod_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit)
    : q('SELECT id, ts, actor, action, target, room_id, details FROM mod_log ORDER BY id DESC LIMIT ?').all(limit)) as unknown as
    { id: number; ts: number; actor: string; action: string; target: string | null; room_id: string | null; details: string | null }[])
    .map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, target: r.target, roomId: r.room_id, details: r.details }));
}

export function setPasswordHash(userId: number, hash: string) {
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
}
export function deleteUsersMatching(pattern: string): { deleted: number; usernames: string[] } {
  const like = pattern.toLowerCase();
  return tx(() => {
    const list = q('SELECT id, username FROM users WHERE username_lower LIKE ?').all(like) as { id: number; username: string }[];
    for (const u of list) {
      q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      q('DELETE FROM friendships WHERE user_id = ? OR peer_id = ?').run(u.id, u.id);
      q('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
      q('DELETE FROM user_blocks WHERE user_id = ? OR blocked_id = ?').run(u.id, u.id);
      q('DELETE FROM recent_rooms WHERE user_id = ?').run(u.id);
      q('DELETE FROM room_invite_uses WHERE user_id = ?').run(u.id);
      q('DELETE FROM mention_inbox WHERE user_id = ?').run(u.id);
      q('DELETE FROM room_reads WHERE user_id = ?').run(u.id);
      q('DELETE FROM whisper_members WHERE user_id = ?').run(u.id);
      q('DELETE FROM dm_reactions WHERE user_id = ?').run(u.id);
      q("UPDATE dm_messages SET text = '', deleted_at = ? WHERE from_user_id = ?").run(Date.now(), u.id);
      q('UPDATE dm_members SET left_at = COALESCE(left_at, ?) WHERE user_id = ?').run(Date.now(), u.id);
      q('DELETE FROM whisper_messages WHERE id NOT IN (SELECT message_id FROM whisper_members)').run();
      q('DELETE FROM users WHERE id = ?').run(u.id);
    }
    return { deleted: list.length, usernames: list.map((u) => u.username) };
  });
}

// ---------------- friends ----------------
export interface FriendRow { id: number; user_id: number; peer_id: number; status: 'pending' | 'accepted'; requested_by: number; created_at: number; updated_at: number }
function pair(a: number, b: number) { return a < b ? [a, b] as const : [b, a] as const; }
export function friendshipBetween(a: number, b: number): FriendRow | undefined {
  const [u, p] = pair(a, b);
  return q('SELECT * FROM friendships WHERE user_id = ? AND peer_id = ?').get(u, p) as FriendRow | undefined;
}
export function listFriendships(userId: number): FriendRow[] {
  return q('SELECT * FROM friendships WHERE user_id = ? OR peer_id = ? ORDER BY updated_at DESC')
    .all(userId, userId) as unknown as FriendRow[];
}
export function requestFriend(fromId: number, toId: number): FriendRow {
  if (fromId === toId) throw new Error('Cannot friend yourself');
  const [u, p] = pair(fromId, toId);
  const existing = friendshipBetween(fromId, toId);
  if (existing?.status === 'accepted') throw new Error('Already friends');
  if (existing?.status === 'pending') throw new Error('Request already pending');
  const t = now();
  const r = q('INSERT INTO friendships (user_id, peer_id, status, requested_by, created_at, updated_at) VALUES (?,?,?,?,?,?) RETURNING *')
    .get(u, p, 'pending', fromId, t, t) as unknown as FriendRow;
  return r;
}
export function respondFriend(userId: number, peerId: number, accept: boolean): FriendRow | null {
  const row = friendshipBetween(userId, peerId);
  if (!row || row.status !== 'pending') return null;
  if (row.requested_by === userId) throw new Error('Cannot respond to your own request');
  if (!accept) {
    q('DELETE FROM friendships WHERE id = ?').run(row.id);
    return { ...row, status: 'pending' };
  }
  q("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?").run(now(), row.id);
  return q('SELECT * FROM friendships WHERE id = ?').get(row.id) as unknown as FriendRow;
}
export function removeFriend(userId: number, peerId: number): boolean {
  const row = friendshipBetween(userId, peerId);
  if (!row) return false;
  q('DELETE FROM friendships WHERE id = ?').run(row.id);
  return true;
}
export function areFriends(a: number, b: number): boolean {
  const r = friendshipBetween(a, b);
  return !!r && r.status === 'accepted';
}

// ---------------- WHIP stream keys (hash only) ----------------
export function setStreamKey(roomId: string, keyHash: string, label: string) {
  q(`INSERT INTO stream_keys (room_id, key_hash, label, created_at) VALUES (?,?,?,?)
     ON CONFLICT(room_id) DO UPDATE SET key_hash = excluded.key_hash, label = excluded.label, created_at = excluded.created_at`)
    .run(roomId, keyHash, label, now());
}
export function streamKeyLabel(roomId: string): string | null {
  const row = q('SELECT label FROM stream_keys WHERE room_id = ?').get(roomId) as { label: string } | undefined;
  return row?.label ?? null;
}
/** Compare a bearer token to the stored hash. Never log `key`. */
export function streamKeyMatches(roomId: string, key: string): { label: string } | null {
  if (!key) return null;
  const row = q('SELECT key_hash, label FROM stream_keys WHERE room_id = ?').get(roomId) as { key_hash: string; label: string } | undefined;
  if (!row) return null;
  const got = createHash('sha256').update(key).digest();
  let exp: Buffer;
  try { exp = Buffer.from(row.key_hash, 'hex'); } catch { return null; }
  if (exp.length !== got.length || !timingSafeEqual(got, exp)) return null;
  return { label: row.label };
}
export function hashStreamKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
/** Match a raw stream name against every stored key hash. Never log `key`. */
export function roomForStreamKey(key: string): { roomId: string; label: string } | null {
  if (typeof key !== 'string' || !key || key.length > 256) return null;
  const got = createHash('sha256').update(key).digest();
  const rows = q('SELECT room_id, key_hash, label FROM stream_keys').all() as { room_id: string; key_hash: string; label: string }[];
  let found: { roomId: string; label: string } | null = null;
  for (const row of rows) {
    const exp = Buffer.from(row.key_hash, 'hex');
    if (exp.length === got.length && timingSafeEqual(got, exp)) found = { roomId: row.room_id, label: row.label };
  }
  return found;
}

// ---------------- user-owned chat bots (hash only) ----------------
export interface BotRow {
  id: number;
  owner_user_id: number;
  name: string;
  name_lower: string;
  token_hash: string | null;
  created_at: number;
}
export interface BotPublic { id: number; name: string; createdAt: number; revoked: boolean }

export function createBot(ownerUserId: number, name: string, tokenHash: string): BotRow {
  return q('INSERT INTO bots (owner_user_id, name, name_lower, token_hash, created_at) VALUES (?,?,?,?,?) RETURNING *')
    .get(ownerUserId, name, name.toLowerCase(), tokenHash, now()) as unknown as BotRow;
}
export function countBots(ownerUserId: number): number {
  return (q('SELECT COUNT(*) AS n FROM bots WHERE owner_user_id = ?').get(ownerUserId) as { n: number }).n;
}
export function listBots(ownerUserId: number): BotPublic[] {
  const rows = q('SELECT id, name, created_at, token_hash FROM bots WHERE owner_user_id = ? ORDER BY created_at, id').all(ownerUserId) as { id: number; name: string; created_at: number; token_hash: string | null }[];
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, revoked: !r.token_hash }));
}
export function botOwned(id: number, ownerUserId: number): BotRow | undefined {
  return q('SELECT * FROM bots WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId) as unknown as BotRow | undefined;
}
export function botByName(name: string): BotRow | undefined {
  return q('SELECT * FROM bots WHERE name_lower = ?').get(name.toLowerCase()) as unknown as BotRow | undefined;
}
export function setBotToken(id: number, ownerUserId: number, tokenHash: string | null): boolean {
  return q('UPDATE bots SET token_hash = ? WHERE id = ? AND owner_user_id = ?').run(tokenHash, id, ownerUserId).changes > 0;
}
export function deleteOwnedBot(id: number, ownerUserId: number): boolean {
  return tx(() => {
    const wasMod = moderatorBotId() === id;
    const deleted = q('DELETE FROM bots WHERE id = ? AND owner_user_id = ?').run(id, ownerUserId).changes > 0;
    if (deleted && wasMod) setModeratorBotId(null);
    return deleted;
  });
}
export function botById(id: number): BotRow | undefined {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return q('SELECT * FROM bots WHERE id = ?').get(id) as unknown as BotRow | undefined;
}
export function listAllBots(): { id: number; name: string }[] {
  return q('SELECT id, name FROM bots ORDER BY name COLLATE NOCASE, id').all() as { id: number; name: string }[];
}

const MODERATOR_BOT_KEY = 'moderator_bot_id';
/** The one bot allowed to moderate, or null. Read on every action so a change applies immediately. */
export function moderatorBotId(): number | null {
  const row = q('SELECT value FROM site_settings WHERE key = ?').get(MODERATOR_BOT_KEY) as { value: string | null } | undefined;
  if (!row?.value) return null;
  const id = Number(row.value);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!q('SELECT 1 FROM bots WHERE id = ?').get(id)) return null;
  return id;
}
/** Pass null to clear. Replaces any previous bot, so only one can hold the role. */
export function setModeratorBotId(botId: number | null) {
  if (botId == null) {
    q('DELETE FROM site_settings WHERE key = ?').run(MODERATOR_BOT_KEY);
    return;
  }
  q('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(MODERATOR_BOT_KEY, String(botId));
}
/** Lift every active site ban tied to this account (account row, and IP/device rows labeled with the username). */
export function liftBansForAccount(userId: number, username: string, by: string): number {
  const t = now();
  return Number(q(`UPDATE bans SET lifted_at = ?, lifted_by = ? WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    AND ((kind = 'account' AND value = ?) OR label = ?)`).run(t, by, t, String(userId), username).changes);
}
export function activeBanById(id: number): { id: number; kind: BanKind; value: string; label: string | null } | undefined {
  return q(`SELECT id, kind, value, label FROM bans WHERE id = ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
    .get(id, now()) as { id: number; kind: BanKind; value: string; label: string | null } | undefined;
}
/** Remove active room bans for this account key or nick so they can rejoin. */
export function liftRoomBans(roomId: string, key: string, nick: string): number {
  return Number(q(`DELETE FROM room_bans WHERE room_id = ? AND (expires_at IS NULL OR expires_at > ?) AND (user_key = ? OR lower(nick) = lower(?))`)
    .run(roomId, now(), key, nick).changes);
}
export function recentMessagesAll(n: number): MsgRow[] {
  const rows = q('SELECT * FROM messages WHERE deleted = 0 ORDER BY ts DESC, rowid DESC LIMIT ?').all(n) as unknown as MsgRow[];
  return rows.reverse();
}
/** Messages at or after `since`, oldest first. Pass a room id to stay in one room. */
export function messagesSince(since: number, n: number, roomId?: string): MsgRow[] {
  if (roomId) {
    return q('SELECT * FROM messages WHERE room_id = ? AND deleted = 0 AND ts >= ? ORDER BY ts ASC, rowid ASC LIMIT ?').all(roomId, since, n) as unknown as MsgRow[];
  }
  return q('SELECT * FROM messages WHERE deleted = 0 AND ts >= ? ORDER BY ts ASC, rowid ASC LIMIT ?').all(since, n) as unknown as MsgRow[];
}
/** Compare a bearer token to stored hashes. Never log `token`. */
export function botByToken(token: string): BotRow | null {
  if (typeof token !== 'string' || !token || token.length > 200) return null;
  const got = createHash('sha256').update(token).digest();
  const rows = q('SELECT * FROM bots WHERE token_hash IS NOT NULL').all() as unknown as BotRow[];
  let found: BotRow | null = null;
  for (const row of rows) {
    if (!row.token_hash) continue;
    const exp = Buffer.from(row.token_hash, 'hex');
    if (exp.length === got.length && timingSafeEqual(got, exp)) found = row;
  }
  return found;
}
export function allowBot(roomId: string, botId: number) {
  q('INSERT INTO room_bots (room_id, bot_id, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING')
    .run(roomId, botId, now());
}
export function removeBotAllow(roomId: string, botId: number) {
  q('DELETE FROM room_bots WHERE room_id = ? AND bot_id = ?').run(roomId, botId);
}
export function botAllowed(roomId: string, botId: number): boolean {
  return !!q('SELECT 1 FROM room_bots WHERE room_id = ? AND bot_id = ?').get(roomId, botId);
}
/** Persisted bot room joins (migration 36), so a restart does not drop a bot from its rooms. */
export function rememberBotJoin(botId: number, roomId: string) {
  q('INSERT INTO bot_room_joins (bot_id, room_id, joined_at) VALUES (?,?,?) ON CONFLICT DO NOTHING').run(botId, roomId, now());
}
export function forgetBotJoin(botId: number, roomId?: string) {
  if (roomId === undefined) q('DELETE FROM bot_room_joins WHERE bot_id = ?').run(botId);
  else q('DELETE FROM bot_room_joins WHERE bot_id = ? AND room_id = ?').run(botId, roomId);
}
export function botJoinRemembered(botId: number, roomId: string): boolean {
  return !!q('SELECT 1 FROM bot_room_joins WHERE bot_id = ? AND room_id = ?').get(botId, roomId);
}
export function rememberedBotJoins(): { bot_id: number; room_id: string; name: string | null }[] {
  return q(`SELECT j.bot_id AS bot_id, j.room_id AS room_id, b.name AS name FROM bot_room_joins j
    LEFT JOIN bots b ON b.id = j.bot_id ORDER BY j.joined_at`).all() as { bot_id: number; room_id: string; name: string | null }[];
}
export function botsAllowed(roomId: string): { id: number; name: string }[] {
  return q(`SELECT b.id AS id, b.name AS name FROM room_bots rb JOIN bots b ON b.id = rb.bot_id
    WHERE rb.room_id = ? ORDER BY b.name`).all(roomId) as { id: number; name: string }[];
}

// ---------------- password resets ----------------
export function createPasswordReset(userId: number, tokenHash: string, createdBy: string | null, ttlMin: number): number {
  q('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(userId);
  const r = q('INSERT INTO password_resets (user_id, token_hash, created_by, created_at, expires_at) VALUES (?,?,?,?,?) RETURNING id')
    .get(userId, tokenHash, createdBy, now(), now() + ttlMin * 60_000) as { id: number };
  return r.id;
}
export function createEmailToken(userId: number, emailLower: string, tokenHash: string, codeHash: string, ttlMin: number): number {
  q('DELETE FROM email_tokens WHERE user_id = ? AND used_at IS NULL').run(userId);
  const r = q('INSERT INTO email_tokens (user_id, email_lower, token_hash, code_hash, created_at, expires_at) VALUES (?,?,?,?,?,?) RETURNING id')
    .get(userId, emailLower, tokenHash, codeHash, now(), now() + ttlMin * 60_000) as { id: number };
  return r.id;
}
/** Single-use. A 6-digit code is accepted only when exactly one live token matches. */
export function consumeEmailToken(hash: string): { userId: number; emailLower: string } | null {
  const rows = q('SELECT id, user_id, email_lower FROM email_tokens WHERE used_at IS NULL AND expires_at > ? AND (token_hash = ? OR code_hash = ?)')
    .all(now(), hash, hash) as { id: number; user_id: number; email_lower: string }[];
  if (rows.length !== 1) return null;
  const r = rows[0];
  q('UPDATE email_tokens SET used_at = ? WHERE id = ?').run(now(), r.id);
  return { userId: r.user_id, emailLower: r.email_lower };
}

export function consumePasswordReset(tokenHash: string): number | null {
  const r = q('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .get(tokenHash, now()) as { id: number; user_id: number } | undefined;
  if (!r) return null;
  q('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now(), r.id);
  return r.user_id;
}

// ---------------- maintenance ----------------
export function prune(): { messages: number; sessions: number } {
  return tx(() => {
    const messages = q(`DELETE FROM messages WHERE id IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY ts DESC, rowid DESC) AS rn FROM messages) WHERE rn > ?)`).run(LIMITS.historySize).changes as number;
    const sessions = q('DELETE FROM sessions WHERE expires_at < ?').run(now()).changes as number;
    q('DELETE FROM mutes WHERE expires_at < ?').run(now() - 86400_000);
    q('DELETE FROM room_bans WHERE expires_at IS NOT NULL AND expires_at < ?').run(now() - 86400_000);
    q('DELETE FROM mod_log WHERE ts < ?').run(now() - 365 * 86400_000);
    q('DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL').run(now() - 86400_000);
    q('DELETE FROM email_tokens WHERE expires_at < ? OR used_at IS NOT NULL').run(now() - 86400_000);
    return { messages, sessions };
  });
}

// ---------------- burn-after-reading ----------------
/** First reveal time for this viewer; records `now` if this is the first. */
export function burnFirstView(messageId: string, viewerKey: string, at: number): number {
  q('INSERT OR IGNORE INTO burn_views (message_id, viewer_key, first_at) VALUES (?,?,?)').run(messageId, viewerKey, at);
  return (q('SELECT first_at FROM burn_views WHERE message_id = ? AND viewer_key = ?').get(messageId, viewerKey) as { first_at: number }).first_at;
}
export function burnViews(messageId: string): Map<string, number> {
  const rows = q('SELECT viewer_key, first_at FROM burn_views WHERE message_id = ?').all(messageId) as unknown as { viewer_key: string; first_at: number }[];
  return new Map(rows.map((r) => [r.viewer_key, r.first_at]));
}
/** Burn messages whose content still exists. */
export function liveBurnMessages(): MsgRow[] {
  return q('SELECT * FROM messages WHERE burn_ttl IS NOT NULL AND burned_at IS NULL').all() as unknown as MsgRow[];
}
/** Wipe the content for good; the row stays so history can show "Burned". */
export function burnMessage(id: string, at: number) {
  q("UPDATE messages SET text = '', burned_at = ? WHERE id = ? AND burned_at IS NULL").run(at, id);
  q('DELETE FROM burn_views WHERE message_id = ?').run(id);
  q('DELETE FROM message_pins WHERE message_id = ?').run(id);
  q('DELETE FROM message_reactions WHERE message_id = ?').run(id);
}

// ---------------- voice notes ----------------
export interface VoiceRow {
  id: string; room_id: string; message_id: string | null; mime: string; ext: string; bytes: number;
  uploader_user_id: number | null; uploader_devices: string; created_at: number;
}
export function insertVoiceNote(r: Omit<VoiceRow, 'message_id'>) {
  q('INSERT INTO voice_notes (id, room_id, message_id, mime, ext, bytes, uploader_user_id, uploader_devices, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.room_id, null, r.mime, r.ext, r.bytes, r.uploader_user_id, r.uploader_devices, r.created_at);
}
export function voiceNoteById(id: string): VoiceRow | undefined {
  return q('SELECT * FROM voice_notes WHERE id = ?').get(id) as VoiceRow | undefined;
}
/** Attach an unclaimed upload to its chat message. False if already claimed. */
export function claimVoiceNote(id: string, messageId: string): boolean {
  return q('UPDATE voice_notes SET message_id = ? WHERE id = ? AND message_id IS NULL').run(messageId, id).changes > 0;
}
export function voiceNotesForMessages(ids: string[]): VoiceRow[] {
  if (!ids.length) return [];
  return q(`SELECT * FROM voice_notes WHERE message_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as VoiceRow[];
}
export function voiceNotesForRoom(roomId: string): VoiceRow[] {
  return q('SELECT * FROM voice_notes WHERE room_id = ?').all(roomId) as unknown as VoiceRow[];
}
/** Unclaimed uploads older than the cutoff, and notes whose message was deleted, pruned or cascaded away. */
export function orphanVoiceNotes(unclaimedBefore: number): VoiceRow[] {
  // batch W4: a whisper voice note belongs to a dm_messages row instead
  return q(`SELECT v.* FROM voice_notes v LEFT JOIN messages m ON m.id = v.message_id LEFT JOIN dm_messages d ON d.id = v.message_id
    WHERE (v.message_id IS NULL AND v.created_at < ?) OR (v.message_id IS NOT NULL AND (m.id IS NULL OR m.deleted = 1) AND (d.id IS NULL OR d.deleted_at IS NOT NULL))`).all(unclaimedBefore) as unknown as VoiceRow[];
}
export function deleteVoiceNoteRow(id: string) { q('DELETE FROM voice_notes WHERE id = ?').run(id); }

// ---------------- chat images (tracked since migration 17) ----------------
export interface ChatImageRow {
  name: string; room_id: string; message_id: string | null;
  uploader_user_id: number | null; uploader_devices: string; created_at: number;
}
export function insertChatImage(r: Omit<ChatImageRow, 'message_id'>) {
  q('INSERT INTO chat_images (name, room_id, message_id, uploader_user_id, uploader_devices, created_at) VALUES (?,?,?,?,?,?)')
    .run(r.name, r.room_id, null, r.uploader_user_id, r.uploader_devices, r.created_at);
}
export function chatImageByName(name: string): ChatImageRow | undefined {
  return q('SELECT * FROM chat_images WHERE name = ?').get(name) as ChatImageRow | undefined;
}
export function claimChatImage(name: string, messageId: string): boolean {
  return q('UPDATE chat_images SET message_id = ? WHERE name = ? AND message_id IS NULL').run(messageId, name).changes > 0;
}
export function chatImagesForMessages(ids: string[]): ChatImageRow[] {
  if (!ids.length) return [];
  return q(`SELECT * FROM chat_images WHERE message_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as ChatImageRow[];
}
export function chatImagesForRoom(roomId: string): ChatImageRow[] {
  return q('SELECT * FROM chat_images WHERE room_id = ?').all(roomId) as unknown as ChatImageRow[];
}
export function orphanChatImages(unclaimedBefore: number): ChatImageRow[] {
  return q(`SELECT c.* FROM chat_images c LEFT JOIN messages m ON m.id = c.message_id
    WHERE (c.message_id IS NULL AND c.created_at < ?) OR (c.message_id IS NOT NULL AND (m.id IS NULL OR m.deleted = 1))`).all(unclaimedBefore) as unknown as ChatImageRow[];
}
export function deleteChatImageRow(name: string) { q('DELETE FROM chat_images WHERE name = ?').run(name); }

// ---------------- trivia leaderboard ----------------
export interface TriviaBoardRow { user_id: number; username: string; points: number; rounds: number; wins: number }
/** Add one finished round's results for registered players. */
export function recordTriviaRound(roomId: string, results: { userId: number; points: number; won: boolean }[]) {
  if (!results.length) return;
  tx(() => {
    const up = q(`INSERT INTO trivia_scores (room_id, user_id, points, rounds, wins, updated_at) VALUES (?,?,?,1,?,?)
      ON CONFLICT(room_id, user_id) DO UPDATE SET points = points + excluded.points, rounds = rounds + 1, wins = wins + excluded.wins, updated_at = excluded.updated_at`);
    for (const r of results) up.run(roomId, r.userId, Math.max(0, Math.round(r.points)), r.won ? 1 : 0, now());
  });
}
export function triviaTop(roomId: string, n: number): TriviaBoardRow[] {
  return q(`SELECT t.user_id, u.username, t.points, t.rounds, t.wins FROM trivia_scores t JOIN users u ON u.id = t.user_id
    WHERE t.room_id = ? ORDER BY t.points DESC, t.wins DESC, t.updated_at ASC LIMIT ?`).all(roomId, n) as unknown as TriviaBoardRow[];
}

// ---------------- badges (cosmetic) ----------------
/** One UPSERT; returns the new value. */
export function bumpStat(userId: number, stat: string, delta = 1): number {
  const r = q('INSERT INTO user_stats (user_id, stat, value) VALUES (?,?,?) ON CONFLICT(user_id, stat) DO UPDATE SET value = value + excluded.value RETURNING value')
    .get(userId, stat, delta) as { value: number };
  return r.value;
}
/** Set an absolute value; returns the previous one. */
export function setStat(userId: number, stat: string, value: number): number {
  const prev = (q('SELECT value FROM user_stats WHERE user_id = ? AND stat = ?').get(userId, stat) as { value: number } | undefined)?.value ?? 0;
  q('INSERT INTO user_stats (user_id, stat, value) VALUES (?,?,?) ON CONFLICT(user_id, stat) DO UPDATE SET value = excluded.value').run(userId, stat, value);
  return prev;
}
export function statsFor(userId: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of q('SELECT stat, value FROM user_stats WHERE user_id = ?').all(userId) as { stat: string; value: number }[]) out[r.stat] = r.value;
  return out;
}
/** True only the first time. */
export function awardBadge(userId: number, badge: string, at = now()): boolean {
  return Number(q('INSERT OR IGNORE INTO user_badges (user_id, badge, earned_at) VALUES (?,?,?)').run(userId, badge, at).changes) > 0;
}
/** Newest first. */
export function badgesFor(userId: number): { id: string; earnedAt: number }[] {
  return (q('SELECT badge, earned_at FROM user_badges WHERE user_id = ? ORDER BY earned_at DESC, badge').all(userId) as { badge: string; earned_at: number }[])
    .map((r) => ({ id: r.badge, earnedAt: r.earned_at }));
}
export function shownBadgeChoice(userId: number): string[] | null {
  const r = q('SELECT shown_badges FROM users WHERE id = ?').get(userId) as { shown_badges: string | null } | undefined;
  if (!r?.shown_badges) return null;
  try { const v = JSON.parse(r.shown_badges); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null; } catch { return null; }
}
export function setShownBadges(userId: number, ids: string[] | null) {
  q('UPDATE users SET shown_badges = ? WHERE id = ?').run(ids ? JSON.stringify(ids) : null, userId);
}
export function friendCount(userId: number): number {
  return (q("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (user_id = ? OR peer_id = ?)").get(userId, userId) as { n: number }).n;
}
