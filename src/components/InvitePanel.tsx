import { useEffect, useRef, useState, type FormEvent } from 'react';
import { INVITE_EXPIRY_LABEL, INVITE_MAX_USES, inviteUrl, type InviteExpiry, type InviteInfo } from '../../shared/invites';
import { api } from '../api';
import { useModal } from '../a11y';

const EXPIRIES = Object.keys(INVITE_EXPIRY_LABEL) as InviteExpiry[];

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** "Copy invite link" in the More menu: the caller's default link (1 day, unlimited), reused while it is good. */
export async function copyDefaultInvite(roomId: string, toast: (t: string, tone?: 'error' | 'info') => void) {
  try {
    const r = await api<{ invite: InviteInfo; url: string }>(`/api/rooms/${encodeURIComponent(roomId)}/invites/default`, {});
    const url = inviteUrl(location.origin, r.invite.code);
    if (await copyText(url)) toast('Invite link copied (works for 1 day)');
    else toast(`Invite link: ${url}`);
  } catch (e) { toast((e as Error).message, 'error'); }
}

function left(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}
function expiryText(i: InviteInfo): string {
  if (i.status === 'expired') return 'expired';
  if (i.expiresAt == null) return 'never expires';
  return `expires in ${left(i.expiresAt - Date.now())}`;
}

function CreateDialog({ onClose, onCreate, canSkip, passwordRequired }: {
  onClose: () => void; onCreate: (o: { expires: InviteExpiry; maxUses: number | null; skipPassword: boolean }) => Promise<void>;
  canSkip: boolean; passwordRequired: boolean;
}) {
  const [expires, setExpires] = useState<InviteExpiry>('1d');
  const [maxUses, setMaxUses] = useState<string>('');
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLFormElement>(null);
  useModal(ref, onClose);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await onCreate({ expires, maxUses: maxUses ? Number(maxUses) : null, skipPassword: skip }); onClose(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form ref={ref} className="modal panel invite-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit} role="dialog" aria-modal="true" aria-label="Create invite link" data-testid="invite-dialog">
        <h3>Create invite link</h3>
        <p className="muted small">Anyone with the link can join. Signed-out people sign in or sign up first.</p>
        <label className="field">
          <span>Expires after</span>
          <select name="expires" value={expires} onChange={(e) => setExpires(e.target.value as InviteExpiry)}>
            {EXPIRIES.map((k) => <option key={k} value={k}>{INVITE_EXPIRY_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Max uses</span>
          <select name="maxUses" value={maxUses} onChange={(e) => setMaxUses(e.target.value)}>
            {INVITE_MAX_USES.map((n) => <option key={String(n)} value={n == null ? '' : String(n)}>{n == null ? 'No limit' : `${n} ${n === 1 ? 'person' : 'people'}`}</option>)}
          </select>
        </label>
        {canSkip && (
          <label className="check-row">
            <input type="checkbox" name="skipPassword" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            <span>Skips the room password{passwordRequired ? '' : ' (if you add one later)'}</span>
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy} data-action="invite-create-confirm">Create link</button>
        </div>
      </form>
    </div>
  );
}

/** Room Info tab: invite links with uses / expiry, create, copy, revoke; owner/staff also set "room mods can invite". */
export function InvitePanel({ roomId, canSkipPassword, passwordRequired, modsCanInvite, toast }: {
  roomId: string; canSkipPassword: boolean; passwordRequired: boolean; modsCanInvite: boolean;
  toast: (t: string, tone?: 'error' | 'info') => void;
}) {
  const [list, setList] = useState<InviteInfo[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [mods, setMods] = useState(modsCanInvite);
  useEffect(() => setMods(modsCanInvite), [modsCanInvite]);
  const base = `/api/rooms/${encodeURIComponent(roomId)}`;
  const load = () => api<{ invites: InviteInfo[] }>(`${base}/invites`).then((r) => setList(r.invites), (e) => { setList([]); toast((e as Error).message, 'error'); });
  useEffect(() => { void load(); }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = async (o: { expires: InviteExpiry; maxUses: number | null; skipPassword: boolean }) => {
    const r = await api<{ invite: InviteInfo }>(`${base}/invites`, o);
    setList((l) => [r.invite, ...(l ?? [])]);
    const url = inviteUrl(location.origin, r.invite.code);
    toast(await copyText(url) ? 'Invite link created and copied' : `Invite link: ${url}`);
  };
  const revoke = async (code: string) => {
    try { await api(`${base}/invites/${code}`, undefined, 'DELETE'); setList((l) => (l ?? []).filter((i) => i.code !== code)); toast('Invite link revoked'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const toggleMods = async (on: boolean) => {
    setMods(on);
    try { await api(`${base}/invite-settings`, { modsCanInvite: on }, 'PATCH'); }
    catch (e) { setMods(!on); toast((e as Error).message, 'error'); }
  };
  return (
    <section className="invite-panel" data-testid="invite-panel" aria-labelledby={`inv-${roomId}`}>
      <div className="invite-head">
        <h4 id={`inv-${roomId}`}>Invite links</h4>
        <button type="button" className="btn small-btn primary" data-action="invite-create" onClick={() => setCreating(true)}>Create link</button>
      </div>
      {canSkipPassword && (
        <label className="check-row small">
          <input type="checkbox" checked={mods} onChange={(e) => void toggleMods(e.target.checked)} data-action="invite-mods-toggle" />
          <span>Room mods can create invite links</span>
        </label>
      )}
      {list == null ? <p className="muted small">Loading…</p> : list.length === 0 ? <p className="muted small" data-testid="invite-empty">No invite links yet.</p> : (
        <ul className="invite-list">
          {list.map((i) => (
            <li key={i.code} className={`invite-item${i.status !== 'ok' ? ' dead' : ''}`} data-invite={i.code} data-status={i.status}>
              <div className="invite-item-main">
                <code className="invite-code" title={inviteUrl(location.origin, i.code)}>/i/{i.code}</code>
                <span className="muted small">
                  {i.uses}{i.maxUses != null ? ` / ${i.maxUses}` : ''} {i.uses === 1 && i.maxUses == null ? 'use' : 'uses'} · {i.status === 'used' ? 'used up' : expiryText(i)}
                  {i.skipPassword ? ' · skips password' : ''}{i.isDefault ? ' · quick link' : ''} · by {i.createdBy}
                </span>
              </div>
              <div className="invite-item-actions">
                <button type="button" className="btn ghost small-btn" data-action="invite-copy" aria-label={`Copy invite link ${i.code}`} disabled={i.status !== 'ok'}
                  onClick={async () => { toast(await copyText(inviteUrl(location.origin, i.code)) ? 'Invite link copied' : inviteUrl(location.origin, i.code)); }}>Copy</button>
                {i.canRevoke && <button type="button" className="btn ghost small-btn" data-action="invite-revoke" aria-label={`Revoke invite link ${i.code}`} onClick={() => void revoke(i.code)}>Revoke</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreate={create} canSkip={canSkipPassword} passwordRequired={passwordRequired} />}
    </section>
  );
}
