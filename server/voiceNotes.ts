import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { DATA_DIR } from './env';
import * as repo from './repo';
import { sniffVoice, VOICE_EXT, VOICE_MAX_BYTES, VOICE_MIME } from '../shared/voice';

export const VOICE_DIR = path.join(DATA_DIR, 'voice');
fs.mkdirSync(VOICE_DIR, { recursive: true, mode: 0o750 });
/** Uploads that never became a message are swept after this long. */
export const VOICE_UNCLAIMED_TTL_MS = 10 * 60_000;

export function voiceFilePath(id: string, ext: string): string | null {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id) || !/^(webm|ogg|m4a)$/.test(ext)) return null;
  return path.join(VOICE_DIR, `${id}.${ext}`);
}

/** Validate (magic bytes + size) and store a recorded clip for one room. */
export function storeVoiceNote(roomId: string, buf: Buffer, uploader: { userId: number | null; devices: string[] }): repo.VoiceRow {
  if (buf.length > VOICE_MAX_BYTES) throw new Error('Voice note too large (max 1 MB)');
  const kind = sniffVoice(buf);
  if (!kind) throw new Error('Not a WebM, Ogg, or MP4 audio recording');
  const id = randomBytes(12).toString('base64url');
  const ext = VOICE_EXT[kind];
  const file = voiceFilePath(id, ext)!;
  fs.writeFileSync(file, buf, { mode: 0o640 });
  const row = {
    id, room_id: roomId, mime: VOICE_MIME[kind], ext, bytes: buf.length,
    uploader_user_id: uploader.userId, uploader_devices: JSON.stringify(uploader.devices.slice(0, 4)), created_at: Date.now(),
  };
  try { repo.insertVoiceNote(row); } catch (err) { try { fs.unlinkSync(file); } catch { /* ignore */ } throw err; }
  return { ...row, message_id: null };
}

/** Did this account/device upload the clip? */
export function isVoiceUploader(row: repo.VoiceRow, accountId: number | null, devices: string[]): boolean {
  if (row.uploader_user_id != null) return accountId === row.uploader_user_id;
  let ids: string[] = [];
  try { ids = JSON.parse(row.uploader_devices) as string[]; } catch { /* none */ }
  return !accountId && devices.some((d) => ids.includes(d));
}

function removeVoice(rows: repo.VoiceRow[]): number {
  for (const r of rows) {
    const file = voiceFilePath(r.id, r.ext);
    if (file) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
    repo.deleteVoiceNoteRow(r.id);
  }
  return rows.length;
}
export const deleteVoiceForMessages = (messageIds: string[]) => removeVoice(repo.voiceNotesForMessages(messageIds));
export const deleteVoiceForRoom = (roomId: string) => removeVoice(repo.voiceNotesForRoom(roomId));
/** Unclaimed uploads, and clips whose message is gone (deleted, purged, pruned, room removed). */
export const sweepVoiceNotes = () => removeVoice(repo.orphanVoiceNotes(Date.now() - VOICE_UNCLAIMED_TTL_MS));
