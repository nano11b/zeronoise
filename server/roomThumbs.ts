import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import { DATA_DIR } from './env';
import { ROOM_THUMB_H, ROOM_THUMB_ID_RE, ROOM_THUMB_MAX_BYTES, ROOM_THUMB_W } from '../shared/roomThumbs';

/** Mirrors avatars: DATA_DIR/room-thumbs/<random id>.webp */
export const ROOM_THUMB_DIR = path.join(DATA_DIR, 'room-thumbs');
fs.mkdirSync(ROOM_THUMB_DIR, { recursive: true, mode: 0o750 });

export const newThumbId = () => randomBytes(16).toString('hex');

export function roomThumbPath(id: string): string | null {
  if (!ROOM_THUMB_ID_RE.test(id)) return null;
  return path.join(ROOM_THUMB_DIR, `${id}.webp`);
}

export function roomThumbExists(id: string) {
  const p = roomThumbPath(id);
  if (!p) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Validate and re-encode to a 640×360 cover-cropped WebP. Animated GIF/WebP keep only the first
 * frame (static), EXIF is stripped by the re-encode.
 */
export async function processRoomThumb(buf: Buffer): Promise<Buffer> {
  if (buf.length > ROOM_THUMB_MAX_BYTES) throw new Error('Image too large (max 5 MB)');
  if (buf.length < 24) throw new Error('Not a valid image');
  try {
    const img = sharp(buf, { failOn: 'error', animated: false, limitInputPixels: 40_000_000 }).rotate();
    const meta = await img.metadata();
    if (!meta.format || !['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) throw new Error('Use PNG, JPEG, WebP or GIF');
    return await img
      .resize(ROOM_THUMB_W, ROOM_THUMB_H, { fit: 'cover', position: 'attention' })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();
  } catch (e) {
    if (e instanceof Error && /too large|Use PNG|Not a valid/.test(e.message)) throw e;
    throw new Error('Could not read image');
  }
}

export function writeRoomThumb(id: string, webp: Buffer) {
  const p = roomThumbPath(id);
  if (!p) throw new Error('bad thumb id');
  fs.writeFileSync(p, webp, { mode: 0o640 });
}

export function deleteRoomThumb(id: string | null | undefined) {
  if (!id) return;
  const p = roomThumbPath(id);
  if (!p) return;
  try { fs.unlinkSync(p); } catch { /* missing ok */ }
}

/** Remove files no room points at (crash between write and DB update, deleted rooms). */
export function sweepRoomThumbs(inUse: Set<string>): number {
  let n = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(ROOM_THUMB_DIR); } catch { return 0; }
  const cutoff = Date.now() - 10 * 60_000;
  for (const name of names) {
    const m = /^([a-f0-9]{32})\.webp$/.exec(name);
    if (!m || inUse.has(m[1])) continue;
    const p = path.join(ROOM_THUMB_DIR, name);
    try { if (fs.statSync(p).mtimeMs > cutoff) continue; fs.unlinkSync(p); n++; } catch { /* ignore */ }
  }
  return n;
}
