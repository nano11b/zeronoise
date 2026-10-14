import { FormEvent, useState, useRef } from 'react';
import { useModal } from '../a11y';
import { api, storedDeviceId } from '../api';
import { loadSoundVolume, saveSoundVolume } from '../soundboard';

export interface SoundClip { id: string; name: string }

export function SoundsPanel({
  roomId, clips, isOwner, onClose, onPlay, onChange, toast,
}: {
  roomId: string;
  clips: SoundClip[];
  isOwner: boolean;
  onClose: () => void;
  onPlay: (id: string) => void;
  onChange: (clips: SoundClip[]) => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
}) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [volume, setVolume] = useState(loadSoundVolume);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('name', name.trim());
      body.append('file', file);
      const headers: Record<string, string> = { 'X-CSRF': '1' };
      const dev = storedDeviceId();
      if (dev) headers['X-Device-Id'] = dev;
      const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/sounds`, { method: 'POST', headers, body, credentials: 'same-origin' });
      const data = await r.json().catch(() => null) as { ok?: boolean; error?: string; sound?: SoundClip } | null;
      if (!r.ok || !data?.ok || !data.sound) throw new Error(data?.error || 'Could not add sound');
      onChange([...clips, data.sound]);
      setName('');
      setFile(null);
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await api(`/api/rooms/${encodeURIComponent(roomId)}/sounds/${encodeURIComponent(id)}`, undefined, 'DELETE');
      onChange(clips.filter((c) => c.id !== id));
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const modalRef = useRef<HTMLDivElement>(null);
  useModal(modalRef, onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={modalRef} className="modal panel sounds-panel" role="dialog" aria-modal="true" aria-label="Sounds" onClick={(e) => e.stopPropagation()}>
        <h3>Sounds</h3>
        {clips.length === 0 ? (
          <p className="muted">{isOwner ? 'Add a clip: name it, then choose an MP3, Ogg, WAV, or WebM under 300 KB.' : 'No sounds yet.'}</p>
        ) : (
          <div className="sound-list">
            {clips.map((c) => (
              <div key={c.id} className="sound-row">
                <button type="button" className="btn" data-action="sound-play" onClick={() => onPlay(c.id)}>{c.name}</button>
                {isOwner && <button type="button" className="btn ghost small-btn" data-action="sound-delete" disabled={busy} onClick={() => { void remove(c.id); }}>Delete</button>}
              </div>
            ))}
          </div>
        )}
        <label className="sound-volume">Volume
          <input type="range" min={0} max={1} step={0.05} value={volume} aria-label="Soundboard volume" onChange={(e) => { const n = Number(e.target.value); setVolume(n); saveSoundVolume(n); }} />
        </label>
        {isOwner && (
          <form onSubmit={upload} className="stack">
            <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} aria-label="Sound name" placeholder="Sound name" data-action="sound-name" />
            <input type="file" accept="audio/mpeg,audio/ogg,audio/wav,audio/webm" aria-label="Sound file" data-action="sound-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button className="btn primary" data-action="sound-add" disabled={busy || !name.trim() || !file}>Add sound</button>
          </form>
        )}
        <button type="button" className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
