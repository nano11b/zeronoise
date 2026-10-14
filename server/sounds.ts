import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { DATA_DIR } from './env';
import * as repo from './repo';

export const SOUND_DIR = path.join(DATA_DIR, 'sounds');
fs.mkdirSync(SOUND_DIR, { recursive: true, mode: 0o750 });

export const SOUND_MAX_BYTES = 300 * 1024;
export const SOUND_MAX_CLIPS = 12;
export const SOUND_COOLDOWN_MS = 3000;

const MIME = {
  mpeg: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
} as const;
type SoundKind = keyof typeof MIME;
const EXT: Record<SoundKind, string> = { mpeg: 'mp3', ogg: 'ogg', wav: 'wav', webm: 'webm' };

/** True when `now` is outside the per-user window. `lastAt` 0 means they have not played yet. */
export function soundPlayAllowed(lastAt: number, now: number, windowMs = SOUND_COOLDOWN_MS): boolean {
  if (!lastAt) return true;
  return now - lastAt >= windowMs;
}

export function cleanSoundName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 24) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** Magic bytes only. The declared mime must match; the client type is not enough on its own. */
export function sniffSound(buf: Buffer): SoundKind | null {
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mpeg';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const head = buf.subarray(0, Math.min(buf.length, 64)).toString('binary');
    if (head.includes('webm')) return 'webm';
  }
  return null;
}

export function soundFilePath(id: string, ext: string): string | null {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return null;
  if (!['mp3', 'ogg', 'wav', 'webm'].includes(ext)) return null;
  const root = path.resolve(SOUND_DIR);
  const full = path.resolve(root, `${id}.${ext}`);
  if (full !== path.join(root, `${id}.${ext}`)) return null;
  return full;
}

export function storeSound(roomId: string, name: string, buf: Buffer, declaredMime: string): repo.SoundRow {
  if (buf.length > SOUND_MAX_BYTES) throw new Error('Sound too large (max 300 KB)');
  const kind = sniffSound(buf);
  if (!kind || MIME[kind] !== declaredMime) throw new Error('Use MP3, Ogg, WAV, or WebM');
  if (repo.countSounds(roomId) >= SOUND_MAX_CLIPS) throw new Error('This room already has 12 sounds.');
  const id = randomBytes(12).toString('base64url');
  const ext = EXT[kind];
  const file = soundFilePath(id, ext);
  if (!file) throw new Error('Could not store sound');
  fs.writeFileSync(file, buf, { mode: 0o640 });
  try {
    return repo.insertSound({ id, room_id: roomId, name, mime: MIME[kind], ext, created_at: Date.now() });
  } catch (err) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    throw err;
  }
}

export function removeSoundFile(row: { id: string; ext: string }) {
  const file = soundFilePath(row.id, row.ext);
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

export function deleteRoomSoundFiles(roomId: string) {
  for (const row of repo.listSounds(roomId)) removeSoundFile(row);
}
