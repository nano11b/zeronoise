import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import { DATA_DIR } from './env';
import { EMOTE_ID_RE, EMOTE_MAX_BYTES, EMOTE_SIZE } from '../shared/batch3';

/** Mirrors room thumbnails: DATA_DIR/room-emotes/<random id>.webp */
export const EMOTE_DIR = path.join(DATA_DIR, 'room-emotes');
fs.mkdirSync(EMOTE_DIR, { recursive: true, mode: 0o750 });

export const newEmoteId = () => randomBytes(16).toString('hex');
export function emotePath(id: string): string | null {
  return EMOTE_ID_RE.test(id) ? path.join(EMOTE_DIR, `${id}.webp`) : null;
}
export function emoteFileExists(id: string) {
  const p = emotePath(id);
  if (!p) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Validate + re-encode to WebP that fits in 128×128. Animated GIF/WebP keep their animation
 * (sharp reads every frame with animated: true and writes an animated WebP); capped at 200 frames.
 */
export async function processEmote(buf: Buffer): Promise<{ webp: Buffer; animated: boolean }> {
  if (buf.length > EMOTE_MAX_BYTES) throw new Error('Image too large (max 512 KB)');
  if (buf.length < 24) throw new Error('Not a valid image');
  try {
    const probe = await sharp(buf, { failOn: 'error', animated: true, limitInputPixels: 40_000_000 }).metadata();
    if (!probe.format || !['jpeg', 'png', 'webp', 'gif'].includes(probe.format)) throw new Error('Use PNG, JPEG, WebP or GIF');
    const pages = probe.pages ?? 1;
    const animated = pages > 1 && pages <= 200 && (probe.format === 'gif' || probe.format === 'webp');
    const img = sharp(buf, { failOn: 'error', animated, limitInputPixels: 40_000_000 });
    const webp = await (animated ? img : img.rotate())
      .resize(EMOTE_SIZE, EMOTE_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
    return { webp, animated };
  } catch (e) {
    if (e instanceof Error && /too large|Use PNG|Not a valid/.test(e.message)) throw e;
    throw new Error('Could not read image');
  }
}
export function writeEmote(id: string, webp: Buffer) {
  const p = emotePath(id);
  if (!p) throw new Error('bad emote id');
  fs.writeFileSync(p, webp, { mode: 0o640 });
}
export function deleteEmoteFile(id: string) {
  const p = emotePath(id);
  if (!p) return;
  try { fs.unlinkSync(p); } catch { /* missing ok */ }
}
export function sweepEmoteFiles(inUse: Set<string>): number {
  let n = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(EMOTE_DIR); } catch { return 0; }
  const cutoff = Date.now() - 10 * 60_000;
  for (const name of names) {
    const m = /^([a-f0-9]{32})\.webp$/.exec(name);
    if (!m || inUse.has(m[1])) continue;
    const p = path.join(EMOTE_DIR, name);
    try { if (fs.statSync(p).mtimeMs > cutoff) continue; fs.unlinkSync(p); n++; } catch { /* ignore */ }
  }
  return n;
}
