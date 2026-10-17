import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket';

/**
 * Batch G2: the owner trims a ≤60 s highlight out of a recording, right in the browser (decode, pick start + length,
 * preview, re-encode to webm/opus in real time), then posts it to the room as an audio message. The server keeps it
 * only as long as the source recording's retention.
 */
const MAX_S = 60;
const DECODE_MAX_BYTES = 60 * 1048576;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
type Toast = (msg: string, kind?: 'error' | 'info') => void;

export function ClipMaker({ roomId, rec, onClose, toast }: { roomId: string; rec: { id: string; bytes: number }; onClose: () => void; toast: Toast }) {
  const [buf, setBuf] = useState<AudioBuffer | null>(null);
  const [err, setErr] = useState('');
  const [start, setStart] = useState(0);
  const [len, setLen] = useState(15);
  const [busy, setBusy] = useState<'' | 'preview' | 'render'>('');
  const [progress, setProgress] = useState(0);
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  useEffect(() => {
    if (rec.bytes > DECODE_MAX_BYTES) { setErr('This recording is too long to trim in the browser. Download it and trim it in an audio editor.'); return; }
    let dead = false;
    const ctx = new AudioContext(); ctxRef.current = ctx;
    fetch(`/api/rooms/${encodeURIComponent(roomId)}/recordings/${rec.id}/file`).then((r) => { if (!r.ok) throw new Error('Could not load the recording'); return r.arrayBuffer(); })
      .then((ab) => ctx.decodeAudioData(ab)).then((b) => { if (!dead) { setBuf(b); setLen(Math.min(15, Math.max(1, Math.floor(b.duration)))); } })
      .catch((e) => !dead && setErr((e as Error).message || 'This recording could not be decoded in this browser.'));
    return () => { dead = true; try { srcRef.current?.stop(); } catch { /* */ } void ctx.close().catch(() => {}); };
  }, [roomId, rec.id, rec.bytes]);
  const dur = buf?.duration ?? 0;
  const maxLen = Math.max(1, Math.min(MAX_S, Math.floor(dur - start)));
  const realLen = Math.min(len, maxLen);
  const play = (to?: AudioNode) => {
    const ctx = ctxRef.current!; const s = ctx.createBufferSource(); s.buffer = buf; s.connect(to ?? ctx.destination);
    s.start(0, start, realLen); srcRef.current = s; return s;
  };
  const preview = () => {
    if (busy === 'preview') { try { srcRef.current?.stop(); } catch { /* */ } setBusy(''); return; }
    void ctxRef.current?.resume(); const s = play(); setBusy('preview'); s.onended = () => setBusy((b) => (b === 'preview' ? '' : b));
  };
  const share = async () => {
    if (!buf || !ctxRef.current) return;
    setBusy('render'); setProgress(0);
    try {
      const ctx = ctxRef.current; await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      const mr = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
      const parts: Blob[] = [];
      mr.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      const done = new Promise<void>((r) => { mr.onstop = () => r(); });
      mr.start(500);
      const s = play(dest);
      const t0 = performance.now();
      const tick = setInterval(() => setProgress(Math.min(1, (performance.now() - t0) / 1000 / realLen)), 250);
      await new Promise<void>((r) => { s.onended = () => r(); });
      clearInterval(tick); mr.stop(); await done;
      const blob = new Blob(parts, { type: mr.mimeType || 'audio/webm' });
      const fd = new FormData();
      fd.append('recordingId', rec.id); fd.append('startMs', String(Math.round(start * 1000))); fd.append('durationMs', String(Math.round(realLen * 1000)));
      fd.append('voice', blob, 'clip.webm');
      const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/clips`, { method: 'POST', headers: { 'x-csrf': '1' }, body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'Upload failed');
      await new Promise<void>((resolve, reject) => socket.emit('chat:voice', { voiceId: j.voiceId, durationMs: Math.round(realLen * 1000) }, (a) => (a.ok ? resolve() : reject(new Error(a.error)))));
      toast(`Clip shared. It is kept until ${new Date(j.expiresAt).toLocaleDateString()} (the recording's retention).`, 'info');
      onClose();
    } catch (e) { toast((e as Error).message || 'Could not make the clip', 'error'); setBusy(''); }
  };
  return (
    <div className="clip-maker" data-testid="clip-maker" role="group" aria-label="Make a clip">
      <strong>✂ Make a clip</strong> <span className="small muted">up to {MAX_S} s, shared in this room as audio</span>
      {err ? <p className="form-error small" data-testid="clip-error">{err}</p> : !buf ? <p className="small muted">Loading the recording…</p> : (
        <>
          <label className="small">Start {fmt(start)}
            <input type="range" min={0} max={Math.max(0, Math.floor(dur) - 1)} step={1} value={start} onChange={(e) => setStart(Number(e.target.value))} data-testid="clip-start" aria-valuetext={fmt(start)} />
          </label>
          <label className="small">Length {realLen} s
            <input type="range" min={1} max={maxLen} step={1} value={realLen} onChange={(e) => setLen(Number(e.target.value))} data-testid="clip-len" aria-valuetext={`${realLen} seconds`} />
          </label>
          <p className="small muted" data-testid="clip-range">{fmt(start)} – {fmt(start + realLen)} of {fmt(dur)}</p>
          <div className="row">
            <button type="button" className="btn ghost small-btn" onClick={preview} disabled={busy === 'render'} data-action="clip-preview">{busy === 'preview' ? '⏹ Stop' : '▶ Preview'}</button>
            <button type="button" className="btn small-btn" onClick={() => void share()} disabled={!!busy} data-action="clip-share">{busy === 'render' ? `Making clip… ${Math.round(progress * 100)}%` : 'Share to room'}</button>
            <button type="button" className="btn ghost small-btn" onClick={onClose} disabled={busy === 'render'}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
