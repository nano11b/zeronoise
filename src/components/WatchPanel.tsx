import { useEffect, useRef, useState } from 'react';
import type { WatchState } from '../../shared/types';
import { WATCH_DRIFT_SEC, expectedPosition, parseWatchUrl } from '../../shared/watch';
import { socket, call } from '../socket';
import { createTwitch, createYouTube, type WatchAdapter } from '../watchPlayers';

const VOLUME_KEY = 'camchat.watchVolume';
/** Player events this soon after we applied remote state are ours, not the user's. */
const SUPPRESS_MS = 1500;

export function loadWatchVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    if (localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(v)) return Math.min(1, Math.max(0, v));
  } catch { /* ignore */ }
  return 0.8;
}

interface Props {
  watch: WatchState | null;
  /** server clock minus local clock (ms) */
  skewMs: number;
  canControl: boolean;
  locked: boolean;
  isCreator: boolean;
  onClose: () => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
}

const keyOf = (w: WatchState | null) => (w ? `${w.provider}:${w.kind}:${w.id}` : '');

export function WatchPanel({ watch, skewMs, canControl, locked, isCreator, onClose, toast }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<WatchAdapter | null>(null);
  const readyRef = useRef(false);
  const lastApply = useRef(0);
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const skewRef = useRef(skewMs);
  skewRef.current = skewMs;
  const canControlRef = useRef(canControl);
  canControlRef.current = canControl;
  const [link, setLink] = useState('');
  const [volume, setVolume] = useState(loadWatchVolume);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seekTimer = useRef<number | null>(null);

  const expected = () => {
    const w = watchRef.current;
    return w ? expectedPosition(w, Date.now() + skewRef.current) : 0;
  };

  /** Bring the local player to the room state. Marks a suppression window so we don't echo it back. */
  const apply = () => {
    const a = adapterRef.current;
    const w = watchRef.current;
    if (!a || !w || !readyRef.current) return;
    lastApply.current = Date.now();
    if (w.kind !== 'live' && Math.abs(a.getTime() - expected()) > WATCH_DRIFT_SEC) a.seek(expected());
    if (w.playing && !a.isPlaying()) a.play();
    if (!w.playing && a.isPlaying()) a.pause();
    if (w.playing) {
      window.setTimeout(() => {
        const cur = watchRef.current;
        if (cur && cur.playing && keyOf(cur) === keyOf(w) && adapterRef.current && !adapterRef.current.isPlaying()) setBlocked(true);
      }, 2500);
    } else setBlocked(false);
  };

  const send = (action: 'play' | 'pause' | 'seek', positionSec: number) => {
    socket.emit('watch:update', { action, positionSec: Math.max(0, positionSec) }, (r) => {
      if (!r.ok) { toast(r.error, 'error'); apply(); }
    });
  };

  /** A player event the user caused (outside the suppression window). */
  const onChange = () => {
    const a = adapterRef.current;
    const w = watchRef.current;
    if (!a || !w || !readyRef.current) return;
    if (Date.now() - lastApply.current < SUPPRESS_MS) return;
    const playing = a.isPlaying();
    if (playing) setBlocked(false);
    if (!canControlRef.current) { apply(); return; }
    const cur = a.getTime();
    if (playing !== w.playing) { send(playing ? 'play' : 'pause', cur); return; }
    if (w.kind !== 'live' && Math.abs(cur - expected()) > WATCH_DRIFT_SEC) {
      // scrubbing fires many events; send the last one
      if (seekTimer.current) window.clearTimeout(seekTimer.current);
      seekTimer.current = window.setTimeout(() => {
        seekTimer.current = null;
        const now = adapterRef.current;
        if (now) send('seek', now.getTime());
      }, 300);
    }
  };

  // (re)create the player when the video changes
  const vidKey = keyOf(watch);
  useEffect(() => {
    const host = hostRef.current;
    const w = watchRef.current;
    if (!host || !w) return;
    let cancelled = false;
    readyRef.current = false;
    setError(null);
    setBlocked(false);
    const hooks = {
      onReady: () => {
        if (cancelled) return;
        readyRef.current = true;
        adapterRef.current?.setVolume(volumeRef.current);
        apply();
      },
      onChange: () => { if (!cancelled) onChange(); },
      onError: (msg: string) => { if (!cancelled) setError(msg); },
    };
    const make = w.provider === 'youtube' ? createYouTube : createTwitch;
    make(host, w, expected(), hooks)
      .then((a) => { if (cancelled) a.destroy(); else adapterRef.current = a; })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => {
      cancelled = true;
      readyRef.current = false;
      adapterRef.current?.destroy();
      adapterRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vidKey]);

  // remote state for the same video
  useEffect(() => { apply(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [watch?.playing, watch?.positionSec, watch?.updatedAt]);

  // drift correction
  useEffect(() => {
    const t = window.setInterval(() => {
      const a = adapterRef.current;
      const w = watchRef.current;
      if (!a || !w || !readyRef.current || w.kind === 'live' || !w.playing || !a.isPlaying()) return;
      if (Date.now() - lastApply.current < SUPPRESS_MS || seekTimer.current) return;
      if (Math.abs(a.getTime() - expected()) > WATCH_DRIFT_SEC) { lastApply.current = Date.now(); a.seek(expected()); }
    }, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    adapterRef.current?.setVolume(volume);
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* ignore */ }
  }, [volume]);

  const load = async () => {
    const parsed = parseWatchUrl(link);
    if (!parsed) { toast('Paste a YouTube or Twitch link', 'error'); return; }
    try {
      await call((ack) => socket.emit('watch:update', { action: 'load', url: link }, ack));
      setLink('');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const joinPlayback = () => {
    const a = adapterRef.current;
    setBlocked(false);
    if (!a) return;
    lastApply.current = Date.now();
    if (watchRef.current?.kind !== 'live') a.seek(expected());
    a.play();
  };

  return (
    <div className="watch-dock" data-testid="watch-dock">
      <div className="watch-head">
        <strong>Watch</strong>
        {watch && <span className="muted small watch-by" title={watch.url}>{watch.provider === 'youtube' ? 'YouTube' : watch.kind === 'live' ? 'Twitch live' : 'Twitch VOD'} · {watch.by}</span>}
        <button type="button" className="btn ghost small-btn watch-close" data-action="watch-close" aria-label="Close player" title="Close player" onClick={onClose}>✕</button>
      </div>
      {watch ? (
        <div className="watch-frame">
          <div ref={hostRef} className="watch-host" />
          {blocked && !error && (
            <button type="button" className="watch-overlay" data-action="watch-join" onClick={joinPlayback}>Click to join playback</button>
          )}
          {error && <div className="watch-overlay watch-error" role="alert">{error}</div>}
        </div>
      ) : (
        <p className="muted small watch-empty">{canControl ? 'Paste a YouTube or Twitch link to watch together.' : 'Nothing is playing. The room creator controls playback.'}</p>
      )}
      {canControl && (
        <form className="watch-load" onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="YouTube or Twitch link" aria-label="Video link" maxLength={300} inputMode="url" />
          <button className="btn primary small-btn" data-action="watch-load" disabled={!link.trim()}>{watch ? 'Change' : 'Play'}</button>
          {watch && <button type="button" className="btn ghost small-btn" data-action="watch-clear" onClick={() => { socket.emit('watch:update', { action: 'clear' }, (r) => { if (!r.ok) toast(r.error, 'error'); }); }}>Stop</button>}
        </form>
      )}
      <div className="watch-tools">
        <label className="watch-volume">
          <span className="muted small">Volume</span>
          <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Watch volume" />
        </label>
        {isCreator ? (
          <label className="watch-lock small">
            <input type="checkbox" checked={locked} data-action="watch-lock" onChange={(e) => {
              socket.emit('watch:lock', { locked: e.target.checked }, (r) => { if (!r.ok) toast(r.error, 'error'); });
            }} />
            Only me and mods control
          </label>
        ) : locked ? <span className="muted small">Creator controls playback</span> : null}
      </div>
    </div>
  );
}
