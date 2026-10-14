import { useEffect, useMemo, useState } from 'react';
import { BIO_MAX } from '../../shared/bio';
import { api } from '../api';
import { call, socket } from '../socket';
import { renderBioMarkdown } from '../markdown';

/** Profile settings: bio (280 chars, markdown-lite). */
export function BioSection({ username, toast }: { username: string; toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [bio, setBio] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ profile: { bio: string } }>(`/api/users/${encodeURIComponent(username)}/profile`).then((r) => { setBio(r.profile.bio); setSaved(r.profile.bio); }).catch(() => {});
  }, [username]);
  const preview = useMemo(() => renderBioMarkdown(bio), [bio]);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ bio: string }>('/api/me/bio', { bio }, 'PATCH');
      setBio(r.bio); setSaved(r.bio);
      toast('Bio saved');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="profile-section bio-section">
      <div className="muted small">Bio <span className="bio-count">{bio.length}/{BIO_MAX}</span></div>
      <textarea value={bio} maxLength={BIO_MAX} rows={3} onChange={(e) => setBio(e.target.value)} placeholder="A few words about you. **bold**, _italic_, `code` and links work." aria-label="Bio" data-field="bio" />
      {preview && bio !== saved && <div className="bio-preview md small" dangerouslySetInnerHTML={{ __html: preview }} />}
      <div className="row-actions">
        <button type="button" className="btn small-btn primary" disabled={busy || bio === saved} data-action="save-bio" onClick={() => void save()}>Save bio</button>
      </div>
    </div>
  );
}

const b64ToBytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Profile settings: opt-in Web Push for @mentions, private messages and whispers while you are away. */
export function PushSection({ toast }: { toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [server, setServer] = useState<{ enabled: boolean; key: string | null } | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();
  useEffect(() => {
    api<{ enabled: boolean; key: string | null }>('/api/push/key').then(setServer).catch(() => setServer({ enabled: false, key: null }));
    if (!supported) return;
    navigator.serviceWorker.getRegistration('/sw.js').then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      setOn(!!sub && Notification.permission === 'granted');
    }).catch(() => {});
  }, [supported]);
  const enable = async () => {
    if (!server?.key) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notifications are blocked for this site in your browser settings.');
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(server.key) });
      const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await api('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
      setOn(true);
      toast('Notifications on for this browser');
    } catch (e) { toast((e as Error).message || 'Could not turn on notifications', 'error'); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await api('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      setOn(false);
      toast('Notifications off');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const unavailable = !supported ? 'This browser does not support push notifications.' : server && !server.enabled ? 'Push notifications are turned off on this server.' : '';
  return (
    <div className="profile-section push-section">
      <div className="muted small">Notifications</div>
      <label className="push-toggle">
        <input type="checkbox" checked={on} disabled={busy || !!unavailable || !server} onChange={() => void (on ? disable() : enable())} data-action="push-toggle" />
        <span>Notify me about @mentions, private messages and whispers when I'm not connected</span>
      </label>
      {unavailable && <p className="muted small">{unavailable}</p>}
    </div>
  );
}

/** Friends online now: whether friends see which room you are in (default on). */
export function PrivacySection({ toast }: { toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call<{ showRoom: boolean }>((ack) => socket.emit('presence:get', ack)).then((r) => setOn(r.showRoom)).catch(() => setOn(true));
  }, []);
  const flip = async () => {
    setBusy(true);
    try {
      const r = await call<{ showRoom: boolean }>((ack) => socket.emit('presence:set', { showRoom: !on }, ack));
      setOn(r.showRoom);
      toast(r.showRoom ? 'Friends can see your room' : 'Your room is hidden from friends');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="profile-section privacy-section">
      <div className="muted small">Privacy</div>
      <label className="push-toggle">
        <input type="checkbox" checked={on ?? true} disabled={busy || on === null} onChange={() => void flip()} data-action="show-room-toggle" />
        <span>Show which room I'm in to friends</span>
      </label>
      <p className="muted small">Friends still see that you are online. Private calls and password rooms are never shown.</p>
    </div>
  );
}
