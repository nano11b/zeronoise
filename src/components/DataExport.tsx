import { useState } from 'react';
import { storedDeviceId } from '../api';

/** Profile dialog: download a copy of your data (ZIP of JSON files, or one JSON). Once an hour. */
export function DataExportSection() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const download = async (format: 'zip' | 'json') => {
    setBusy(true); setMsg(null);
    try {
      const headers: Record<string, string> = { 'X-CSRF': '1', 'Content-Type': 'application/json' };
      const dev = storedDeviceId(); if (dev) headers['X-Device-Id'] = dev;
      const r = await fetch('/api/me/export', { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ format }) });
      if (!r.ok) { const j = await r.json().catch(() => null); throw new Error(j?.error || `Download failed (${r.status})`); }
      const blob = await r.blob();
      const name = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '')?.[1] || `export.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMsg({ text: `Downloaded ${name}.` });
    } catch (e) { setMsg({ text: (e as Error).message, error: true }); } finally { setBusy(false); }
  };
  return (
    <div className="profile-section" data-section="export">
      <div className="muted small">Your data</div>
      <p className="small">Download your profile, settings, the room messages you sent and your whispers. Burn messages, passwords and IP addresses are left out. Once an hour.</p>
      <div className="row-actions">
        <button type="button" className="btn small-btn" disabled={busy} data-action="export-zip" onClick={() => void download('zip')}>Download ZIP</button>
        <button type="button" className="btn small-btn ghost" disabled={busy} data-action="export-json" onClick={() => void download('json')}>JSON only</button>
      </div>
      {msg && <p className={`small ${msg.error ? 'form-error' : 'muted'}`} role={msg.error ? 'alert' : 'status'} data-testid="export-msg">{msg.text}</p>}
    </div>
  );
}
