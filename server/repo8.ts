/** Batch D data access: XP and levels, ban appeals, two-factor sign-in, data export. */
import { createHash } from 'crypto';
import { q, tx } from './db';
import { levelFor, XP_DAILY_CAP } from '../shared/xp';
import { open, SCRUBBED, seal, secretKeySet, secretKeyTooShort } from './secretbox';

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
// batch E: `secret_enc` holds the AES-GCM sealed seed when CAMCHAT_SECRET_KEY is set (then `secret` is a scrubbed marker).
// `marker = 1` rows are not TOTP at all: they keep `enabled_at` set for passkey-only accounts so an OLDER build
// (which only knows user_totp) still demands a second step after a --keep-db rollback instead of silently skipping it.
export interface TotpRow { user_id: number; secret: string; enabled_at: number | null; last_step: number; created_at: number; secret_enc: string | null; marker: number }
const rawTotp = (userId: number) => q('SELECT * FROM user_totp WHERE user_id = ?').get(userId) as TotpRow | undefined;
/** the real TOTP enrolment (marker rows are hidden) */
export const totpOf = (userId: number) => { const t = rawTotp(userId); return t && !t.marker ? t : undefined; };
export const mfaEnabled = (userId: number) => !!totpOf(userId)?.enabled_at;
/** an enrolment waiting for its first code (a not-yet-enabled row, or a passkey marker row with a fresh secret) */
export const totpSetupRow = (userId: number) => { const t = rawTotp(userId); return t && (t.marker || !t.enabled_at) ? t : undefined; };
/** Keep the passkey marker in step: enabled while the account has passkeys but no real TOTP. */
export function syncPasskeyMarker(userId: number) {
  const t = rawTotp(userId);
  const pk = !!q('SELECT 1 AS x FROM user_passkeys WHERE user_id = ? AND removed_at IS NULL').get(userId);
  if (t && !t.marker && t.enabled_at) return; // real TOTP already makes old builds ask
  if (pk) {
    if (!t) q(`INSERT INTO user_totp (user_id, secret, enabled_at, last_step, created_at, marker) VALUES (?, ?, ?, 0, ?, 1)`).run(userId, SCRUBBED, now(), now());
    else q('UPDATE user_totp SET marker = 1, enabled_at = COALESCE(enabled_at, ?), secret = ?, secret_enc = NULL WHERE user_id = ?').run(now(), SCRUBBED, userId);
  } else if (t?.marker) q('UPDATE user_totp SET enabled_at = NULL, marker = 0 WHERE user_id = ?').run(userId);
}
/** Startup (key present): seal every plaintext seed and scrub the old column. Returns how many were sealed. */
export function sealPlaintextSecrets(): number {
  if (!secretKeySet()) return 0;
  const rows = q(`SELECT user_id, secret FROM user_totp WHERE marker = 0 AND secret_enc IS NULL AND secret <> ?`).all(SCRUBBED) as { user_id: number; secret: string }[];
  tx(() => { for (const r of rows) q('UPDATE user_totp SET secret_enc = ?, secret = ? WHERE user_id = ?').run(seal(r.secret, `totp:${r.user_id}`), SCRUBBED, r.user_id); });
  return rows.length;
}
export function secretStatus() {
  const c = (sql: string, ...a: (string | number)[]) => (q(sql).get(...a) as { n: number }).n;
  return {
    keySet: secretKeySet(), keyTooShort: secretKeyTooShort(),
    plaintext: c(`SELECT COUNT(*) AS n FROM user_totp WHERE marker = 0 AND secret_enc IS NULL AND secret <> ?`, SCRUBBED),
    encrypted: c('SELECT COUNT(*) AS n FROM user_totp WHERE marker = 0 AND secret_enc IS NOT NULL'),
    // sealed secrets but no (or a different) key: those TOTP users must use recovery codes until the key is back
    unreadable: secretKeySet() ? (q('SELECT user_id, secret_enc FROM user_totp WHERE marker = 0 AND secret_enc IS NOT NULL').all() as { user_id: number; secret_enc: string }[]).filter((r) => open(r.secret_enc, `totp:${r.user_id}`) == null).length
      : c('SELECT COUNT(*) AS n FROM user_totp WHERE marker = 0 AND secret_enc IS NOT NULL'),
  };
}
const sealFor = (userId: number, secret: string) => (secretKeySet() ? { secret: SCRUBBED, enc: seal(secret, `totp:${userId}`) } : { secret, enc: null });
/** Start (or restart) enrolment with a fresh secret. Never touches an enabled one. */
export function startTotp(userId: number, secret: string): boolean {
  const cur = totpOf(userId);
  if (cur?.enabled_at) return false;
  const s = sealFor(userId, secret);
  // a passkey marker row stays enabled (old-build safety) until this enrolment is confirmed
  q(`INSERT INTO user_totp (user_id, secret, secret_enc, enabled_at, last_step, created_at, marker) VALUES (?,?,?,NULL,0,?,0)
     ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, secret_enc = excluded.secret_enc, created_at = excluded.created_at, last_step = 0`)
    .run(userId, s.secret, s.enc, now());
  return true;
}
export function enableTotp(userId: number, step: number, codeHashes: string[]) {
  tx(() => {
    q('UPDATE user_totp SET enabled_at = ?, last_step = ?, marker = 0 WHERE user_id = ?').run(now(), step, userId);
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
  syncPasskeyMarker(userId);
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

// ---------------- passkeys (migration 43) ----------------
export interface PasskeyRow { id: number; user_id: number; cred_id: string; public_jwk: string; alg: number; sign_count: number; name: string; created_at: number; last_used_at: number | null; removed_at: number | null }
export const passkeysOf = (userId: number) => q('SELECT * FROM user_passkeys WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at').all(userId) as unknown as PasskeyRow[];
export const passkeyByCred = (credId: string) => q('SELECT * FROM user_passkeys WHERE cred_id = ? AND removed_at IS NULL').get(credId) as PasskeyRow | undefined;
export function addPasskey(userId: number, credId: string, jwk: object, alg: number, signCount: number, name: string): number {
  const id = (q('INSERT INTO user_passkeys (user_id, cred_id, public_jwk, alg, sign_count, name, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id').get(userId, credId, JSON.stringify(jwk), alg, signCount, name, now()) as { id: number }).id;
  syncPasskeyMarker(userId);
  return id;
}
export const touchPasskey = (id: number, signCount: number) => q('UPDATE user_passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?').run(signCount, now(), id);
/** removed, not deleted */
export function removePasskey(userId: number, id: number): boolean {
  const ok = Number(q('UPDATE user_passkeys SET removed_at = ? WHERE id = ? AND user_id = ? AND removed_at IS NULL').run(now(), id, userId).changes) > 0;
  if (ok) syncPasskeyMarker(userId);
  return ok;
}
export const hasPasskey = (userId: number) => !!q('SELECT 1 AS x FROM user_passkeys WHERE user_id = ? AND removed_at IS NULL').get(userId);
/** any second factor: TOTP on or at least one passkey */
export const secondFactorOn = (userId: number) => mfaEnabled(userId) || hasPasskey(userId);
/** the TOTP secret in the clear (batch E3 replaces this with the decrypting version) */
export const totpSecret = (t: TotpRow) => (t.secret_enc ? open(t.secret_enc, `totp:${t.user_id}`) ?? '' : t.secret);

// ---------------- room-ban appeals (migration 43) ----------------
export interface RoomAppealRow { id: number; room_ban_id: number; room_id: string; user_id: number; username: string; text: string; created_at: number; status: 'open' | 'approved' | 'denied'; decided_by: string | null; decided_at: number | null; decision_note: string | null }
export const roomAppealForBan = (banId: number) => q('SELECT * FROM room_ban_appeals WHERE room_ban_id = ?').get(banId) as RoomAppealRow | undefined;
export const roomAppealById = (id: number) => q('SELECT * FROM room_ban_appeals WHERE id = ?').get(id) as RoomAppealRow | undefined;
export function insertRoomAppeal(a: { banId: number; roomId: string; userId: number; username: string; text: string }): RoomAppealRow | null {
  const r = q(`INSERT INTO room_ban_appeals (room_ban_id, room_id, user_id, username, text, created_at, status) VALUES (?,?,?,?,?,?, 'open')
    ON CONFLICT(room_ban_id) DO NOTHING RETURNING id`).get(a.banId, a.roomId, a.userId, a.username, a.text, now()) as { id: number } | undefined;
  return r ? roomAppealById(r.id)! : null;
}
export function decideRoomAppeal(id: number, status: 'approved' | 'denied', by: string, note: string | null): boolean {
  return Number(q(`UPDATE room_ban_appeals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'open'`).run(status, by, now(), note, id).changes) > 0;
}
export const passkeyUsers = () => (q('SELECT DISTINCT user_id FROM user_passkeys WHERE removed_at IS NULL').all() as { user_id: number }[]).map((r) => r.user_id);

// ---------- draft sync (batch E4): one unsent draft per account, room and thread; '' = cleared ----------
export interface DraftRow { thread_id: string; text: string; updated_at: number }
export const draftsOf = (userId: number, roomId: string) =>
  q("SELECT thread_id, text, updated_at FROM user_drafts WHERE user_id = ? AND room_id = ? AND text <> '' ORDER BY updated_at DESC LIMIT 50").all(userId, roomId) as unknown as DraftRow[];
/** Last writer wins by time; returns the stored time, or null when a newer draft was already there. */
export function saveDraft(userId: number, roomId: string, threadId: string, text: string, at: number): number | null {
  const cur = q('SELECT updated_at FROM user_drafts WHERE user_id = ? AND room_id = ? AND thread_id = ?').get(userId, roomId, threadId) as { updated_at: number } | undefined;
  if (cur && cur.updated_at > at) return null;
  q(`INSERT INTO user_drafts (user_id, room_id, thread_id, text, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, room_id, thread_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`).run(userId, roomId, threadId, text, at);
  return at;
}

// ---------- room analytics for owners (batch F8): active members, peak times, growth ----------
const DAY = 86_400_000;
export interface DayPoint { day: number; active: number; chatters: number; guests: number; newMembers: number; peak: number; messages: number }
export interface RoomAnalytics {
  days: DayPoint[];
  /** [hour of day UTC 0..23, average daily peak online, highest peak] over the window */
  peakByHour: [number, number, number][];
  totals: { members: number; active7: number; activePrev7: number; growthPct: number | null; new7: number; new30: number; returning7: number; peak30: number };
}
export function roomAnalytics(roomId: string, at = Date.now(), days = 30): RoomAnalytics {
  const today = Math.floor(at / DAY); const from = today - (days - 1);
  const pts = new Map<number, DayPoint>();
  for (let d = from; d <= today; d++) pts.set(d, { day: d, active: 0, chatters: 0, guests: 0, newMembers: 0, peak: 0, messages: 0 });
  for (const r of q('SELECT day, COUNT(*) AS a, SUM(messages > 0) AS c FROM room_visitors WHERE room_id = ? AND day >= ? GROUP BY day').all(roomId, from) as { day: number; a: number; c: number }[]) {
    const p = pts.get(Number(r.day)); if (p) { p.active = Number(r.a); p.chatters = Number(r.c); }
  }
  for (const r of q('SELECT day, guests FROM room_stats_daily WHERE room_id = ? AND day >= ?').all(roomId, from) as { day: number; guests: number }[]) {
    const p = pts.get(Number(r.day)); if (p) p.guests = Number(r.guests);
  }
  for (const r of q('SELECT first AS day, COUNT(*) AS n FROM (SELECT user_id, MIN(day) AS first FROM room_visitors WHERE room_id = ? GROUP BY user_id) WHERE first >= ? GROUP BY first').all(roomId, from) as { day: number; n: number }[]) {
    const p = pts.get(Number(r.day)); if (p) p.newMembers = Number(r.n);
  }
  const hourly = q('SELECT hour, messages, peak FROM room_stats_hourly WHERE room_id = ? AND hour >= ?').all(roomId, from * 24) as { hour: number; messages: number; peak: number }[];
  const byHour = Array.from({ length: 24 }, () => ({ sum: 0, max: 0 }));
  for (const r of hourly) {
    const p = pts.get(Math.floor(Number(r.hour) / 24));
    if (p) { p.peak = Math.max(p.peak, Number(r.peak)); p.messages += Number(r.messages); }
    const h = byHour[Number(r.hour) % 24]; h.sum += Number(r.peak); h.max = Math.max(h.max, Number(r.peak));
  }
  const distinct = (a: number, b: number) => (q('SELECT COUNT(DISTINCT user_id) AS n FROM room_visitors WHERE room_id = ? AND day >= ? AND day <= ?').get(roomId, a, b) as { n: number }).n;
  const active7 = distinct(today - 6, today); const activePrev7 = distinct(today - 13, today - 7);
  const returning7 = (q(`SELECT COUNT(DISTINCT user_id) AS n FROM room_visitors WHERE room_id = ? AND day >= ? AND user_id IN
    (SELECT user_id FROM room_visitors WHERE room_id = ? AND day < ?)`).get(roomId, today - 6, roomId, today - 6) as { n: number }).n;
  const list = [...pts.values()];
  return {
    days: list,
    peakByHour: byHour.map((h, i) => [i, Math.round((h.sum / days) * 10) / 10, h.max]),
    totals: {
      members: (q('SELECT COUNT(DISTINCT user_id) AS n FROM room_visitors WHERE room_id = ?').get(roomId) as { n: number }).n,
      active7, activePrev7, growthPct: activePrev7 ? Math.round(((active7 - activePrev7) / activePrev7) * 100) : null,
      new7: list.filter((p) => p.day > today - 7).reduce((a, p) => a + p.newMembers, 0),
      new30: list.reduce((a, p) => a + p.newMembers, 0), returning7, peak30: Math.max(0, ...list.map((p) => p.peak)),
    },
  };
}
export const ownedRoomIds = (userId: number) => (q('SELECT id, name FROM rooms WHERE owner_user_id = ? AND is_private = 0 ORDER BY name_lower LIMIT 50').all(userId) as { id: string; name: string }[]);
