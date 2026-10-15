import { FormEvent, useEffect, useRef, useState } from 'react';
import type { BookmarkEntry, SearchHit, WhisperMessage } from '../../shared/types';
import { call, socket } from '../socket';
import { fmtTime } from '../util';

const snippet = (t: string) => t.replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]').replace(/\s+/g, ' ').trim().slice(0, 160);
const when = (ts: number) => `${new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtTime(ts)}`;

/** Highlight query words in a plain-text snippet (no HTML injection: React text nodes only). */
function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}

/** Local-date input value (YYYY-MM-DD) to a ms range edge. */
const dayStart = (v: string) => (v ? new Date(`${v}T00:00:00`).getTime() : undefined);
const dayEnd = (v: string) => (v ? new Date(`${v}T00:00:00`).getTime() + 86_400_000 : undefined);

/** Side-panel tab: search this room's history or your whispers here, by words, person and date. */
export function SearchPanel({ registered, roomName, people = [], onJump }: { registered: boolean; roomName: string; people?: string[]; onJump: (hit: SearchHit) => void }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'room' | 'whispers'>('room');
  const [from, setFrom] = useState('');
  const [after, setAfter] = useState('');
  const [before, setBefore] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [whisperHits, setWhisperHits] = useState<WhisperMessage[]>([]);
  const [state, setState] = useState<{ q: string; offset: number; hasMore: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const filter = () => ({ from: from.trim() || undefined, after: dayStart(after), before: dayEnd(before) });
  const run = async (query: string, offset: number) => {
    setBusy(true);
    setError('');
    try {
      if (scope === 'whispers') {
        const r = await call<{ hits: WhisperMessage[] }>((ack) => socket.emit('whisper:search', { q: query, ...filter() }, ack));
        setWhisperHits(r.hits); setHits([]);
        setState({ q: query, offset: 0, hasMore: false });
      } else {
        const r = await call<{ hits: SearchHit[]; hasMore: boolean; offset: number }>((ack) => socket.emit('chat:search', { q: query, offset, ...filter() }, ack));
        setHits((cur) => (offset ? [...cur, ...r.hits] : r.hits)); setWhisperHits([]);
        setState({ q: query, offset: r.offset, hasMore: r.hasMore });
      }
    } catch (e) { setError((e as Error).message); if (!offset) { setHits([]); setWhisperHits([]); } }
    finally { setBusy(false); }
  };
  const hasFilter = !!(from.trim() || after || before);
  const canSearch = q.trim().length >= 2 || (hasFilter && !q.trim());
  const submit = (e: FormEvent) => { e.preventDefault(); if (canSearch) void run(q.trim(), 0); };
  if (!registered) return <div className="side-body"><h3>Search</h3><p className="muted small">Sign in to search chat history.</p></div>;
  const words = (state?.q ?? '').split(/\s+/).filter((w) => w.length > 0);
  const empty = state && !error && hits.length === 0 && whisperHits.length === 0;
  return (
    <div className="side-body search-side" data-panel="search">
      <h3>Search #{roomName}</h3>
      <div className="seg search-scope" role="tablist" aria-label="Search in">
        <button type="button" role="tab" aria-selected={scope === 'room'} className={scope === 'room' ? 'on' : ''} data-action="search-scope-room" onClick={() => { setScope('room'); setState(null); }}>Room</button>
        <button type="button" role="tab" aria-selected={scope === 'whispers'} className={scope === 'whispers' ? 'on' : ''} data-action="search-scope-whispers" onClick={() => { setScope('whispers'); setState(null); }}>My whispers</button>
      </div>
      <form className="side-search search-form" onSubmit={submit} role="search">
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages" aria-label="Search messages" maxLength={100} data-field="search" />
        <div className="search-filters">
          <label className="search-filter"><span>From</span>
            <input list="search-people" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="anyone" aria-label="From person" maxLength={20} data-field="search-from" />
          </label>
          <datalist id="search-people">{people.map((n) => <option key={n} value={n} />)}</datalist>
          <label className="search-filter"><span>After</span><input type="date" value={after} onChange={(e) => setAfter(e.target.value)} aria-label="On or after date" data-field="search-after" /></label>
          <label className="search-filter"><span>Before</span><input type="date" value={before} onChange={(e) => setBefore(e.target.value)} aria-label="On or before date" data-field="search-before" /></label>
        </div>
        <div className="search-actions">
          <button className="btn primary small-btn" disabled={busy || !canSearch} data-action="search-go">Search</button>
          {hasFilter && <button type="button" className="btn ghost small-btn" data-action="search-clear" onClick={() => { setFrom(''); setAfter(''); setBefore(''); }}>Clear filters</button>}
        </div>
        {scope === 'whispers' && <p className="muted small">Only whispers you were part of in this room, since the server last restarted.</p>}
      </form>
      {error && <p className="muted small error-text">{error}</p>}
      {empty && <p className="muted small">No messages match.</p>}
      <ul className="hit-list">
        {hits.map((h) => (
          <li key={h.message.id}>
            <button type="button" className="hit" data-hit={h.message.id} onClick={() => onJump(h)}>
              <span className="hit-meta"><strong>{h.message.kind === 'chat' ? h.message.from : ''}</strong><span className="muted small">{when(h.message.ts)}{h.threadId ? ' · in thread' : ''}</span></span>
              <span className="hit-text"><Marked text={snippet(h.message.text)} words={words} /></span>
            </button>
          </li>
        ))}
        {whisperHits.map((m) => (
          <li key={m.id}>
            <div className="hit whisper-hit" data-whisper-hit={m.id}>
              <span className="hit-meta"><strong>🤫 {m.from}</strong><span className="muted small">{when(m.ts)}</span></span>
              <span className="hit-text"><Marked text={snippet(m.text)} words={words} /></span>
            </div>
          </li>
        ))}
      </ul>
      {state?.hasMore && <button type="button" className="btn ghost small-btn" disabled={busy} data-action="search-more" onClick={() => void run(state.q, state.offset)}>More results</button>}
    </div>
  );
}

/** Side-panel tab: my private bookmarks (deleted and burn messages are never listed). */
export function SavedPanel({ version, currentRoomId, onJump, onRemove }: {
  version: number; currentRoomId: string; onJump: (b: BookmarkEntry) => void; onRemove: (id: string) => void;
}) {
  const [list, setList] = useState<BookmarkEntry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    call<{ bookmarks: BookmarkEntry[] }>((ack) => socket.emit('bookmark:list', ack))
      .then((r) => { if (alive) setList(r.bookmarks); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [version]);
  return (
    <div className="side-body saved-side" data-panel="saved">
      <h3>Bookmarks</h3>
      {error && <p className="muted small">{error}</p>}
      {list && list.length === 0 && <p className="muted small">Nothing saved yet. Use the bookmark button on a message.</p>}
      <ul className="hit-list">
        {(list ?? []).map((b) => (
          <li key={b.message.id} className="saved-row">
            <button type="button" className="hit" data-saved={b.message.id} onClick={() => onJump(b)} title={b.roomId === currentRoomId ? 'Show in chat' : `In #${b.roomName}`}>
              <span className="hit-meta"><strong>{b.message.kind === 'chat' ? b.message.from : ''}</strong><span className="muted small">#{b.roomName} · {when(b.message.ts)}</span></span>
              <span className="hit-text">{snippet(b.message.text)}</span>
            </button>
            <button type="button" className="icon-btn" title="Remove bookmark" aria-label="Remove bookmark" data-action="unsave" onClick={() => { onRemove(b.message.id); setList((cur) => (cur ?? []).filter((x) => x.message.id !== b.message.id)); }}>✕</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
