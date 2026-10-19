import { useState } from 'react';
import type { Account } from '../App';
import { api } from '../api';
import { MSG_COLORS, normalizeHex, readableMsgColor } from '../../shared/msgColor';
import { UI_PALETTES, UI_THEMES, UI_THEME_LABEL } from '../../shared/uiTheme';
import { setIgnoreMsgColors, useIgnoreMsgColors } from '../msgColorPref';

type Toast = (t: string, tone?: 'error' | 'info') => void;

/** batch X: your message text colour (rooms and whispers), checked on all four themes, plus the viewer opt-out. */
export function MessageColorSection({ account, onAccount, toast }: { account: Account; onAccount: (a: Account) => void; toast: Toast }) {
  const current = account.msgColor ?? null;
  const [custom, setCustom] = useState(current ?? '#9fd8ff');
  const [busy, setBusy] = useState(false);
  const ignore = useIgnoreMsgColors();
  const check = readableMsgColor(custom);
  const save = async (color: string | null) => {
    setBusy(true);
    try {
      const r = await api<{ msgColor: string | null; adjusted: boolean }>('/api/me/msg-color', { color }, 'PATCH');
      onAccount({ ...account, msgColor: r.msgColor });
      if (r.msgColor) setCustom(r.msgColor);
      toast(!r.msgColor ? 'Message colour reset' : r.adjusted ? `That colour was hard to read on some themes, so it was lightened to ${r.msgColor}` : 'Message colour updated');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const shown = check?.color ?? normalizeHex(custom);
  return (
    <div className="profile-section msg-color-section" data-section="msg-color">
      <div className="muted small">Message colour <span className="muted">(your text in rooms and whispers)</span></div>
      <div className="color-grid" role="listbox" aria-label="Message colour">
        <button type="button" className={`color-swatch reset ${!current ? 'on' : ''}`} title="Default" aria-label="Default colour" aria-selected={!current} disabled={busy} onClick={() => void save(null)} data-msg-swatch="none">✕</button>
        {MSG_COLORS.map((c) => (
          <button key={c.hex} type="button" className={`color-swatch ${current === c.hex ? 'on' : ''}`} style={{ background: c.hex }} title={c.label} aria-label={c.label} aria-selected={current === c.hex} disabled={busy} onClick={() => void save(c.hex)} data-msg-swatch={c.hex} />
        ))}
      </div>
      <div className="row-actions msg-color-custom">
        <label className="small">Custom <input type="color" value={normalizeHex(custom) ?? '#9fd8ff'} onChange={(e) => setCustom(e.target.value)} aria-label="Custom message colour" data-field="msg-color" /></label>
        <button type="button" className="btn small-btn" disabled={busy || !check} onClick={() => void save(custom)} data-action="msg-color-save">Use this colour</button>
        {check?.adjusted && <span className="small warn-text" data-testid="msg-color-adjusted">Too dark for some themes: it will be lightened to <code>{check.color}</code>.</span>}
      </div>
      <div className="msg-color-previews" aria-label="Preview on each theme">
        {UI_THEMES.map((t) => (
          <span key={t} className="msg-color-preview" style={{ background: UI_PALETTES[t].panel, color: shown ?? UI_PALETTES[t].text, borderColor: UI_PALETTES[t].line }} data-preview={t}>
            <b style={{ color: UI_PALETTES[t].muted }}>{UI_THEME_LABEL[t]}</b> Hello there!
          </span>
        ))}
      </div>
      <label className="check-row small"><input type="checkbox" checked={ignore} onChange={(e) => setIgnoreMsgColors(e.target.checked)} data-action="ignore-msg-colors" /> <span>Show everyone's messages in the normal text colour (ignore custom message colours, on this device)</span></label>
    </div>
  );
}
