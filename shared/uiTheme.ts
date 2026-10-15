/** Interface themes a chatter can pick. 'dark' is the original look and the default. */
export const UI_THEMES = ['dark', 'dark-red', 'dark-green', 'dark-orange'] as const;
export type UiTheme = (typeof UI_THEMES)[number];
export const UI_THEME_DEFAULT: UiTheme = 'dark';
export const UI_THEME_KEY = 'zn.uiTheme';
export const UI_THEME_LABEL: Record<UiTheme, string> = { dark: 'Dark', 'dark-red': 'Dark/Red', 'dark-green': 'Dark/Green', 'dark-orange': 'Dark/Orange' };
export const isUiTheme = (v: unknown): v is UiTheme => typeof v === 'string' && (UI_THEMES as readonly string[]).includes(v);

export interface UiPalette {
  bg: string; bg2: string; panel: string; panel2: string; line: string;
  text: string; muted: string; accent: string; accent2: string; accentRgb: string;
  primaryBg: string; primaryText: string;
}
/** Background tint, font colour and accent per theme. All text pairs meet WCAG AA (4.5:1); see test-api. */
export const UI_PALETTES: Record<UiTheme, UiPalette> = {
  dark: { bg: '#0b1220', bg2: '#10192a', panel: '#162033', panel2: '#1c2940', line: '#2c3d57', text: '#e7eef8', muted: '#93a4bb', accent: '#39ff14', accent2: '#b6ff9a', accentRgb: '57 255 20', primaryBg: '#123321', primaryText: '#e7ffe7' },
  'dark-red': { bg: '#150a0d', bg2: '#1c0e12', panel: '#251217', panel2: '#2e171e', line: '#4a2630', text: '#fbe9ec', muted: '#c9a2aa', accent: '#ff5c6c', accent2: '#ffb8c0', accentRgb: '255 92 108', primaryBg: '#3d1219', primaryText: '#ffe8eb' },
  'dark-green': { bg: '#07130b', bg2: '#0b1a10', panel: '#102316', panel2: '#152c1c', line: '#24452e', text: '#e5f7ea', muted: '#9cc4a6', accent: '#3ddc84', accent2: '#b5f5cf', accentRgb: '61 220 132', primaryBg: '#0f3320', primaryText: '#e3fbec' },
  'dark-orange': { bg: '#150e07', bg2: '#1c130a', panel: '#25190e', panel2: '#2f2013', line: '#4d3520', text: '#fdf0e3', muted: '#cfae8e', accent: '#ff9f1c', accent2: '#ffd39a', accentRgb: '255 159 28', primaryBg: '#3d2610', primaryText: '#fff1e0' },
};
const vars = (p: UiPalette) =>
  `--bg:${p.bg};--bg-2:${p.bg2};--panel:${p.panel};--panel-2:${p.panel2};--line:${p.line};--text:${p.text};--muted:${p.muted};` +
  `--accent:${p.accent};--accent-2:${p.accent2};--accent-rgb:${p.accentRgb};--primary-bg:${p.primaryBg};--primary-text:${p.primaryText};`;
/** CSS variable blocks for every theme (used by the server-rendered pages: /status, /docs). */
export function uiThemeCss(): string {
  return UI_THEMES.map((t) => `${t === 'dark' ? ':root,' : ''}html[data-ui-theme="${t}"]{${vars(UI_PALETTES[t])}}`).join('\n');
}
/** WCAG relative luminance contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
