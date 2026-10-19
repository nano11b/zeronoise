import { useEffect, useState } from 'react';
import { socket } from '../socket';
import { parseWatchUrl } from '../../shared/watch';
import { QUEUE_MAX, type QueueState } from '../../shared/musicQueue';

/** batch MC2: anyone queues YouTube links; the owner (or a role with music control) skips and removes. */
export function MusicQueuePanel({ toast, me }: { toast: (t: string, tone?: 'error' | 'info') => void; me?: string }) {
  const [q, setQ] = useState<QueueState>({ items: [], current: null });
  const [ctl, setCtl] = useState(false);
  const [link, setLink] = useState('');
  useEffect(() => {
    const get = () => socket.emit('queue:get', (r) => { if (r.ok) { setQ(r.queue); setCtl(!!r.queue.canControl); } });
    get();
    const on = (s: QueueState) => setQ(s);
    socket.on('queue:state', on); socket.on('connect', get);
    return () => { socket.off('queue:state', on); socket.off('connect', get); };
  }, []);
  const res = (r: { ok: boolean; error?: string }) => { if (!r.ok) toast(r.error ?? 'Failed', 'error'); return r.ok; };
  const add = () => {
    const p = parseWatchUrl(link);
    if (!p || p.provider !== 'youtube' || p.kind !== 'video') return toast('Paste a YouTube video link', 'error');
    socket.emit('queue:add', { url: link }, (r) => { if (res(r)) setLink(''); });
  };
  return (
    <section className="music-queue" data-testid="music-queue" aria-label="Music queue">
      <div className="mq-head"><strong className="small">Up next</strong> <span className="muted small">{q.items.length}/{QUEUE_MAX}</span>
        {ctl && (q.items.length > 0 || q.current) && <button type="button" className="btn ghost small-btn" data-action="queue-skip" onClick={() => socket.emit('queue:skip', res)}>Skip ⏭</button>}</div>
      {q.current && <p className="small mq-now" data-testid="queue-now">Now from the queue: <a href={q.current.url} target="_blank" rel="noopener noreferrer">{q.current.videoId}</a> · {q.current.by}</p>}
      {q.items.length > 0 ? (
        <ol className="mq-list small">{q.items.map((it) => (
          <li key={it.id} data-queue-item={it.videoId}><a href={it.url} target="_blank" rel="noopener noreferrer"><img src={`https://i.ytimg.com/vi/${it.videoId}/default.jpg`} alt="" width={48} height={36} loading="lazy" referrerPolicy="no-referrer" /> {it.videoId}</a> <span className="muted">{it.by}</span>
            {(ctl || it.by === me) && <button type="button" className="btn ghost small-btn" aria-label={`Remove ${it.videoId} from the queue`} data-action="queue-remove" onClick={() => socket.emit('queue:remove', { id: it.id }, res)}>✕</button>}</li>
        ))}</ol>
      ) : <p className="small muted">The queue is empty. Add a YouTube link; it plays when the current video ends.</p>}
      <form className="watch-load" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Queue a YouTube link" aria-label="Queue a YouTube link" maxLength={300} inputMode="url" data-field="queue-link" />
        <button className="btn small-btn" data-action="queue-add" disabled={!link.trim()}>Queue</button>
      </form>
    </section>
  );
}
