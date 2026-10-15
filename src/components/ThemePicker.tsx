import { useEffect, useState, type CSSProperties } from 'react';
import { UI_PALETTES, UI_THEME_LABEL, UI_THEMES, type UiTheme } from '../../shared/uiTheme';
import { applyUiTheme, currentUiTheme } from '../uiTheme';

/** Interface theme picker. onSaved lets a signed-in account store the choice on the server. */
export function ThemePicker({ onSaved }: { onSaved?: (t: UiTheme) => void }) {
  const [cur, setCur] = useState<UiTheme>(currentUiTheme);
  useEffect(() => {
    const h = (e: Event) => setCur((e as CustomEvent<UiTheme>).detail);
    window.addEventListener('zn-ui-theme', h);
    return () => window.removeEventListener('zn-ui-theme', h);
  }, []);
  const pick = (t: UiTheme) => { applyUiTheme(t); setCur(t); onSaved?.(t); };
  return (
    <fieldset className="ui-theme-picker" data-panel="ui-theme">
      <legend>Theme</legend>
      {UI_THEMES.map((t) => (
        <label key={t} className={`ui-theme-opt${cur === t ? ' on' : ''}`} style={{ ['--sw-bg' as string]: UI_PALETTES[t].panel, ['--sw-accent' as string]: UI_PALETTES[t].accent } as CSSProperties}>
          <input type="radio" name="ui-theme" value={t} checked={cur === t} onChange={() => pick(t)} data-ui-theme-opt={t} />
          <span className="ui-theme-swatch" aria-hidden="true" />
          <span>{UI_THEME_LABEL[t]}</span>
        </label>
      ))}
    </fieldset>
  );
}
