import { useEffect, useRef, useState } from 'react';
import { useEscape } from '../a11y';
import type { Account } from '../App';
import { api } from '../api';
import { MSG_COLORS, MSG_GRADIENTS, msgStyleCss, normalizeHex, parseMsgStyle, readableMsgStyle } from '../../shared/msgColor';
import { UI_PALETTES, UI_THEMES, UI_THEME_LABEL } from '../../shared/uiTheme';
import { setIgnoreMsgColors, useIgnoreMsgColors } from '../msgColorPref';

type Toast = (t: string, tone?: 'error' | 'info') => void;

/** batch X / MC2: your message text colour or gradient, opened from the chat bar next to the name colour control.
 *  Every colour (and every gradient stop) is checked on all four themes; also holds the viewer opt-out. */
export function MessageColorPicker({ account, onAccount, toast }: { account: Account; onAccount: (a: Account) => void; toast: Toast }) {
  const current = account.msgColor ?? null;
  const cur = parseMsgStyle(current);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'solid' | 'gradient'>(cur?.kind === 'gradient' ? 'gradient' : 'solid');
  const [custom, setCustom] = useState(cur?.kind === 'solid' ? cur.color : '#9fd8ff');
  const [stops, setStops] = useState<string[]>(cur?.kind === 'gradient' ? cur.stops : ['#ffd166', '#9fd8ff']);
  const [busy, setBusy] = useState(false);
  const ignore = useIgnoreMsgColors();
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEscape(open, () => setOpen(false), () => wrap.current?.querySelector<HTMLElement>('[aria-expanded]'));

  const draft = mode === 'solid' ? readableMsgStyle(custom) : readableMsgStyle({ stops });
  const save = async (body: { color: string | null } | { gradient: string[] }) => {
    setBusy(true);
    try {
      const r = await api<{ msgColor: string | null; adjusted: boolean }>('/api/me/msg-color', body, 'PATCH');
      onAccount({ ...account, msgColor: r.msgColor });
      const st = parseMsgStyle(r.msgColor);
      if (st?.kind === 'solid') setCustom(st.color);
      if (st?.kind === 'gradient') setStops(st.stops);
      toast(!r.msgColor ? 'Message colour reset' : r.adjusted ? 'Some colours were hard to read on a theme, so they were lightened' : 'Message colour updated');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const btnCss = msgStyleCss(cur);
  const preview = msgStyleCss(draft?.style ?? null);
  return (
    <div className="name-style-wrap msg-style-wrap" ref={wrap}>
      <button type="button" className="btn ghost name-style-btn" title="Message colour" aria-label="Message colour" aria-expanded={open} data-action="msg-style" onClick={() => setOpen((o) => !o)}>
        <span className={`md msg-style-aa ${btnCss.className}`} style={btnCss.style as React.CSSProperties | undefined}>Ab</span>
      </button>
      {open && (
        <div className="name-style-pop msg-style-pop" role="dialog" aria-label="Message colour" data-section="msg-color">
          <div className="muted small">Message colour <span className="muted">(your text in rooms, threads and whispers)</span></div>
          <div className="color-grid" role="listbox" aria-label="Message colour">
            <button type="button" className={`color-swatch reset ${!current ? 'on' : ''}`} title="Default" aria-label="Default colour" aria-selected={!current} disabled={busy} onClick={() => void save({ color: null })} data-msg-swatch="none">✕</button>
            {MSG_COLORS.map((c) => (
              <button key={c.hex} type="button" className={`color-swatch ${current === c.hex ? 'on' : ''}`} style={{ background: c.hex }} title={c.label} aria-label={c.label} aria-selected={current === c.hex} disabled={busy} onClick={() => void save({ color: c.hex })} data-msg-swatch={c.hex} />
            ))}
          </div>
          <div className="muted small msg-style-sub">Gradients</div>
          <div className="color-grid" role="listbox" aria-label="Message gradient">
            {MSG_GRADIENTS.map((g) => { const v = `g:${g.stops.join(',')}`; return (
              <button key={v} type="button" className={`color-swatch msg-grad-swatch ${current === v ? 'on' : ''}`} style={{ backgroundColor: g.stops[0], backgroundImage: `linear-gradient(90deg, ${g.stops.join(', ')})` }} title={g.label} aria-label={`${g.label} gradient`} aria-selected={current === v} disabled={busy} onClick={() => void save({ gradient: [...g.stops] })} data-msg-gradient={v} />
            ); })}
          </div>
          <div className="row-actions msg-style-mode" role="radiogroup" aria-label="Custom colour type">
            <button type="button" className={`btn small-btn ${mode === 'solid' ? 'primary' : 'ghost'}`} aria-pressed={mode === 'solid'} onClick={() => setMode('solid')} data-action="msg-mode-solid">Custom colour</button>
            <button type="button" className={`btn small-btn ${mode === 'gradient' ? 'primary' : 'ghost'}`} aria-pressed={mode === 'gradient'} onClick={() => setMode('gradient')} data-action="msg-mode-gradient">Custom gradient</button>
          </div>
          <div className="row-actions msg-color-custom">
            {mode === 'solid'
              ? <label className="small">Colour <input type="color" value={normalizeHex(custom) ?? '#9fd8ff'} onChange={(e) => setCustom(e.target.value)} aria-label="Custom message colour" data-field="msg-color" /></label>
              : <>
                  {stops.map((s, i) => (
                    <label key={i} className="small">{i + 1} <input type="color" value={s} onChange={(e) => setStops((p) => p.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Gradient colour ${i + 1}`} data-field={`msg-stop-${i}`} /></label>
                  ))}
                  {stops.length < 3
                    ? <button type="button" className="btn ghost small-btn" onClick={() => setStops((p) => [...p, '#d7b8ff'])} data-action="msg-stop-add">+ Colour</button>
                    : <button type="button" className="btn ghost small-btn" onClick={() => setStops((p) => p.slice(0, 2))} data-action="msg-stop-remove">− Colour</button>}
                </>}
            <button type="button" className="btn small-btn" disabled={busy || !draft} onClick={() => void save(mode === 'solid' ? { color: custom } : { gradient: stops })} data-action="msg-color-save">Use this</button>
          </div>
          {draft?.adjusted && <div className="small warn-text" data-testid="msg-color-adjusted">Too dark for some themes: it will be lightened to <code>{draft.value.replace(/^g:/, '')}</code>.</div>}
          <div className="msg-color-previews" aria-label="Preview on each theme">
            {UI_THEMES.map((t) => (
              <span key={t} className="msg-color-preview" style={{ background: UI_PALETTES[t].panel, borderColor: UI_PALETTES[t].line, color: UI_PALETTES[t].text }} data-preview={t}>
                <b style={{ color: UI_PALETTES[t].muted }}>{UI_THEME_LABEL[t]}</b> <span className={`md ${preview.className}`} style={preview.style as React.CSSProperties | undefined}>Hello there!</span>
              </span>
            ))}
          </div>
          <label className="check-row small"><input type="checkbox" checked={ignore} onChange={(e) => setIgnoreMsgColors(e.target.checked)} data-action="ignore-msg-colors" /> <span>Show everyone's messages in the normal text colour (ignore custom colours and gradients, on this device)</span></label>
        </div>
      )}
    </div>
  );
}
