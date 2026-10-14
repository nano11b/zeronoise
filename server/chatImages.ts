import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import { DATA_DIR } from './env';
import * as repo from './repo';

export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o750 });

export const CHAT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_EDGE = 1280;

export function uploadPath(name: string) {
  return path.join(UPLOAD_DIR, name);
}

function sniff(buf: Buffer): 'jpeg' | 'png' | 'webp' | 'gif' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) return 'gif';
  return null;
}

/** Upload not posted in a message within this long is deleted. */
export const CHAT_IMAGE_UNCLAIMED_TTL_MS = 60 * 60_000;

/** Store a chat image for one room and record who uploaded it, so it can be cleaned up with its message/room. */
export async function storeRoomChatImage(roomId: string, buf: Buffer, uploader: { userId: number | null; devices: string[] }) {
  const saved = await storeChatImage(buf);
  try {
    repo.insertChatImage({ name: saved.name, room_id: roomId, uploader_user_id: uploader.userId, uploader_devices: JSON.stringify(uploader.devices.slice(0, 4)), created_at: Date.now() });
  } catch (err) {
    try { fs.unlinkSync(uploadPath(saved.name)); } catch { /* ignore */ }
    throw err;
  }
  return saved;
}

const UPLOAD_REF = /\/api\/uploads\/([A-Za-z0-9_-]{8,80}\.(?:webp|gif))/g;
/** Attach this uploader's unposted images referenced in a message's markdown to that message. */
export function claimChatImagesInText(roomId: string, messageId: string, text: string, accountId: number | null, devices: string[]): number {
  let n = 0;
  for (const m of text.matchAll(UPLOAD_REF)) {
    const row = repo.chatImageByName(m[1]);
    if (!row || row.room_id !== roomId || row.message_id) continue;
    if (!isUploader(row, accountId, devices)) continue;
    if (repo.claimChatImage(row.name, messageId)) n++;
  }
  return n;
}
function isUploader(row: { uploader_user_id: number | null; uploader_devices: string }, accountId: number | null, devices: string[]) {
  if (row.uploader_user_id != null) return accountId === row.uploader_user_id;
  let ids: string[] = [];
  try { ids = JSON.parse(row.uploader_devices) as string[]; } catch { /* none */ }
  return !accountId && devices.some((d) => ids.includes(d));
}
function removeImages(rows: repo.ChatImageRow[]): number {
  for (const r of rows) {
    if (/^[A-Za-z0-9_-]{8,80}\.(webp|gif)$/.test(r.name)) { try { fs.unlinkSync(uploadPath(r.name)); } catch { /* already gone */ } }
    repo.deleteChatImageRow(r.name);
  }
  return rows.length;
}
export const deleteImagesForMessages = (ids: string[]) => removeImages(repo.chatImagesForMessages(ids));
export const deleteImagesForRoom = (roomId: string) => removeImages(repo.chatImagesForRoom(roomId));
/** Unposted uploads past the TTL, and images whose message is gone. Pre-tracking images are never touched. */
export const sweepChatImages = () => removeImages(repo.orphanChatImages(Date.now() - CHAT_IMAGE_UNCLAIMED_TTL_MS));

/** Validate and store a chat image. GIF stays GIF (animation); others become WebP. */
export async function storeChatImage(buf: Buffer): Promise<{ name: string; url: string }> {
  if (buf.length > CHAT_IMAGE_MAX_BYTES) throw new Error('Image too large (max 2 MB)');
  const kind = sniff(buf);
  if (!kind) throw new Error('Use JPEG, PNG, WebP, or GIF');
  const id = randomBytes(12).toString('base64url');
  if (kind === 'gif') {
    const name = `${id}.gif`;
    fs.writeFileSync(uploadPath(name), buf, { mode: 0o640 });
    return { name, url: `/api/uploads/${name}` };
  }
  const webp = await sharp(buf, { failOn: 'error', animated: false })
    .rotate()
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const name = `${id}.webp`;
  fs.writeFileSync(uploadPath(name), webp, { mode: 0o640 });
  return { name, url: `/api/uploads/${name}` };
}
