/** Profiles 2.0 (batch C): banner, links and "now playing" editors for the Profile dialog, and the read-only blocks for profile cards. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BANNER_MAX_BYTES, NOW_PLAYING_MAX, PROFILE_LINK_LABEL_MAX, PROFILE_LINK_URL_MAX, PROFILE_LINKS_MAX, type ProfileLink } from '../../shared/profile2';
import { api } from '../api';

type Toast = (t: string, tone?: 'error' | 'info') => void;

export function Profile2Section({ toast }: { toast: Toast }) {
  const [banner, setBanner] = useState<string | null>(null);
  const [links, setLinks] = useState<ProfileLink[]>([]);
  const [np, setNp] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api<{ bannerUrl: string | null; links: ProfileLink[]; nowPlaying: string | null }>('/api/me/profile2')
      .then((r) => { setBanner(r.bannerUrl); setLinks(r.links); setNp(r.nowPlaying ?? ''); }).catch(() => {});
  }, []);
  const upload = async (file: File | null) => {
    if (!file) return;
    if (file.size > BANNER_MAX_BYTES) { toast('Image too large (max 2 MB)', 'error'); return; }
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('banner', file);
      const r = await fetch('/api/me/banner', { method: 'POST', headers: { 'X-CSRF': '1' }, credentials: 'same-origin', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data?.ok === false) throw new Error(data?.error || 'Upload failed');
      setBanner(data.bannerUrl); toast('Banner updated');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const removeBanner = async () => {
    setBusy(true);
    try { await api('/api/me/banner', undefined, 'DELETE'); setBanner(null); toast('Banner removed'); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const saveLinks = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { const r = await api<{ links: ProfileLink[] }>('/api/me/links', { links }, 'PATCH'); setLinks(r.links); toast('Links saved'); }
    catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const saveNp = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { const r = await api<{ nowPlaying: string | null }>('/api/me/now-playing', { text: np }, 'PATCH'); setNp(r.nowPlaying ?? ''); toast(r.nowPlaying ? 'Status set' : 'Status cleared'); }
    catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="profile-section" data-section="banner">
        <div className="muted small">Banner (JPEG/PNG/WebP/GIF, max 2 MB, shown 1200×300)</div>
        {banner ? <img className="p2-banner-preview" src={banner} alt="Your profile banner" data-banner="1" /> : <div className="p2-banner-preview empty" aria-hidden="true" />}
        <div className="row-actions">
          <button type="button" className="btn small-btn primary" disabled={busy} onClick={() => fileRef.current?.click()} data-action="banner-upload">{banner ? 'Change' : 'Upload'}</button>
          {banner && <button type="button" className="btn small-btn ghost" disabled={busy} onClick={() => void removeBanner()} data-action="banner-remove">Remove</button>}
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => void upload(e.target.files?.[0] ?? null)} data-field="banner-file" />
      </div>
      <form className="profile-section" onSubmit={saveNp} data-form="now-playing">
        <div className="muted small">Now playing (game, song or show; clears after 12 hours)</div>
        <div className="row-actions">
          <input value={np} maxLength={NOW_PLAYING_MAX} onChange={(e) => setNp(e.target.value)} placeholder="e.g. Rocket League" aria-label="Now playing" data-field="now-playing" />
          <button className="btn small-btn" disabled={busy} data-action="now-playing-save">Save</button>
        </div>
      </form>
      <form className="profile-section" onSubmit={saveLinks} data-form="profile-links">
        <div className="muted small">Links (up to {PROFILE_LINKS_MAX}, http/https only; shown with rel="nofollow")</div>
        {links.map((l, i) => (
          <div key={i} className="p2-link-row">
            <input value={l.label} maxLength={PROFILE_LINK_LABEL_MAX} placeholder="Label" aria-label={`Link ${i + 1} label`} onChange={(e) => setLinks((cur) => cur.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} data-field={`link-label-${i}`} />
            <input value={l.url} maxLength={PROFILE_LINK_URL_MAX} placeholder="https://…" aria-label={`Link ${i + 1} address`} inputMode="url" onChange={(e) => setLinks((cur) => cur.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} data-field={`link-url-${i}`} />
            <button type="button" className="icon-btn" aria-label={`Remove link ${i + 1}`} onClick={() => setLinks((cur) => cur.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <div className="row-actions">
          {links.length < PROFILE_LINKS_MAX && <button type="button" className="btn small-btn ghost" onClick={() => setLinks((cur) => [...cur, { label: '', url: '' }])} data-action="link-add">+ Add link</button>}
          <button className="btn small-btn" disabled={busy} data-action="links-save">Save links</button>
        </div>
      </form>
    </>
  );
}

/** Profile card blocks: banner strip, now playing, links (nofollow), mutual friends and rooms. */
export function Profile2Banner({ url }: { url?: string | null }) {
  return url ? <img className="pc-banner" src={url} alt="" data-banner="1" /> : null;
}
export function Profile2Blocks({ nowPlaying, links, mutualFriends, mutualRooms, onOpenRoom }: {
  nowPlaying?: string | null; links?: ProfileLink[]; mutualFriends?: { id: number; username: string }[]; mutualRooms?: { id: string; name: string }[]; onOpenRoom?: (id: string) => void;
}) {
  return (
    <>
      {nowPlaying && <p className="pc-np small" data-now-playing="1"><span aria-hidden="true">🎮</span> Now playing: <b>{nowPlaying}</b></p>}
      {links && links.length > 0 && (
        <ul className="pc-links" data-links={links.length}>
          {links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="nofollow ugc noopener noreferrer" data-profile-link="1">🔗 {l.label}</a></li>)}
        </ul>
      )}
      {mutualFriends && mutualFriends.length > 0 && (
        <div className="pc-rooms" data-mutual="friends">
          <span className="muted small">Mutual friends · {mutualFriends.length}</span>
          <span className="pc-room-list">{mutualFriends.map((f) => <span key={f.id} className="tag">{f.username}</span>)}</span>
        </div>
      )}
      {mutualRooms && mutualRooms.length > 0 && (
        <div className="pc-rooms" data-mutual="rooms">
          <span className="muted small">Rooms you both visit</span>
          <span className="pc-room-list">{mutualRooms.map((r) => <button key={r.id} type="button" className="tag pc-room" data-room={r.id} onClick={() => onOpenRoom?.(r.id)} disabled={!onOpenRoom}>#{r.name}</button>)}</span>
        </div>
      )}
    </>
  );
}
