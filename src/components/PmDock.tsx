import { FormEvent, useEffect, useRef, useState } from 'react';
import { LIMITS } from '../../shared/config';
import type { PrivateMessage } from '../../shared/types';
import { socket } from '../socket';
import { fmtTime, unreadBadge } from '../util';
import { ChatText } from './ChatText';
import { EmojiPicker } from './EmojiPicker';
import { GifPicker } from './GifPicker';
import { NickLabel } from './UserAvatar';

export interface PmTarget { id: string; nick: string }
type Convs = Record<string, { nick: string; messages: PrivateMessage[]; unread: number }>;

export function PmDock({ convs, open, setOpen, close, send, ignored, gifs }: {
  convs: Convs; open: string | null; setOpen: (id: string | null) => void; close: (id: string) => void;
  send: (toId: string, text: string) => Promise<boolean>; ignored: Set<string>; gifs?: boolean;
}) {
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const pmInputRef = useRef<HTMLInputElement>(null);
  const ids = Object.keys(convs).filter((id) => !ignored.has(convs[id].nick.toLowerCase()));
  const active = open && convs[open] ? convs[open] : null;
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [active?.messages.length, open]);
  if (ids.length === 0) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const draft = text;
    if (!open || !draft.trim()) return;
    const ok = await send(open, draft.trim());
    if (ok) setText((cur) => (cur === draft ? '' : cur));
  };

  return (
    <div className="pm-dock">
      <div className="pm-tabs">
        {ids.map((id) => (
          <div key={id} className={`pm-tab ${open === id ? 'active' : ''}`}>
            <button onClick={() => setOpen(open === id ? null : id)}>
              ✉ <NickLabel nick={convs[id].nick} />{convs[id].unread > 0 && <span className="badge" data-unread="pm">{unreadBadge(convs[id].unread)}</span>}
            </button>
            <button className="icon-btn" onClick={() => close(id)} aria-label="Close conversation">×</button>
          </div>
        ))}
      </div>
      {active && open && (
        <div className="pm-window">
          <div className="pm-head">Private chat with <strong>{active.nick}</strong></div>
          <div className="pm-log">
            {active.messages.length === 0 && <p className="muted small">Messages here are only visible to you two.</p>}
            {active.messages.map((m) => (
              <div key={m.id} className={`pm-msg ${m.fromId === socket.id ? 'mine' : ''}`}>
                <span className="ts">{fmtTime(m.ts)}</span> <ChatText text={m.text} />
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <form onSubmit={submit} className="pm-form">
            <input ref={pmInputRef} value={text} onChange={(e) => setText(e.target.value)} maxLength={LIMITS.messageMax} placeholder={`Message ${active.nick}`} aria-label="Private message" />
            <div className="composer-tools">
              <EmojiPicker value={text} onChange={setText} inputRef={pmInputRef} />
              <GifPicker enabled={!!gifs} value={text} onChange={setText} inputRef={pmInputRef} />
            </div>
            <button className="btn primary">Send</button>
          </form>
        </div>
      )}
    </div>
  );
}
