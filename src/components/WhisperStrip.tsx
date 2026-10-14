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

export function WhisperStrip({ convs, open, setOpen, selfId, isIgnored, toast, onReport }: {
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
  if (ids.length === 0) return null;

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
                {onReport && m.fromId !== selfId && <button type="button" className="icon-btn whisper-report" title="Report message" aria-label={`Report whisper from ${m.from}`} data-action="report-whisper" onClick={() => onReport(m)}>⚑</button>}
              </div>
            ))}
            <div ref={endRef} />
          </div>
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
