import { FormEvent, useState } from 'react';
import { APP_NAME, LIMITS } from '../../shared/config';
import { api } from '../api';
import type { Account } from '../App';
import { Logo } from './Login';

export function ResetPassword({ token, onDone }: { token: string; onDone: (a: Account) => void }) {
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < LIMITS.passwordMin) { setError(`At least ${LIMITS.passwordMin} characters.`); return; }
    if (password !== password2) { setError('Passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      const r = await api<{ account: Account | null; twoFactor?: boolean }>('/api/auth/reset', { token, password });
      if (r.twoFactor || !r.account) { location.replace('/'); return; }
      onDone(r.account);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <main className="login">
      <section className="login-card">
        <Logo size={48} />
        <h1 className="brand-title">Reset password</h1>
        <p className="muted">Choose a new password for your zeronoise account.</p>
        <form onSubmit={submit} className="stack">
          <label className="field"><span>New password</span>
            <input type="password" autoComplete="new-password" value={password} maxLength={LIMITS.passwordMax} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          <label className="field"><span>Repeat password</span>
            <input type="password" autoComplete="new-password" value={password2} maxLength={LIMITS.passwordMax} onChange={(e) => setPassword2(e.target.value)} />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn primary big" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
        </form>
      </section>
    </main>
  );
}
