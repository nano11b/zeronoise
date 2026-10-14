import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { AVATAR_MAX_BYTES, AVATAR_SIZE } from '../shared/colors';
import { DATA_DIR } from './env';

export const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true, mode: 0o750 });

export function avatarPath(userId: number) {
  return path.join(AVATAR_DIR, `${userId}.webp`);
}

export function avatarExists(userId: number) {
  try { return fs.statSync(avatarPath(userId)).isFile(); } catch { return false; }
}

/** Validate + resize uploaded image buffer to 128×128 WebP. Strips EXIF by re-encoding. */
export async function processAvatarUpload(buf: Buffer): Promise<Buffer> {
  if (buf.length > AVATAR_MAX_BYTES) throw new Error('Image too large (max 512 KB)');
  if (buf.length < 24) throw new Error('Not a valid image');
  try {
    const img = sharp(buf, { failOn: 'error', animated: false }).rotate(); // honor EXIF orientation then strip
    const meta = await img.metadata();
    if (!meta.format || !['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) {
      throw new Error('Use JPEG, PNG, or WebP');
    }
    return await img
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
  } catch (e) {
    if (e instanceof Error && /too large|Use JPEG|Not a valid/.test(e.message)) throw e;
    throw new Error('Could not read image');
  }
}

export function writeAvatar(userId: number, webp: Buffer) {
  fs.writeFileSync(avatarPath(userId), webp, { mode: 0o640 });
}

export function deleteAvatarFile(userId: number) {
  try { fs.unlinkSync(avatarPath(userId)); } catch { /* missing ok */ }
}
