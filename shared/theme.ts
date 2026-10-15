/** Room theme set by the owner: a banner image, an accent color, and a welcome message pinned at the top of chat. */
export interface RoomThemeInfo { bannerUrl: string | null; accent: string | null; welcome: string | null }
export const THEME_ACCENT_RE = /^#[0-9a-f]{6}$/i;
export const THEME_WELCOME_MAX = 500;
export const ROOM_BANNER_W = 1200;
export const ROOM_BANNER_H = 300;
export const roomBannerUrl = (id: string) => `/api/room-banners/${id}.webp`;
/** Accent colors that keep text readable on the dark theme (relative luminance between 0.08 and 0.9). */
export function accentReadable(hex: string): boolean {
  if (!THEME_ACCENT_RE.test(hex)) return false;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L >= 0.08 && L <= 0.9;
}
