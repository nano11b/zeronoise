import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { APP_NAME } from '../../shared/config';
import { placeBelow, useDismiss } from '../dropdown';
import { Icon } from '../icons';
import {
  applyAudioOutput, DEFAULT_AUDIO_OUTPUT, deviceLabel, listDevices, storedAudioOutputId, supportsSinkId,
} from '../mediaDevices';
import { refreshRadio, setRadioPlaying, useRadio } from '../radioState';
import { NowPlayingCard } from './NowPlaying';

const STREAM = 'https://radio.seven-labs.com/listen/labsfm/impulsivefrequencies';
const STATION_PAGE = 'https://radio.seven-labs.com/public/labsfm';
const KEY = `${APP_NAME.toLowerCase()}.radio`;

function readStored(): { volume?: unknown; sinkId?: unknown } {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const j = JSON.parse(raw) as { volume?: unknown; sinkId?: unknown };
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

function loadVolume(): number {
  const n = Number(readStored().volume);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return 0.8;
}

/** Radio's own sink if saved (including ''), otherwise the voice-chat speaker. */
function loadSink(): string {
  const own = readStored().sinkId;
  if (typeof own === 'string') return own;
  return storedAudioOutputId();
}

function saveVolume(volume: number) {
  try {
    const prev = readStored();
    const next: { volume: number; sinkId?: string } = { volume };
    if (typeof prev.sinkId === 'string') next.sinkId = prev.sinkId;
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

function saveSink(volume: number, sinkId: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ volume, sinkId }));
  } catch { /* ignore */ }
}

/** Labs FM player behind a Music button. Starts paused. Volume and an optional speaker override live in camchat.radio. */
export function RadioPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(loadVolume);
  const [sinkId, setSinkId] = useState(loadSink);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [offline, setOffline] = useState(false);
  const [name, setName] = useState('7LFM');
  const [artist, setArtist] = useState('');
  const [title, setTitle] = useState('');
  const volumeRef = useRef(volume);
  const sinkRef = useRef(sinkId);
  volumeRef.current = volume;
  sinkRef.current = sinkId;
  const sinkOk = supportsSinkId();

  useEffect(() => {
    const el = new Audio();
    el.preload = 'none';
    el.src = STREAM;
    el.volume = volumeRef.current;
    audioRef.current = el;
    void applyAudioOutput(el, sinkRef.current);
    const onError = () => { setOffline(true); setPlaying(false); setRadioPlaying(false); };
    const onPlaying = () => { setOffline(false); setPlaying(true); setRadioPlaying(true); };
    const onPause = () => { setRadioPlaying(false); };
    el.addEventListener('error', onError);
    el.addEventListener('playing', onPlaying);
    el.addEventListener('pause', onPause);
    return () => {
      el.removeEventListener('pause', onPause);
      setRadioPlaying(false);
      el.pause();
      el.removeEventListener('error', onError);
      el.removeEventListener('playing', onPlaying);
      el.removeAttribute('src');
      el.load();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.volume = volume;
    saveVolume(volume);
  }, [volume]);

  useEffect(() => {
    void applyAudioOutput(audioRef.current, sinkId);
  }, [sinkId]);

  useEffect(() => {
    if (!sinkOk) return;
    let dead = false;
    const refresh = () => {
      listDevices().then((d) => { if (!dead) setOutputs(d.output); }).catch(() => {});
    };
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      dead = true;
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
    };
  }, [sinkOk]);

  // Now-playing comes from the server (it polls the station at most every 15 s while someone listens
  // and proxies the album art); opening the panel asks for a cached value.
  const radio = useRadio();
  useEffect(() => { if (open) refreshRadio(); }, [open]);
  useEffect(() => {
    const np = radio.np;
    if (!np) return;
    if (np.station.trim()) setName(np.station.trim());
    setArtist(np.offline ? '' : np.artist);
    setTitle(np.offline ? '' : np.title);
  }, [radio.np]);

  const toggle = async () => {
    const el = audioRef.current;
    if (!el) return;
    if (!el.paused) {
      el.pause();
      setPlaying(false);
      return;
    }
    setOffline(false);
    if (!el.src) el.src = STREAM;
    try {
      await el.play();
    } catch {
      setOffline(true);
      setPlaying(false);
    }
  };

  const chooseSink = (id: string) => {
    setSinkId(id);
    saveSink(volumeRef.current, id);
  };

  const song = [artist, title].filter(Boolean).join(' — ');
  const savedMissing = sinkId !== '' && !outputs.some((d) => d.deviceId === sinkId);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, wrapRef, close);
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = wrapRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const run = () => placeBelow(anchor, panel);
    run();
    window.addEventListener('resize', run);
    window.addEventListener('scroll', run, true);
    return () => {
      window.removeEventListener('resize', run);
      window.removeEventListener('scroll', run, true);
    };
  }, [open, sinkOk, offline, name, song]);

  return (
    <div className={`radio-wrap${playing ? ' playing' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className={`btn ghost icon-act radio-toggle${playing ? ' playing' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Music"
        title="Music"
        data-action="music"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="music" />
        <span className="radio-label">Music</span>
        {playing && <span className="radio-live" aria-hidden="true" />}
      </button>
      {open && (
        <div className={`radio-panel radio${offline ? ' offline' : ''}`} ref={panelRef} role="dialog" aria-label="Music">
          {radio.np && <NowPlayingCard np={radio.np} />}
          <button type="button" className="btn ghost small-btn radio-play" onClick={() => { void toggle(); }} aria-pressed={playing} aria-label={playing ? 'Pause radio' : 'Play radio'} data-action="radio">
            {playing ? 'Pause' : 'Play'}
          </button>
          <div className="radio-meta">
            <a className="radio-name" href={STATION_PAGE} target="_blank" rel="noopener noreferrer" title="Open station">{name}</a>
            <span className="radio-song" title={offline ? 'station offline' : song}>{offline ? 'station offline' : song}</span>
            {!sinkOk && (
              <span className="radio-sink-note" title="Speaker selection needs Chrome or Edge (this browser does not support setSinkId).">
                Speaker selection needs Chrome or Edge (this browser does not support <code>setSinkId</code>).
              </span>
            )}
          </div>
          {sinkOk && (
            <select
              className="radio-sink"
              value={sinkId}
              aria-label="Radio speaker"
              data-action="radio-output"
              onChange={(e) => chooseSink(e.target.value)}
            >
              <option value={DEFAULT_AUDIO_OUTPUT}>Default</option>
              {savedMissing && <option value={sinkId}>Saved speaker</option>}
              {outputs.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>{deviceLabel(d, i)}</option>
              ))}
            </select>
          )}
          <input className="radio-vol" type="range" min={0} max={1} step={0.05} value={volume} aria-label="Radio volume" onChange={(e) => setVolume(Number(e.target.value))} />
        </div>
      )}
    </div>
  );
}
