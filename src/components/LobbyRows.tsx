import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomSummary } from '../../shared/types';
import type { FriendOnline, RecentRoom } from '../../shared/lobby';
import { call, socket } from '../socket';
import { useEscape } from '../a11y';
import { Lazy, lazyNamed } from '../lazy';
import { unreadBadge } from '../util';
import { UserAvatar } from './UserAvatar';

const ProfileCard = lazyNamed(() => import('./ProfileCard'), 'ProfileCard');

/** Room to open from a row; a password room goes through the lobby's password prompt. */
export interface RowRoom { id: string; name: string; passwordRequired: boolean }

const KEY = (k: 'friends' | 'recent' | 'active') => `camchat.lobbyRow.${k}`;
const lastCount = (k: 'friends' | 'recent' | 'active') => { try { return Math.min(6, Number(localStorage.getItem(KEY(k))) || 0); } catch { return 0; } };
const saveCount = (k: 'friends' | 'recent' | 'active', n: number) => { try { localStorage.setItem(KEY(k), String(n)); } catch { /* ignore */ } };

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function RowSkeleton({ n, label }: { n: number; label: string }) {
  return (
    <section className="lobby-row is-loading" aria-busy="true" aria-label={label}>
      <h3 className="lr-title"><span className="sk-line tiny" /></h3>
      <div className="lr-scroll" aria-hidden>
        {Array.from({ length: n }, (_, i) => <div key={i} className="lr-card lr-skeleton"><span className="sk-line" /><span className="sk-line short" /></div>)}
      </div>
    </section>
  );
}

function FriendCard({ f, onJoin, onPm, onProfile }: { f: FriendOnline; onJoin: (r: RowRoom) => void; onPm: (f: FriendOnline) => void; onProfile: (nick: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const moreRef = useRef<HTMLButtonElement>(null);
  useEscape(open, () => setOpen(false), moreRef);
  useEffect(() => {
    if (!open) return;
    // the row scrolls sideways (and clips), so the menu is placed in the viewport next to its button
    const place = () => {
      const r = moreRef.current?.getBoundingClientRect();
      if (!r) return;
      const w = 176;
      setPos({ top: Math.min(r.bottom + 4, window.innerHeight - 100), left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) });
    };
    place();
    const off = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(`[data-friend-card="${f.userId}"]`)) setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('click', off);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('click', off); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [open, f.userId]);
  const primary = () => (f.room ? onJoin({ id: f.room.id, name: f.room.name, passwordRequired: false }) : onPm(f));
  return (
    <div className="lr-card lr-friend" role="listitem" data-friend-card={f.userId}>
      <button type="button" className="lr-main" onClick={primary} data-action="friend-join"
        aria-label={f.room ? `Join ${f.username} in #${f.room.name}` : `Message ${f.username}`}>
        <UserAvatar nick={f.username} accountId={f.userId} chatColor={f.chatColor} hasAvatar={f.hasAvatar} size={36} />
        <span className="lr-text">
          <span className="lr-name"><span className="lr-nt">{f.username}</span></span>
          <span className="lr-sub">{f.room ? <>in <strong>#{f.room.name}</strong></> : 'online'}</span>
        </span>
      </button>
      <button ref={moreRef} type="button" className="lr-more" aria-label={`More for ${f.username}`} aria-haspopup="menu" aria-expanded={open}
        data-action="friend-more" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>⋯</button>
      {open && (
        <div className="menu lr-menu" role="menu" aria-label={`${f.username} actions`} style={{ top: pos.top, left: pos.left }}>
          <button type="button" role="menuitem" data-action="friend-pm" onClick={() => { setOpen(false); onPm(f); }}>Message</button>
          <button type="button" role="menuitem" data-action="friend-profile" onClick={() => { setOpen(false); onProfile(f.username); }}>View profile</button>
        </div>
      )}
    </div>
  );
}

export function LobbyRows({ signedIn, rooms, roomsLoaded, busy, onJoin, openPm, toast, isIgnored, toggleIgnore }: {
  signedIn: boolean;
  rooms: RoomSummary[];
  roomsLoaded: boolean;
  busy: boolean;
  onJoin: (r: RowRoom) => void;
  openPm: (t: { id: string; nick: string }) => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
  isIgnored: (nick: string) => boolean;
  toggleIgnore: (nick: string) => void;
}) {
  const [friends, setFriends] = useState<FriendOnline[] | null>(null);
  const [recent, setRecent] = useState<RecentRoom[] | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const loadFriends = useCallback(async () => {
    if (!signedIn) { setFriends([]); return; }
    try {
      const r = await call<{ friends: FriendOnline[] }>((ack) => socket.emit('lobby:friends', ack));
      setFriends(r.friends); saveCount('friends', r.friends.length);
    } catch { setFriends((f) => f ?? []); }
  }, [signedIn]);
  const loadRecent = useCallback(async () => {
    if (!signedIn) { setRecent([]); return; }
    try {
      const r = await call<{ rooms: RecentRoom[] }>((ack) => socket.emit('lobby:recent', ack));
      setRecent(r.rooms); saveCount('recent', r.rooms.length);
    } catch { setRecent((x) => x ?? []); }
  }, [signedIn]);

  useEffect(() => {
    void loadFriends(); void loadRecent();
    const onFriend = (p: { userId: number; entry: FriendOnline | null }) => setFriends((prev) => {
      const rest = (prev ?? []).filter((f) => f.userId !== p.userId);
      const next = p.entry ? [...rest, p.entry] : rest;
      return next.sort((a, b) => Number(!!b.room) - Number(!!a.room) || a.username.localeCompare(b.username));
    });
    const onFriendList = () => { void loadFriends(); };
    // unread counts on "Jump back in" follow room activity (debounced)
    let t: number | undefined;
    const onActivity = () => { window.clearTimeout(t); t = window.setTimeout(() => { void loadRecent(); }, 1500); };
    const onConnect = () => { void loadFriends(); void loadRecent(); };
    socket.on('lobby:friend', onFriend);
    socket.on('friend:update', onFriendList);
    socket.on('room:activity', onActivity);
    socket.on('connect', onConnect);
    const clock = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      socket.off('lobby:friend', onFriend); socket.off('friend:update', onFriendList); socket.off('room:activity', onActivity); socket.off('connect', onConnect);
      window.clearTimeout(t); window.clearInterval(clock);
    };
  }, [loadFriends, loadRecent]);

  const remove = async (r: RecentRoom) => {
    setRecent((prev) => (prev ?? []).filter((x) => x.id !== r.id));
    try { await call((ack) => socket.emit('lobby:recent:remove', { roomId: r.id }, ack)); }
    catch (e) { toast((e as Error).message, 'error'); void loadRecent(); }
  };
  const pm = (f: FriendOnline) => { if (f.socketId) openPm({ id: f.socketId, nick: f.username }); };

  const shownFriends = (friends ?? []).filter((f) => !isIgnored(f.username));
  const active = rooms.filter((r) => r.active).sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0)).slice(0, 8);
  useEffect(() => { if (roomsLoaded) saveCount('active', active.length); }, [roomsLoaded, active.length]);

  return (
    <div className="lobby-rows" data-testid="lobby-rows">
      {signedIn && friends === null && lastCount('friends') > 0 && <RowSkeleton n={lastCount('friends')} label="Friends online now" />}
      {shownFriends.length > 0 && (
        <section className="lobby-row" data-row="friends" aria-labelledby="lr-friends">
          <h3 className="lr-title" id="lr-friends">Friends online now <span className="lr-count">{shownFriends.length}</span></h3>
          <div className="lr-scroll" role="list">
            {shownFriends.map((f) => <FriendCard key={f.userId} f={f} onJoin={onJoin} onPm={pm} onProfile={setProfile} />)}
          </div>
        </section>
      )}
      {!roomsLoaded && lastCount('active') > 0 && <RowSkeleton n={lastCount('active')} label="Active now" />}
      {active.length > 0 && (
        <section className="lobby-row" data-row="active" aria-labelledby="lr-active">
          <h3 className="lr-title" id="lr-active">Active now</h3>
          <div className="lr-scroll" role="list">
            {active.map((r) => (
              <div key={r.id} className="lr-card lr-room" role="listitem">
                <button type="button" className="lr-main" disabled={busy} data-active-room={r.id} onClick={() => onJoin({ id: r.id, name: r.name, passwordRequired: r.passwordRequired })}
                  aria-label={`Join #${r.name}, ${r.users} ${r.users === 1 ? 'person' : 'people'}${r.broadcasters ? `, ${r.broadcasters} live` : ''}`}>
                  {r.thumbUrl ? <span className="lr-thumb" style={{ backgroundImage: `url("${r.thumbUrl}")` }} aria-hidden /> : <span className="lr-thumb lr-thumb-blank" aria-hidden>#</span>}
                  <span className="lr-text">
                    <span className="lr-name"><span className="lr-nt">#{r.name}</span></span>
                    <span className="lr-sub"><span className="tag hot">🔥 active</span> {r.users} {r.users === 1 ? 'person' : 'people'}{r.broadcasters > 0 ? ` · ● ${r.broadcasters} live` : ''}</span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {signedIn && recent === null && lastCount('recent') > 0 && <RowSkeleton n={lastCount('recent')} label="Jump back in" />}
      {(recent?.length ?? 0) > 0 && (
        <section className="lobby-row" data-row="recent" aria-labelledby="lr-recent">
          <h3 className="lr-title" id="lr-recent">Jump back in</h3>
          <div className="lr-scroll" role="list">
            {recent!.map((r) => (
              <div key={r.id} className="lr-card lr-room" role="listitem" data-recent-room={r.id}>
                <button type="button" className="lr-main" disabled={busy} onClick={() => onJoin({ id: r.id, name: r.name, passwordRequired: r.passwordRequired })}
                  aria-label={`Back to #${r.name}, visited ${ago(r.visitedAt)}${r.unread ? `, ${r.unread} new` : ''}${r.mentions ? `, ${r.mentions} mention${r.mentions === 1 ? '' : 's'}` : ''}`}>
                  {r.thumbUrl ? <span className="lr-thumb" style={{ backgroundImage: `url("${r.thumbUrl}")` }} aria-hidden /> : <span className="lr-thumb lr-thumb-blank" aria-hidden>#</span>}
                  <span className="lr-text">
                    <span className="lr-name">{r.iconUrl && <img className="room-icon-mini" src={r.iconUrl} alt="" width={20} height={20} loading="lazy" data-room-icon-mini="1" />}<span className="lr-nt">#{r.name}</span>{r.unread > 0 && <span className={`badge${r.mentions ? ' mention' : ''}`} data-recent-unread={r.unread}>{r.mentions ? `@${r.mentions}` : unreadBadge(r.unread)}</span>}</span>
                    <span className="lr-sub">{ago(r.visitedAt)}{r.passwordRequired ? ' · password' : ''}</span>
                  </span>
                </button>
                <button type="button" className="lr-remove" aria-label={`Remove #${r.name} from Jump back in`} data-action="recent-remove" onClick={() => void remove(r)}>✕</button>
              </div>
            ))}
          </div>
        </section>
      )}
      {profile && (
        <Lazy fallback={null}><ProfileCard nick={profile} onClose={() => setProfile(null)} toast={toast} isIgnored={isIgnored(profile)}
          toggleIgnore={() => toggleIgnore(profile)} openPm={(t) => { setProfile(null); openPm(t); }} /></Lazy>
      )}
    </div>
  );
}

