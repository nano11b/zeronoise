/** Link previews: fetch title / description / image / site name for the first URL in a chat line. */
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import type { LinkPreviewInfo } from '../shared/types';
import { parseWatchUrl } from '../shared/watch';
import * as repo2 from './repo2';
import { FetchError, safeFetch } from './safeFetch';

const OK_TTL_MS = 24 * 3600_000;
const FAIL_TTL_MS = 3600_000;
/** Test-only knob; production is 5 s as specified. */
const TIMEOUT_MS = Math.max(200, Math.min(5000, Number(process.env.LINK_PREVIEW_TIMEOUT_MS) || 5000));
const HTML_MAX = 512 * 1024;
const IMAGE_MAX = 2 * 1024 * 1024;
const MAX_CONCURRENT = 4;
const URL_MAX = 500;

/** First http(s) URL that is not an image embed (GIF markdown / uploaded images) and not this site. */
export function firstPreviewUrl(text: string, ownOrigins: string[] = []): string | null {
  if (!text) return null;
  // drop markdown images ![alt](url) so GIFs and uploads never get a card
  const stripped = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  const re = /https?:\/\/[^\s<>"'`]+/gi;
  for (const m of stripped.matchAll(re)) {
    let url = m[0].replace(/[),.!?;:\]]+$/, '');
    if (url.length > URL_MAX) continue;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (ownOrigins.includes(u.origin)) continue;
      if (u.pathname.startsWith('/api/uploads/')) continue;
      u.hash = '';
      url = u.toString();
    } catch { continue; }
    return url;
  }
  return null;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (full, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) { const n = parseInt(k.slice(2), 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    if (k.startsWith('#')) { const n = Number(k.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENT[k] ?? full;
  });
}
const tidy = (s: string | null | undefined, max: number) => {
  if (!s) return null;
  const t = decodeEntities(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null;
};
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}
/** Parse OpenGraph / Twitter / <title> metadata out of the HTML head. */
export function parseHtmlMeta(html: string, baseUrl: string): { title: string | null; description: string | null; image: string | null; siteName: string | null } {
  const head = html.slice(0, HTML_MAX);
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'property') ?? attr(m[0], 'name') ?? '').toLowerCase();
    const content = attr(m[0], 'content');
    if (key && content != null && !(key in meta)) meta[key] = content;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? null;
  let image: string | null = meta['og:image:secure_url'] ?? meta['og:image'] ?? meta['twitter:image'] ?? meta['twitter:image:src'] ?? null;
  if (image) {
    try {
      const u = new URL(decodeEntities(image.trim()), baseUrl);
      image = u.protocol === 'http:' || u.protocol === 'https:' ? u.toString().slice(0, URL_MAX) : null;
    } catch { image = null; }
  }
  return {
    title: tidy(meta['og:title'] ?? meta['twitter:title'] ?? titleTag, 200),
    description: tidy(meta['og:description'] ?? meta['twitter:description'] ?? meta.description, 300),
    image,
    siteName: tidy(meta['og:site_name'] ?? meta['application-name'], 80),
  };
}

let active = 0;
const inflight = new Map<string, Promise<repo2.PreviewRow | null>>();

/** X oEmbed JSON -> card title ("<author> on X") and the post text (tags stripped, entities decoded, 300 chars). */
export function parseXOembed(json: string, handle: string): { title: string; text: string | null } {
  const j = JSON.parse(json) as { author_name?: string; html?: string };
  const para = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(j.html ?? '')?.[1] ?? '';
  const text = tidy(para.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''), 300);
  return { title: `${tidy(j.author_name ?? '', 80) || `@${handle}`} on X`, text: text || null };
}
/** A direct link to an image file (the card is the proxied image). */
export const isImageUrl = (u: URL) => /\.(png|jpe?g|gif|webp|avif)$/i.test(u.pathname);
async function fetchPreview(url: string): Promise<repo2.PreviewRow> {
  const existing = repo2.previewByUrl(url);
  const id = existing?.id ?? randomUUID();
  const base = { url, id, fetched_at: Date.now() };
  const watch = parseWatchUrl(url);
  let kind: 'page' | 'youtube' | 'twitch' | 'x' | 'image' = 'page';
  let u: URL | null = null;
  try { u = new URL(url); } catch { /* checked by the caller */ }
  // a direct image link: the card is the (proxied, re-encoded) image itself
  if (u && isImageUrl(u)) {
    const name = decodeURIComponent(u.pathname.split('/').pop() || 'image').slice(0, 120);
    return { ...base, ok: 1, kind: 'image', title: name, description: null, image_url: url, site_name: u.hostname.replace(/^www\./, '') };
  }
  // X / Twitter posts: the public oEmbed endpoint (x.com itself serves no metadata to fetchers)
  const xm = u && /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i.test(u.hostname) ? /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})/.exec(u.pathname) : null;
  if (xm) {
    try {
      const r = await safeFetch(`https://publish.x.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(`https://twitter.com/${xm[1]}/status/${xm[2]}`)}`, {
        timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024, maxRedirects: 2, headers: { accept: 'application/json' },
        accept: (status) => { if (status < 200 || status >= 300) throw new FetchError(`HTTP ${status}`, 'status'); },
      });
      const x = parseXOembed(r.body.toString('utf8'), xm[1]);
      return { ...base, ok: 1, kind: 'x', title: x.title, description: x.text, image_url: null, site_name: 'X' };
    } catch {
      return { ...base, ok: 1, kind: 'x', title: `@${xm[1]} on X`, description: null, image_url: null, site_name: 'X' };
    }
  }
  let fallback: { title: string | null; image: string | null; siteName: string | null } = { title: null, image: null, siteName: null };
  if (watch?.provider === 'youtube') {
    kind = 'youtube';
    fallback = { title: 'YouTube video', image: `https://i.ytimg.com/vi/${watch.id}/hqdefault.jpg`, siteName: 'YouTube' };
  } else if (watch?.provider === 'twitch') {
    kind = 'twitch';
    fallback = watch.kind === 'live'
      ? { title: `${watch.id} on Twitch`, image: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${watch.id.toLowerCase()}-640x360.jpg`, siteName: 'Twitch' }
      : { title: 'Twitch video', image: null, siteName: 'Twitch' };
  }
  try {
    const r = await safeFetch(url, {
      timeoutMs: TIMEOUT_MS, maxBytes: HTML_MAX, maxRedirects: 3,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9', 'accept-language': 'en' },
      accept: (status, headers) => {
        if (status < 200 || status >= 300) throw new FetchError(`HTTP ${status}`, 'status');
        const ct = String(headers['content-type'] ?? '').toLowerCase();
        if (!/^(text\/html|application\/xhtml\+xml)\b/.test(ct)) throw new FetchError('Not HTML', 'type');
      },
    });
    const meta = parseHtmlMeta(r.body.toString('utf8'), r.url);
    const title = meta.title ?? fallback.title;
    if (!title && !meta.description) return { ...base, ok: 0, kind, title: null, description: null, image_url: null, site_name: null };
    return {
      ...base, ok: 1, kind, title, description: meta.description,
      image_url: kind === 'page' ? meta.image : fallback.image ?? meta.image,
      site_name: meta.siteName ?? fallback.siteName ?? new URL(r.url).hostname.replace(/^www\./, ''),
    };
  } catch {
    // YouTube / Twitch still get a card from the id alone
    if (kind !== 'page') return { ...base, ok: 1, kind, title: fallback.title, description: null, image_url: fallback.image, site_name: fallback.siteName };
    return { ...base, ok: 0, kind, title: null, description: null, image_url: null, site_name: null };
  }
}

/** Cached (TTL) preview for a URL; fetches at most MAX_CONCURRENT at a time. Null on failure or when busy. */
export async function getPreview(url: string): Promise<repo2.PreviewRow | null> {
  const cached = repo2.previewByUrl(url);
  if (cached && Date.now() - cached.fetched_at < (cached.ok ? OK_TTL_MS : FAIL_TTL_MS)) return cached.ok ? cached : null;
  const running = inflight.get(url);
  if (running) return running;
  if (active >= MAX_CONCURRENT) return null;
  active++;
  const p = fetchPreview(url).then((row) => { repo2.savePreview(row); return row.ok ? repo2.previewByUrl(url) ?? null : null; })
    .catch((err) => { console.error('[preview] failed', (err as Error).message); return null; })
    .finally(() => { active--; inflight.delete(url); });
  inflight.set(url, p);
  return p;
}

export function previewInfo(r: repo2.PreviewRow): LinkPreviewInfo {
  return {
    id: r.id, url: r.url, kind: (r.kind === 'youtube' || r.kind === 'twitch' || r.kind === 'x' || r.kind === 'image' ? r.kind : 'page'),
    title: r.title, description: r.description, siteName: r.site_name,
    image: r.image_url ? `/api/link-preview/${r.id}/image` : null,
  };
}

// ---- image proxy: never hotlink third-party images into the page ----
const imageCache = new Map<string, { at: number; body: Buffer | null }>();
const IMAGE_CACHE_MAX = 100;
const IMAGE_TTL_MS = 6 * 3600_000;
/** Fetch the preview image through the SSRF guard, re-encode it with sharp (strips anything active), cache in memory. */
export async function previewImage(previewId: string): Promise<Buffer | null> {
  const hit = imageCache.get(previewId);
  if (hit && Date.now() - hit.at < IMAGE_TTL_MS) return hit.body;
  const row = repo2.previewById(previewId);
  if (!row?.ok || !row.image_url) return null;
  let body: Buffer | null = null;
  try {
    const r = await safeFetch(row.image_url, {
      timeoutMs: TIMEOUT_MS, maxBytes: IMAGE_MAX, maxRedirects: 3, failOnOversize: true,
      headers: { accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.8' },
      accept: (status, headers) => {
        if (status < 200 || status >= 300) throw new FetchError(`HTTP ${status}`, 'status');
        const ct = String(headers['content-type'] ?? '').toLowerCase();
        if (!/^image\/(png|jpe?g|gif|webp|avif)\b/.test(ct)) throw new FetchError('Not an image', 'type');
      },
    });
    body = await sharp(r.body, { limitInputPixels: 40_000_000, animated: false })
      .rotate().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
  } catch { body = null; }
  if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value as string);
  imageCache.set(previewId, { at: Date.now(), body });
  return body;
}
