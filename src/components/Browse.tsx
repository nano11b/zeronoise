/** Room discovery (batch C): browse open rooms by category / tag, trending now, members and people online. Private and password rooms never appear. */
import { useEffect, useState } from 'react';
import { CATEGORY_ICON, CATEGORY_LABEL, isRoomCategory } from '../../shared/batch3';
import type { DiscoverRoom, DiscoverSort } from '../../shared/discover';
import type { RoomState } from '../../shared/types';
import { call, socket } from '../socket';

type Result = { rooms: DiscoverRoom[]; trending: DiscoverRoom[]; categories: { category: string; count: number }[]; tags: { tag: string; count: number }[] };
const SORT_LABEL: Record<DiscoverSort, string> = { trending: '📈 Trending', members: '👥 Most members', active: '🟢 Online now', new: '✨ New' };

export function Browse({ onJoined, onBack, toast }: { onJoined: (r: RoomState) => void; onBack: () => void; toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [sort, setSort] = useState<DiscoverSort>('trending');
  const [cat, setCat] = useState('');
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      call<Result>((ack) => socket.emit('rooms:discover', { sort, ...(cat ? { category: cat } : {}), ...(tag ? { tag } : {}), ...(q.trim() ? { q: q.trim() } : {}) }, ack))
        .then((r) => { if (alive) setRes(r); }, (e) => toast((e as Error).message, 'error'));
    }, q ? 250 : 0);
    return () => { alive = false; window.clearTimeout(t); };
  }, [sort, cat, tag, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const join = async (id: string) => {
    setBusy(true);
    try { const r = await call<{ room: RoomState }>((ack) => socket.emit('room:join', { roomId: id }, ack)); onJoined(r.room); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const catLabel = (c: string | null) => (c && isRoomCategory(c) ? `${CATEGORY_ICON[c]} ${CATEGORY_LABEL[c]}` : null);
  const card = (r: DiscoverRoom) => (
    <li key={r.id} className="disc-card" data-discover-room={r.id}>
      {r.thumbUrl && <span className="disc-thumb" style={{ backgroundImage: `url("${r.thumbUrl}")` }} aria-hidden />}
      <div className="disc-body">
        <div className="disc-top">
          <b className="disc-name">#{r.name}</b>
          {r.voice && <span className="tag voice-tag">🎙 voice</span>}
          {catLabel(r.category) && <button type="button" className="tag" onClick={() => setCat(r.category!)}>{catLabel(r.category)}</button>}
        </div>
        {r.topic && <p className="muted small disc-topic">{r.topic}</p>}
        <p className="disc-stats small">
          <span data-online={r.users}>🟢 {r.users} online</span>
          <span data-members={r.members}>👥 {r.members} member{r.members === 1 ? '' : 's'}</span>
          <span>💬 {r.messages24h} today</span>
        </p>
        {r.tags.length > 0 && <p className="disc-tags">{r.tags.map((t) => <button key={t} type="button" className={`tag tag-btn${tag === t ? ' on' : ''}`} onClick={() => setTag(tag === t ? '' : t)} data-tag={t}>#{t}</button>)}</p>}
      </div>
      <button type="button" className="btn primary small-btn disc-join" disabled={busy} onClick={() => void join(r.id)} data-action="discover-join">Join</button>
    </li>
  );
  return (
    <main className="browse" data-page="browse">
      <div className="browse-head">
        <button type="button" className="btn ghost small-btn" onClick={onBack} data-action="browse-back">← Lobby</button>
        <h1>Browse rooms</h1>
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rooms, topics, #tags" aria-label="Search rooms" data-field="browse-search" />
      </div>
      <div className="cat-chips" role="group" aria-label="Sort">
        {(Object.keys(SORT_LABEL) as DiscoverSort[]).map((s) => <button key={s} type="button" className={`chip${sort === s ? ' on' : ''}`} aria-pressed={sort === s} onClick={() => setSort(s)} data-sort={s}>{SORT_LABEL[s]}</button>)}
      </div>
      <div className="cat-chips" role="group" aria-label="Category">
        <button type="button" className={`chip${!cat ? ' on' : ''}`} aria-pressed={!cat} onClick={() => setCat('')} data-browse-cat="">All</button>
        {(res?.categories ?? []).map((c) => <button key={c.category} type="button" className={`chip${cat === c.category ? ' on' : ''}`} aria-pressed={cat === c.category} onClick={() => setCat(cat === c.category ? '' : c.category)} data-browse-cat={c.category}>{catLabel(c.category) ?? c.category}<span className="chip-n">{c.count}</span></button>)}
      </div>
      {(res?.tags.length ?? 0) > 0 && (
        <div className="disc-cloud" aria-label="Popular tags">
          {res!.tags.map((t) => <button key={t.tag} type="button" className={`tag tag-btn${tag === t.tag ? ' on' : ''}`} onClick={() => setTag(tag === t.tag ? '' : t.tag)} data-cloud-tag={t.tag}>#{t.tag} <span className="muted">{t.count}</span></button>)}
        </div>
      )}
      {!cat && !tag && !q && (res?.trending.length ?? 0) > 0 && (
        <section className="disc-trending" data-testid="trending">
          <h2>📈 Trending now</h2>
          <ol className="disc-trend-list">{res!.trending.map((r) => <li key={r.id}><button type="button" className="linkish" onClick={() => void join(r.id)} data-trending-room={r.id}>#{r.name}</button> <span className="muted small">{r.users} online · {r.messages24h} today</span></li>)}</ol>
        </section>
      )}
      {!res ? <p className="muted">Loading…</p> : res.rooms.length === 0 ? <p className="muted" data-testid="browse-empty">No open rooms match.</p> : <ul className="disc-grid">{res.rooms.map(card)}</ul>}
      <p className="muted small">Private calls and password-protected rooms are never listed here.</p>
    </main>
  );
}
