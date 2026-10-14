import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { VoiceNoteInfo } from '../../shared/types';
import { fmtVoiceDuration, pickVoiceMime, VOICE_MAX_BYTES, VOICE_MAX_MS, VOICE_MIN_MS } from '../../shared/voice';
import { storedDeviceId } from '../api';
import { applyAudioOutput, audioConstraints, loadStoredDevices } from '../mediaDevices';
import { socket } from '../socket';

type Phase = 'idle' | 'starting' | 'holding' | 'locked' | 'sending';
/** A press shorter than this is a tap (tap-to-start, tap-to-stop) rather than hold-to-talk. */
const TAP_MS = 300;
/** How far outside the button a held pointer may drift before release cancels. */
const SLOP_PX = 24;

function devHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'X-CSRF': '1' };
  const dev = storedDeviceId();
  if (dev) h['X-Device-Id'] = dev;
  return h;
}

/** Separate mic stream for the note so an active call track is never touched. Falls back to the default mic. */
async function openNoteMic(): Promise<MediaStream> {
  const id = loadStoredDevices().audioinput;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(id || undefined) });
  } catch (e) {
    if (id && (e as Error).name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
    throw e;
  }
}

/** Press-and-hold (or tap, tap) mic button that records, uploads and posts a voice note. */
export function VoiceNoteButton({ roomId, parentId, toast }: {
  roomId: string;
  parentId?: string;
  toast: (t: string, tone?: 'error' | 'info') => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [offTarget, setOffTarget] = useState(false);
  const phaseRef = useRef<Phase>('idle');
  const setP = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  const btnRef = useRef<HTMLButtonElement>(null);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedAt: number; mime: string } | null>(null);
  const pressAt = useRef(0);
  /** Button rect at press time: the composer can reflow while recording, the finger does not move with it. */
  const pressRect = useRef<DOMRect | null>(null);
  const releaseBeforeReady = useRef<'send' | 'cancel' | 'tap' | null>(null);
  const tick = useRef<number | null>(null);
  const supported = typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const cleanup = useCallback(() => {
    if (tick.current) { window.clearInterval(tick.current); tick.current = null; }
    const r = rec.current;
    rec.current = null;
    if (r) {
      r.mr.ondataavailable = null; r.mr.onstop = null;
      try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch { /* ignore */ }
      r.stream.getTracks().forEach((t) => t.stop());
    }
    setElapsed(0);
    setOffTarget(false);
  }, []);

  const upload = useCallback(async (blob: Blob, durationMs: number) => {
    setP('sending');
    try {
      if (blob.size > VOICE_MAX_BYTES) throw new Error('Voice note too large (max 1 MB)');
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      const fd = new FormData();
      fd.append('voice', blob, `voice.${ext}`);
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/voice`, { method: 'POST', headers: devHeaders(), credentials: 'same-origin', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || 'Upload failed');
      await new Promise<void>((resolve, reject) => {
        socket.emit('chat:voice', { voiceId: data.id, durationMs, parentId }, (r) => (r.ok ? resolve() : reject(new Error(r.error))));
      });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setP('idle');
    }
  }, [roomId, parentId, toast]);

  /** Stop recording; send unless cancelled or too short. */
  const finish = useCallback((send: boolean) => {
    const r = rec.current;
    if (!r) { setP('idle'); cleanup(); return; }
    const durationMs = Math.min(performance.now() - r.startedAt, VOICE_MAX_MS);
    if (!send) { cleanup(); setP('idle'); return; }
    if (durationMs < VOICE_MIN_MS) { cleanup(); setP('idle'); toast('Too short - hold the mic to record', 'info'); return; }
    rec.current = null;
    if (tick.current) { window.clearInterval(tick.current); tick.current = null; }
    r.mr.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(r.chunks, { type: r.mr.mimeType || r.mime });
      setElapsed(0); setOffTarget(false);
      void upload(blob, Math.round(durationMs));
    };
    try { r.mr.stop(); } catch { r.stream.getTracks().forEach((t) => t.stop()); setP('idle'); }
  }, [cleanup, toast, upload]);

  const start = useCallback(async (mode: 'holding' | 'locked') => {
    if (!supported) { toast('Voice notes are not supported in this browser', 'error'); return; }
    if (phaseRef.current !== 'idle') return;
    releaseBeforeReady.current = null;
    setP('starting');
    let stream: MediaStream;
    try { stream = await openNoteMic(); } catch (e) {
      setP('idle');
      toast((e as Error).name === 'NotAllowedError' ? 'Microphone permission denied.' : 'Could not open the microphone.', 'error');
      return;
    }
    const mime = pickVoiceMime((t) => MediaRecorder.isTypeSupported(t));
    let mr: MediaRecorder;
    try { mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 }); } catch {
      stream.getTracks().forEach((t) => t.stop()); setP('idle');
      toast('Voice notes are not supported in this browser', 'error');
      return;
    }
    const chunks: Blob[] = [];
    mr.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    mr.start(250);
    rec.current = { mr, stream, chunks, startedAt: performance.now(), mime: mime ?? '' };
    tick.current = window.setInterval(() => {
      const r = rec.current;
      if (!r) return;
      const ms = performance.now() - r.startedAt;
      setElapsed(ms);
      if (ms >= VOICE_MAX_MS) finish(true); // auto-stop and send at the cap
    }, 100);
    const early = releaseBeforeReady.current;
    releaseBeforeReady.current = null;
    if (early === 'cancel') { finish(false); return; }
    // Released during mic startup: a quick tap locks recording on; a real hold that ended sends.
    if (early === 'tap') { setP('locked'); return; }
    if (early === 'send') { setP('holding'); finish(true); return; }
    setP(mode);
  }, [finish, supported, toast]);

  // Esc cancels; unmount stops the mic.
  useEffect(() => {
    if (phase !== 'holding' && phase !== 'locked' && phase !== 'starting') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); if (phaseRef.current === 'starting') releaseBeforeReady.current = 'cancel'; else finish(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, finish]);
  useEffect(() => () => cleanup(), [cleanup]);

  const outside = (e: ReactPointerEvent) => {
    const r = pressRect.current ?? btnRef.current?.getBoundingClientRect();
    if (!r) return false;
    return e.clientX < r.left - SLOP_PX || e.clientX > r.right + SLOP_PX || e.clientY < r.top - SLOP_PX || e.clientY > r.bottom + SLOP_PX;
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (phaseRef.current === 'locked') return; // second tap handled on pointerup
    if (phaseRef.current !== 'idle') return;
    pressAt.current = performance.now();
    pressRect.current = e.currentTarget.getBoundingClientRect();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    void start('holding');
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (phaseRef.current === 'holding' || phaseRef.current === 'starting') setOffTarget(outside(e));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const p = phaseRef.current;
    if (p === 'locked') { finish(true); return; }
    const quick = performance.now() - pressAt.current < TAP_MS;
    const off = outside(e);
    if (p === 'starting') { releaseBeforeReady.current = off ? 'cancel' : quick ? 'tap' : 'send'; return; }
    if (p !== 'holding') return;
    if (off) { finish(false); return; }
    if (quick) { setP('locked'); return; } // tap: keep recording until the next tap
    finish(true);
  };
  const onPointerCancel = () => {
    if (phaseRef.current === 'starting') releaseBeforeReady.current = 'cancel';
    else if (phaseRef.current === 'holding') finish(false);
  };
  // Keyboard (Enter/Space) arrives as a click with detail 0: tap-to-start / tap-to-stop.
  const onClick = (e: ReactMouseEvent) => {
    if (e.detail !== 0) return;
    if (phaseRef.current === 'idle') void start('locked');
    else if (phaseRef.current === 'locked' || phaseRef.current === 'holding') finish(true);
  };

  const recording = phase === 'holding' || phase === 'locked' || phase === 'starting';
  const label = phase === 'sending' ? 'Sending voice note' : recording ? (phase === 'locked' ? 'Tap to send voice note' : 'Release to send, drag away to cancel') : 'Hold to record a voice note, or tap to start';
  return (
    <span className={`voice-rec ${recording ? 'recording' : ''} ${offTarget ? 'off-target' : ''}`} data-voice-phase={phase}>
      <button
        ref={btnRef}
        type="button"
        className={`btn ghost voice-btn ${recording ? 'on' : ''}`}
        title={label}
        aria-label={label}
        aria-pressed={recording}
        data-action="voice-note"
        disabled={phase === 'sending' || !supported}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        {phase === 'sending' ? '…' : recording ? '●' : '🎤'}
      </button>
      {recording && (
        <span className="voice-status" role="status" aria-live="polite">
          <span className="voice-timer" data-voice-timer>{fmtVoiceDuration(elapsed)} / {fmtVoiceDuration(VOICE_MAX_MS)}</span>
          <span className="voice-hint">{offTarget ? 'Release to cancel' : phase === 'locked' ? 'Tap ● again to send' : 'Release to send'}</span>
          <button type="button" className="icon-btn voice-cancel" aria-label="Cancel voice note" title="Cancel (Esc)" data-action="voice-cancel"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => { if (phaseRef.current === 'starting') releaseBeforeReady.current = 'cancel'; else finish(false); }}>✕</button>
        </span>
      )}
    </span>
  );
}

/** Inline player: play/pause, progress bar, duration. Plays through the selected speaker when the browser allows. */
export function VoicePlayer({ voice }: { voice: VoiceNoteInfo }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => {
    audio.current?.pause();
    if (url.current) URL.revokeObjectURL(url.current);
  }, []);
  const total = voice.durationMs / 1000;

  const toggle = async () => {
    if (playing) { audio.current?.pause(); return; }
    try {
      if (!audio.current) {
        setLoading(true);
        // fetched (not a bare src) so the device header proves room membership and the file is never cached
        const r = await fetch(voice.url, { headers: devHeaders(), credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) throw new Error(r.status === 403 ? 'Join the room to play this' : 'Voice note unavailable');
        url.current = URL.createObjectURL(await r.blob());
        const a = new Audio();
        a.preload = 'auto';
        a.src = url.current;
        a.ontimeupdate = () => setPos(a.currentTime);
        a.onplay = () => setPlaying(true);
        a.onpause = () => setPlaying(false);
        a.onended = () => { setPlaying(false); setPos(0); };
        audio.current = a;
        await applyAudioOutput(a);
      }
      await audio.current.play();
    } catch (e) {
      setFailed(true);
      console.warn('voice note', e);
    } finally { setLoading(false); }
  };
  const seek = (e: ReactMouseEvent<HTMLSpanElement>) => {
    const a = audio.current;
    if (!a || !total) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total;
    setPos(a.currentTime);
  };
  const pct = total ? Math.min(100, (pos / total) * 100) : 0;
  return (
    <span className="voice-player" data-voice={voice.id}>
      <button type="button" className="icon-btn voice-play" data-action="voice-play" aria-label={playing ? 'Pause voice note' : 'Play voice note'} onClick={() => void toggle()} disabled={loading}>
        {loading ? '…' : playing ? '❚❚' : '▶'}
      </button>
      <span className="voice-bar" onClick={seek} role="progressbar" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(pos)} aria-label="Voice note progress">
        <span className="voice-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="voice-dur">{failed ? 'unavailable' : `${playing || pos ? `${fmtVoiceDuration(pos * 1000)} / ` : ''}${fmtVoiceDuration(voice.durationMs)}`}</span>
    </span>
  );
}
