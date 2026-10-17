/** Profiles 2.0 (batch C): profile links, "now playing" status, banner limits. Shared by server (enforcement) and client (form hints). */
export interface ProfileLink { label: string; url: string }
export const PROFILE_LINKS_MAX = 4;
export const PROFILE_LINK_LABEL_MAX = 32;
export const PROFILE_LINK_URL_MAX = 200;
export const NOW_PLAYING_MAX = 80;
/** a "now playing" status older than this is not shown */
export const NOW_PLAYING_TTL_MS = 12 * 3_600_000;
export const BANNER_MAX_BYTES = 2 * 1024 * 1024;
export const BANNER_W = 1200;
export const BANNER_H = 300;

/**
 * One profile link: http(s) only, a real host name (with a dot, no IP literals), no user:password@,
 * no control characters. Returns the normalized URL or an error.
 */
export function checkProfileUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Link must be text' };
  let s = raw.trim();
  if (!s) return { ok: false, error: 'Link is empty' };
  if (s.length > PROFILE_LINK_URL_MAX) return { ok: false, error: `Links can be at most ${PROFILE_LINK_URL_MAX} characters` };
  if (/[\u0000-\u001f\u007f\s<>"']/.test(s)) return { ok: false, error: 'Link has characters that are not allowed' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: 'Not a valid link' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Only http and https links' };
  if (u.username || u.password) return { ok: false, error: 'Links cannot contain a user name or password' };
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[') || host.endsWith('.local') || host === 'localhost') return { ok: false, error: 'Use a public web address' };
  return { ok: true, url: u.toString() };
}

export function checkProfileLinks(raw: unknown): { ok: true; links: ProfileLink[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'Links must be a list' };
  if (raw.length > PROFILE_LINKS_MAX) return { ok: false, error: `At most ${PROFILE_LINKS_MAX} links` };
  const out: ProfileLink[] = [];
  for (const item of raw) {
    const it = (item ?? {}) as { label?: unknown; url?: unknown };
    if (typeof it.url === 'string' && !it.url.trim() && (typeof it.label !== 'string' || !it.label.trim())) continue; // empty row
    const u = checkProfileUrl(it.url);
    if (!u.ok) return u;
    const label = (typeof it.label === 'string' ? it.label : '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, PROFILE_LINK_LABEL_MAX) || new URL(u.url).hostname.replace(/^www\./, '');
    out.push({ label, url: u.url });
  }
  return { ok: true, links: out };
}

export function cleanNowPlaying(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOW_PLAYING_MAX);
}
