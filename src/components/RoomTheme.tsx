import { FormEvent, useState } from 'react';
import type { RoomThemeInfo } from '../../shared/theme';
import { THEME_WELCOME_MAX } from '../../shared/theme';
import { call, socket } from '../socket';

/** Banner + pinned welcome message shown at the top of the chat. */
export function RoomThemeHeader({ theme, onDismiss }: { theme: RoomThemeInfo | null | undefined; onDismiss?: () => void }) {
  if (!theme || (!theme.bannerUrl && !theme.welcome)) return null;
  return (
    <div className="room-theme-head" data-room-theme="1">
      {theme.bannerUrl && <img className="room-banner" src={theme.bannerUrl} alt="" data-room-banner="1" />}
      {theme.welcome && (
        <div className="room-welcome" data-room-welcome="1" role="note" aria-label="Welcome message">
          <span className="room-welcome-pin" aria-hidden="true">📌</span>
          <span className="room-welcome-text">{theme.welcome}</span>
          {onDismiss && <button type="button" className="icon-btn" aria-label="Hide welcome message" data-action="welcome-hide" onClick={onDismiss}>✕</button>}
        </div>
      )}
    </div>
  );
}

/** Owner settings (side panel, room info): banner upload, accent color, welcome message. */
export function RoomThemeSettings({ roomId, theme, toast }: { roomId: string; theme: RoomThemeInfo | null | undefined; toast: (t: string, tone?: 'error') => void }) {
  const [accent, setAccent] = useState(theme?.accent ?? '#39ff14');
  const [useAccent, setUseAccent] = useState(!!theme?.accent);
  const [welcome, setWelcome] = useState(theme?.welcome ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await call((ack) => socket.emit('room:theme:set', { accent: useAccent ? accent : null, welcome }, ack));
      toast('Theme saved');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const upload = async (file: File | null) => {
    if (!file) return;
    const fd = new FormData(); fd.append('thumb', file);
    setBusy(true);
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/banner`, { method: 'POST', body: fd, headers: { 'x-csrf': '1' }, credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'Upload failed');
      toast('Banner updated');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const removeBanner = async () => {
    setBusy(true);
    try { await fetch(`/api/rooms/${encodeURIComponent(roomId)}/banner`, { method: 'DELETE', headers: { 'x-csrf': '1' }, credentials: 'same-origin' }); toast('Banner removed'); }
    finally { setBusy(false); }
  };
  return (
    <form className="room-theme-settings" onSubmit={save} data-panel="room-theme">
      <h4>Room theme</h4>
      <div className="theme-banner-row">
        {theme?.bannerUrl ? <img className="room-banner small" src={theme.bannerUrl} alt="" /> : <div className="room-banner small empty">No banner</div>}
        <div className="theme-banner-actions">
          <label className="btn small-btn ghost">Upload banner<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => { void upload(e.target.files?.[0] ?? null); e.target.value = ''; }} data-field="banner-file" /></label>
          {theme?.bannerUrl && <button type="button" className="btn small-btn ghost" disabled={busy} onClick={() => void removeBanner()} data-action="banner-remove">Remove</button>}
        </div>
      </div>
      <p className="muted small">Wide image, cropped to 1200×300.</p>
      <label className="check-row"><input type="checkbox" checked={useAccent} onChange={(e) => setUseAccent(e.target.checked)} data-action="accent-toggle" /> <span>Accent color</span>
        <input type="color" value={accent} disabled={!useAccent} onChange={(e) => setAccent(e.target.value)} aria-label="Accent color" data-field="accent" />
      </label>
      <label className="field"><span>Welcome message (pinned at the top)</span>
        <textarea rows={3} maxLength={THEME_WELCOME_MAX} value={welcome} onChange={(e) => setWelcome(e.target.value)} data-field="welcome" />
      </label>
      <button className="btn primary small-btn" disabled={busy} data-action="theme-save">Save theme</button>
    </form>
  );
}
