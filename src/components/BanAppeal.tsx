import { useEffect, useState } from 'react';
import { APPEAL_MAX, APPEAL_MIN, type AppealInfo } from '../../shared/appeals';

interface State { banned: boolean; ban?: { id: number; reason: string; expiresAt: number | null }; appeal?: AppealInfo | null }

/** Shown on the blocked screen: one appeal per ban, then its status. */
export function BanAppeal() {
  const [st, setSt] = useState<State | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch('/api/appeal', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => { if (j.ok) setSt(j); }).catch(() => {});
  }, []);
  if (!st?.banned || !st.ban) return null;
  const a = st.appeal;
  if (a) {
    return (
      <div className="appeal-box" data-testid="appeal-status" data-status={a.status}>
        <h2>Your appeal</h2>
        <p className="small">{a.status === 'open' ? 'Sent. A moderator will review it. You can appeal each ban once.'
          : a.status === 'approved' ? 'Approved: the ban was lifted. Press Try again.' : 'Denied. The ban stays in place.'}</p>
        {a.note && <p className="small muted">Moderator note: {a.note}</p>}
        <blockquote className="small quoted">{a.text}</blockquote>
      </div>
    );
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await fetch('/api/appeal', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF': '1' }, body: JSON.stringify({ text }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Could not send');
      setSt({ ...st, appeal: j.appeal });
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const len = text.trim().length;
  return (
    <form className="appeal-box" data-testid="appeal-form" onSubmit={(e) => void submit(e)}>
      <h2>Appeal this ban</h2>
      <p className="small muted">Reason given: {st.ban.reason}{st.ban.expiresAt ? ` · ends ${new Date(st.ban.expiresAt).toLocaleString()}` : ''}</p>
      <label className="small" htmlFor="appeal-text">Tell the moderators why the ban should be lifted. You get one appeal per ban.</label>
      <textarea id="appeal-text" className="input" rows={4} maxLength={APPEAL_MAX} value={text} onChange={(e) => setText(e.target.value)} data-testid="appeal-text" />
      <p className="small muted">{len < APPEAL_MIN ? `At least ${APPEAL_MIN} characters (${len} so far)` : `${len}/${APPEAL_MAX}`}</p>
      {err && <p className="form-error" role="alert">{err}</p>}
      <button className="btn" type="submit" disabled={busy || len < APPEAL_MIN} data-action="appeal-submit">Send appeal</button>
    </form>
  );
}
