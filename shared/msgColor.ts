/** batch X: chatter-chosen message text colour. Must stay readable (4.5:1) on every theme; unreadable picks are lightened. */
import { UI_PALETTES, UI_THEMES, contrast } from './uiTheme';
/** 4.5:1 on every theme's backgrounds, panels and own-message bubbles */
export function readableOnAllThemes(hex: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  return UI_THEMES.every((t) => { const p = UI_PALETTES[t]; return [p.bg, p.bg2, p.panel, p.panel2, p.primaryBg].every((b) => contrast(hex, b) >= 4.5); });
}

export const MSG_COLOR_KEY = 'zn.ignoreMsgColors';
/** Ready-made picks (all pass readableOnAllThemes; see test-api / people-check). */
export const MSG_COLORS = [
  { hex: '#ffd166', label: 'Gold' }, { hex: '#ff9fb2', label: 'Pink' }, { hex: '#9fd8ff', label: 'Sky' },
  { hex: '#b9f6ca', label: 'Mint' }, { hex: '#d7b8ff', label: 'Lilac' }, { hex: '#ffc49b', label: 'Peach' },
  { hex: '#f2f2f2', label: 'Snow' }, { hex: '#c6f68d', label: 'Lime' },
] as const;

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}
/**
 * Returns the colour itself when it is readable on all four themes, otherwise the closest lighter tint that is
 * (mixing toward white in 5% steps), or null for input that is not a colour.
 */
export function readableMsgColor(v: unknown): { color: string; adjusted: boolean } | null {
  const h = normalizeHex(v);
  if (!h) return null;
  if (readableOnAllThemes(h)) return { color: h, adjusted: false };
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (let k = 1; k <= 20; k++) {
    const t = k / 20;
    const c = `#${hex2(r + (255 - r) * t)}${hex2(g + (255 - g) * t)}${hex2(b + (255 - b) * t)}`;
    if (readableOnAllThemes(c)) return { color: c, adjusted: true };
  }
  return { color: '#ffffff', adjusted: true };
}
/** Only colours that pass the check are ever shown (stored values are re-checked on render). */
export const safeMsgColor = (v: unknown): string | null => { const h = normalizeHex(v); return h && readableOnAllThemes(h) ? h : null; };
