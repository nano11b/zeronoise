/**
 * Labs FM "now playing" relay. The server polls the AzuraCast public API (at most every 15 s, and only
 * while at least one socket is listening or someone asked for a fresh value), re-encodes album art
 * through sharp and serves it from /api/radio/art/<id>.webp, so clients never hotlink the station.
 */
import { createHash } from 'crypto';
import sharp from 'sharp';
import { FetchError, safeFetch } from './safeFetch';
import type { RadioNowPlaying } from '../shared/types';

export const RADIO_NOWPLAYING_URL = process.env.RADIO_NOWPLAYING_URL || 'https://radio.seven-labs.com/api/nowplaying/labsfm';
/** RADIO_NOWPLAYING_URL is a test-only override; only then may the interval go under 15 s. */
const TESTING = !!process.env.RADIO_NOWPLAYING_URL;
export const RADIO_POLL_MS = Math.max(TESTING ? 200 : 15_000, Number(process.env.RADIO_POLL_MS) || 15_000);
const TIMEOUT_MS = Math.max(500, Number(process.env.RADIO_TIMEOUT_MS) || 5000);
const UPSTREAM_HOST = (() => { try { return new URL(RADIO_NOWPLAYING_URL).host.toLowerCase(); } catch { return ''; } })();

const art = new Map<string, Buffer>(); // id -> webp (most recent few songs)
const ART_KEEP = 12;
const artIdFor = (url: string) => createHash('sha1').update(url).digest('hex').slice(0, 24);
export const ART_ID_RE = /^[a-f0-9]{24}$/;
export function radioArt(id: string): Buffer | null { return art.get(id) ?? null; }

let current: RadioNowPlaying | null = null;
let lastFetchAt = 0;
let inflight: Promise<RadioNowPlaying | null> | null = null;
let failures = 0;
let timer: NodeJS.Timeout | null = null;
let upstreamHits = 0;
export const radioStats = () => ({ upstreamHits, polling: !!timer });

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

async function fetchArt(url: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.host.toLowerCase() !== UPSTREAM_HOST || !/^https?:$/.test(u.protocol)) return null; // only the station's own art
  const id = artIdFor(u.toString());
  if (art.has(id)) return id;
  try {
    const r = await safeFetch(u.toString(), {
      timeoutMs: TIMEOUT_MS, maxBytes: 4 * 1024 * 1024, maxRedirects: 2, failOnOversize: true,
      headers: { accept: 'image/webp,image/png,image/jpeg;q=0.8' },
      accept: (status, headers) => {
        if (status < 200 || status >= 300) throw new FetchError(`HTTP ${status}`, 'status');
        if (!/^image\//.test(String(headers['content-type'] ?? '').toLowerCase())) throw new FetchError('Not an image', 'type');
      },
    });
    const webp = await sharp(r.body, { limitInputPixels: 40_000_000, animated: false }).rotate()
      .resize(160, 160, { fit: 'cover' }).webp({ quality: 78 }).toBuffer();
    if (art.size >= ART_KEEP) art.delete(art.keys().next().value as string);
    art.set(id, webp);
    return id;
  } catch { return null; }
}

function parse(data: unknown, artId: string | null): RadioNowPlaying | null {
  const d = data as Record<string, any> | null;
  if (!d || typeof d !== 'object') return null;
  const np = d.now_playing;
  const song = np?.song;
  if (!song || typeof song !== 'object') return null;
  return {
    station: str(d.station?.name, 60) || 'Labs FM',
    title: str(song.title), artist: str(song.artist), album: str(song.album),
    artUrl: artId ? `/api/radio/art/${artId}.webp` : null,
    listeners: Math.round(num(d.listeners?.current ?? d.listeners?.total)),
    elapsed: num(np.elapsed), duration: num(np.duration), playedAt: num(np.played_at) * 1000,
    isLive: !!d.live?.is_live, streamer: str(d.live?.streamer_name, 60),
    offline: false, serverNow: Date.now(),
  };
}

/** One upstream fetch (coalesced). Never throws. */
export function refreshNowPlaying(): Promise<RadioNowPlaying | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    lastFetchAt = Date.now();
    upstreamHits++;
    try {
      const r = await safeFetch(RADIO_NOWPLAYING_URL, {
        timeoutMs: TIMEOUT_MS, maxBytes: 1024 * 1024, maxRedirects: 2, failOnOversize: true,
        headers: { accept: 'application/json' },
        accept: (status) => { if (status < 200 || status >= 300) throw new FetchError(`HTTP ${status}`, 'status'); },
      });
      const data = JSON.parse(r.body.toString('utf8'));
      const songArt = typeof data?.now_playing?.song?.art === 'string' ? data.now_playing.song.art : '';
      const artId = songArt ? await fetchArt(songArt) : null;
      const np = parse(data, artId);
      if (!np) throw new Error('bad shape');
      failures = 0;
      current = np;
    } catch {
      failures++;
      // keep the last song for one blip; after that show the station as offline
      if (current && failures >= 2) current = { ...current, offline: true, serverNow: Date.now() };
      else if (!current && failures >= 1) current = { station: 'Labs FM', title: '', artist: '', album: '', artUrl: null, listeners: 0, elapsed: 0, duration: 0, playedAt: 0, isLive: false, streamer: '', offline: true, serverNow: Date.now() };
    } finally { inflight = null; }
    if (current) { current = { ...current, serverNow: Date.now() }; onUpdate(current); }
    return current;
  })();
  return inflight;
}

/** Current value; fetches when older than the poll interval (so a burst of panel opens costs one request). */
export async function getNowPlaying(): Promise<RadioNowPlaying | null> {
  if (current && Date.now() - lastFetchAt < RADIO_POLL_MS) return { ...current, serverNow: Date.now() };
  return refreshNowPlaying();
}

let onUpdate: (np: RadioNowPlaying) => void = () => {};
let shouldPoll: () => boolean = () => false;
let wrap: (label: string, fn: () => void) => () => void = (_l, fn) => fn;
export function initRadio(opts: { onUpdate: (np: RadioNowPlaying) => void; shouldPoll: () => boolean; guard: (label: string, fn: () => void) => () => void }) {
  onUpdate = opts.onUpdate; shouldPoll = opts.shouldPoll; wrap = opts.guard;
}
/** Start/stop the poll loop to match demand. Call whenever listeners change. */
export function syncRadioPolling() {
  if (shouldPoll()) {
    if (timer) return;
    const due = Math.max(0, RADIO_POLL_MS - (Date.now() - lastFetchAt));
    if (due === 0) void refreshNowPlaying();
    const loop = wrap('radio poll', () => {
      if (!shouldPoll()) { timer = null; return; }
      void refreshNowPlaying();
      timer = setTimeout(loop, RADIO_POLL_MS);
      timer.unref?.();
    });
    timer = setTimeout(loop, due === 0 ? RADIO_POLL_MS : due);
    timer.unref?.();
  } else if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
