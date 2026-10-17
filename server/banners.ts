/** Profile banners (batch C): re-encoded 1200x300 WebP under DATA_DIR/banners, random ids (cacheable; a new upload gets a new id). */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import { BANNER_H, BANNER_MAX_BYTES, BANNER_W } from '../shared/profile2';
import { DATA_DIR } from './env';

export const BANNER_DIR = path.join(DATA_DIR, 'banners');
fs.mkdirSync(BANNER_DIR, { recursive: true, mode: 0o750 });
export const BANNER_ID_RE = /^[a-f0-9]{20}$/;
export const bannerPath = (id: string) => path.join(BANNER_DIR, `${id}.webp`);
export const bannerUrl = (id: string) => `/api/banners/${id}.webp`;
export function newBannerId() { return randomBytes(10).toString('hex'); }

export async function processBanner(buf: Buffer): Promise<Buffer> {
  if (buf.length > BANNER_MAX_BYTES) throw new Error('Image too large (max 2 MB)');
  if (buf.length < 24) throw new Error('Not a valid image');
  try {
    const img = sharp(buf, { failOn: 'error', animated: false, limitInputPixels: 40_000_000 }).rotate();
    const meta = await img.metadata();
    if (!meta.format || !['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) throw new Error('Use JPEG, PNG, WebP or GIF');
    return await img.resize(BANNER_W, BANNER_H, { fit: 'cover', position: 'attention' }).webp({ quality: 80, effort: 4 }).toBuffer();
  } catch (e) {
    if (e instanceof Error && /too large|Use JPEG|Not a valid/.test(e.message)) throw e;
    throw new Error('Could not read image');
  }
}
export function writeBanner(id: string, webp: Buffer) { fs.writeFileSync(bannerPath(id), webp, { mode: 0o640 }); }
/** old banner files are moved aside (kept), never deleted outright */
export function retireBanner(id: string) {
  try { fs.renameSync(bannerPath(id), path.join(BANNER_DIR, `${id}.webp.old`)); } catch { /* missing ok */ }
}
