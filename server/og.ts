/**
 * Share preview cards: Open Graph / Twitter meta injected into the SPA shell for "/", "/?room=<id>" and "/i/<code>",
 * and a generated 1200x630 JPEG card per room (sharp: SVG overlay -> raster). Cards are cached per room and variant,
 * rebuilt when the name / thumbnail / icon / category / tags change, and at most every 5 minutes for the online count.
 *
 * Privacy: private calls and unknown rooms get the generic site card and site meta (the room is not confirmed to exist).
 * Password rooms show only their name (plus the lobby-visible thumbnail/icon) unless an invite that skips the password
 * is being shared.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import sharp, { type OverlayOptions, type Sharp } from 'sharp';
import { BRAND_NAME, TAGLINE } from '../shared/config';
import { CATEGORY_LABEL, isRoomCategory } from '../shared/batch3';
import { roomThumbPath } from './roomThumbs';
import { roomIconPath } from './roomIcons';

export const CARD_W = 1200;
export const CARD_H = 630;
export const CARD_REFRESH_MS = Math.max(1000, Number(process.env.OG_CARD_REFRESH_MS) || 5 * 60_000);

export interface CardRoom {
  id: string; name: string; topic: string; isPrivate: boolean; passwordRequired: boolean;
  category: string | null; tags: string[]; users: number; thumbId: string | null; iconId: string | null;
}
/** full = topic/category/online shown; locked = name only (password room); none = generic site card */
export type CardVariant = 'full' | 'locked' | 'none';

export function variantFor(room: CardRoom | null, skipsPassword = false): CardVariant {
  if (!room || room.isPrivate) return 'none';
  if (room.passwordRequired && !skipsPassword) return 'locked';
  return 'full';
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const catLabel = (c: string | null) => (c && isRoomCategory(c) ? CATEGORY_LABEL[c] : null);
const FONT = "DejaVu Sans, Noto Sans, Liberation Sans, Arial, Helvetica, sans-serif";

/** Parts of the card that, when changed, force a rebuild right away (the online count is throttled instead). */
function staticSig(room: CardRoom, v: CardVariant) {
  return [v, room.name, room.thumbId ?? '', room.iconId ?? '', v === 'full' ? room.category ?? '' : '', v === 'full' ? room.tags.join(',') : ''].join('|');
}
/** Short version for the image URL so link unfurlers refetch after a change. */
export function cardVersion(room: CardRoom, v: CardVariant): string {
  const online = v === 'full' ? Math.floor(Date.now() / CARD_REFRESH_MS) : 0;
  return createHash('sha1').update(`${staticSig(room, v)}|${online}`).digest('base64url').slice(0, 10);
}

async function render(room: CardRoom, v: CardVariant, clientDir: string): Promise<Buffer> {
  // background: the room thumbnail (cover) or a brand gradient
  const tp = room.thumbId ? roomThumbPath(room.thumbId) : null;
  let base: Sharp;
  if (tp && fs.existsSync(tp)) {
    base = sharp(await sharp(tp).resize(CARD_W, CARD_H, { fit: 'cover' }).modulate({ brightness: 0.9 }).toBuffer());
  } else {
    base = sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1220"/><stop offset="0.6" stop-color="#111c33"/><stop offset="1" stop-color="#1a1040"/></linearGradient>
      <radialGradient id="r" cx="0.85" cy="0.1" r="0.7"><stop offset="0" stop-color="#2bd4ff" stop-opacity="0.28"/><stop offset="1" stop-color="#2bd4ff" stop-opacity="0"/></radialGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/></svg>`));
  }
  const iconSize = 168;
  const ix = 72, iy = 300;
  const tx = ix + iconSize + 36;
  const name = clip(room.name, 26);
  const nameSize = name.length > 18 ? 62 : 76;
  const cat = v === 'full' ? catLabel(room.category) : null;
  const tags = v === 'full' ? room.tags.slice(0, 3).map((t) => `#${t}`).join('  ') : '';
  const line2 = v === 'locked' ? 'Password-protected room' : [cat, tags].filter(Boolean).join('   ·   ');
  const online = v === 'full' ? `${room.users} online` : '';
  const letter = esc((room.name || '?').slice(0, 1).toUpperCase());
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">
    <defs>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050a14" stop-opacity="0.35"/><stop offset="0.45" stop-color="#050a14" stop-opacity="0.6"/><stop offset="1" stop-color="#050a14" stop-opacity="0.94"/></linearGradient>
      <linearGradient id="side" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#050a14" stop-opacity="0.55"/><stop offset="0.7" stop-color="#050a14" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#fade)"/><rect width="100%" height="100%" fill="url(#side)"/>
    ${room.iconId ? `<circle cx="${ix + iconSize / 2}" cy="${iy + iconSize / 2}" r="${iconSize / 2 + 5}" fill="#0b1220" stroke="#3ee07a" stroke-width="5"/>`
      : `<circle cx="${ix + iconSize / 2}" cy="${iy + iconSize / 2}" r="${iconSize / 2}" fill="#1e2a44" stroke="#3ee07a" stroke-width="5"/>
         <text x="${ix + iconSize / 2}" y="${iy + iconSize / 2 + 26}" text-anchor="middle" font-family="${FONT}" font-size="76" font-weight="700" fill="#ffffff">${letter}</text>`}
    <text x="${tx}" y="${iy + 72}" font-family="${FONT}" font-size="${nameSize}" font-weight="700" fill="#ffffff">${esc(name)}</text>
    ${line2 ? `<text x="${tx}" y="${iy + 124}" font-family="${FONT}" font-size="32" fill="#c9d4ea">${esc(clip(line2, 48))}</text>` : ''}
    ${online ? `<circle cx="${tx + 11}" cy="${iy + 160}" r="10" fill="#3ee07a"/><text x="${tx + 32}" y="${iy + 171}" font-family="${FONT}" font-size="32" font-weight="700" fill="#3ee07a">${esc(online)}</text>` : ''}
    <text x="${CARD_W - 72}" y="${CARD_H - 52}" text-anchor="end" font-family="${FONT}" font-size="26" fill="#9fb0cf">Join on ${esc(BRAND_NAME)}</text>
  </svg>`;
  const layers: OverlayOptions[] = [{ input: Buffer.from(overlay), top: 0, left: 0 }];
  const ipath = room.iconId ? roomIconPath(room.iconId) : null;
  if (ipath && fs.existsSync(ipath)) {
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${iconSize}" height="${iconSize}"><circle cx="${iconSize / 2}" cy="${iconSize / 2}" r="${iconSize / 2}" fill="#fff"/></svg>`);
    const icon = await sharp(ipath).resize(iconSize, iconSize, { fit: 'cover' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    layers.push({ input: icon, top: iy, left: ix });
  }
  const wm = path.join(clientDir, 'logo-wordmark.png');
  if (fs.existsSync(wm)) layers.push({ input: await sharp(wm).resize(300).png().toBuffer(), top: 64, left: 72 });
  return base.composite(layers).flatten({ background: '#0b1220' }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
}

type Entry = { sig: string; online: number; at: number; buf: Buffer; etag: string };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
export const cardStats = { renders: 0 };

/** Cached card for a room + variant (variant 'none' is never rendered; callers send the site image). */
export async function roomCard(room: CardRoom, v: Exclude<CardVariant, 'none'>, clientDir: string): Promise<Entry> {
  const key = `${room.id}:${v}`;
  const sig = staticSig(room, v);
  const online = v === 'full' ? room.users : 0;
  const hit = cache.get(key);
  if (hit && hit.sig === sig && (hit.online === online || Date.now() - hit.at < CARD_REFRESH_MS)) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const buf = await render(room, v, clientDir);
      cardStats.renders++;
      const e: Entry = { sig, online, at: Date.now(), buf, etag: `"${createHash('sha1').update(buf).digest('base64url').slice(0, 20)}"` };
      cache.set(key, e);
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
      return e;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}
export function forgetCards(roomId: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${roomId}:`)) cache.delete(k);
}

// ---------------- meta ----------------
export interface Meta { title: string; description: string; image: string; imageAlt: string; url: string; type?: string }

export function siteMeta(base: string, url: string): Meta {
  return { title: BRAND_NAME, description: `${BRAND_NAME} - ${TAGLINE}`, image: `${base}/og-image.png`, imageAlt: BRAND_NAME, url };
}

export function roomMeta(base: string, url: string, room: CardRoom, v: CardVariant, imagePath: string): Meta {
  if (v === 'none') return siteMeta(base, url);
  const title = `Join ${room.name} on ${BRAND_NAME}`;
  let description: string;
  if (v === 'locked') description = `A password-protected room on ${BRAND_NAME}.`;
  else {
    const bits = [room.topic.trim(), catLabel(room.category), room.tags.length ? room.tags.slice(0, 5).map((t) => `#${t}`).join(' ') : '',
      `${room.users} ${room.users === 1 ? 'person' : 'people'} online now`].filter(Boolean);
    description = clip(bits.join(' · '), 280);
  }
  return { title, description, image: `${base}${imagePath}`, imageAlt: `${room.name} on ${BRAND_NAME}`, url };
}

export function metaTags(m: Meta): string {
  const t = [
    `<title>${esc(m.title)}</title>`,
    `<meta name="description" content="${esc(m.description)}" />`,
    `<meta property="og:type" content="${m.type ?? 'website'}" />`,
    `<meta property="og:site_name" content="${esc(BRAND_NAME)}" />`,
    `<meta property="og:title" content="${esc(m.title)}" />`,
    `<meta property="og:description" content="${esc(m.description)}" />`,
    `<meta property="og:url" content="${esc(m.url)}" />`,
    `<meta property="og:image" content="${esc(m.image)}" />`,
    `<meta property="og:image:width" content="${CARD_W}" />`,
    `<meta property="og:image:height" content="${CARD_H}" />`,
    `<meta property="og:image:alt" content="${esc(m.imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(m.title)}" />`,
    `<meta name="twitter:description" content="${esc(m.description)}" />`,
    `<meta name="twitter:image" content="${esc(m.image)}" />`,
    `<meta name="twitter:image:alt" content="${esc(m.imageAlt)}" />`,
  ];
  return t.join('\n    ');
}

/** Replace the shell's static title / description / og / twitter tags with ours. */
export function injectMeta(html: string, m: Meta): string {
  const stripped = html
    .replace(/\s*<title>[\s\S]*?<\/title>/i, '')
    .replace(/\s*<meta\s+(?:name|property)="(?:description|og:[^"]+|twitter:[^"]+)"[^>]*>/gi, '');
  return stripped.replace(/<\/head>/i, `    ${metaTags(m)}\n  </head>`);
}
