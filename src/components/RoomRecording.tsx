import { useEffect, useRef, useState } from 'react';
import type { RecState } from '../../shared/types';
import { call, socket } from '../socket';
import { api, storedDeviceId } from '../api';

/**
 * Batch F6: voice-room recording. Owner-started only; everyone sees a red notice while it runs and gets a
 * notice when they join. The owner's browser mixes the room audio (Web Audio + MediaRecorder) and uploads
 * webm/opus chunks; the server caps size and time and keeps files for the room's retention setting.
 */
type Toast = (msg: string, kind?: 'error' | 'info') => void;
const fmt = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const recordingSupported = () => typeof window !== 'undefined' && 'MediaRecorder' in window && ('AudioContext' in window || 'webkitAudioContext' in window);

/** Mixes every audio track it is handed into one stream; tracks can come and go while recording. */
class Mixer {
  ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  dest = this.ctx.createMediaStreamDestination();
  private srcs = new Map<string, MediaStreamAudioSourceNode>();
  constructor() {
    // a silent source keeps the recorder producing data when nobody has a mic on
    const g = this.ctx.createGain(); g.gain.value = 0; const o = this.ctx.createOscillator(); o.connect(g).connect(this.dest); o.start();
  }
  set(tracks: MediaStreamTrack[]) {
    const want = new Map(tracks.filter((t) => t.kind === 'audio' && t.readyState === 'live').map((t) => [t.id, t]));
    for (const [id, n] of this.srcs) if (!want.has(id)) { n.disconnect(); this.srcs.delete(id); }
    for (const [id, t] of want) if (!this.srcs.has(id)) { const n = this.ctx.createMediaStreamSource(new MediaStream([t])); n.connect(this.dest); this.srcs.set(id, n); }
  }
  close() { for (const n of this.srcs.values()) n.disconnect(); void this.ctx.close().catch(() => {}); }
}

export function RecordingBanner({ rec, onLeave, joinNotice }: { rec: RecState | null; onLeave: () => void; joinNotice: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [ack, setAck] = useState(!joinNotice);
  useEffect(() => { if (!rec) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, [rec]);
  useEffect(() => { if (!rec) setAck(true); }, [rec]);
  if (!rec) return null;
  return (
    <>
      <div className="rec-banner" role="status" aria-live="polite" data-testid="rec-banner">
        <span className="rec-dot" aria-hidden="true" /> Recording · started by {rec.by} · {fmt(now - rec.startedAt)}
      </div>
      {!ack && (
        <div className="rec-join-notice" role="alertdialog" aria-label="This room is being recorded" data-testid="rec-join-notice">
          <b>🔴 This room is being recorded.</b> Your voice may be in the recording, which the room owner keeps and can download.
          <div className="rec-actions">
            <button type="button" className="btn" data-action="rec-ok" onClick={() => setAck(true)}>OK, stay</button>
            <button type="button" className="btn ghost" data-action="rec-leave" onClick={onLeave}>Leave room</button>
          </div>
        </div>
      )}
    </>
  );
}

export function RecorderControls({ roomId, rec, tracks, toast }: { roomId: string; rec: RecState | null; tracks: MediaStreamTrack[]; toast: Toast }) {
  const mine = useRef<{ mixer: Mixer; mr: MediaRecorder; id: string; chain: Promise<void>; stopped: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const supported = recordingSupported();
  useEffect(() => { mine.current?.mixer.set(tracks); }, [tracks]);
  const stopLocal = () => {
    const m = mine.current; if (!m || m.stopped) return;
    m.stopped = true; try { if (m.mr.state !== 'inactive') m.mr.stop(); } catch { /* */ }
    window.setTimeout(() => m.mixer.close(), 1500); mine.current = null;
  };
  // someone else (cap, idle, voice off) ended it: stop our recorder too
  useEffect(() => { if (!rec || (mine.current && rec.id !== mine.current.id)) stopLocal(); }, [rec]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopLocal(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const upload = (id: string, blob: Blob) => {
    const m = mine.current; if (!m) return;
    m.chain = m.chain.then(async () => {
      const headers: Record<string, string> = { 'X-CSRF': '1' };
      const fd = new FormData(); fd.append('chunk', blob, 'chunk.webm');
      const dev = storedDeviceId(); if (dev) headers['X-Device-Id'] = dev;
      const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/recordings/${id}/chunk`, { method: 'POST', headers, credentials: 'same-origin', body: fd }).then((x) => x.json()).catch(() => null);
      if (r?.stop) { stopLocal(); if (r.reason === 'size' || r.reason === 'time') toast(`Recording stopped: ${r.reason === 'size' ? 'size' : 'time'} limit reached`, 'info'); }
    });
  };
  const start = async () => {
    setBusy(true);
    try {
      const r = await call<{ rec: RecState }>((ack) => socket.emit('rec:start', {}, ack));
      const mixer = new Mixer(); mixer.set(tracks);
      const mime = ['audio/webm;codecs=opus', 'audio/webm', ''].find((t) => !t || MediaRecorder.isTypeSupported(t)) ?? '';
      const mr = new MediaRecorder(mixer.dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 64_000 } : undefined);
      mine.current = { mixer, mr, id: r.rec.id, chain: Promise.resolve(), stopped: false };
      mr.ondataavailable = (e) => { if (e.data.size) upload(r.rec.id, e.data); };
      mr.start(4000);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); setConfirm(false); }
  };
  const stop = async () => {
    const m = mine.current;
    if (m && m.mr.state !== 'inactive') { m.mr.requestData(); m.mr.stop(); m.stopped = true; await new Promise((r) => setTimeout(r, 300)); await m.chain; window.setTimeout(() => m.mixer.close(), 500); mine.current = null; }
    try { await call((ack) => socket.emit('rec:stop', {}, ack)); } catch (err) { toast((err as Error).message, 'error'); }
  };
  return (
    <div className="rec-bar" data-testid="rec-controls">
      {!supported && <span className="small muted">This browser can't record (no MediaRecorder).</span>}
      {supported && !rec && !confirm && <button type="button" className="btn ghost small-btn" data-action="rec-start" onClick={() => setConfirm(true)}>🔴 Record</button>}
      {confirm && (
        <span className="rec-confirm" data-testid="rec-confirm">
          Everyone in the room will see a red recording notice, and people joining are told. Start?
          <button type="button" className="btn danger small-btn" data-action="rec-confirm" disabled={busy} onClick={() => void start()}>Start recording</button>
          <button type="button" className="btn ghost small-btn" onClick={() => setConfirm(false)}>Cancel</button>
        </span>
      )}
      {rec && <button type="button" className="btn danger small-btn" data-action="rec-stop" onClick={() => void stop()}>⏹ Stop recording</button>}
      <button type="button" className="btn ghost small-btn" data-action="rec-list" aria-expanded={listOpen} onClick={() => setListOpen((o) => !o)}>Recordings</button>
      {listOpen && <RecordingList roomId={roomId} toast={toast} />}
    </div>
  );
}

interface RecItem { id: string; startedAt: number; endedAt: number | null; by: string; bytes: number; status: string; endReason: string | null }
export function RecordingList({ roomId, toast }: { roomId: string; toast: Toast }) {
  const [d, setD] = useState<{ recordings: RecItem[]; retentionDays: number; choices: number[]; maxBytes: number; maxMs: number } | null>(null);
  const load = () => api<typeof d>(`/api/rooms/${encodeURIComponent(roomId)}/recordings`).then(setD).catch((e) => toast((e as Error).message, 'error'));
  useEffect(() => { void load(); }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  return (
    <div className="rec-list" data-testid="rec-list" data-count={d.recordings.length}>
      <label className="small">Keep recordings for{' '}
        <select data-testid="rec-retention" value={d.retentionDays} onChange={async (e) => { try { await api(`/api/rooms/${encodeURIComponent(roomId)}/recordings/settings`, { retentionDays: Number(e.target.value) }); void load(); } catch (err) { toast((err as Error).message, 'error'); } }}>
          {d.choices.map((c) => <option key={c} value={c}>{c} day{c === 1 ? '' : 's'}</option>)}
        </select>
      </label>
      <p className="small muted">Limit per recording: {Math.round(d.maxBytes / 1048576)} MB or {Math.round(d.maxMs / 60000)} min. Older files are removed automatically.</p>
      {d.recordings.length === 0 ? <p className="small muted">No recordings yet.</p> : (
        <ul>
          {d.recordings.map((r) => (
            <li key={r.id} data-testid="rec-item" data-status={r.status}>
              <span>{new Date(r.startedAt).toLocaleString()} · {r.endedAt ? fmt(r.endedAt - r.startedAt) : 'recording…'} · {(r.bytes / 1048576).toFixed(1)} MB{r.endReason === 'size' || r.endReason === 'time' ? ' · hit the limit' : ''}</span>
              {r.status === 'expired' ? <span className="small muted"> (removed)</span> : r.status !== 'recording' && <a className="btn ghost small-btn" data-action="rec-download" href={`/api/rooms/${encodeURIComponent(roomId)}/recordings/${r.id}/file`} download>Download</a>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
