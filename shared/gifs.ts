/** GIF CDN allowlist — only these https hosts may render as images in chat. */

const TENOR = new Set(['media.tenor.com', 'media1.tenor.com', 'c.tenor.com']);
const GIPHY = new Set(['media.giphy.com', 'i.giphy.com']);

export function isAllowedGifUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    if (TENOR.has(h) || h.endsWith('.media.tenor.com')) return true;
    if (GIPHY.has(h) || /^media\d\.giphy\.com$/.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Markdown image the client will render (allowlisted https only). */
export function gifMarkdown(url: string): string {
  return `![GIF](${url})`;
}

/** Same-origin chat upload served by this app (no external hosts). */
export function isAllowedUploadPath(raw: string): boolean {
  const s = raw.trim();
  return /^\/api\/uploads\/[A-Za-z0-9_-]{8,80}\.(webp|gif)$/.test(s);
}

/** Tenor/Giphy https CDNs or our own upload path. */
export function isAllowedChatImage(raw: string): boolean {
  return isAllowedGifUrl(raw) || isAllowedUploadPath(raw);
}
