/**
 * Thin adapters over the official YouTube IFrame Player API and Twitch embed player.
 * No video is downloaded or proxied; the providers' own iframes play it.
 */
import type { WatchState } from '../shared/types';

export interface WatchAdapter {
  /** seconds */
  getTime(): number;
  isPlaying(): boolean;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  /** 0..1 */
  setVolume(v: number): void;
  destroy(): void;
}

export interface AdapterHooks {
  /** player finished loading and accepts commands */
  onReady: () => void;
  /** any play / pause / seek / buffering change, user-caused or not */
  onChange: () => void;
  onError: (msg: string) => void;
  /** the video played to its end (YouTube only); duration in seconds */
  onEnded?: (durationSec: number) => void;
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string, ready?: (done: () => void) => void): Promise<void> {
  const hit = scripts.get(src);
  if (hit) return hit;
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onerror = () => { scripts.delete(src); reject(new Error('Could not load the player')); };
    if (ready) ready(resolve);
    else el.onload = () => resolve();
    document.head.appendChild(el);
  });
  scripts.set(src, p);
  return p;
}

// ---- YouTube ----
interface YtPlayer {
  playVideo(): void; pauseVideo(): void; seekTo(s: number, allow: boolean): void;
  getCurrentTime(): number; getPlayerState(): number; setVolume(v: number): void; destroy(): void; getDuration(): number;
}
type YtNs = { Player: new (el: HTMLElement, opts: unknown) => YtPlayer; PlayerState: Record<string, number> };
declare global {
  interface Window { YT?: YtNs; onYouTubeIframeAPIReady?: () => void; Twitch?: { Player: TwitchCtor & Record<string, string> } }
}

function loadYouTube(): Promise<YtNs> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return loadScript('https://www.youtube.com/iframe_api', (done) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); done(); };
  }).then(() => window.YT!);
}

const YT_PLAYING = 1;
const YT_BUFFERING = 3;

export async function createYouTube(host: HTMLElement, w: WatchState, startSec: number, hooks: AdapterHooks): Promise<WatchAdapter> {
  const YT = await loadYouTube();
  // Build the iframe ourselves so it can send a referrer: the site sets Referrer-Policy: no-referrer,
  // and YouTube refuses embeds without one.
  const iframe = document.createElement('iframe');
  const q = new URLSearchParams({
    enablejsapi: '1', playsinline: '1', rel: '0', modestbranding: '1', autoplay: w.playing ? '1' : '0',
    start: String(Math.floor(startSec)), origin: location.origin,
  });
  iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(w.id)}?${q}`;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;
  iframe.title = 'YouTube player';
  host.replaceChildren(iframe);
  let player: YtPlayer | null = null;
  let ready = false;
  player = new YT.Player(iframe, {
    events: {
      onReady: () => { ready = true; hooks.onReady(); },
      onStateChange: (e: { data: number }) => { hooks.onChange(); if (e?.data === 0 && player) { try { hooks.onEnded?.(player.getDuration() || 0); } catch { /* gone */ } } },
      onError: (e: { data: number }) => hooks.onError(e.data === 101 || e.data === 150 || e.data === 153
        ? 'This video cannot be embedded. Try another link.' : 'YouTube could not play this video.'),
    },
  });
  return {
    getTime: () => (ready && player ? player.getCurrentTime() || 0 : 0),
    isPlaying: () => {
      if (!ready || !player) return false;
      const st = player.getPlayerState();
      return st === YT_PLAYING || st === YT_BUFFERING;
    },
    play: () => { if (ready) player?.playVideo(); },
    pause: () => { if (ready) player?.pauseVideo(); },
    seek: (sec) => { if (ready) player?.seekTo(sec, true); },
    setVolume: (v) => { if (ready) player?.setVolume(Math.round(v * 100)); },
    destroy: () => { try { player?.destroy(); } catch { /* gone */ } player = null; host.replaceChildren(); },
  };
}

// ---- Twitch ----
interface TwitchPlayer {
  play(): void; pause(): void; seek(s: number): void; getCurrentTime(): number; isPaused(): boolean;
  setVolume(v: number): void; setMuted(m: boolean): void; addEventListener(ev: string, cb: () => void): void;
}
type TwitchCtor = new (el: HTMLElement, opts: Record<string, unknown>) => TwitchPlayer;

function loadTwitch() {
  if (window.Twitch?.Player) return Promise.resolve(window.Twitch.Player);
  return loadScript('https://player.twitch.tv/js/embed/v1.js').then(() => {
    if (!window.Twitch?.Player) throw new Error('Twitch player did not load');
    return window.Twitch.Player;
  });
}

/** Twitch requires every embedding hostname in `parent`. */
export function twitchParents(): string[] {
  return [...new Set([location.hostname, 'chat.nano11bravo.com'].filter(Boolean))];
}

function twitchTime(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
}

export async function createTwitch(host: HTMLElement, w: WatchState, startSec: number, hooks: AdapterHooks): Promise<WatchAdapter> {
  const Player = await loadTwitch();
  const mount = document.createElement('div');
  mount.className = 'watch-twitch-mount';
  host.replaceChildren(mount);
  const opts: Record<string, unknown> = {
    width: '100%', height: '100%', parent: twitchParents(), autoplay: w.playing, muted: false,
  };
  if (w.kind === 'vod') { opts.video = `v${w.id}`; opts.time = twitchTime(startSec); } else opts.channel = w.id;
  const player = new Player(mount, opts);
  let ready = false;
  const ev = Player as unknown as Record<string, string>;
  player.addEventListener(ev.READY ?? 'ready', () => { ready = true; hooks.onReady(); });
  for (const name of ['PLAY', 'PAUSE', 'SEEK', 'PLAYING']) {
    if (ev[name]) player.addEventListener(ev[name], () => hooks.onChange());
  }
  return {
    getTime: () => (ready ? player.getCurrentTime() || 0 : 0),
    isPlaying: () => (ready ? !player.isPaused() : false),
    play: () => { if (ready) player.play(); },
    pause: () => { if (ready) player.pause(); },
    seek: (sec) => { if (ready && w.kind === 'vod') player.seek(sec); },
    setVolume: (v) => { if (ready) { player.setMuted(false); player.setVolume(v); } },
    destroy: () => { host.replaceChildren(); },
  };
}
