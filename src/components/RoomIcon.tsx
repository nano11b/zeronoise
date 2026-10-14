import { ROOM_ICON_MAX_BYTES } from '../../shared/roomIcons';
import { api } from '../api';
import { THUMB_ACCEPT } from './RoomThumb';

export const ICON_ACCEPT = THUMB_ACCEPT;

/** Client-side pre-check; the server re-checks and re-encodes to a 128×128 WebP. */
export function iconFileError(file: File): string | null {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return 'Use PNG, JPEG, WebP or GIF';
  if (file.size > ROOM_ICON_MAX_BYTES) return 'Image too large (max 2 MB)';
  return null;
}

export async function uploadRoomIcon(roomId: string, file: File): Promise<string> {
  const bad = iconFileError(file);
  if (bad) throw new Error(bad);
  const fd = new FormData();
  fd.append('icon', file);
  const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/icon`, { method: 'POST', headers: { 'X-CSRF': '1' }, credentials: 'same-origin', body: fd });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.ok === false) throw new Error(data?.error || 'Upload failed');
  return String(data.iconUrl);
}

export async function removeRoomIcon(roomId: string): Promise<void> {
  await api(`/api/rooms/${encodeURIComponent(roomId)}/icon`, undefined, 'DELETE');
}

/** Small inline icon next to a room name (lobby cards, Jump back in). Decorative: the name is right beside it. */
export function RoomIconMini({ url }: { url?: string | null }) {
  if (!url) return null;
  return <img className="room-icon-mini" src={url} alt="" width={20} height={20} loading="lazy" decoding="async" data-room-icon-mini="1" />;
}
