import { useEffect, useRef, useState } from 'react';
import { useModal } from '../a11y';
import { TtsSettings } from './TtsSettings';
import {
  applyAudioOutput, applyAudioOutputToDocument, audioConstraints, DEFAULT_AUDIO_OUTPUT,
  deviceLabel, ensureMediaPermission, listDevices, loadStoredDevices, saveStoredDevices,
  supportsSinkId, videoConstraints,
} from '../mediaDevices';
import { BG_MODES, BUNDLED_BGS, CUSTOM_BG, loadCustomBg, saveCustomBg, type BgPref, type NoisePref } from '../bgPrefs';
import { captureConstraints, VIDEO_QUALITIES, VIDEO_QUALITY_LABEL, type ShareMode, type VideoQuality } from '../../shared/videoQuality';

export interface AvApplyResult {
  audioId?: string;
  videoId?: string;
  /** Speaker sink id; '' = default output. */
  outputId?: string;
  audioTrack?: MediaStreamTrack | null;
  videoTrack?: MediaStreamTrack | null;
}

export function AvSettings({
  open,
  onClose,
  onApply,
  camOn,
  micOn,
  blocked,
  onUnblock,
  quality = 'auto',
  onQuality,
  shareMode = 'detail',
  onShareMode,
  bg,
  onBg,
  bgNote,
  noise,
  onNoise,
  ttsRoom,
}: {
  /** batch H10: the room being read aloud (for its per-room mute) */
  ttsRoom?: { id: string; name: string } | null;
  open: boolean;
  onClose: () => void;
  /** Called with chosen device ids and optional fresh tracks if cam/mic currently on. */
  onApply: (r: AvApplyResult) => Promise<void>;
  camOn: boolean;
  micOn: boolean;
  /** Nicks blocked in this browser (lowercased). */
  blocked?: Set<string>;
  onUnblock?: (nick: string) => void;
  /** camera quality preset; changes apply at once */
  quality?: VideoQuality;
  onQuality?: (q: VideoQuality) => void;
  /** screen-share priority */
  shareMode?: ShareMode;
  onShareMode?: (m: ShareMode) => void;
  /** background effect (this browser); applies at once to a live camera */
  bg?: BgPref;
  onBg?: (p: BgPref) => void;
  /** why the effect was switched off (slow device) */
  bgNote?: string | null;
  /** mic processing; a live mic is re-opened with the new setting */
  noise?: NoisePref;
  onNoise?: (p: NoisePref) => void;
}) {
  const [customBg, setCustomBg] = useState<string | null>(() => loadCustomBg());
  const [bgBusy, setBgBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadBg = async (f: File | undefined) => {
    if (!f || !onBg || !bg) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { setError('Pick a PNG, JPEG, WebP or GIF image.'); return; }
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 1280 / bmp.width, 720 / bmp.height);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      const url = c.toDataURL('image/jpeg', 0.82);
      if (!saveCustomBg(url)) { setError('That image is too big to keep in this browser. Try a smaller one.'); return; }
      setCustomBg(url);
      setError('');
      onBg({ mode: 'image', image: CUSTOM_BG });
    } catch { setError('Could not read that image.'); }
  };
  const removeCustomBg = () => {
    saveCustomBg(null); setCustomBg(null);
    if (bg && onBg && bg.image === CUSTOM_BG) onBg({ ...bg, image: BUNDLED_BGS[0].id });
  };
  const [audioDevs, setAudioDevs] = useState<MediaDeviceInfo[]>([]);
  const [videoDevs, setVideoDevs] = useState<MediaDeviceInfo[]>([]);
  const [outputDevs, setOutputDevs] = useState<MediaDeviceInfo[]>([]);
  const [audioId, setAudioId] = useState('');
  const [videoId, setVideoId] = useState('');
  const [outputId, setOutputId] = useState(DEFAULT_AUDIO_OUTPUT);
  const sinkOk = supportsSinkId();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const previewRef = useRef<HTMLVideoElement>(null);
  const previewStream = useRef<MediaStream | null>(null);
  const meterRaf = useRef(0);
  const analyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> } | null>(null);

  const stopPreview = () => {
    if (meterRaf.current) cancelAnimationFrame(meterRaf.current);
    meterRaf.current = 0;
    analyserRef.current?.ctx.close().catch(() => {});
    analyserRef.current = null;
    previewStream.current?.getTracks().forEach((t) => t.stop());
    previewStream.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
    setLevel(0);
  };

  const refreshDevices = async () => {
    try {
      const { audio, video, output } = await listDevices();
      setAudioDevs(audio);
      setVideoDevs(video);
      setOutputDevs(output);
      const stored = loadStoredDevices();
      setAudioId((cur) => {
        if (cur && audio.some((d) => d.deviceId === cur)) return cur;
        if (stored.audioinput && audio.some((d) => d.deviceId === stored.audioinput)) return stored.audioinput!;
        return audio[0]?.deviceId ?? '';
      });
      setVideoId((cur) => {
        if (cur && video.some((d) => d.deviceId === cur)) return cur;
        if (stored.videoinput && video.some((d) => d.deviceId === stored.videoinput)) return stored.videoinput!;
        return video[0]?.deviceId ?? '';
      });
      setOutputId((cur) => {
        if (cur === DEFAULT_AUDIO_OUTPUT) return cur;
        if (cur && output.some((d) => d.deviceId === cur)) return cur;
        if (stored.audiooutput && output.some((d) => d.deviceId === stored.audiooutput)) return stored.audiooutput!;
        return DEFAULT_AUDIO_OUTPUT;
      });
    } catch (e) {
      setError((e as Error).message || 'Could not list devices');
    }
  };

  const startPreview = async (aId: string, vId: string) => {
    stopPreview();
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Media devices unavailable');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: aId ? audioConstraints(aId) : true,
        video: vId ? videoConstraints(vId) : true,
      });
      previewStream.current = stream;
      let shown: MediaStream = stream;
      const cam = stream.getVideoTracks()[0];
      if (cam && bg && bg.mode !== 'off') {
        // preview the effect too (same lazy chunk the room uses)
        setBgBusy(true);
        try {
          const { startBackground } = await import('../bg/background');
          const t = await startBackground(cam, bg);
          if (previewStream.current !== stream) { t.stop(); return; }
          stream.removeTrack(cam);
          stream.addTrack(t);
          shown = new MediaStream([t]);
        } catch { /* plain preview */ } finally { setBgBusy(false); }
      }
      if (previewRef.current) {
        previewRef.current.srcObject = shown;
        previewRef.current.play().catch(() => {});
        applyAudioOutput(previewRef.current, outputId).catch(() => {});
      }
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        const src = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        analyserRef.current = { ctx, analyser, data };
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        const tick = () => {
          meterRaf.current = requestAnimationFrame(tick);
          const a = analyserRef.current;
          if (!a) return;
          a.analyser.getByteFrequencyData(a.data);
          let sum = 0;
          for (let i = 0; i < a.data.length; i++) sum += a.data[i];
          setLevel(Math.min(1, (sum / a.data.length) / 140));
        };
        tick();
      }
      setError('');
    } catch (e) {
      const err = e as Error;
      setError(err.name === 'NotAllowedError' ? 'Permission denied — allow camera/mic to preview devices.' : err.message);
    }
  };

  useEffect(() => {
    if (!open) { stopPreview(); return; }
    let cancelled = false;
    (async () => {
      setError('');
      try {
        await ensureMediaPermission({ audio: true, video: true });
      } catch (e) {
        if (!cancelled) {
          const err = e as Error;
          setError(err.name === 'NotAllowedError' ? 'Permission denied — allow camera/mic in your browser.' : err.message);
        }
      }
      if (cancelled) return;
      await refreshDevices();
      // preview starts via audioId/videoId effect after refreshDevices sets selections
    })();
    const onChange = () => { refreshDevices(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
      stopPreview();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!audioId && !videoId) return;
    const t = setTimeout(() => { startPreview(audioId, videoId); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioId, videoId, bg?.mode, bg?.image, customBg]);

  useEffect(() => {
    if (!open) return;
    applyAudioOutput(previewRef.current, outputId).catch(() => {});
  }, [open, outputId]);

  const modalRef = useRef<HTMLDivElement>(null);
  useModal(modalRef, onClose, open);
  if (!open) return null;

  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      saveStoredDevices({
        audioinput: audioId || undefined,
        videoinput: videoId || undefined,
        audiooutput: outputId || DEFAULT_AUDIO_OUTPUT,
      });
      let audioTrack: MediaStreamTrack | null | undefined;
      let videoTrack: MediaStreamTrack | null | undefined;
      if (micOn || camOn) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: micOn ? audioConstraints(audioId || undefined) : false,
          video: camOn ? captureConstraints(quality, videoId || undefined) : false,
        });
        audioTrack = micOn ? stream.getAudioTracks()[0] ?? null : undefined;
        videoTrack = camOn ? stream.getVideoTracks()[0] ?? null : undefined;
        // unused opposite tracks already not requested
      }
      await applyAudioOutputToDocument();
      await onApply({
        audioId: audioId || undefined,
        videoId: videoId || undefined,
        outputId: outputId || DEFAULT_AUDIO_OUTPUT,
        audioTrack,
        videoTrack,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Could not apply devices');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop av-backdrop" onClick={onClose}>
      <div ref={modalRef} className="modal panel av-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Audio & video settings">
        <div className="av-modal-head">
          <h3>Audio & video</h3>
          <p className="muted small">Pick mic, camera, and speaker. Preview updates live.</p>
        </div>
        <div className="av-grid">
          <div className="av-preview-wrap">
            <video ref={previewRef} className="av-preview" autoPlay playsInline muted />
            <div className="av-meter" aria-hidden>
              <div className="av-meter-fill" style={{ transform: `scaleY(${Math.max(0.04, level)})` }} />
              <div className="av-meter-glow" style={{ opacity: level > 0.05 ? Math.min(1, level * 2) : 0 }} />
            </div>
          </div>
          <div className="av-fields stack">
            <label className="field">
              <span>Microphone</span>
              <select value={audioId} onChange={(e) => setAudioId(e.target.value)} data-action="av-audio">
                {audioDevs.length === 0 && <option value="">No microphones found</option>}
                {audioDevs.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{deviceLabel(d, i)}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Camera</span>
              <select value={videoId} onChange={(e) => setVideoId(e.target.value)} data-action="av-video">
                {videoDevs.length === 0 && <option value="">No cameras found</option>}
                {videoDevs.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{deviceLabel(d, i)}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Speaker / headphones</span>
              <select
                value={outputId}
                onChange={(e) => setOutputId(e.target.value)}
                data-action="av-output"
                disabled={!sinkOk}
              >
                <option value={DEFAULT_AUDIO_OUTPUT}>System default</option>
                {outputDevs.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{deviceLabel(d, i)}</option>
                ))}
              </select>
            </label>
            {!sinkOk && (
              <p className="muted small">Speaker selection needs Chrome or Edge (this browser does not support <code>setSinkId</code>).</p>
            )}
            <p className="muted small">Mic/camera choices apply next time you enable them; speaker applies immediately to remote audio.</p>
            {onQuality && (
              <label className="field">
                <span>Camera quality</span>
                <select value={quality} onChange={(e) => onQuality(e.target.value as VideoQuality)} data-action="av-quality" name="videoQuality">
                  {VIDEO_QUALITIES.map((q) => <option key={q} value={q}>{VIDEO_QUALITY_LABEL[q]}</option>)}
                </select>
              </label>
            )}
            {onQuality && (
              <p className="muted small" data-testid="vq-help">
                {quality === 'auto' ? 'Auto lowers your camera on a weak connection or a busy device and raises it again when things settle.' : 'Fixed quality. Applies right away; others may still get less if your connection cannot keep up.'}
              </p>
            )}
            {onShareMode && (
              <fieldset className="field vq-share" data-testid="vq-share">
                <legend>Screen share</legend>
                <label className="check-row"><input type="radio" name="shareMode" value="detail" checked={shareMode === 'detail'} onChange={() => onShareMode('detail')} data-action="share-detail" /> <span>Prioritize sharpness <span className="muted small">(text, slides)</span></span></label>
                <label className="check-row"><input type="radio" name="shareMode" value="motion" checked={shareMode === 'motion'} onChange={() => onShareMode('motion')} data-action="share-motion" /> <span>Prioritize smoothness <span className="muted small">(video, games)</span></span></label>
              </fieldset>
            )}
            {onBg && bg && (
              <fieldset className="field av-bg" data-testid="av-bg">
                <legend>Background</legend>
                <div className="av-bg-modes" role="radiogroup" aria-label="Background effect">
                  {BG_MODES.map((m) => (
                    <label key={m.id} className={`av-chip${bg.mode === m.id ? ' on' : ''}`}>
                      <input type="radio" name="bgMode" value={m.id} checked={bg.mode === m.id} onChange={() => onBg({ ...bg, mode: m.id })} data-action={`bg-${m.id}`} />
                      <span>{m.label}</span>
                    </label>
                  ))}
                </div>
                {bg.mode === 'image' && (
                  <div className="av-bg-images" role="radiogroup" aria-label="Background image">
                    {BUNDLED_BGS.map((b) => (
                      <button key={b.id} type="button" role="radio" aria-checked={bg.image === b.id} className={`av-bg-thumb${bg.image === b.id ? ' on' : ''}`} onClick={() => onBg({ mode: 'image', image: b.id })} data-bg={b.id} title={b.label}>
                        <img src={b.url} alt={b.label} width={64} height={36} loading="lazy" decoding="async" />
                      </button>
                    ))}
                    {customBg && (
                      <button type="button" role="radio" aria-checked={bg.image === CUSTOM_BG} className={`av-bg-thumb${bg.image === CUSTOM_BG ? ' on' : ''}`} onClick={() => onBg({ mode: 'image', image: CUSTOM_BG })} data-bg="custom" title="Your image">
                        <img src={customBg} alt="Your image" width={64} height={36} decoding="async" />
                      </button>
                    )}
                    <button type="button" className="av-bg-thumb add" onClick={() => fileRef.current?.click()} data-action="bg-upload" title="Upload your own (kept in this browser only)" aria-label="Upload your own background">+</button>
                    <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { void uploadBg(e.target.files?.[0]); e.target.value = ''; }} />
                    {customBg && <button type="button" className="btn ghost small-btn" onClick={removeCustomBg} data-action="bg-remove">Remove mine</button>}
                  </div>
                )}
                <p className="muted small" data-testid="bg-help">
                  {bgBusy ? 'Loading the background model…' : bg.mode === 'off' ? 'Blur or replace what is behind you. Runs on this device; nothing is uploaded.' : 'Runs on this device; your own image stays in this browser. Turns itself off if the device is too busy.'}
                </p>
                {bgNote && <p className="small av-note" role="status" data-testid="bg-note">{bgNote}</p>}
              </fieldset>
            )}
            {onNoise && noise && (
              <fieldset className="field av-noise" data-testid="av-noise">
                <legend>Microphone</legend>
                <label className="check-row"><input type="checkbox" checked={noise.on} onChange={(e) => onNoise({ on: e.target.checked, strong: e.target.checked && noise.strong })} data-action="noise-on" /> <span>Noise suppression <span className="muted small">(also echo cancellation and auto gain)</span></span></label>
                <label className="check-row"><input type="checkbox" checked={noise.strong} disabled={!noise.on} onChange={(e) => onNoise({ on: true, strong: e.target.checked })} data-action="noise-strong" /> <span>Stronger (RNNoise) <span className="muted small">(one-time ~120 KB download, uses a little more CPU)</span></span></label>
              </fieldset>
            )}
            <TtsSettings room={ttsRoom} />
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        {blocked && onUnblock && (
          <div className="blocked-list">
            <h3>Blocked</h3>
            <p className="muted small">Hidden on this browser only. They are not notified.</p>
            {[...blocked].length === 0 ? <p className="muted small">No one blocked.</p> : (
              <ul>
                {[...blocked].sort().map((nick) => (
                  <li key={nick}>
                    <span>{nick}</span>
                    <button type="button" className="btn ghost small-btn" data-action="unblock" onClick={() => onUnblock(nick)}>Unblock</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy} data-action="av-cancel">Cancel</button>
          <button type="button" className="btn primary" onClick={apply} disabled={busy} data-action="av-apply">
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
