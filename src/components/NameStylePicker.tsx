import { useEffect, useRef, useState } from 'react';
import { useEscape } from '../a11y';
import { CHAT_COLORS, CHAT_EFFECTS, type ChatColorId, type ChatEffectId } from '../../shared/colors';
import type { Account } from '../App';
import { api } from '../api';
import { NickLabel } from './UserAvatar';

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
