/** Local mic level via AnalyserNode + remote via getSynchronizationSources, with hysteresis. */

export type SpeakingMap = Record<string, boolean>;

const ATTACK = 0.06;
const RELEASE = 0.025;
const HOLD_MS = 220;

export class LocalSpeakingMonitor {
  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;
  private raf = 0;
  private speaking = false;
  private quietSince = 0;
  private track: MediaStreamTrack | null = null;
  private onChange: (speaking: boolean, level: number) => void;

  constructor(onChange: (speaking: boolean, level: number) => void) {
    this.onChange = onChange;
  }

  setTrack(track: MediaStreamTrack | null) {
    if (track === this.track) return;
    this.teardownGraph();
    this.track = track;
    if (!track || track.readyState === 'ended' || !track.enabled) {
      this.setSpeaking(false, 0);
      return;
    }
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      const stream = new MediaStream([track]);
      this.src = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.5;
      this.src.connect(this.analyser);
      this.data = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this.loop();
    } catch {
      this.setSpeaking(false, 0);
    }
  }

  private teardownGraph() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    try { this.src?.disconnect(); } catch { /* */ }
    try { this.analyser?.disconnect(); } catch { /* */ }
    this.src = null;
    this.analyser = null;
    this.data = null;
    const c = this.ctx;
    this.ctx = null;
    c?.close().catch(() => {});
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.analyser || !this.data || !this.track) return;
    if (this.track.readyState === 'ended' || !this.track.enabled || this.track.muted) {
      this.setSpeaking(false, 0);
      return;
    }
    this.analyser.getByteFrequencyData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i];
    const level = Math.min(1, (sum / this.data.length) / 140);
    const now = performance.now();
    if (level >= ATTACK) {
      this.quietSince = 0;
      this.setSpeaking(true, level);
    } else if (level < RELEASE) {
      if (!this.quietSince) this.quietSince = now;
      if (now - this.quietSince >= HOLD_MS) this.setSpeaking(false, level);
      else this.onChange(this.speaking, level);
    } else {
      this.onChange(this.speaking, level);
    }
  };

  private setSpeaking(s: boolean, level: number) {
    this.speaking = s;
    this.onChange(s, level);
  }

  stop() {
    this.teardownGraph();
    this.track = null;
    this.setSpeaking(false, 0);
  }
}

/** Poll remote inbound audio levels via RTCRtpReceiver.getSynchronizationSources. */
export class RemoteSpeakingMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state = new Map<string, { speaking: boolean; quietSince: number }>();
  private onChange: (map: SpeakingMap) => void;
  private getPcs: () => Iterable<[string, RTCPeerConnection]>;
  private skip: (track: MediaStreamTrack) => boolean;

  /** `skip` filters receivers that are not speech (screen-share audio). */
  constructor(getPcs: () => Iterable<[string, RTCPeerConnection]>, onChange: (map: SpeakingMap) => void, skip: (track: MediaStreamTrack) => boolean = () => false) {
    this.getPcs = getPcs;
    this.onChange = onChange;
    this.skip = skip;
  }

  start(intervalMs = 250) {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.clear();
    this.onChange({});
  }

  private tick() {
    const now = performance.now();
    const next: SpeakingMap = {};
    const seen = new Set<string>();
    for (const [id, pc] of this.getPcs()) {
      if (pc.connectionState === 'closed') continue;
      seen.add(id);
      let level = 0;
      for (const r of pc.getReceivers()) {
        if (r.track?.kind !== 'audio' || r.track.readyState === 'ended' || this.skip(r.track)) continue;
        const sources = r.getSynchronizationSources?.() ?? [];
        for (const s of sources) {
          if (typeof s.audioLevel === 'number' && s.audioLevel > level) level = s.audioLevel;
        }
      }
      let st = this.state.get(id);
      if (!st) { st = { speaking: false, quietSince: 0 }; this.state.set(id, st); }
      if (level >= ATTACK) {
        st.quietSince = 0;
        st.speaking = true;
      } else if (level < RELEASE) {
        if (!st.quietSince) st.quietSince = now;
        if (now - st.quietSince >= HOLD_MS) st.speaking = false;
      }
      if (st.speaking) next[id] = true;
    }
    for (const id of [...this.state.keys()]) if (!seen.has(id)) this.state.delete(id);
    this.onChange(next);
  }
}
