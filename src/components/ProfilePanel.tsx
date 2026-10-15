import { useEffect, useRef, useState } from 'react';
import type { Account } from '../App';
import { api } from '../api';
import { NickLabel, UserAvatar } from './UserAvatar';
import { BadgesSection } from './Badges';
import { BioSection, PrivacySection, PushSection } from './ProfileExtras';
import { useInstallOffer } from '../pwa';
import { ThemePicker } from './ThemePicker';
import type { UiTheme } from '../../shared/uiTheme';

/** Quiet, dismissible install entry: the browser prompt, or the Share -> Add to Home Screen hint on iOS. Hidden when installed. */
function InstallItem() {
  const offer = useInstallOffer();
  if (!offer.mode) return null;
  return (
    <div className="install-item" data-testid="install-item">
      {offer.mode === 'prompt' ? (
        <button type="button" data-action="install-app" onClick={() => { void offer.install(); }}>Install app</button>
      ) : (
        <p className="install-hint" data-action="install-ios-hint">
          Install: tap <strong>Share</strong> <span aria-hidden="true">→</span> <strong>Add to Home Screen</strong>
        </p>
      )}
      <button type="button" className="install-dismiss" data-action="install-dismiss" aria-label="Hide the install option" title="Hide" onClick={offer.dismiss}>
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}

export function ProfilePanel({
  account,
  onAccount,
  toast,
  onAudioVideo,
  signOut,
}: {
  account: Account;
  onAccount: (a: Account) => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
  onAudioVideo?: () => void;
  signOut?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const themeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTheme = (t: UiTheme) => {
    onAccount({ ...account, uiTheme: t });
    if (themeTimer.current) clearTimeout(themeTimer.current);
    themeTimer.current = setTimeout(() => {
      void api('/api/me/ui-theme', { uiTheme: t }, 'PATCH').catch(() => toast('Theme saved in this browser only', 'error'));
    }, 500);
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [bots, setBots] = useState<{ id: number; name: string; revoked: boolean }[]>([]);
  const [botName, setBotName] = useState('');
  const [tokenOnce, setTokenOnce] = useState<string | null>(null);

  const loadBots = async () => {
    const data = await api<{ bots: { id: number; name: string; revoked: boolean }[] }>('/api/bots');
    setBots(data.bots);
  };
  useEffect(() => { loadBots().catch((e) => toast((e as Error).message, 'error')); }, []);

  const upload = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('avatar', file);
      const headers: Record<string, string> = { 'X-CSRF': '1' };
      const r = await fetch('/api/me/avatar', { method: 'POST', headers, credentials: 'same-origin', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data?.ok === false) throw new Error(data?.error || 'Upload failed');
      onAccount({ ...account, hasAvatar: true });
      toast('Avatar updated');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const removeAvatar = async () => {
    setBusy(true);
    try {
      await api('/api/me/avatar', undefined, 'DELETE');
      onAccount({ ...account, hasAvatar: false });
      toast('Avatar removed');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <aside className="panel profile-panel">
      <h3>Your profile</h3>
      <div className="profile-actions" role="group" aria-label="Account actions">
        {onAudioVideo && (
          <button type="button" data-action="profile-av" onClick={onAudioVideo}>Audio & video</button>
        )}
        <InstallItem />
        <a href="/download" data-action="get-app-menu">Get the app</a>
        {signOut && (
          <button type="button" data-action="sign-out" onClick={signOut}>Sign out</button>
        )}
      </div>
      <ThemePicker onSaved={saveTheme} />
      <div className="profile-preview">
        <UserAvatar nick={account.username} accountId={account.id} chatColor={account.chatColor} hasAvatar={account.hasAvatar} size={48} />
        <div>
          <NickLabel nick={account.username} chatColor={account.chatColor} chatEffect={account.chatEffect} />
          <p className="muted small">Name color and effect are on the chat bar. Shown in chat, the people list, and friends.</p>
        </div>
      </div>
      <div className="profile-section">
        <div className="muted small">Avatar (JPEG/PNG/WebP, max 512 KB)</div>
        <div className="row-actions">
          <button type="button" className="btn small-btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>Upload</button>
          {account.hasAvatar && (
            <button type="button" className="btn small-btn ghost" disabled={busy} onClick={removeAvatar}>Remove</button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => upload(e.target.files?.[0] ?? null)} />
      </div>
      <BioSection username={account.username} toast={toast} />
      <PushSection toast={toast} />
      <PrivacySection toast={toast} />
      <BadgesSection toast={toast} />
      <div className="profile-section">
        <div className="muted small">Chat bots</div>
        <p className="muted small">A bot speaks as itself. It can chat only in rooms whose creator has allowed it. The token is shown once and only a hash is stored.</p>
        <p className="small"><a href="/docs/bots">Bot API docs</a></p>
        <form className="row-actions" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const data = await api<{ bot: { id: number; name: string }; token: string }>('/api/bots', { name: botName.trim() });
            setTokenOnce(data.token);
            setBotName('');
            await loadBots();
            toast('Bot created. Copy the token now — it will not be shown again.');
          } catch (err) { toast((err as Error).message, 'error'); }
          finally { setBusy(false); }
        }}>
          <input value={botName} maxLength={20} onChange={(e) => setBotName(e.target.value)} aria-label="Bot display name" placeholder="Display name" data-action="bot-name" />
          <button type="submit" className="btn small-btn primary" disabled={busy || !botName.trim()} data-action="create-bot">Create</button>
        </form>
        {tokenOnce && (
          <label className="whip-field">
            <span className="muted small">Token (shown once)</span>
            <span className="whip-row">
              <input readOnly className="whip-secret" value={tokenOnce} aria-label="Bot token" />
              <button type="button" className="btn ghost small-btn" data-action="copy-bot-token" onClick={async () => {
                try { await navigator.clipboard.writeText(tokenOnce); toast('Token copied'); }
                catch { toast('Could not copy', 'error'); }
              }}>Copy</button>
            </span>
          </label>
        )}
        <ul className="bot-list">
          {bots.map((b) => (
            <li key={b.id} className="bot-row">
              <span>{b.name}{b.revoked ? ' (revoked)' : ''}</span>
              <span className="row-actions">
                <button type="button" className="btn small-btn ghost" disabled={busy} data-action="rotate-bot" onClick={async () => {
                  setBusy(true);
                  try {
                    const data = await api<{ token: string }>(`/api/bots/${b.id}/token`, {});
                    setTokenOnce(data.token);
                    await loadBots();
                    toast('New token ready. Copy it now — it will not be shown again.');
                  } catch (err) { toast((err as Error).message, 'error'); }
                  finally { setBusy(false); }
                }}>Rotate</button>
                <button type="button" className="btn small-btn ghost" disabled={busy || b.revoked} data-action="revoke-bot" onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/api/bots/${b.id}/revoke`, {});
                    setTokenOnce(null);
                    await loadBots();
                    toast('Token revoked');
                  } catch (err) { toast((err as Error).message, 'error'); }
                  finally { setBusy(false); }
                }}>Revoke</button>
                <button type="button" className="btn small-btn ghost" disabled={busy} data-action="delete-bot" onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/api/bots/${b.id}`, undefined, 'DELETE');
                    setTokenOnce(null);
                    await loadBots();
                    toast('Bot deleted');
                  } catch (err) { toast((err as Error).message, 'error'); }
                  finally { setBusy(false); }
                }}>Delete</button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
