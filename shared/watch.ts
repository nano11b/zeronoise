/**
 * Watch-party link parsing. Runs on the server (authoritative) and the client (preview).
 * Only YouTube and Twitch links become embeds; everything else is rejected.
 */
import type { WatchKind, WatchProvider, WatchState } from './types';

export interface ParsedWatch {
  provider: WatchProvider;
  kind: WatchKind;
  id: string;
  /** start offset from t= / start= (seconds), 0 if none */
  startSec: number;
  url: string;
}

export const WATCH_URL_MAX = 300;
/** Drift beyond this (seconds) triggers a seek on the client. */
export const WATCH_DRIFT_SEC = 2;
/** Upper bound on positions we accept (24 h). */
export const WATCH_MAX_POSITION_SEC = 24 * 3600;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const TWITCH_LOGIN = /^[A-Za-z0-9_]{3,25}$/;
const TWITCH_VOD = /^\d{5,12}$/;
/** twitch.tv/<these> are site pages, not channels */
const TWITCH_RESERVED = new Set([
  'videos', 'directory', 'p', 'settings', 'subscriptions', 'inventory', 'wallet', 'downloads', 'jobs', 'search',
  'login', 'signup', 'friends', 'messages', 'payments', 'prime', 'turbo', 'store', 'drops', 'following', 'moderator',
  'popout', 'embed', 'clip', 'clips', 'collections', 'team', 'u', 'privacy', 'legal', 'help',
]);

/** "90", "90s", "1m30s", "1h2m3s", "01:30" -> seconds. Invalid -> 0. */
export function parseTimeParam(raw: string | null | undefined): number {
  if (!raw) return 0;
  const v = raw.trim().toLowerCase();
  if (/^\d{1,6}$/.test(v)) return clampPos(Number(v));
  const hms = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(v);
  if (hms && (hms[1] || hms[2] || hms[3])) return clampPos(Number(hms[1] || 0) * 3600 + Number(hms[2] || 0) * 60 + Number(hms[3] || 0));
  const colon = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/.exec(v);
  if (colon) return clampPos(Number(colon[1] || 0) * 3600 + Number(colon[2]) * 60 + Number(colon[3]));
  return 0;
}

function clampPos(n: number) {
  return Number.isFinite(n) ? Math.max(0, Math.min(WATCH_MAX_POSITION_SEC, Math.floor(n))) : 0;
}

export function canonicalWatchUrl(provider: WatchProvider, kind: WatchKind, id: string): string {
  if (provider === 'youtube') return `https://www.youtube.com/watch?v=${id}`;
  if (kind === 'vod') return `https://www.twitch.tv/videos/${id}`;
  return `https://www.twitch.tv/${id}`;
}

/** Parse a pasted link. Returns null for anything that is not a supported YouTube/Twitch link. */
export function parseWatchUrl(input: unknown): ParsedWatch | null {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw || raw.length > WATCH_URL_MAX || /[\s\u0000-\u001f]/.test(raw)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const parts = u.pathname.split('/').filter(Boolean);
  const t = u.searchParams.get('t') ?? u.searchParams.get('start') ?? (u.hash.startsWith('#t=') ? u.hash.slice(3) : null);

  const yt = (id: string | null | undefined): ParsedWatch | null => {
    if (!id || !YT_ID.test(id)) return null;
    return { provider: 'youtube', kind: 'video', id, startSec: parseTimeParam(t), url: canonicalWatchUrl('youtube', 'video', id) };
  };

  if (host === 'youtu.be') return yt(parts[0]);
  if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com'
    || host === 'youtube-nocookie.com' || host === 'www.youtube-nocookie.com') {
    if (parts[0] === 'watch' && parts.length === 1) return yt(u.searchParams.get('v'));
    if ((parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed' || parts[0] === 'v') && parts.length >= 2) return yt(parts[1]);
    return null;
  }
  if (host === 'twitch.tv' || host === 'www.twitch.tv' || host === 'm.twitch.tv') {
    if (parts[0] === 'videos' && parts.length === 2 && TWITCH_VOD.test(parts[1])) {
      return { provider: 'twitch', kind: 'vod', id: parts[1], startSec: parseTimeParam(t), url: canonicalWatchUrl('twitch', 'vod', parts[1]) };
    }
    if (parts.length === 1 && TWITCH_LOGIN.test(parts[0]) && !TWITCH_RESERVED.has(parts[0].toLowerCase())) {
      const login = parts[0].toLowerCase();
      return { provider: 'twitch', kind: 'live', id: login, startSec: 0, url: canonicalWatchUrl('twitch', 'live', login) };
    }
    return null;
  }
  return null;
}

/** Where playback should be right now, given state and the server clock. Live channels are always 0. */
export function expectedPosition(w: Pick<WatchState, 'kind' | 'playing' | 'positionSec' | 'updatedAt'>, serverNowMs: number): number {
  if (w.kind === 'live') return 0;
  if (!w.playing) return w.positionSec;
  return Math.max(0, w.positionSec + Math.max(0, serverNowMs - w.updatedAt) / 1000);
}

/** Accept a client-reported position (seconds). */
export function cleanPosition(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 0 || n > WATCH_MAX_POSITION_SEC) return null;
  return Math.round(n * 10) / 10;
}

/** Who may load/play/pause/seek/clear. Locked rooms: creator and moderators only. */
export function canControlWatch(p: { locked: boolean; isCreator: boolean; isModerator: boolean; isBot?: boolean }): boolean {
  if (p.isBot) return false;
  if (!p.locked) return true;
  return p.isCreator || p.isModerator;
}
