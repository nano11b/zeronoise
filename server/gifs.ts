import { isAllowedGifUrl } from '../shared/gifs';
import { GIPHY_API_KEY, TENOR_API_KEY } from './env';

export interface GifHit {
  id: string;
  previewUrl: string;
  url: string;
  width: number;
  height: number;
}

const FIXTURE: GifHit[] = [
  {
    id: 'fixture-1',
    previewUrl: 'https://media.tenor.com/fixture/tiny.gif',
    url: 'https://media.tenor.com/fixture/full.gif',
    width: 220,
    height: 140,
  },
  {
    id: 'fixture-2',
    previewUrl: 'https://media.giphy.com/media/fixture/200.gif',
    url: 'https://media.giphy.com/media/fixture/giphy.gif',
    width: 200,
    height: 200,
  },
];

function num(v: unknown, d = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : d;
}

function keep(hit: GifHit | null): hit is GifHit {
  return !!hit && isAllowedGifUrl(hit.url) && isAllowedGifUrl(hit.previewUrl);
}

function fromTenor(results: any[]): GifHit[] {
  const out: GifHit[] = [];
  for (const r of results || []) {
    const formats = r?.media_formats || {};
    const full = formats.gif || formats.mediumgif || formats.tinygif;
    const prev = formats.tinygif || formats.gif;
    if (!full?.url || !prev?.url) continue;
    const dims = full.dims || prev.dims || [];
    const hit: GifHit = {
      id: String(r.id || full.url),
      previewUrl: String(prev.url),
      url: String(full.url),
      width: num(dims[0], 200),
      height: num(dims[1], 200),
    };
    if (keep(hit)) out.push(hit);
  }
  return out;
}

function fromGiphy(data: any[]): GifHit[] {
  const out: GifHit[] = [];
  for (const r of data || []) {
    const images = r?.images || {};
    const full = images.downsized || images.original || images.fixed_width;
    const prev = images.fixed_width_small || images.fixed_width || images.downsized;
    if (!full?.url || !prev?.url) continue;
    const hit: GifHit = {
      id: String(r.id || full.url),
      previewUrl: String(prev.url),
      url: String(full.url),
      width: num(full.width ?? prev.width, 200),
      height: num(full.height ?? prev.height, 200),
    };
    if (keep(hit)) out.push(hit);
  }
  return out;
}

async function tenor(kind: 'search' | 'trending', q: string, limit: number): Promise<GifHit[]> {
  const path = kind === 'search' ? 'search' : 'featured';
  const u = new URL(`https://tenor.googleapis.com/v2/${path}`);
  u.searchParams.set('key', TENOR_API_KEY);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('media_filter', 'gif,tinygif');
  if (kind === 'search') u.searchParams.set('q', q);
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`tenor ${r.status}`);
  const j = await r.json() as { results?: any[] };
  return fromTenor(j.results || []);
}

async function giphy(kind: 'search' | 'trending', q: string, limit: number): Promise<GifHit[]> {
  const path = kind === 'search' ? 'search' : 'trending';
  const u = new URL(`https://api.giphy.com/v1/gifs/${path}`);
  u.searchParams.set('api_key', GIPHY_API_KEY);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('rating', 'pg-13');
  if (kind === 'search') u.searchParams.set('q', q);
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`giphy ${r.status}`);
  const j = await r.json() as { data?: any[] };
  return fromGiphy(j.data || []);
}

/** Resolve one GIF id through the same providers search uses. */
export async function gifById(id: string): Promise<GifHit | null> {
  const clean = id.trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(clean)) return null;
  if (process.env.GIF_FIXTURE === '1') return FIXTURE.find((g) => g.id === clean) ?? null;
  if (GIPHY_API_KEY) {
    const u = new URL(`https://api.giphy.com/v1/gifs/${encodeURIComponent(clean)}`);
    u.searchParams.set('api_key', GIPHY_API_KEY);
    const r = await fetch(u, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const j = await r.json() as { data?: any };
      const hits = fromGiphy(j.data ? [j.data] : []);
      if (hits[0]) return hits[0];
    } else if (!TENOR_API_KEY) {
      throw new Error(`giphy ${r.status}`);
    }
  }
  if (TENOR_API_KEY) {
    const u = new URL('https://tenor.googleapis.com/v2/posts');
    u.searchParams.set('key', TENOR_API_KEY);
    u.searchParams.set('ids', clean);
    u.searchParams.set('media_filter', 'gif,tinygif');
    const r = await fetch(u, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`tenor ${r.status}`);
    const j = await r.json() as { results?: any[] };
    return fromTenor(j.results || [])[0] ?? null;
  }
  return null;
}

export async function searchGifs(kind: 'search' | 'trending', q: string, limit: number): Promise<GifHit[]> {
  if (process.env.GIF_FIXTURE === '1') {
    const needle = q.trim().toLowerCase();
    return FIXTURE.filter((g) => !needle || g.id.includes(needle) || needle === 'cat').slice(0, limit);
  }
  if (TENOR_API_KEY) {
    try { return await tenor(kind, q, limit); }
    catch (e) {
      if (!GIPHY_API_KEY) throw e;
    }
  }
  if (GIPHY_API_KEY) return giphy(kind, q, limit);
  throw new Error('not configured');
}
