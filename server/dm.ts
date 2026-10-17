/**
 * batch W: private conversations (1:1 and named groups of 3-10). Account-only, participants-only.
 * Staff never browse these; the only way a moderator sees a line is a participant's report (an excerpt they consented to send).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { q, tx } from './db';
import { DATA_DIR } from './env';
import { voiceFilePath } from './voiceNotes';
import * as repo from './repo';
import { DM, DM_FILE_TYPES, type DmConvo, type DmFileInfo, type DmMember, type DmMessage, type DmPolicy } from '../shared/dm';

export const DM_FILE_DIR = path.join(DATA_DIR, 'dm-files');
fs.mkdirSync(DM_FILE_DIR, { recursive: true, mode: 0o750 });
const now = () => Date.now();

export interface ConvoRow { id: string; kind: 'direct' | 'group'; name: string | null; created_by: number; created_at: number; last_ts: number; disappear_sec: number; direct_key: string | null }
export interface MemberRow { convo_id: string; user_id: number; joined_at: number; left_at: number | null; state: 'active' | 'request' | 'declined'; pinned: number; archived: number; read_ts: number }
export interface MsgRow { id: string; convo_id: string; ts: number; from_user_id: number | null; text: string; kind: DmMessage['kind']; reply_to: string | null; edited_at: number | null; deleted_at: number | null; file_id: string | null; voice_id: string | null; voice_ms: number | null; expires_at: number | null }
export interface FileRow { id: string; convo_id: string; uploader_id: number; name: string; mime: string; bytes: number; width: number | null; height: number | null; created_at: number; message_id: string | null }

export const convoById = (id: string) => q('SELECT * FROM dm_convos WHERE id = ?').get(id) as ConvoRow | undefined;
export const memberRow = (convoId: string, userId: number) => q('SELECT * FROM dm_members WHERE convo_id = ? AND user_id = ?').get(convoId, userId) as MemberRow | undefined;
export const membersOf = (convoId: string) => q('SELECT * FROM dm_members WHERE convo_id = ? ORDER BY joined_at').all(convoId) as unknown as MemberRow[];
/** Current participants (not left). */
export const activeMemberIds = (convoId: string) => membersOf(convoId).filter((m) => m.left_at == null).map((m) => m.user_id);
export const isParticipant = (convoId: string, userId: number) => { const m = memberRow(convoId, userId); return !!m && m.left_at == null; };
export const directKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
export const directBetween = (a: number, b: number) => q('SELECT * FROM dm_convos WHERE direct_key = ?').get(directKey(a, b)) as ConvoRow | undefined;

export function createConvo(kind: 'direct' | 'group', createdBy: number, others: number[], name: string | null, stateFor: (uid: number) => MemberRow['state']): ConvoRow {
  const id = randomUUID();
  const t = now();
  return tx(() => {
    q('INSERT INTO dm_convos (id, kind, name, created_by, created_at, last_ts, disappear_sec, direct_key) VALUES (?,?,?,?,?,?,0,?)')
      .run(id, kind, name, createdBy, t, t, kind === 'direct' ? directKey(createdBy, others[0]) : null);
    q('INSERT INTO dm_members (convo_id, user_id, joined_at, state) VALUES (?,?,?,?)').run(id, createdBy, t, 'active');
    for (const u of others) q('INSERT INTO dm_members (convo_id, user_id, joined_at, state) VALUES (?,?,?,?)').run(id, u, t, stateFor(u));
    return convoById(id)!;
  });
}
export function addMember(convoId: string, userId: number, state: MemberRow['state'] = 'active') {
  q(`INSERT INTO dm_members (convo_id, user_id, joined_at, state) VALUES (?,?,?,?)
     ON CONFLICT(convo_id, user_id) DO UPDATE SET left_at = NULL, joined_at = excluded.joined_at, state = excluded.state, archived = 0`).run(convoId, userId, now(), state);
}
export const markLeft = (convoId: string, userId: number) => q('UPDATE dm_members SET left_at = ? WHERE convo_id = ? AND user_id = ?').run(now(), convoId, userId);
export const setState = (convoId: string, userId: number, state: MemberRow['state']) => q('UPDATE dm_members SET state = ? WHERE convo_id = ? AND user_id = ?').run(state, convoId, userId);
export const setName = (convoId: string, name: string) => q('UPDATE dm_convos SET name = ? WHERE id = ?').run(name, convoId);
export const setCreator = (convoId: string, userId: number) => q('UPDATE dm_convos SET created_by = ? WHERE id = ?').run(userId, convoId);
export const setDisappear = (convoId: string, sec: number) => q('UPDATE dm_convos SET disappear_sec = ? WHERE id = ?').run(sec, convoId);
export const setPinned = (convoId: string, userId: number, on: boolean) => q('UPDATE dm_members SET pinned = ? WHERE convo_id = ? AND user_id = ?').run(on ? 1 : 0, convoId, userId);
export const setArchived = (convoId: string, userId: number, on: boolean) => q('UPDATE dm_members SET archived = ? WHERE convo_id = ? AND user_id = ?').run(on ? 1 : 0, convoId, userId);
export const markRead = (convoId: string, userId: number, ts: number) => q('UPDATE dm_members SET read_ts = MAX(read_ts, ?) WHERE convo_id = ? AND user_id = ?').run(ts, convoId, userId);

export function insertMessage(m: Omit<MsgRow, 'edited_at' | 'deleted_at'>) {
  tx(() => {
    q(`INSERT INTO dm_messages (id, convo_id, ts, from_user_id, text, kind, reply_to, file_id, voice_id, voice_ms, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(m.id, m.convo_id, m.ts, m.from_user_id, m.text, m.kind, m.reply_to, m.file_id, m.voice_id, m.voice_ms, m.expires_at);
    q('UPDATE dm_convos SET last_ts = ? WHERE id = ?').run(m.ts, m.convo_id);
    // a new message brings an archived conversation back for everyone in it (batch W8)
    q('UPDATE dm_members SET archived = 0 WHERE convo_id = ? AND left_at IS NULL').run(m.convo_id);
  });
}
export const msgById = (id: string) => q('SELECT * FROM dm_messages WHERE id = ?').get(id) as MsgRow | undefined;
export const editMessage = (id: string, text: string) => q('UPDATE dm_messages SET text = ?, edited_at = ? WHERE id = ?').run(text, now(), id);
/** Soft delete: the line stays as "message deleted"; its text, file and voice go. */
export function deleteMessage(id: string) {
  const m = msgById(id);
  if (!m) return;
  q("UPDATE dm_messages SET text = '', deleted_at = ?, file_id = NULL, voice_id = NULL WHERE id = ?").run(now(), id);
  q('DELETE FROM dm_reactions WHERE message_id = ?').run(id);
  if (m.file_id) removeFile(m.file_id);
  if (m.voice_id) removeVoice(m.voice_id);
}

export function pageOf(convoId: string, sinceTs: number, before: number | null, limit: number = DM.pageSize): MsgRow[] {
  const rows = q(`SELECT * FROM dm_messages WHERE convo_id = ? AND ts >= ? AND ts < ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY ts DESC LIMIT ?`)
    .all(convoId, sinceTs, before ?? 1e15, now(), limit) as unknown as MsgRow[];
  return rows.reverse();
}
export function reactionsFor(ids: string[]): Map<string, { emoji: string; user_id: number }[]> {
  const out = new Map<string, { emoji: string; user_id: number }[]>();
  if (!ids.length) return out;
  for (const r of q(`SELECT message_id, emoji, user_id FROM dm_reactions WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`).all(...ids) as { message_id: string; emoji: string; user_id: number }[]) {
    const a = out.get(r.message_id) ?? []; a.push(r); out.set(r.message_id, a);
  }
  return out;
}
export function toggleReaction(messageId: string, userId: number, emoji: string): boolean {
  const had = q('DELETE FROM dm_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, emoji).changes > 0;
  if (!had) {
    const n = (q('SELECT COUNT(DISTINCT emoji) AS n FROM dm_reactions WHERE message_id = ?').get(messageId) as { n: number }).n;
    if (n >= 12) return false;
    q('INSERT INTO dm_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)').run(messageId, userId, emoji, now());
  }
  return true;
}
export const fileById = (id: string) => q('SELECT * FROM dm_files WHERE id = ?').get(id) as FileRow | undefined;
export const claimFile = (id: string, messageId: string) => q('UPDATE dm_files SET message_id = ? WHERE id = ? AND message_id IS NULL').run(messageId, id).changes > 0;
export const filePath = (id: string) => (/^[A-Za-z0-9_-]{16,40}$/.test(id) ? path.join(DM_FILE_DIR, id) : null);

function removeFile(id: string) {
  const f = filePath(id);
  if (f) { try { fs.unlinkSync(f); } catch { /* gone */ } }
  q('DELETE FROM dm_files WHERE id = ?').run(id);
}
function removeVoice(id: string) {
  const v = repo.voiceNoteById(id);
  if (!v) return;
  const f = voiceFilePath(v.id, v.ext);
  if (f) { try { fs.unlinkSync(f); } catch { /* gone */ } }
  repo.deleteVoiceNoteRow(v.id);
}
/** Remove messages (and their files/voice) for good: disappearing timers, retention, account deletion. */
function purge(rows: { id: string; file_id: string | null; voice_id: string | null }[]) {
  for (const r of rows) {
    if (r.file_id) removeFile(r.file_id);
    if (r.voice_id) removeVoice(r.voice_id);
    q('DELETE FROM dm_reactions WHERE message_id = ?').run(r.id);
    q('DELETE FROM dm_messages WHERE id = ?').run(r.id);
  }
  return rows.length;
}
/** Disappearing messages past their time, plus everything older than the whisper retention. Returns ids per convo. */
export function sweep(keepMs: number = DM.keepMs): Map<string, string[]> {
  const t = now();
  const rows = q('SELECT id, convo_id, file_id, voice_id FROM dm_messages WHERE (expires_at IS NOT NULL AND expires_at <= ?) OR ts < ?').all(t, t - keepMs) as { id: string; convo_id: string; file_id: string | null; voice_id: string | null }[];
  const by = new Map<string, string[]>();
  for (const r of rows) { const a = by.get(r.convo_id) ?? []; a.push(r.id); by.set(r.convo_id, a); }
  purge(rows);
  // uploads never sent within an hour
  for (const f of q('SELECT id FROM dm_files WHERE message_id IS NULL AND created_at < ?').all(t - 3600_000) as { id: string }[]) removeFile(f.id);
  return by;
}
/** Account deletion: their lines go; conversations with nobody left go too. */
export function forgetUser(userId: number) {
  purge(q('SELECT id, file_id, voice_id FROM dm_messages WHERE from_user_id = ?').all(userId) as { id: string; file_id: string | null; voice_id: string | null }[]);
  q('DELETE FROM dm_reactions WHERE user_id = ?').run(userId);
  q('UPDATE dm_members SET left_at = COALESCE(left_at, ?) WHERE user_id = ?').run(now(), userId);
  for (const c of q('SELECT c.id FROM dm_convos c WHERE NOT EXISTS (SELECT 1 FROM dm_members m WHERE m.convo_id = c.id AND m.left_at IS NULL)').all() as { id: string }[]) {
    purge(q('SELECT id, file_id, voice_id FROM dm_messages WHERE convo_id = ?').all(c.id) as { id: string; file_id: string | null; voice_id: string | null }[]);
  }
}

// ---------- files ----------
function sniffMime(buf: Buffer, claimed: string): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4) return 'application/zip';
  if (buf.length >= 3 && (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (claimed === 'text/plain' && !buf.subarray(0, 4096).includes(0)) return 'text/plain';
  return null;
}
export function cleanFileName(raw: unknown): string {
  const s = String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return s || 'file';
}
/** Validate type and size; re-encode images (drops EXIF/GPS and any trailing data). */
export async function storeFile(convoId: string, uploaderId: number, buf: Buffer, claimedMime: string, name: string): Promise<FileRow> {
  if (buf.length === 0) throw new Error('Empty file');
  if (buf.length > DM.fileMaxBytes) throw new Error(`Files can be up to ${DM.fileMaxBytes / 1024 / 1024} MB`);
  const mime = sniffMime(buf, claimedMime);
  if (!mime || !(mime in DM_FILE_TYPES)) throw new Error('That file type is not allowed (images, PDF, text, zip, MP3/Ogg audio, MP4 video)');
  let out = buf; let width: number | null = null; let height: number | null = null; let finalMime = mime; let finalName = cleanFileName(name);
  if (DM_FILE_TYPES[mime] === 'image') {
    const animated = mime === 'image/gif';
    const img = sharp(buf, { animated, limitInputPixels: 40_000_000 }).rotate();
    const resized = img.resize({ width: DM.imageMaxEdge, height: DM.imageMaxEdge, fit: 'inside', withoutEnlargement: true });
    // sharp writes no metadata unless asked (.withMetadata), so EXIF/GPS/comments are gone
    if (animated) { out = await resized.gif().toBuffer(); finalMime = 'image/gif'; }
    else { out = await resized.webp({ quality: 85 }).toBuffer(); finalMime = 'image/webp'; finalName = finalName.replace(/\.(jpe?g|png|webp)$/i, '') + '.webp'; }
    const meta = await sharp(out, { animated }).metadata();
    width = meta.width ?? null; height = (meta.pageHeight ?? meta.height) ?? null;
  }
  const id = randomBytes(18).toString('base64url');
  fs.writeFileSync(filePath(id)!, out, { mode: 0o640 });
  const row: FileRow = { id, convo_id: convoId, uploader_id: uploaderId, name: finalName, mime: finalMime, bytes: out.length, width, height, created_at: now(), message_id: null };
  q('INSERT INTO dm_files (id, convo_id, uploader_id, name, mime, bytes, width, height, created_at, message_id) VALUES (?,?,?,?,?,?,?,?,?,NULL)')
    .run(id, convoId, uploaderId, row.name, row.mime, row.bytes, width, height, row.created_at);
  return row;
}
export const fileInfo = (f: FileRow): DmFileInfo => ({ id: f.id, name: f.name, mime: f.mime, bytes: f.bytes, width: f.width, height: f.height, url: `/api/dm/files/${f.id}`, image: f.mime.startsWith('image/') });

// ---------- settings ----------
export function policyOf(userId: number): DmPolicy {
  const r = q('SELECT dm_policy FROM users WHERE id = ?').get(userId) as { dm_policy: string } | undefined;
  return r?.dm_policy === 'everyone' || r?.dm_policy === 'friends' ? r.dm_policy : 'requests';
}
export const setPolicy = (userId: number, p: DmPolicy) => q('UPDATE users SET dm_policy = ? WHERE id = ?').run(p, userId);
export function typingOn(userId: number): boolean {
  const r = q('SELECT dm_typing FROM users WHERE id = ?').get(userId) as { dm_typing: number } | undefined;
  return r ? r.dm_typing !== 0 : true;
}
export const setTyping = (userId: number, on: boolean) => q('UPDATE users SET dm_typing = ? WHERE id = ?').run(on ? 1 : 0, userId);

// ---------- views ----------
export function convosFor(userId: number): { c: ConvoRow; me: MemberRow }[] {
  const rows = q(`SELECT c.*, m.joined_at AS m_joined, m.left_at AS m_left, m.state AS m_state, m.pinned AS m_pinned, m.archived AS m_archived, m.read_ts AS m_read
    FROM dm_members m JOIN dm_convos c ON c.id = m.convo_id WHERE m.user_id = ? AND m.left_at IS NULL AND m.state != 'declined' ORDER BY c.last_ts DESC LIMIT 300`).all(userId) as Record<string, unknown>[];
  return rows.map((r) => ({
    c: { id: r.id, kind: r.kind, name: r.name, created_by: r.created_by, created_at: r.created_at, last_ts: r.last_ts, disappear_sec: r.disappear_sec, direct_key: r.direct_key } as ConvoRow,
    me: { convo_id: r.id as string, user_id: userId, joined_at: r.m_joined as number, left_at: r.m_left as number | null, state: r.m_state as MemberRow['state'], pinned: r.m_pinned as number, archived: r.m_archived as number, read_ts: r.m_read as number },
  }));
}
export function lastLine(convoId: string, since: number): MsgRow | undefined {
  return q('SELECT * FROM dm_messages WHERE convo_id = ? AND ts >= ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY ts DESC LIMIT 1').get(convoId, since, now()) as MsgRow | undefined;
}
export function unreadCount(convoId: string, userId: number, readTs: number, since: number): number {
  return (q(`SELECT COUNT(*) AS n FROM dm_messages WHERE convo_id = ? AND ts > ? AND ts >= ? AND deleted_at IS NULL AND (from_user_id IS NULL OR from_user_id != ?) AND kind != 'system' AND (expires_at IS NULL OR expires_at > ?)`)
    .get(convoId, readTs, since, userId, now()) as { n: number }).n;
}
export function search(userId: number, text: string, limit = 50): MsgRow[] {
  const like = `%${text.replace(/[!%_]/g, (c) => `!${c}`)}%`;
  return q(`SELECT d.* FROM dm_messages d JOIN dm_members m ON m.convo_id = d.convo_id AND m.user_id = ?
    WHERE m.left_at IS NULL AND m.state != 'declined' AND d.ts >= m.joined_at AND d.deleted_at IS NULL AND d.kind != 'system' AND d.text LIKE ? ESCAPE '!' AND (d.expires_at IS NULL OR d.expires_at > ?)
    ORDER BY d.ts DESC LIMIT ?`).all(userId, like, now(), limit) as unknown as MsgRow[];
}
export function memberView(rows: MemberRow[], convo: ConvoRow, online: (id: number) => boolean, withRead: boolean): DmMember[] {
  const users = repo.usersByIds(rows.map((r) => r.user_id));
  return rows.map((r) => {
    const u = users.get(r.user_id);
    return {
      userId: r.user_id, username: u?.username ?? 'deleted', chatColor: u?.chat_color ?? null, hasAvatar: !!u?.has_avatar,
      ...(r.left_at != null ? { left: true } : {}), online: online(r.user_id),
      ...(withRead ? { readTs: r.read_ts } : {}), ...(convo.kind === 'group' && convo.created_by === r.user_id ? { owner: true } : {}),
    };
  });
}
export function exportFor(userId: number) {
  const convos = q(`SELECT c.id, c.kind, c.name, c.created_at, m.joined_at, m.left_at FROM dm_members m JOIN dm_convos c ON c.id = m.convo_id WHERE m.user_id = ?`).all(userId) as { id: string; kind: string; name: string | null; created_at: number; joined_at: number; left_at: number | null }[];
  const out = [];
  for (const c of convos) {
    const people = (q('SELECT u.username FROM dm_members m JOIN users u ON u.id = m.user_id WHERE m.convo_id = ?').all(c.id) as { username: string }[]).map((r) => r.username);
    const lines = (q(`SELECT d.ts, d.kind, d.text, d.edited_at, u.username AS sender, f.name AS file_name, f.mime AS file_mime FROM dm_messages d
      LEFT JOIN users u ON u.id = d.from_user_id LEFT JOIN dm_files f ON f.id = d.file_id
      WHERE d.convo_id = ? AND d.ts >= ? AND d.deleted_at IS NULL ORDER BY d.ts LIMIT 20000`).all(c.id, c.joined_at) as Record<string, unknown>[])
      .map((r) => ({ at: new Date(r.ts as number).toISOString(), from: r.sender ?? null, kind: r.kind, text: r.text, ...(r.edited_at ? { edited: true } : {}), ...(r.file_name ? { file: { name: r.file_name, type: r.file_mime } } : {}) }));
    out.push({ kind: c.kind, name: c.name, people, joined: new Date(c.joined_at).toISOString(), ...(c.left_at ? { left: new Date(c.left_at).toISOString() } : {}), messages: lines });
  }
  return out;
}
