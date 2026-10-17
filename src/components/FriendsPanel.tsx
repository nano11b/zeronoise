import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import type { FriendEntry, RoomState } from '../../shared/types';
import { call, socket } from '../socket';
import { NickLabel, UserAvatar } from './UserAvatar';

/**
 * Friends. Always mounted while the lobby is open (it listens for friend updates and incoming calls);
 * the list itself shows in the Friends dialog (open), the call banner shows either way.
 */
export function FriendsPanel({ onJoinCall, toast, open = true, onClose, onPending }: {
  onJoinCall: (room: RoomState) => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
  open?: boolean;
  onClose?: () => void;
  onPending?: (n: number) => void;
}) {
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [pendingIn, setPendingIn] = useState<FriendEntry[]>([]);
  const [pendingOut, setPendingOut] = useState<FriendEntry[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [incoming, setIncoming] = useState<{ from: FriendEntry; roomId: string } | null>(null);
  const onPendingRef = useRef(onPending);
  onPendingRef.current = onPending;

  const refresh = useCallback(async () => {
    try {
      const r = await call<{ friends: FriendEntry[]; pendingIn: FriendEntry[]; pendingOut: FriendEntry[] }>((ack) => socket.emit('friends:list', ack));
      setFriends(r.friends); setPendingIn(r.pendingIn); setPendingOut(r.pendingOut); onPendingRef.current?.(r.pendingIn.length);
    } catch { /* not signed in */ }
  }, []);

  useEffect(() => {
    refresh();
    const onUp = () => refresh();
    const onCall = (p: { from: FriendEntry; roomId: string; convoId?: string }) => { if (!p.convoId) setIncoming(p); }; // whisper calls ring in the top bar (W1-2)
    socket.on('friend:update', onUp);
    socket.on('call:incoming', onCall);
    return () => { socket.off('friend:update', onUp); socket.off('call:incoming', onCall); };
  }, [refresh]);

  const request = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await call((ack) => socket.emit('friends:request', { username: name.trim() }, ack));
      setName(''); toast('Friend request sent'); await refresh();
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const respond = async (userId: number, accept: boolean) => {
    try { await call((ack) => socket.emit('friends:respond', { userId, accept }, ack)); await refresh(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const remove = async (userId: number) => {
    try { await call((ack) => socket.emit('friends:remove', { userId }, ack)); await refresh(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const callFriend = async (userId: number) => {
    try {
      const r = await call<{ roomId: string; room: RoomState }>((ack) => socket.emit('call:invite', { userId }, ack));
      onJoinCall(r.room);
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const answer = async (accept: boolean) => {
    if (!incoming) return;
    const { roomId } = incoming;
    setIncoming(null);
    try {
      const r = await call<{ room?: RoomState }>((ack) => socket.emit('call:respond', { roomId, accept }, ack));
      if (accept && r.room) onJoinCall(r.room);
      else toast(accept ? 'Joined call' : 'Call declined');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const body = (
    <div className="friends-panel" data-panel="friends">
      <form onSubmit={request} className="inline-form" style={{ marginBottom: 10 }}>
        <input placeholder="Username" aria-label="Friend username" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required />
        <button className="btn primary small-btn" disabled={busy}>Add</button>
      </form>
      {pendingIn.length > 0 && (
        <div className="friend-section">
          <div className="muted small">Requests</div>
          <ul className="friend-list">
            {pendingIn.map((f) => (
              <li key={f.userId}>
                <UserAvatar nick={f.username} accountId={f.userId} chatColor={f.chatColor} hasAvatar={f.hasAvatar} size={20} />
                <NickLabel nick={f.username} chatColor={f.chatColor} chatEffect={f.chatEffect} />
                <button className="btn small-btn primary" onClick={() => respond(f.userId, true)}>Accept</button>
                <button className="btn small-btn ghost" onClick={() => respond(f.userId, false)}>Decline</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pendingOut.length > 0 && (
        <div className="friend-section">
          <div className="muted small">Outgoing</div>
          <ul className="friend-list">{pendingOut.map((f) => <li key={f.userId}><UserAvatar nick={f.username} accountId={f.userId} chatColor={f.chatColor} hasAvatar={f.hasAvatar} size={20} /><NickLabel nick={f.username} chatColor={f.chatColor} chatEffect={f.chatEffect} /><span className="muted small">pending</span></li>)}</ul>
        </div>
      )}
      <ul className="friend-list">
        {friends.map((f) => (
          <li key={f.userId}>
            <span className={`dot ${f.online ? 'live' : ''}`} />
            <UserAvatar nick={f.username} accountId={f.userId} chatColor={f.chatColor} hasAvatar={f.hasAvatar} size={20} />
            <NickLabel nick={f.username} chatColor={f.chatColor} chatEffect={f.chatEffect} className="nick" />
            {f.online && <button className="btn small-btn primary" onClick={() => callFriend(f.userId)} data-action="call">Call</button>}
            <button className="btn small-btn ghost" onClick={() => remove(f.userId)}>Remove</button>
          </li>
        ))}
        {friends.length === 0 && <li className="muted small">No friends yet.</li>}
      </ul>
    </div>
  );
  return (
    <>
      {open && (onClose ? <Sheet name="friends" title="Friends" onClose={onClose}>{body}</Sheet> : <aside className="panel"><h3>Friends</h3>{body}</aside>)}
      {incoming && (
        <div className="call-banner call-banner-float" role="alertdialog" aria-label="Incoming call">
          <strong>{incoming.from.username}</strong> is calling…
          <div className="row-actions">
            <button className="btn primary small-btn" onClick={() => answer(true)}>Accept</button>
            <button className="btn ghost small-btn" onClick={() => answer(false)}>Decline</button>
          </div>
        </div>
      )}
    </>
  );
}
