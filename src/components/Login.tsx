import { FormEvent, useEffect, useState } from 'react';
import { ThemePicker } from './ThemePicker';
import { LIMITS, TAGLINE } from '../../shared/config';
import type { CaptchaChallenge } from '../../shared/types';
import { api } from '../api';
import type { Account } from '../App';
import { peekPendingInvite } from '../invite';

const nickRe = new RegExp(LIMITS.nickPattern);
type Mode = 'signin' | 'register';

export function Login({ onAccount, mode, setMode, google, discord, tiktok }: {
  onAccount: (a: Account) => void; mode: Mode; setMode: (m: Mode) => void; google: boolean; discord: boolean; tiktok: boolean;
}) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [agree, setAgree] = useState(true);
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotMsg, setForgotMsg] = useState('');

  const switchMode = (m: Mode) => { setMode(m); setError(''); setForgotOpen(false); setForgotMsg(''); };
  const loadCaptcha = async () => {
    try {
      const r = await fetch('/api/auth/captcha').then((x) => x.json()) as CaptchaChallenge & { ok?: boolean };
      setCaptcha(r); setCaptchaAnswer('');
    } catch { setCaptcha(null); }
  };
  useEffect(() => { if (mode === 'register') loadCaptcha(); }, [mode]);

  const submitAccount = async (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim();
    if (mode === 'register') {
      if (!nickRe.test(u)) { setError(`Username: ${LIMITS.nickMin}-${LIMITS.nickMax} characters, letters, numbers, _ or -, starting with a letter.`); return; }
      if (password.length < LIMITS.passwordMin) { setError(`Password must be at least ${LIMITS.passwordMin} characters.`); return; }
      if (password !== password2) { setError('Passwords do not match.'); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter a valid email address.'); return; }
      if (!agree) { setError('Please confirm you are 18+ and agree to the rules.'); return; }
    }
    setBusy(true); setError('');
    try {
      const body: Record<string, string> = { username: u, password };
      if (mode === 'register') body.email = email.trim();
      const invite = mode === 'register' ? peekPendingInvite() : null;
      if (invite) body.invite = invite;
      if (mode === 'register' && captcha) {
        if (captcha.mode === 'builtin') { body.captchaId = captcha.id || ''; body.captchaAnswer = captchaAnswer; }
        else body.captchaToken = captchaAnswer; // site widget token stored in answer field for third-party
      }
      const r = await api<{ account: Account }>(mode === 'register' ? '/api/auth/register' : '/api/auth/login', body);
      onAccount(r.account);
    } catch (err) {
      setError((err as Error).message);
      if (mode === 'register') loadCaptcha();
    } finally { setBusy(false); }
  };

  const submitForgot = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setForgotMsg('');
    try {
      const r = await api<{ message: string }>('/api/auth/forgot', { username: username.trim() });
      setForgotMsg(r.message);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <main className="login">
      <div className="login-glow" aria-hidden />
      <section className="login-card">
        <h1 className="brand-title"><img className="lockup" src="/logo-lockup.png" alt="zeronoise" width={512} height={359} /></h1>
        <p className="muted">{TAGLINE}</p>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" className={`tab ${mode === 'signin' ? 'active' : ''}`} aria-selected={mode === 'signin'} data-tab="signin" onClick={() => switchMode('signin')}>Sign in</button>
          <button type="button" role="tab" className={`tab ${mode === 'register' ? 'active' : ''}`} aria-selected={mode === 'register'} data-tab="register" onClick={() => switchMode('register')}>Register</button>
        </div>
        <form onSubmit={forgotOpen ? (e) => e.preventDefault() : submitAccount} className="stack">
            <label className="field">
              <span>{forgotOpen ? 'Username or email' : 'Username'}</span>
              <input autoFocus name="username" autoComplete="username" value={username} maxLength={forgotOpen ? 254 : LIMITS.nickMax} onChange={(e) => setUsername(e.target.value)} />
            </label>
            {mode === 'register' && !forgotOpen && (
              <label className="field">
                <span>Email</span>
                <input name="email" type="email" autoComplete="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} required data-testid="register-email" />
              </label>
            )}
            <label className="field">
              <span>Password</span>
              <input name="password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} maxLength={LIMITS.passwordMax} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {mode === 'register' && (
              <>
                <label className="field">
                  <span>Repeat password</span>
                  <input name="password2" type="password" autoComplete="new-password" value={password2} maxLength={LIMITS.passwordMax} onChange={(e) => setPassword2(e.target.value)} />
                </label>
                {captcha?.mode === 'builtin' && (
                  <label className="field">
                    <span>CAPTCHA: {captcha.question}</span>
                    <input name="captcha" inputMode="numeric" value={captchaAnswer} onChange={(e) => setCaptchaAnswer(e.target.value)} data-testid="captcha" required autoComplete="off" />
                  </label>
                )}
                {captcha && captcha.mode !== 'builtin' && (
                  <p className="muted small">Complete the CAPTCHA widget (site key configured).</p>
                )}
                <label className="check">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                  <span>I'm 18+ and will be respectful. No harassment, spam or illegal content. I agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</span>
                </label>
              </>
            )}
            {error && <div className="form-error">{error}</div>}
            {forgotMsg && <div className="notice">{forgotMsg}</div>}
            {forgotOpen && mode === 'signin' ? (
              <>
                <button type="button" className="btn primary big" disabled={busy} onClick={submitForgot} data-action="forgot-submit">
                  {busy ? 'Please wait…' : 'Request reset'}
                </button>
                <button type="button" className="btn ghost" onClick={() => setForgotOpen(false)}>Back to sign in</button>
              </>
            ) : (
              <>
                <button type="submit" className="btn primary big" disabled={busy} data-action="account-submit">
                  {busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}
                </button>
                {mode === 'signin' && (
                  <button type="button" className="link-btn" data-action="forgot" onClick={() => { setForgotOpen(true); setError(''); }}>
                    Forgot password?
                  </button>
                )}
              </>
            )}
            {google && !forgotOpen && <a className="btn ghost big center" href="/api/auth/google" data-action="oauth-google">Continue with Google</a>}
            {discord && !forgotOpen && <a className="btn big center discord-btn" href="/api/auth/discord" data-action="oauth-discord">Continue with Discord</a>}
            {tiktok && !forgotOpen && <a className="btn big center tiktok-btn" href={/zeronoise\//.test(navigator.userAgent) ? '/api/auth/google?provider=tiktok' : '/api/auth/tiktok'} data-action="oauth-tiktok">Sign in with TikTok</a>}
            {mode === 'register' && <p className="muted small center">Your email is private. Other people only see your username.</p>}
        </form>
        <ul className="feature-pills">
          <li>Public rooms</li><li>Webcam + voice</li><li>Private messages</li><li>Account required</li>
        </ul>
        <p className="muted small center legal-links"><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>
        <p className="muted small center get-app"><a href="/download">Get the app</a></p>
        <details className="login-theme"><summary className="muted small center">Theme</summary><ThemePicker /></details>
      </section>
    </main>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return <img src="/logo-mark.png" width={size} height={size} alt="" className="logo" />;
}
