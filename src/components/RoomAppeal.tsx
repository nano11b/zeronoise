import { useEffect, useState } from 'react';
import { call, socket } from '../socket';
import { APPEAL_MAX, APPEAL_MIN, type RoomAppealInfo } from '../../shared/appeals';

interface St { banned: boolean; ban?: { id: number; reason: string | null; expiresAt: number | null }; appeal?: RoomAppealInfo | null; canAppeal?: boolean }

/** Shown in the lobby after "You are banned from this room": one appeal per room ban, decided by the room's managers. */
export function RoomAppeal({ roomId, roomName, onClose }: { roomId: string; roomName: string; onClose: () => void }) {
  const [st, setSt] = useState<St | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { call<St>((ack) => socket.emit('roomappeal:status', { roomId }, ack)).then(setSt).catch((e) => setErr((e as Error).message)); }, [roomId]);
  if (!st) return err ? <p className="form-error small">{err}</p> : null;
  if (!st.banned) return null;
  const a = st.appeal;
  const len = text.trim().length;
  return (
    <section className="appeal-box room-appeal" data-testid="room-appeal" data-status={a?.status ?? 'none'}>
      <div className="row-between"><h2>Banned from #{roomName}</h2><button type="button" className="btn ghost small-btn" onClick={onClose} aria-label="Close">✕</button></div>
      <p className="small muted">Reason: {st.ban?.reason || 'none given'}{st.ban?.expiresAt ? ` · ends ${new Date(st.ban.expiresAt).toLocaleString()}` : ''}</p>
      {a ? (
        <>
          <p className="small">{a.status === 'open' ? 'Appeal sent. The room owner or a moderator will review it. You can appeal each ban once.'
            : a.status === 'approved' ? 'Approved: you can join the room again.' : 'Denied. The ban stays in place.'}</p>
          {a.note && <p className="small muted">Note: {a.note}</p>}
          <blockquote className="small quoted">{a.text}</blockquote>
        </>
      ) : !st.canAppeal ? <p className="small">Sign in with an account to appeal this ban.</p> : (
        <form onSubmit={(e) => { e.preventDefault(); setBusy(true); setErr(''); call<{ appeal: RoomAppealInfo }>((ack) => socket.emit('roomappeal:submit', { roomId, text }, ack)).then((r) => setSt({ ...st, appeal: r.appeal })).catch((e2) => setErr((e2 as Error).message)).finally(() => setBusy(false)); }}>
          <label className="small" htmlFor="room-appeal-text">Tell the room's moderators why the ban should be lifted.</label>
          <textarea id="room-appeal-text" className="input" rows={3} maxLength={APPEAL_MAX} value={text} onChange={(e) => setText(e.target.value)} data-testid="room-appeal-text" />
          <p className="small muted">{len < APPEAL_MIN ? `At least ${APPEAL_MIN} characters (${len} so far)` : `${len}/${APPEAL_MAX}`}</p>
          {err && <p className="form-error small" role="alert">{err}</p>}
          <button className="btn" type="submit" disabled={busy || len < APPEAL_MIN} data-action="room-appeal-submit">Send appeal</button>
        </form>
      )}
    </section>
  );
}
