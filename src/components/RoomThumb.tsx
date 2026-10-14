import { useRef, useState } from 'react';
import { ROOM_THUMB_MAX_BYTES } from '../../shared/roomThumbs';
import { api } from '../api';

export const THUMB_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/** Client-side pre-check; the server re-checks and re-encodes. */
export function thumbFileError(file: File): string | null {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return 'Use PNG, JPEG, WebP or GIF';
  if (file.size > ROOM_THUMB_MAX_BYTES) return 'Image too large (max 5 MB)';
  return null;
}

export async function uploadRoomThumb(roomId: string, file: File): Promise<string> {
  const bad = thumbFileError(file);
  if (bad) throw new Error(bad);
  const fd = new FormData();
  fd.append('thumb', file);
  const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/thumb`, { method: 'POST', headers: { 'X-CSRF': '1' }, credentials: 'same-origin', body: fd });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.ok === false) throw new Error(data?.error || 'Upload failed');
  return String(data.thumbUrl);
}

export async function removeRoomThumb(roomId: string): Promise<void> {
  await api(`/api/rooms/${encodeURIComponent(roomId)}/thumb`, undefined, 'DELETE');
}

/** Room info tab: preview + upload / remove (owner or site staff only). */
export function RoomThumbEditor({ roomId, thumbUrl, canEdit, onChange, toast }: {
  roomId: string; thumbUrl: string | null; canEdit: boolean;
  onChange: (url: string | null) => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!thumbUrl && !canEdit) return null;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try { onChange(await uploadRoomThumb(roomId, file)); toast('Thumbnail updated'); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const remove = async () => {
    setBusy(true);
    try { await removeRoomThumb(roomId); onChange(null); toast('Thumbnail removed'); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="room-thumb-edit" data-room-thumb={thumbUrl ? '1' : '0'}>
      {thumbUrl
        ? <img className="room-thumb-img" src={thumbUrl} alt="Room thumbnail" width={320} height={180} loading="lazy" />
        : <div className="room-thumb-img empty" aria-hidden>No thumbnail</div>}
      {canEdit && (
        <div className="room-thumb-actions">
          <input ref={fileRef} type="file" accept={THUMB_ACCEPT} hidden data-field="room-thumb-file" onChange={(e) => void pick(e.target.files?.[0])} />
          <button type="button" className="btn small-btn" disabled={busy} data-action="room-thumb-upload" onClick={() => fileRef.current?.click()}>{thumbUrl ? 'Change thumbnail' : 'Upload thumbnail'}</button>
          {thumbUrl && <button type="button" className="btn ghost small-btn" disabled={busy} data-action="room-thumb-remove" onClick={() => void remove()}>Remove thumbnail</button>}
        </div>
      )}
      {canEdit && <p className="muted small">Shown on the lobby card. PNG, JPEG, WebP or GIF up to 5 MB; cropped to 16:9.</p>}
    </div>
  );
}
