import { useState } from 'react';
import type { Account } from '../App';
import { api } from '../api';
import { AVATAR_FX } from '../../shared/avatarFx';
import { setHideAvatarFx, useHideAvatarFx } from '../avatarFxPref';
import { UserAvatar } from './UserAvatar';

/** batch MC2: pick a subtle avatar frame / glow, plus the viewer toggle to hide everyone's. */
export function AvatarFxSection({ account, onAccount, toast }: { account: Account; onAccount: (a: Account) => void; toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [busy, setBusy] = useState(false);
  const hide = useHideAvatarFx();
  const cur = account.avatarFx ?? null;
  const save = async (fx: string | null) => {
    setBusy(true);
    try {
      const r = await api<{ avatarFx: string | null }>('/api/me/avatar-fx', { fx }, 'PATCH');
      onAccount({ ...account, avatarFx: r.avatarFx });
      toast(r.avatarFx ? 'Profile effect updated' : 'Profile effect removed');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="profile-section avatar-fx-section" data-section="avatar-fx">
      <div className="muted small">Profile effect <span className="muted">(a frame or glow around your picture)</span></div>
      <div className="avatar-fx-grid" role="listbox" aria-label="Profile effect">
        <button type="button" className={`avatar-fx-pick ${!cur ? 'on' : ''}`} aria-selected={!cur} disabled={busy} onClick={() => void save(null)} data-avatar-fx="none">
          <UserAvatar nick={account.username} accountId={account.id} chatColor={account.chatColor} hasAvatar={account.hasAvatar} size={36} /><span>None</span>
        </button>
        {AVATAR_FX.map((f) => (
          <button key={f.id} type="button" className={`avatar-fx-pick ${cur === f.id ? 'on' : ''}`} aria-selected={cur === f.id} disabled={busy} onClick={() => void save(f.id)} data-avatar-fx={f.id}>
            <UserAvatar nick={account.username} accountId={account.id} chatColor={account.chatColor} hasAvatar={account.hasAvatar} avatarFx={f.id} size={36} /><span>{f.label}</span>
          </button>
        ))}
      </div>
      <label className="check-row small"><input type="checkbox" checked={hide} onChange={(e) => setHideAvatarFx(e.target.checked)} data-action="hide-avatar-fx" /> <span>Hide profile effects (frames and glows) on everyone, on this device</span></label>
    </div>
  );
}
