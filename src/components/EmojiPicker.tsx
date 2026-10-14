import { useEffect, useRef, useState, type RefObject } from 'react';
import { useEscape } from '../a11y';
import { EMOJI_GRID } from '../markdown';
import type { RoomEmote } from '../../shared/types';

/** Compact emoji grid; inserts into a controlled text field at the caret. */
export function EmojiPicker({
  value,
  onChange,
  inputRef,
  emotes,
}: {
  value: string;
  onChange: (next: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** this room's custom emotes; adds an Emotes tab when non-empty */
  emotes?: RoomEmote[];
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'emoji' | 'emotes'>('emoji');
  const hasEmotes = !!emotes && emotes.length > 0;
  const showEmotes = hasEmotes && tab === 'emotes';
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  // Escape closes the picker and puts focus back on its button.
  useEscape(open, () => setOpen(false), () => wrap.current?.querySelector<HTMLElement>('[aria-expanded]'));

  const insert = (emoji: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + emoji + value.slice(end);
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + emoji.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="emoji-wrap" ref={wrap}>
      <button
        type="button"
        className="btn ghost emoji-btn"
        title="Emoji"
        aria-label="Insert emoji"
        aria-expanded={open}
        data-action="emoji-picker"
        onClick={() => setOpen((o) => !o)}
      >
        😊
      </button>
      {open && (
        <div className={`emoji-pop${hasEmotes ? ' has-tabs' : ''}`} role="listbox" aria-label="Emoji picker">
          {hasEmotes && (
            <div className="emoji-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={!showEmotes} className={!showEmotes ? 'on' : ''} data-action="emoji-tab-emoji" onClick={() => setTab('emoji')}>Emoji</button>
              <button type="button" role="tab" aria-selected={showEmotes} className={showEmotes ? 'on' : ''} data-action="emoji-tab-emotes" onClick={() => setTab('emotes')}>Room emotes</button>
            </div>
          )}
          {showEmotes ? emotes!.map((e) => (
            <button key={e.id} type="button" className="emoji-cell emote-cell" onClick={() => insert(`:${e.name}: `)} aria-label={`:${e.name}:`} title={`:${e.name}:`} data-emote={e.name}>
              <img src={e.url} alt="" width={28} height={28} loading="lazy" />
            </button>
          )) : EMOJI_GRID.map((e, i) => (
            // index keys: the grid can contain the same emoji twice, and duplicate keys leave stale cells when switching tabs
            <button key={`${i}:${e}`} type="button" className="emoji-cell" onClick={() => insert(e)} aria-label={e}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
