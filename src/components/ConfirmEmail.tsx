import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import type { Account } from '../App';
import { peekPendingInvite } from '../invite';
import { Logo } from './Login';

/** Blocking (or opened from the banner) screen to add or confirm the signed-in address. */
export function ConfirmEmail({ account, onAccount, onSignOut, blocked, onClose }: {
  account: Account; onAccount: (a: Account) => void; onSignOut: () => void; blocked: boolean; onClose?: () => void;
}) {
  const [email, setEmail] = useState(account.email ?? '');
  const [editing, setEditing] = useState(!account.email);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(account.email ? `We sent a confirmation link and a 6-digit code to ${account.email}.` : '');
  const [busy, setBusy] = useState(false);

  const saveEmail = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ account: Account }>('/api/me/email', { email: email.trim() });
      onAccount(r.account);
      setEditing(false);
      setNotice(`We sent a confirmation link and a 6-digit code to ${r.account.email}.`);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ account: Account }>('/api/auth/verify-email/send', peekPendingInvite() ? { invite: peekPendingInvite() } : {});
      onAccount(r.account);
      setNotice(`Sent again to ${r.account.email}.`);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ account: Account }>('/api/auth/verify-email', { code: code.trim() });
      onAccount(r.account);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <main className="login">
      <section className="login-card" data-testid="confirm-email">
        <Logo size={48} />
        <h1 className="brand-title">Confirm your email</h1>
        <p className="muted">{blocked
          ? 'Add and confirm an email before you can enter a room. This address is only visible to you and moderators.'
          : 'Confirming your email lets you reset your password. You can keep using rooms while you do.'}</p>
        {account.email && !editing ? (
          <>
            <p>Address: <strong data-testid="confirm-address">{account.email}</strong></p>
            {notice && <div className="notice">{notice}</div>}
            <form onSubmit={submitCode} className="stack">
              <label className="field">
                <span>6-digit code</span>
                <input name="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} data-testid="confirm-code" />
              </label>
              {error && <div className="form-error">{error}</div>}
              <button className="btn primary big" disabled={busy || code.trim().length < 6}>{busy ? 'Please wait…' : 'Confirm'}</button>
            </form>
            <div className="stack">
              <button type="button" className="btn ghost" disabled={busy} onClick={resend} data-action="resend-email">Resend email</button>
              <button type="button" className="btn ghost" onClick={() => { setEditing(true); setError(''); }} data-action="change-email">Change address</button>
            </div>
          </>
        ) : (
          <form onSubmit={saveEmail} className="stack">
            <label className="field">
              <span>Email</span>
              <input name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="add-email" />
            </label>
            {error && <div className="form-error">{error}</div>}
            <button className="btn primary big" disabled={busy}>{busy ? 'Please wait…' : 'Save and send confirmation'}</button>
            {account.email && <button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>}
          </form>
        )}
        {!blocked && onClose && <button type="button" className="btn ghost" onClick={onClose}>Back to rooms</button>}
        <button type="button" className="link-btn" onClick={onSignOut} data-action="sign-out">Sign out</button>
      </section>
    </main>
  );
}

/** Lands on /verify-email?token=… from the message. */
export function VerifyFromLink({ token, onDone }: { token: string; onDone: (a: Account) => void }) {
  const [error, setError] = useState('');
  const done = useState(() => onDone)[0];
  useEffect(() => {
    let cancel = false;
    api<{ account: Account }>('/api/auth/verify-email', { token })
      .then((r) => { if (!cancel) done(r.account); })
      .catch((e) => { if (!cancel) setError((e as Error).message); });
    return () => { cancel = true; };
  }, [token, done]);
  return (
    <main className="login">
      <section className="login-card">
        <Logo size={48} />
        <h1 className="brand-title">Confirm your email</h1>
        {error ? <div className="form-error">{error}</div> : <p className="muted">Checking that link…</p>}
      </section>
    </main>
  );
}
