import { useEffect, useState } from 'react';
import { loadMentions, markMentions, openRoomById, useMentions } from '../mentions';
import { fmtTime } from '../util';

/** Mentions inbox: @mentions and replies to you across rooms, newest first, with read / unread. */
export function MentionsDialogBody({ toast, onJump }: { toast: (t: string, tone?: 'error' | 'info') => void; onJump: () => void }) {
  const { items, unread } = useMentions();
  const [busy, setBusy] = useState(false);
  useEffect(() => { void loadMentions().catch((e: Error) => toast(e.message, 'error')); }, [toast]);
  const mark = (ids: number[] | 'all', read: boolean) => { void markMentions(ids, read).catch((e: Error) => toast(e.message, 'error')); };
  if (!items) return <p className="muted">Loading…</p>;
  return (
    <div className="mentions-panel" data-testid="mentions-panel">
      <div className="mentions-head">
        <span className="muted" data-mentions-unread={unread}>{unread ? `${unread} unread` : 'All caught up'}</span>
        <button type="button" className="btn ghost small-btn" data-action="mentions-read-all" disabled={!unread || busy}
          onClick={() => { setBusy(true); void markMentions('all', true).catch((e: Error) => toast(e.message, 'error')).finally(() => setBusy(false)); }}>Mark all read</button>
      </div>
      {items.length === 0 ? <p className="muted" data-testid="mentions-empty">No mentions yet. When someone @mentions you or replies to your message, it shows up here.</p> : (
        <ul className="mentions-list">
          {items.map((m) => (
            <li key={m.id} className={`mention-item${m.read ? '' : ' unread'}`} data-mention={m.id} data-read={m.read ? '1' : '0'}>
              <button type="button" className="mention-open" data-action="mention-open"
                onClick={() => { if (!m.read) mark([m.id], true); onJump(); openRoomById(m.roomId); }}>
                <span className="mention-meta"><strong>{m.from}</strong> {m.kind === 'reply' ? 'replied to you' : 'mentioned you'} in <span className="mention-room">#{m.roomName}</span> · <time>{fmtTime(m.ts)}</time></span>
                <span className="mention-text">{m.text || <em className="muted">message removed</em>}</span>
              </button>
              <button type="button" className="btn ghost small-btn mention-toggle" data-action="mention-toggle"
                aria-label={m.read ? 'Mark as unread' : 'Mark as read'} onClick={() => mark([m.id], !m.read)}>{m.read ? 'Unread' : 'Read'}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
