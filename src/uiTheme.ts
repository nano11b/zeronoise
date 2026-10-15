import { isUiTheme, UI_PALETTES, UI_THEME_DEFAULT, UI_THEME_KEY, type UiTheme } from '../shared/uiTheme';

/** The theme this browser shows now (set before first paint by /theme-boot.js). */
export function currentUiTheme(): UiTheme {
  const a = document.documentElement.getAttribute('data-ui-theme');
  return isUiTheme(a) ? a : UI_THEME_DEFAULT;
}
/** Apply a theme and remember it in this browser (the fallback for visitors who are not signed in). */
export function applyUiTheme(t: UiTheme) {
  document.documentElement.setAttribute('data-ui-theme', t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', UI_PALETTES[t].bg);
  try { localStorage.setItem(UI_THEME_KEY, t); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('zn-ui-theme', { detail: t }));
}
