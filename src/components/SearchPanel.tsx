import { FormEvent, useEffect, useRef, useState } from 'react';
import type { BookmarkEntry, SearchHit } from '../../shared/types';
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

/** Side-panel tab: search this room's history (registered users). */
export function SearchPanel({ registered, roomName, onJump }: { registered: boolean; roomName: string; onJump: (hit: SearchHit) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<{ q: string; offset: number; hasMore: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const run = async (query: string, offset: number) => {
    setBusy(true);
    setError('');
    try {
      const r = await call<{ hits: SearchHit[]; hasMore: boolean; offset: number }>((ack) => socket.emit('chat:search', { q: query, offset }, ack));
      setHits((cur) => (offset ? [...cur, ...r.hits] : r.hits));
      setState({ q: query, offset: r.offset, hasMore: r.hasMore });
    } catch (e) { setError((e as Error).message); if (!offset) setHits([]); }
    finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); const t = q.trim(); if (t) void run(t, 0); };
  if (!registered) return <div className="side-body"><h3>Search</h3><p className="muted small">Sign in to search chat history.</p></div>;
  const words = (state?.q ?? '').split(/\s+/).filter((w) => w.length > 0);
  return (
    <div className="side-body search-side" data-panel="search">
      <h3>Search #{roomName}</h3>
      <form className="side-search" onSubmit={submit} role="search">
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages" aria-label="Search messages" maxLength={100} data-field="search" />
        <button className="btn primary small-btn" disabled={busy || q.trim().length < 2} data-action="search-go">Search</button>
      </form>
      {error && <p className="muted small error-text">{error}</p>}
      {state && !error && hits.length === 0 && <p className="muted small">No messages match.</p>}
      <ul className="hit-list">
        {hits.map((h) => (
          <li key={h.message.id}>
            <button type="button" className="hit" data-hit={h.message.id} onClick={() => onJump(h)}>
              <span className="hit-meta"><strong>{h.message.kind === 'chat' ? h.message.from : ''}</strong><span className="muted small">{when(h.message.ts)}{h.threadId ? ' · in thread' : ''}</span></span>
              <span className="hit-text"><Marked text={snippet(h.message.text)} words={words} /></span>
            </button>
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
