/**
 * Batch F6: voice-room recordings. The room owner's browser mixes the room audio (MediaRecorder, webm/opus) and
 * streams chunks here; nothing is transcoded on the server (no ffmpeg). Capped by size and time; kept for the
 * room's retention setting, then the file is removed and the row marked expired.
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { DATA_DIR } from './env';
import { q } from './db';

export const REC_DIR = path.join(DATA_DIR, 'recordings');
fs.mkdirSync(REC_DIR, { recursive: true, mode: 0o750 });
export const REC_MAX_BYTES = Math.max(64 * 1024, Number(process.env.RECORDING_MAX_BYTES) || 200 * 1024 * 1024);
export const REC_MAX_MS = Math.max(10_000, Number(process.env.RECORDING_MAX_MINUTES) * 60_000 || 120 * 60_000);
/** stop a recording whose owner went quiet (closed the tab, lost the network) */
export const REC_IDLE_MS = Math.max(5_000, Number(process.env.RECORDING_IDLE_MS) || 45_000);
export const RETENTION_CHOICES = [1, 7, 30, 90] as const;
export const DEFAULT_RETENTION_DAYS = 30;

export interface RecRow { id: string; room_id: string; started_by: number; started_nick: string; started_at: number; ended_at: number | null; last_chunk_at: number; bytes: number; status: 'recording' | 'done' | 'capped' | 'expired'; end_reason: string | null; mime: string }
export const recFile = (id: string) => (/^[a-f0-9]{24}$/.test(id) ? path.join(REC_DIR, `${id}.webm`) : null);
export const activeRec = (roomId: string) => q("SELECT * FROM room_recordings WHERE room_id = ? AND status = 'recording'").get(roomId) as unknown as RecRow | undefined;
export const recById = (id: string) => q('SELECT * FROM room_recordings WHERE id = ?').get(id) as unknown as RecRow | undefined;
export const recsOf = (roomId: string) => q('SELECT * FROM room_recordings WHERE room_id = ? ORDER BY started_at DESC LIMIT 50').all(roomId) as unknown as RecRow[];
export function startRec(roomId: string, userId: number, nick: string): RecRow {
  const id = randomBytes(12).toString('hex'); const now = Date.now();
  fs.writeFileSync(recFile(id)!, Buffer.alloc(0), { mode: 0o640 });
  q(`INSERT INTO room_recordings (id, room_id, started_by, started_nick, started_at, last_chunk_at, bytes, status, mime) VALUES (?,?,?,?,?,?,0,'recording','audio/webm')`).run(id, roomId, userId, nick, now, now);
  return recById(id)!;
}
export function endRec(id: string, status: 'done' | 'capped', reason: string) {
  q("UPDATE room_recordings SET status = ?, ended_at = ?, end_reason = ? WHERE id = ? AND status = 'recording'").run(status, Date.now(), reason, id);
}
/** Append a chunk. Returns 'ok', or why the recording ended (the chunk that crossed the cap is not kept past it). */
export function appendChunk(r: RecRow, buf: Buffer): 'ok' | 'size' | 'time' {
  const now = Date.now();
  if (now - r.started_at > REC_MAX_MS) { endRec(r.id, 'capped', 'time'); return 'time'; }
  const room = REC_MAX_BYTES - r.bytes;
  const part = buf.length > room ? buf.subarray(0, Math.max(0, room)) : buf;
  if (part.length) fs.appendFileSync(recFile(r.id)!, part);
  q('UPDATE room_recordings SET bytes = bytes + ?, last_chunk_at = ? WHERE id = ?').run(part.length, now, r.id);
  if (buf.length >= room) { endRec(r.id, 'capped', 'size'); return 'size'; }
  return 'ok';
}
export const idleRecs = () => q("SELECT * FROM room_recordings WHERE status = 'recording' AND (last_chunk_at < ? OR started_at < ?)").all(Date.now() - REC_IDLE_MS, Date.now() - REC_MAX_MS) as unknown as RecRow[];
export const retentionOf = (roomId: string) => ((q('SELECT retention_days FROM room_recording_settings WHERE room_id = ?').get(roomId) as { retention_days: number } | undefined)?.retention_days ?? DEFAULT_RETENTION_DAYS);
export function setRetention(roomId: string, days: number) {
  q('INSERT INTO room_recording_settings (room_id, retention_days) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET retention_days = excluded.retention_days').run(roomId, days);
}
/** Remove files past their room's retention (the row stays, marked expired). */
export function sweepRecordings(): number {
  const rows = q(`SELECT r.id, r.started_at, COALESCE(s.retention_days, ${DEFAULT_RETENTION_DAYS}) AS days FROM room_recordings r
    LEFT JOIN room_recording_settings s ON s.room_id = r.room_id WHERE r.status IN ('done', 'capped')`).all() as { id: string; started_at: number; days: number }[];
  let n = 0;
  for (const r of rows) {
    if (Date.now() - r.started_at < r.days * 86_400_000) continue;
    const f = recFile(r.id); if (f) fs.rmSync(f, { force: true });
    q("UPDATE room_recordings SET status = 'expired' WHERE id = ?").run(r.id); n++;
  }
  return n;
}
export const recView = (r: RecRow) => ({ id: r.id, startedAt: r.started_at, endedAt: r.ended_at, by: r.started_nick, bytes: r.bytes, status: r.status, endReason: r.end_reason });
