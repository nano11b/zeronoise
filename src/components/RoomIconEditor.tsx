import { useRef, useState } from 'react';
import { ICON_ACCEPT, removeRoomIcon, uploadRoomIcon } from './RoomIcon';

/** Room info tab, next to the thumbnail controls: "Room icon: Upload / Change / Remove" (owner or site staff only). */
export function RoomIconEditor({ roomId, roomName, iconUrl, canEdit, onChange, toast }: {
  roomId: string; roomName: string; iconUrl: string | null; canEdit: boolean;
  onChange: (url: string | null) => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!iconUrl && !canEdit) return null;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try { onChange(await uploadRoomIcon(roomId, file)); toast('Room icon updated'); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const remove = async () => {
    setBusy(true);
    try { await removeRoomIcon(roomId); onChange(null); toast('Room icon removed'); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="room-icon-edit" data-room-icon={iconUrl ? '1' : '0'}>
      <span className="room-icon-preview" aria-hidden={!iconUrl}>
        {iconUrl ? <img src={iconUrl} alt={roomName} width={48} height={48} /> : (roomName || '?').slice(0, 1).toUpperCase()}
      </span>
      <div className="room-icon-body">
        <span className="room-icon-label">Room icon</span>
        {canEdit && (
          <div className="room-thumb-actions">
            <input ref={fileRef} type="file" accept={ICON_ACCEPT} hidden data-field="room-icon-file" onChange={(e) => void pick(e.target.files?.[0])} />
            <button type="button" className="btn small-btn" disabled={busy} data-action="room-icon-upload" onClick={() => fileRef.current?.click()}>{iconUrl ? 'Change' : 'Upload'}</button>
            {iconUrl && <button type="button" className="btn ghost small-btn" disabled={busy} data-action="room-icon-remove" aria-label="Remove room icon" onClick={() => void remove()}>Remove</button>}
          </div>
        )}
        {canEdit && <p className="muted small">Shown in the room list rail and header. PNG, JPEG, WebP or GIF up to 2 MB; cropped square.</p>}
      </div>
    </div>
  );
}
