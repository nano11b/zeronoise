import { useEffect, useRef, useState } from 'react';
import { useEscape } from '../a11y';
import { CHAT_COLORS, CHAT_EFFECTS, type ChatColorId, type ChatEffectId } from '../../shared/colors';
import type { Account } from '../App';
import { api } from '../api';
import { NickLabel } from './UserAvatar';
import { MSG_GRADIENTS, parseMsgStyle, readableMsgStyle } from '../../shared/msgColor';

/** Color and effect whitelist, opened from the composer. No custom CSS. */
export function NameStylePicker({
  account,
  onAccount,
  toast,
}: {
  account: Account;
  onAccount: (a: Account) => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const curG = parseMsgStyle(account.chatColor);
  const [stops, setStops] = useState<string[]>(curG?.kind === 'gradient' ? curG.stops : ['#ffd166', '#9fd8ff']);
  const draftG = readableMsgStyle({ stops });
  const setGradient = async (g: string[]) => {
    setBusy(true);
    try {
      const r = await api<{ chatColor: string | null; adjusted?: boolean }>('/api/me/color', { gradient: g }, 'PATCH');
      onAccount({ ...account, chatColor: r.chatColor });
      toast(r.adjusted ? 'Some colours were hard to read on a theme, so they were lightened' : 'Name gradient updated');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
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

  const setEffect = async (effect: ChatEffectId) => {
    setBusy(true);
    try {
      const r = await api<{ chatEffect: string | null }>('/api/me/effect', { effect }, 'PATCH');
      onAccount({ ...account, chatEffect: r.chatEffect });
      toast(effect === 'none' ? 'Effect removed' : 'Effect updated');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const setColor = async (color: ChatColorId | null) => {
    setBusy(true);
    try {
      const r = await api<{ chatColor: string | null }>('/api/me/color', { color }, 'PATCH');
      onAccount({ ...account, chatColor: r.chatColor });
      toast(color ? 'Color updated' : 'Color reset');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="name-style-wrap" ref={wrap}>
      <button
        type="button"
        className="btn ghost name-style-btn"
        title="Name color and effect"
        aria-label="Name color and effect"
        aria-expanded={open}
        data-action="name-style"
        onClick={() => setOpen((o) => !o)}
      >
        <NickLabel nick="Aa" chatColor={account.chatColor} chatEffect={account.chatEffect} />
      </button>
      {open && (
        <div className="name-style-pop" role="dialog" aria-label="Name color and effect">
          <div className="muted small">Name color</div>
          <div className="color-grid" role="listbox" aria-label="Chat name color">
            <button
              type="button"
              className={`color-swatch reset ${!account.chatColor ? 'on' : ''}`}
              title="Default (hash)"
              disabled={busy}
              onClick={() => setColor(null)}
            >
              ✕
            </button>
            {CHAT_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`color-swatch ${account.chatColor === c.id ? 'on' : ''}`}
                style={{ background: c.hex }}
                title={c.label}
                aria-label={c.label}
                disabled={busy}
                onClick={() => setColor(c.id)}
              />
            ))}
          </div>
          <div className="muted small name-style-effects-label">Name gradient</div>
          <div className="color-grid" role="listbox" aria-label="Chat name gradient">
            {MSG_GRADIENTS.map((g) => { const v = `g:${g.stops.join(',')}`; return (
              <button key={v} type="button" className={`color-swatch ${account.chatColor === v ? 'on' : ''}`} style={{ backgroundColor: g.stops[0], backgroundImage: `linear-gradient(90deg, ${g.stops.join(', ')})` }} title={g.label} aria-label={`${g.label} gradient`} aria-selected={account.chatColor === v} disabled={busy} onClick={() => void setGradient([...g.stops])} data-name-gradient={v} />
            ); })}
          </div>
          <div className="row-actions msg-color-custom name-grad-custom">
            {stops.map((st, i) => (
              <label key={i} className="small">{i + 1} <input type="color" value={st} onChange={(e) => setStops((p) => p.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Name gradient colour ${i + 1}`} data-field={`name-stop-${i}`} /></label>
            ))}
            {stops.length < 3
              ? <button type="button" className="btn ghost small-btn" onClick={() => setStops((p) => [...p, '#d7b8ff'])} data-action="name-stop-add">+</button>
              : <button type="button" className="btn ghost small-btn" onClick={() => setStops((p) => p.slice(0, 2))} data-action="name-stop-remove">−</button>}
            <button type="button" className="btn small-btn" disabled={busy || !draftG} onClick={() => void setGradient(stops)} data-action="name-grad-save">Use gradient</button>
          </div>
          {draftG?.adjusted && <div className="small warn-text" data-testid="name-grad-adjusted">Too dark for some themes: it will be lightened.</div>}
          <div className="muted small name-style-effects-label">Name effect</div>
          <div className="row-actions effect-picks" role="listbox" aria-label="Chat name effect">
            {CHAT_EFFECTS.map((id) => {
              const on = (account.chatEffect || 'none') === id;
              return (
                <button key={id} type="button" className={`btn small-btn ${on ? 'primary' : 'ghost'}`} disabled={busy} aria-pressed={on} data-effect={id} onClick={() => setEffect(id)}>
                  {id === 'none' ? 'None' : id[0].toUpperCase() + id.slice(1)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
