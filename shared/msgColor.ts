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

/* ---- batch MC2: gradient message colours. Stored in the same users.msg_color text column as
 *  "g:#rrggbb,#rrggbb[,#rrggbb]" (2-3 stops, every stop readable on all four themes). Older builds read
 *  that as "not a colour" and show the normal text colour, so no migration is needed. ---- */
export type MsgStyle = { kind: 'solid'; color: string } | { kind: 'gradient'; stops: string[]; fallback: string };
export const MSG_GRADIENTS = [
  { stops: ['#ffd166', '#ff9fb2'], label: 'Sunset' },
  { stops: ['#9fd8ff', '#d7b8ff'], label: 'Dusk' },
  { stops: ['#b9f6ca', '#9fd8ff'], label: 'Lagoon' },
  { stops: ['#ffc49b', '#ffd166', '#c6f68d'], label: 'Citrus' },
  { stops: ['#ff9fb2', '#d7b8ff', '#9fd8ff'], label: 'Candy' },
  { stops: ['#f2f2f2', '#9fd8ff'], label: 'Frost' },
] as const;
const GRAD_RE = /^g:(#[0-9a-f]{6})(?:,(#[0-9a-f]{6})){1,2}$/;
/** parse a stored value (no readability check) */
export function parseMsgStyle(v: unknown): MsgStyle | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s.startsWith('g:')) {
    if (!GRAD_RE.test(s)) return null;
    const stops = s.slice(2).split(',');
    return { kind: 'gradient', stops, fallback: stops[0] };
  }
  const h = normalizeHex(s);
  return h ? { kind: 'solid', color: h } : null;
}
export const serializeMsgStyle = (st: MsgStyle): string => (st.kind === 'solid' ? st.color : `g:${st.stops.join(',')}`);
/** what a viewer may render: every colour re-checked on all themes, otherwise null */
export function safeMsgStyle(v: unknown): MsgStyle | null {
  const st = parseMsgStyle(v);
  if (!st) return null;
  if (st.kind === 'solid') return readableOnAllThemes(st.color) ? st : null;
  return st.stops.every(readableOnAllThemes) ? st : null;
}
/**
 * Server/client input check. Accepts a hex string, a stored "g:" string, or { stops: [...] } (2-3 hex stops).
 * Unreadable stops are lightened like solid colours. Returns the value to store, or null for bad input.
 */
export function readableMsgStyle(v: unknown): { value: string; style: MsgStyle; adjusted: boolean } | null {
  let stops: unknown[] | null = null;
  if (v && typeof v === 'object' && Array.isArray((v as { stops?: unknown }).stops)) stops = (v as { stops: unknown[] }).stops;
  else if (typeof v === 'string' && v.trim().toLowerCase().startsWith('g:')) stops = v.trim().slice(2).split(',');
  if (!stops) {
    const r = readableMsgColor(v);
    return r ? { value: r.color, style: { kind: 'solid', color: r.color }, adjusted: r.adjusted } : null;
  }
  if (stops.length < 2 || stops.length > 3) return null;
  const fixed = stops.map((x) => readableMsgColor(x));
  if (fixed.some((x) => !x)) return null;
  const out = fixed.map((x) => x!.color);
  const style: MsgStyle = { kind: 'gradient', stops: out, fallback: out[0] };
  return { value: serializeMsgStyle(style), style, adjusted: fixed.some((x) => x!.adjusted) };
}
/** CSS for a line. Gradients get a solid `color` fallback; the gradient itself only applies under @supports (see styles.css). */
export function msgStyleCss(st: MsgStyle | null): { className: string; style?: Record<string, string> } {
  if (!st) return { className: '' };
  if (st.kind === 'solid') return { className: 'msg-colored', style: { color: st.color } };
  return { className: 'msg-colored msg-grad', style: { color: st.fallback, '--msg-grad': `linear-gradient(90deg, ${st.stops.join(', ')})` } };
}
