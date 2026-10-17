import { FormEvent, useEffect, useRef, useState } from 'react';
import { LIMITS } from '../../shared/config';
import type { WhisperInfo, WhisperMessage } from '../../shared/types';
import { socket } from '../socket';
import { fmtTime, unreadBadge } from '../util';
import { ChatText } from './ChatText';
import { EmojiPicker } from './EmojiPicker';

export interface WhisperConv { info: WhisperInfo; messages: WhisperMessage[]; unread: number }

/** Names of the other participants, e.g. "alice, bob". */
export function whisperLabel(info: WhisperInfo, selfId: string) {
  return info.members.filter((m) => m.id !== selfId).map((m) => m.nick).join(', ') || 'just you';
}

export function WhisperStrip({ convs, open, setOpen, selfId, isIgnored, toast, onReport, receiptsOn = false, setReceipts, seen = {} }: {
  receiptsOn?: boolean;
  setReceipts?: (on: boolean) => void;
  seen?: Record<string, Record<string, { messageId: string; nick: string }>>;
  convs: Record<string, WhisperConv>;
  open: string | null;
  setOpen: (id: string | null) => void;
  selfId: string;
  isIgnored: (nick: string) => boolean;
  toast: (t: string, tone?: 'error' | 'info') => void;
  onReport?: (m: WhisperMessage) => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const ids = Object.keys(convs);
  const active = open && convs[open] ? convs[open] : null;
  const shown = active ? active.messages.filter((m) => m.fromId === selfId || !isIgnored(m.from)) : [];
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [shown.length, open]);
  // batch G5: tell the others we've read their newest line (only while open and the tab is visible; only if our receipts are on)
  const lastTheirs = [...shown].reverse().find((m) => m.fromId !== selfId);
  useEffect(() => {
    if (!receiptsOn || !open || !lastTheirs) return;
    const send = () => { if (document.visibilityState === 'visible') socket.emit('whisper:seen', { whisperId: open, messageId: lastTheirs.id }); };
    send();
    document.addEventListener('visibilitychange', send);
    return () => document.removeEventListener('visibilitychange', send);
  }, [receiptsOn, open, lastTheirs?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (ids.length === 0) return null;
  // newest line of mine that each other member has read up to
  const seenUnder = new Map<string, string[]>();
  if (receiptsOn && active && open) {
    const idx = new Map(active.messages.map((m, i) => [m.id, i]));
    const mine = active.messages.map((m, i) => [m, i] as const).filter(([m]) => m.fromId === selfId);
    for (const [by, v] of Object.entries(seen[open] ?? {})) {
      if (!active.info.members.some((x) => x.id === by)) continue;
      const upTo = idx.get(v.messageId); if (upTo == null) continue;
      // they saw a line after (or at) mine: mark my latest line before that point
      const mark = [...mine].reverse().find(([, i]) => i <= upTo) ?? null;
      // receipts arrive for their reading of *my* line's successors too: they read everything up to upTo
      if (mark) seenUnder.set(mark[0].id, [...(seenUnder.get(mark[0].id) ?? []), v.nick]);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const draft = text.trim();
    if (!open || !draft) return;
    socket.emit('whisper:send', { whisperId: open, text: draft }, (r) => {
      if (!r.ok) toast(r.error, 'error');
      else setText((cur) => (cur.trim() === draft ? '' : cur));
    });
  };
  const leave = (id: string) => {
    socket.emit('whisper:leave', { whisperId: id }, (r) => { if (!r.ok) toast(r.error, 'error'); });
  };

  return (
    <div className="whisper-strip" data-testid="whisper-strip">
      <div className="whisper-tabs" role="tablist" aria-label="Whispers">
        {ids.map((id) => (
          <div key={id} className={`whisper-tab ${open === id ? 'active' : ''}`}>
            <button type="button" role="tab" aria-selected={open === id} data-action="whisper-tab" onClick={() => setOpen(open === id ? null : id)} title="Whisper: only these people see it">
              🤫 {whisperLabel(convs[id].info, selfId)}
              {convs[id].unread > 0 && <span className="badge" data-unread="whisper">{unreadBadge(convs[id].unread)}</span>}
            </button>
            <button type="button" className="icon-btn" data-action="whisper-leave" aria-label="Leave whisper" title="Leave whisper" onClick={() => leave(id)}>×</button>
          </div>
        ))}
      </div>
      {active && open && (
        <div className="whisper-window">
          <div className="whisper-log" aria-live="polite">
            {shown.length === 0 && <p className="muted small">Whisper with {whisperLabel(active.info, selfId)}. Only people in this whisper see these messages, not moderators. Nothing is saved unless someone reports a message.</p>}
            {shown.map((m) => (
              <div key={m.id} className={`whisper-msg ${m.fromId === selfId ? 'mine' : ''}`}>
                <span className="ts">{fmtTime(m.ts)}</span> <span className="from">{m.from}</span> <ChatText text={m.text} />
                {seenUnder.has(m.id) && <span className="whisper-seen small muted" data-testid="whisper-seen">✓ Seen by {seenUnder.get(m.id)!.join(', ')}</span>}
                {onReport && m.fromId !== selfId && <button type="button" className="icon-btn whisper-report" title="Report message" aria-label={`Report whisper from ${m.from}`} data-action="report-whisper" onClick={() => onReport(m)}>⚑</button>}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          {setReceipts && (
            <label className="whisper-receipts small muted" title="Read receipts work both ways: turn yours off and you won't see anyone else's.">
              <input type="checkbox" checked={receiptsOn} onChange={(e) => setReceipts(e.target.checked)} data-testid="whisper-receipts" /> Read receipts
            </label>
          )}
          <form onSubmit={submit} className="whisper-form">
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} maxLength={LIMITS.messageMax} placeholder={`Whisper to ${whisperLabel(active.info, selfId)}`} aria-label="Whisper message" />
            <EmojiPicker value={text} onChange={setText} inputRef={inputRef} />
            <button className="btn primary small-btn" data-action="whisper-send">Send</button>
          </form>
        </div>
      )}
    </div>
  );
}
