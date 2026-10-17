import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import { resetTranslateConfig } from '../translate';

/** Batch G1: admins point tap-to-translate at a self-hosted LibreTranslate (optional). */
export function TranslateSettings() {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { api<{ url: string; hasKey: boolean }>('/api/admin/settings/translate').then((j) => { setUrl(j.url); setHasKey(j.hasKey); }).catch(() => {}); }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const j = await api<{ url: string; hasKey: boolean }>('/api/admin/settings/translate', { url, ...(key ? { key } : {}) });
      setUrl(j.url); setHasKey(j.hasKey); setKey(''); resetTranslateConfig();
      setMsg(j.url ? 'Saved. People without on-device translation will use this server.' : 'Cleared. Only on-device browser translation is used.');
    } catch (err) { setMsg((err as Error).message); }
  };
  return (
    <section className="panel translate-settings" data-testid="translate-settings">
      <h2>Translation</h2>
      <p className="muted">Tap-to-translate uses the browser's on-device translator where it exists (recent Chrome). Optionally add your own LibreTranslate server for everyone else. No paid API is used.</p>
      <form onSubmit={save} className="row-form">
        <label>LibreTranslate URL <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://10.0.10.60:5000" data-testid="libre-url" /></label>
        <label>API key (only if your server needs one) <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? 'saved — leave blank to keep' : 'optional'} /></label>
        <button className="btn" type="submit" data-action="save-translate">Save</button>
      </form>
      {msg && <p className="notice" role="status">{msg}</p>}
    </section>
  );
}
