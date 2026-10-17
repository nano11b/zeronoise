import { FormEvent, useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { LIMITS } from '../../shared/config';
import type { RoomState, RoomSummary, UserInfo } from '../../shared/types';
import type { Account } from '../App';
import { applyAudioOutputToDocument } from '../mediaDevices';
import { call, socket } from '../socket';
import { Lazy, lazyNamed } from '../lazy';
import { useModal } from '../a11y';

const AvSettings = lazyNamed(() => import('./AvSettings'), 'AvSettings');
// friends online / active now / jump back in: its own chunk so the first paint stays small
const LobbyRows = lazyNamed(() => import('./LobbyRows'), 'LobbyRows');
import { unreadBadge } from '../util';
import { FriendsPanel } from './FriendsPanel';
import { RadioPlayer } from './RadioPlayer';
import { GamesButton, GamesSlot } from './GamesSlot';
import { SiteBar } from './SiteBar';
import { Icon, IconAction } from '../icons';
import { THUMB_ACCEPT, thumbFileError, uploadRoomThumb } from './RoomThumb';
import { ICON_ACCEPT, RoomIconMini, iconFileError, uploadRoomIcon } from './RoomIcon';
import { CATEGORY_ICON, CATEGORY_LABEL, ROOM_CATEGORIES, cleanTags, type RoomCategory } from '../../shared/batch3';
import { CategorySelect, CategoryTag, TagList } from './RoomMeta';

const SKELETON_KEY = 'camchat.lobbyRooms';
function skeletonCount(): number {
  try { const n = Number(localStorage.getItem(SKELETON_KEY)); if (Number.isFinite(n) && n > 0) return Math.min(12, Math.round(n)); } catch { /* ignore */ }
  return 4;
}

export function Lobby({ me, account, onJoined, toast, signOut, wantAccount, openAdmin, onAccount, onGames, roomUnread, openPm, ignored, toggleIgnore, askRoom }: {
  me: UserInfo; account: Account | null; onJoined: (r: RoomState, password?: string) => void; toast: (t: string, tone?: 'error' | 'info') => void;
  signOut: () => void; wantAccount: (m: 'signin' | 'register') => void; openAdmin: () => void;
  onAccount: (a: Account) => void;
  onGames: () => void;
  roomUnread: Record<string, { n: number; mention: boolean }>;
  openPm?: (t: { id: string; nick: string }) => void;
  ignored?: Set<string>;
  toggleIgnore?: (nick: string) => void;
  /** followed an invite to a password room whose link does not skip it */
  askRoom?: { id: string; name: string; n: number } | null;
}) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  // Until the first list arrives, placeholder cards hold the grid's height so the page does not jump.
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [roomPw, setRoomPw] = useState('');
  const [filter, setFilter] = useState('');
  const [catFilter, setCatFilter] = useState<RoomCategory | ''>('');
  const [activeFirst, setActiveFirst] = useState(false);
  const [newCat, setNewCat] = useState('');
  const [newVoice, setNewVoice] = useState(false);
  const [newTags, setNewTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [askPw, setAskPw] = useState<RoomSummary | null>(null);
  // an invite to a password room (link does not skip it): ask for the password right away
  useEffect(() => { if (askRoom) { setAskPw({ id: askRoom.id, name: askRoom.name, passwordRequired: true } as RoomSummary); setJoinPw(''); } }, [askRoom?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const [joinPw, setJoinPw] = useState('');
  const [avOpen, setAvOpen] = useState(false);
  // Friends and Start a room open as dialogs from the profile menu (and the Start a room button by the room list).
  // A room page sends people here with zn.lobbyOpen = 'friends' | 'create'.
  const [sheet, setSheet] = useState<'friends' | 'create' | null>(() => {
    try { const v = sessionStorage.getItem('zn.lobbyOpen'); sessionStorage.removeItem('zn.lobbyOpen'); return v === 'friends' || v === 'create' ? v : null; } catch { return null; }
  });
  const [friendRequests, setFriendRequests] = useState(0);
  const [newThumb, setNewThumb] = useState<File | null>(null);
  const thumbRef = useRef<HTMLInputElement>(null);
  const [newIcon, setNewIcon] = useState<File | null>(null);
  const iconRef = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLFormElement>(null);
  useModal(askRef, () => setAskPw(null), !!askPw);

  useEffect(() => {
    const got = (r: RoomSummary[]) => {
      setRooms(r);
      setRoomsLoaded(true);
      try { localStorage.setItem(SKELETON_KEY, String(r.length)); } catch { /* ignore */ }
    };
    let alive = true;
    let have = false;
    let retry: number | undefined;
    const onRooms = (r: RoomSummary[]) => { have = true; got(r); };
    // Ask for the list now and again after every (re)connect. An ask sent just before a reconnect loses its
    // answer, and the server only pushes 'rooms' on changes, so without this the lobby could stay empty.
    const ask = (attempt = 0) => {
      call<{ rooms: RoomSummary[] }>((ack) => socket.emit('rooms:list', ack), 6000).then((r) => { if (alive) { have = true; got(r.rooms); } }).catch(() => {
        if (!alive || have) return;
        setRoomsLoaded(true);
        if (attempt < 5) retry = window.setTimeout(() => ask(attempt + 1), 1000);
      });
    };
    const onConnect = () => ask();
    socket.on('rooms', onRooms);
    socket.on('connect', onConnect);
    ask();
    return () => { alive = false; window.clearTimeout(retry); socket.off('rooms', onRooms); socket.off('connect', onConnect); };
  }, []);

  const join = async (roomId: string, password?: string) => {
    setBusy(true);
    try {
      const r = await call<{ room: RoomState }>((ack) => socket.emit('room:join', password ? { roomId, password } : { roomId }, ack));
      onJoined(r.room, password);
      setAskPw(null);
      setJoinPw('');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const password = roomPw.trim();
      const parsedTags = cleanTags(newTags);
      if ('error' in parsedTags) throw new Error(parsedTags.error);
      const meta = { ...(newCat ? { category: newCat } : {}), ...(parsedTags.tags.length ? { tags: parsedTags.tags } : {}) };
      const r = await call<{ roomId: string }>((ack) => socket.emit('room:create', { name, topic, ...(password ? { password } : {}), ...(newVoice ? { voice: true } : {}), ...meta }, ack));
      setName(''); setTopic(''); setRoomPw(''); setNewCat(''); setNewTags('');
      if (newThumb) {
        // optional: a failed thumbnail never blocks the new room; it can be set later from the room info tab
        try { await uploadRoomThumb(r.roomId, newThumb); } catch (err) { toast(`Room created, but the thumbnail failed: ${(err as Error).message}`, 'error'); }
        setNewThumb(null);
        if (thumbRef.current) thumbRef.current.value = '';
      }
      if (newIcon) {
        try { await uploadRoomIcon(r.roomId, newIcon); } catch (err) { toast(`Room created, but the icon failed: ${(err as Error).message}`, 'error'); }
        setNewIcon(null);
        if (iconRef.current) iconRef.current.value = '';
      }
      await join(r.roomId, password || undefined);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const total = rooms.reduce((a, r) => a + r.users, 0);
  // text filter matches name, topic, category and tags; "#tag" matches a tag exactly
  const q = filter.trim().toLowerCase();
  const shown = rooms.filter((r) => {
    if (catFilter && r.category !== catFilter) return false;
    if (!q) return true;
    if (q.startsWith('#') && q.length > 1) return (r.tags ?? []).some((t) => t === q.slice(1)) || r.name.toLowerCase().includes(q.slice(1));
    const hay = [r.name, r.topic, r.category ? CATEGORY_LABEL[r.category as RoomCategory] ?? '' : '', ...(r.tags ?? [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (activeFirst) shown.sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0));
  const catCounts = rooms.reduce<Record<string, number>>((acc, r) => { if (r.category) acc[r.category] = (acc[r.category] ?? 0) + 1; return acc; }, {});

  return (
    <div className="lobby">
      <SiteBar
        me={me} account={account} onAccount={onAccount} toast={toast} signOut={signOut} openAdmin={openAdmin} wantAccount={wantAccount} showGuestActions
        onAudioVideo={() => setAvOpen(true)}
        onFriends={account ? () => setSheet('friends') : undefined}
        onStartRoom={() => setSheet('create')}
        friendRequests={friendRequests}
        extras={<><GamesButton onOpen={onGames} /><span className="muted small top-count">{total} online now</span></>}
      >
        <IconAction label="Rooms" icon="home" className="ghost on" data-action="nav-rooms" aria-current="page" />
        <RadioPlayer />
      </SiteBar>
      <main className="lobby-main">
        <section>
          <GamesSlot />
          <Lazy fallback={null}>
            <LobbyRows signedIn={!!account} rooms={rooms} roomsLoaded={roomsLoaded} busy={busy} toast={toast}
              onJoin={(r) => { if (r.passwordRequired) { setAskPw({ id: r.id, name: r.name } as RoomSummary); setJoinPw(''); } else void join(r.id); }}
              openPm={(t) => openPm?.(t)} isIgnored={(n) => !!ignored?.has(n.toLowerCase())} toggleIgnore={(n) => toggleIgnore?.(n)} />
          </Lazy>
          <div className="section-head">
            <h2>Rooms</h2>
            <button type="button" className="btn primary small-btn start-room-btn" data-action="create-room" onClick={() => setSheet('create')}><Icon name="plus" /> Start a room</button>
            <a href="/browse" className="btn ghost small-btn browse-link" data-action="open-browse" onClick={(e) => { e.preventDefault(); history.pushState(null, '', '/browse'); dispatchEvent(new PopStateEvent('popstate')); }}>🧭 Browse</a>
            <input className="search" placeholder="Search rooms or #tags" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search rooms or tags" data-field="room-filter" />
          </div>
          <div className="cat-chips" role="group" aria-label="Filter by category">
            <button type="button" className={`chip${catFilter === '' ? ' on' : ''}`} aria-pressed={catFilter === ''} data-category-chip="" onClick={() => setCatFilter('')}>All</button>
            <button type="button" className={`chip chip-hot${activeFirst ? ' on' : ''}`} aria-pressed={activeFirst} data-action="sort-active" onClick={() => setActiveFirst((v) => !v)}><span aria-hidden>🔥</span> Active first</button>
            {ROOM_CATEGORIES.map((c) => (
              <button key={c} type="button" className={`chip${catFilter === c ? ' on' : ''}`} aria-pressed={catFilter === c} data-category-chip={c} onClick={() => setCatFilter(catFilter === c ? '' : c)}>
                <span aria-hidden>{CATEGORY_ICON[c]}</span> {CATEGORY_LABEL[c]}{catCounts[c] ? <span className="chip-n">{catCounts[c]}</span> : null}
              </button>
            ))}
          </div>
          <div className="room-grid" aria-busy={!roomsLoaded}>
            {!roomsLoaded && Array.from({ length: skeletonCount() }, (_, i) => (
              <div key={`sk${i}`} className="room-card room-card-skeleton" aria-hidden>
                <div className="room-card-top"><span className="room-name sk-line" /></div>
                <p className="muted small"><span className="sk-line short" /></p>
                <div className="room-stats"><span className="sk-line tiny" /></div>
              </div>
            ))}
            {shown.map((r) => (
              <button key={r.id} className={`room-card${r.thumbUrl ? ' has-thumb' : ''}`} onClick={() => { if (r.passwordRequired) { setAskPw(r); setJoinPw(''); } else void join(r.id); }} disabled={busy} data-room={r.id}>
                {r.thumbUrl && <span className="room-card-thumb" style={{ backgroundImage: `url("${r.thumbUrl}")` }} data-room-thumb={r.id} aria-hidden />}
                <div className="room-card-top">
                  <span className="room-name"><RoomIconMini url={r.iconUrl} />#{r.name}{(roomUnread[r.id]?.n ?? 0) > 0 && <span className={`badge${roomUnread[r.id].mention ? ' mention' : ''}`} data-unread={r.id}>{unreadBadge(roomUnread[r.id].n)}</span>}</span>
                  <span className="room-stats">
                    {!r.permanent && <span className="tag">{r.persistent ? 'user room' : 'guest room'}</span>}
                    {r.passwordRequired && <span className="tag" data-password="1">password</span>}
                    {r.voice && <span className="tag voice-tag" data-voice="1">🎙 voice</span>}
                    {r.active && <span className="tag hot" data-active="1" title="Lots going on right now">🔥 active</span>}
                    {r.eventLive ? (
                      <span className="tag event-soon live" data-event-live="1" title={`📅 ${r.eventLive.title} · happening now`} aria-label={`Event live: ${r.eventLive.title}`}>📅 live</span>
                    ) : r.eventSoon ? (
                      <span className="tag event-soon" data-event-soon="1" title={`📅 ${r.eventSoon.title} · ${new Date(r.eventSoon.startsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`} aria-label={`Event soon: ${r.eventSoon.title}`}>📅</span>
                    ) : null}
                  </span>
                </div>
                <p className="muted small">{r.topic || 'No topic'}</p>
                {(r.category || (r.tags?.length ?? 0) > 0) && (
                  <div className="room-card-meta" data-room-meta={r.id}>
                    <CategoryTag category={r.category} />
                    <TagList tags={r.tags} />
                  </div>
                )}
                <div className="room-stats">
                  <span className={`dot ${r.users ? 'live' : ''}`} /> {r.users} {r.users === 1 ? 'person' : 'people'}
                  {r.broadcasters > 0 && <span className="tag cam">● {r.broadcasters} live</span>}
                </div>
              </button>
            ))}
            {roomsLoaded && shown.length === 0 && <p className="muted">No rooms match.{(catFilter || q) && <> <button type="button" className="link-btn" onClick={() => { setCatFilter(''); setFilter(''); }}>Clear filters</button></>}</p>}
          </div>
        </section>
        {sheet === 'create' && <Sheet name="create" title="Start a room" onClose={() => setSheet(null)}>
        <div className="create" data-panel="create">
          <p className="muted small">
            {account
              ? `You become its owner: set the topic and remove disruptive users. Your rooms stay until you delete them (max ${LIMITS.maxRoomsPerUser}).`
              : 'Sign in to keep a room. Rooms you create stay until you delete them.'}
          </p>
          <form onSubmit={create} className="stack">
            <input placeholder="Room name" aria-label="Room name" value={name} maxLength={LIMITS.roomNameMax} onChange={(e) => setName(e.target.value)} required minLength={LIMITS.roomNameMin} />
            <input placeholder="Topic (optional)" aria-label="Topic (optional)" value={topic} maxLength={LIMITS.roomTopicMax} onChange={(e) => setTopic(e.target.value)} />
            <div className="create-meta">
              <CategorySelect value={newCat} onChange={setNewCat} />
              <input placeholder="Tags: music, chill" value={newTags} maxLength={140} onChange={(e) => setNewTags(e.target.value)} aria-label="Tags (optional)" data-field="create-tags" />
            </div>
            <label className="check-row voice-check"><input type="checkbox" checked={newVoice} onChange={(e) => setNewVoice(e.target.checked)} data-field="room-voice" /> <span>🎙 Voice room (audio only)</span></label>
            <input type="password" placeholder="Password (optional)" value={roomPw} maxLength={LIMITS.passwordMax} onChange={(e) => setRoomPw(e.target.value)} autoComplete="new-password" aria-label="Room password" />
            {account && (
              <div className="create-thumb">
                <input ref={thumbRef} type="file" accept={THUMB_ACCEPT} hidden data-field="create-thumb" onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  const bad = f ? thumbFileError(f) : null;
                  if (bad) { toast(bad, 'error'); e.target.value = ''; setNewThumb(null); return; }
                  setNewThumb(f);
                }} />
                <button type="button" className="btn ghost small-btn" data-action="create-thumb-pick" onClick={() => thumbRef.current?.click()}>🖼 {newThumb ? 'Change thumbnail' : 'Thumbnail (optional)'}</button>
                {newThumb && <span className="muted small create-thumb-name" title={newThumb.name}>{newThumb.name}</span>}
                {newThumb && <button type="button" className="icon-btn" aria-label="Clear thumbnail" data-action="create-thumb-clear" onClick={() => { setNewThumb(null); if (thumbRef.current) thumbRef.current.value = ''; }}>✕</button>}
              </div>
            )}
            {account && (
              <div className="create-thumb">
                <input ref={iconRef} type="file" accept={ICON_ACCEPT} hidden data-field="create-icon" onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  const bad = f ? iconFileError(f) : null;
                  if (bad) { toast(bad, 'error'); e.target.value = ''; setNewIcon(null); return; }
                  setNewIcon(f);
                }} />
                <button type="button" className="btn ghost small-btn" data-action="create-icon-pick" onClick={() => iconRef.current?.click()}>🔵 {newIcon ? 'Change icon' : 'Room icon (optional)'}</button>
                {newIcon && <span className="muted small create-thumb-name" title={newIcon.name}>{newIcon.name}</span>}
                {newIcon && <button type="button" className="icon-btn" aria-label="Clear room icon" data-action="create-icon-clear" onClick={() => { setNewIcon(null); if (iconRef.current) iconRef.current.value = ''; }}>✕</button>}
              </div>
            )}
            <button className="btn primary" disabled={busy}>Create & join</button>
          </form>
        </div>
        </Sheet>}
      </main>
      {account && <FriendsPanel onJoinCall={onJoined} toast={toast} open={sheet === 'friends'} onClose={() => setSheet(null)} onPending={setFriendRequests} />}
      {askPw && (
        <div className="modal-backdrop" onClick={() => setAskPw(null)}>
          <form ref={askRef} className="modal panel" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void join(askPw.id, joinPw); }} role="dialog" aria-modal="true" aria-label={`Password for ${askPw.name}`}>
            <h3>#{askPw.name}</h3>
            <p className="muted small">This room needs a password.</p>
            <input type="password" autoFocus value={joinPw} maxLength={LIMITS.passwordMax} onChange={(e) => setJoinPw(e.target.value)} aria-label="Room password" autoComplete="current-password" />
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setAskPw(null)}>Cancel</button>
              <button className="btn primary" disabled={busy || !joinPw.trim()}>Join</button>
            </div>
          </form>
        </div>
      )}
      {avOpen && (
        <Lazy><AvSettings open onClose={() => setAvOpen(false)} onApply={async () => { await applyAudioOutputToDocument(); }} camOn={false} micOn={false} /></Lazy>
      )}
    </div>
  );
}
