import { useEffect, useState } from 'react';
import { api } from '../api';
import { qrSvg } from '../../shared/qr';
import { createPasskey, getPasskey, passkeyError, passkeysSupported } from '../passkey';

interface PasskeyInfo { id: number; name: string; createdAt: number; lastUsedAt: number | null }
interface Status { enabled: boolean; enabledAt: number | null; recoveryLeft: number; required: boolean; canDisable: boolean; passkeys?: PasskeyInfo[] }

/** The code step after password / Discord / Google sign-in for an account with two-factor on. */
export function TwoFactorGate() {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api('/api/auth/2fa', { code }); location.replace('/' + location.search); }
    catch (e2) { setErr((e2 as Error).message); setBusy(false); }
  };
  const usePasskey = async () => {
    setBusy(true); setErr('');
    try {
      const o = await api<{ ticket: string; options: any }>('/api/auth/2fa/passkey/options', {});
      const credential = await getPasskey(o.options);
      await api('/api/auth/2fa/passkey', { ticket: o.ticket, credential });
      location.replace('/' + location.search);
    } catch (e2) { setErr(passkeyError(e2)); setBusy(false); }
  };
  const cancel = async () => { try { await api('/api/auth/2fa/cancel', {}); } catch { /* */ } location.replace('/'); };
  return (
    <main className="login">
      <section className="login-card">
        <h1 className="brand-title"><img className="lockup" src="/logo-lockup.png" alt="zeronoise" width={512} height={359} /></h1>
        <form className="tfa-gate" data-testid="tfa-gate" onSubmit={(e) => void submit(e)}>
          <h2>Two-step sign-in</h2>
          <label htmlFor="tfa-code" className="small">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</label>
          <input id="tfa-code" className="input tfa-code" autoComplete="one-time-code" inputMode="text" autoFocus maxLength={20}
            value={code} onChange={(e) => setCode(e.target.value)} data-testid="tfa-code" />
          {err && <p className="form-error" role="alert">{err}</p>}
          <button className="btn" type="submit" disabled={busy || code.trim().length < 6} data-action="tfa-verify">Verify</button>
          {passkeysSupported() && <button className="btn ghost" type="button" disabled={busy} data-action="tfa-passkey" onClick={() => void usePasskey()}>Use a passkey</button>}
          <button className="btn ghost" type="button" onClick={() => void cancel()} data-action="tfa-cancel">Cancel and sign out</button>
        </form>
      </section>
    </main>
  );
}

function RecoveryList({ codes }: { codes: string[] }) {
  const copy = () => { void navigator.clipboard?.writeText(codes.join('\n')).catch(() => {}); };
  return (
    <div className="tfa-codes" data-testid="tfa-recovery">
      <p className="small"><strong>Save these recovery codes now.</strong> Each works once if you lose your phone. They will not be shown again.</p>
      <ul>{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
      <button type="button" className="btn ghost small-btn" onClick={copy}>Copy codes</button>
    </div>
  );
}

/** Set up / manage two-factor. Used in the Profile dialog for everyone and in the admin panel's Security tab. */
export function TwoFactorSection({ adminView = false }: { adminView?: boolean }) {
  const [st, setSt] = useState<Status | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<Status>('/api/me/2fa').then(setSt).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  if (!st) return <p className="muted small">{err || 'Loading…'}</p>;
  return (
    <div className="tfa" data-testid="tfa-section" data-enabled={st.enabled ? '1' : '0'}>
      {adminView && <p className="small muted">Admins: two-factor is optional until you turn it on. After that it is required for your account at every sign-in, including Discord and Google.</p>}
      {st.enabled ? (
        <>
          <p className="small"><span className="tag status-ok">On</span> Since {new Date(st.enabledAt!).toLocaleDateString()} · {st.recoveryLeft} recovery code{st.recoveryLeft === 1 ? '' : 's'} left{st.required ? ' · required for admins' : ''}</p>
          {codes && <RecoveryList codes={codes} />}
          <div className="tfa-row">
            <input className="input tfa-code" placeholder="Current code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} aria-label="Current code" data-testid="tfa-manage-code" />
            <button type="button" className="btn ghost small-btn" disabled={busy || code.length < 6} data-action="tfa-new-codes"
              onClick={() => void run(async () => { const r = await api<Status & { recoveryCodes: string[] }>('/api/me/2fa/recovery', { code }); setCodes(r.recoveryCodes); setSt(r); setCode(''); })}>New recovery codes</button>
            {st.canDisable && <button type="button" className="btn ghost small-btn" disabled={busy || code.length < 6} data-action="tfa-disable"
              onClick={() => void run(async () => { const r = await api<Status>('/api/me/2fa/disable', { code }); setSt(r); setCodes(null); setCode(''); })}>Turn off</button>}
          </div>
        </>
      ) : setup ? (
        <>
          <ol className="small tfa-steps">
            <li>In your authenticator app (Google Authenticator, Aegis, 1Password, Authy…), scan this code, type the key below, or <a href={setup.otpauthUrl} data-testid="tfa-otpauth">open it in the app</a> on this phone.</li>
            <li className="tfa-qr-li"><span className="tfa-qr" data-testid="tfa-qr" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: qrSvg(setup.otpauthUrl, 4) }} /></li>
            <li><code className="tfa-secret" data-testid="tfa-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code></li>
            <li>Type the 6-digit code it shows.</li>
          </ol>
          <div className="tfa-row">
            <input className="input tfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-label="6-digit code" data-testid="tfa-enable-code" />
            <button type="button" className="btn small-btn" disabled={busy || code.length !== 6} data-action="tfa-enable"
              onClick={() => void run(async () => { const r = await api<Status & { recoveryCodes: string[] }>('/api/me/2fa/enable', { code }); setCodes(r.recoveryCodes); setSt(r); setSetup(null); setCode(''); })}>Turn on</button>
            <button type="button" className="btn ghost small-btn" onClick={() => { setSetup(null); setCode(''); }}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          {codes && <RecoveryList codes={codes} />}
          <p className="small muted">Off. Add a code from an authenticator app to every sign-in.</p>
          <button type="button" className="btn small-btn" disabled={busy} data-action="tfa-setup"
            onClick={() => void run(async () => { setSetup(await api('/api/me/2fa/setup', {})); })}>Set up two-factor</button>
        </>
      )}
      <PasskeyList st={st} setSt={setSt} setCodes={setCodes} run={run} busy={busy} />
      {err && <p className="form-error small" role="alert">{err}</p>}
    </div>
  );
}

function PasskeyList({ st, setSt, setCodes, run, busy }: { st: Status; setSt: (s: Status) => void; setCodes: (c: string[]) => void; run: (fn: () => Promise<void>) => Promise<void>; busy: boolean }) {
  const [name, setName] = useState('');
  const list = st.passkeys ?? [];
  return (
    <div className="tfa-passkeys" data-testid="passkeys" data-count={list.length}>
      <div className="muted small">Passkeys {list.length ? `(${list.length})` : ''}</div>
      {list.length > 0 && (
        <ul className="pk-list">
          {list.map((p) => (
            <li key={p.id} data-passkey={p.id}>
              <span>🔑 {p.name}</span> <span className="muted small">added {new Date(p.createdAt).toLocaleDateString()}{p.lastUsedAt ? ` · used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ''}</span>
              <button type="button" className="btn ghost small-btn" disabled={busy} data-action="passkey-remove"
                onClick={() => void run(async () => { setSt(await api<Status>(`/api/me/passkeys/${p.id}/remove`, {})); })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {passkeysSupported() ? (
        <div className="tfa-row">
          <input className="input" placeholder="Name (e.g. Phone)" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} aria-label="Passkey name" data-testid="passkey-name" />
          <button type="button" className="btn small-btn" disabled={busy} data-action="passkey-add"
            onClick={() => void run(async () => {
              const o = await api<{ ticket: string; options: any }>('/api/me/passkeys/options', {});
              let credential; try { credential = await createPasskey(o.options); } catch (e) { throw new Error(passkeyError(e)); }
              const r = await api<Status & { recoveryCodes?: string[] }>('/api/me/passkeys', { ticket: o.ticket, name, credential });
              setSt(r); setName(''); if (r.recoveryCodes) setCodes(r.recoveryCodes);
            })}>Add a passkey</button>
        </div>
      ) : <p className="small muted">This browser does not support passkeys.</p>}
      <p className="small muted">A passkey works as your second step, and on its own to sign in without a password.</p>
    </div>
  );
}
