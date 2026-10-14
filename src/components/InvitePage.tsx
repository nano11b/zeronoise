import { useEffect, useState } from 'react';
import type { InvitePublic, InviteStatus } from '../../shared/invites';
import { CATEGORY_LABEL, isRoomCategory } from '../../shared/batch3';
import { api } from '../api';

const DEAD: Record<Exclude<InviteStatus, 'ok'>, { title: string; text: string }> = {
  expired: { title: 'This invite has expired', text: 'Invite links stop working after a while. Ask whoever sent it for a fresh one.' },
  used: { title: 'This invite has been used up', text: 'It reached its limit of people. Ask whoever sent it for a new link.' },
  revoked: { title: 'This invite was turned off', text: 'The room owner revoked this link. Ask them for a new one.' },
  notfound: { title: 'This invite link doesn’t work', text: 'It may be mistyped, or the room is gone. You can still look around the open rooms.' },
};

/** Landing page for /i/<code>: who you are invited by is not shown; just the room, as much as the link allows. */
export function InvitePage({ code, signedIn, onJoin, onAuth, onHome }: {
  code: string;
  /** null while the session probe is still running */
  signedIn: boolean | null;
  onJoin: () => void;
  onAuth: (mode: 'signin' | 'register') => void;
  onHome: () => void;
}) {
  const [info, setInfo] = useState<InvitePublic | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancel = false;
    api<{ invite: InvitePublic }>(`/api/invites/${encodeURIComponent(code)}`)
      .then((r) => { if (!cancel) setInfo(r.invite); })
      .catch((e) => { if (!cancel) setError((e as Error).message); });
    return () => { cancel = true; };
  }, [code]);
  const ok = info?.status === 'ok';
  // Signed in and the link is good: straight into the room.
  useEffect(() => { if (ok && signedIn) onJoin(); }, [ok, signedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const room = info?.room;
  const cat = room?.category && isRoomCategory(room.category) ? CATEGORY_LABEL[room.category] : null;
  return (
    <main className="login invite-page" data-testid="invite-page">
      <section className="login-card invite-card" data-invite-status={info?.status ?? (error ? 'error' : 'loading')}>
        <img className="lockup invite-lockup" src="/logo-lockup.png" alt="zeronoise" width={512} height={359} />
        {!info && !error && <p className="muted">Checking your invite…</p>}
        {error && (
          <>
            <h1 className="invite-title">Couldn’t check this invite</h1>
            <p className="muted">{error}</p>
            <button type="button" className="btn primary" data-action="invite-home" onClick={onHome}>Go to the lobby</button>
          </>
        )}
        {info && !ok && (
          <div data-testid="invite-dead">
            <h1 className="invite-title">{DEAD[info.status as Exclude<InviteStatus, 'ok'>].title}</h1>
            <p className="muted">{DEAD[info.status as Exclude<InviteStatus, 'ok'>].text}</p>
            <button type="button" className="btn primary" data-action="invite-home" onClick={onHome}>Browse open rooms</button>
          </div>
        )}
        {ok && room && (
          <div data-testid="invite-ok">
            <p className="muted small invite-kicker">You’re invited to</p>
            <div className="invite-room">
              <span className="invite-room-icon" aria-hidden>{room.iconUrl ? <img src={room.iconUrl} alt="" width={56} height={56} /> : (room.name || '?').slice(0, 1).toUpperCase()}</span>
              <div className="invite-room-text">
                <h1 className="invite-title">#{room.name}</h1>
                {room.topic && <p className="muted">{room.topic}</p>}
                <p className="small invite-meta">
                  {cat && <span className="cat-tag">{cat}</span>}
                  {room.users != null && <span className="invite-online"><span className="dot" aria-hidden /> {room.users} online now</span>}
                  {room.passwordRequired && (info.skipPassword ? <span className="tag">no password needed</span> : <span className="tag">password needed</span>)}
                </p>
              </div>
            </div>
            {signedIn === false && (
              <div className="invite-actions">
                <button type="button" className="btn primary" data-action="invite-register" onClick={() => onAuth('register')}>Create an account to join</button>
                <button type="button" className="btn ghost" data-action="invite-signin" onClick={() => onAuth('signin')}>I have an account</button>
              </div>
            )}
            {signedIn && <p className="muted">Joining…</p>}
          </div>
        )}
      </section>
    </main>
  );
}
