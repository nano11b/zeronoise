/**
 * Rolling "last ~30 s" clip buffer, entirely in the browser (nothing is uploaded).
 *
 * A single MediaRecorder can only produce a valid WebM from its own start, so two recorders run
 * staggered by SEGMENT_MS: each is restarted once it is 2×SEGMENT_MS old. Once warm (after
 * SEGMENT_MS), the older one always holds between 30 and 60 s. Saving stops that recorder (so the
 * file is finalized), hands back its chunks as one .webm, and restarts it; the other keeps going.
 * Before it is warm a save returns whatever was recorded since clip-ready was turned on.
 */
export const SEGMENT_MS = 30_000;

function pickMime(withAudio: boolean): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const opts = withAudio
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
  return opts.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) ?? null;
}
export const clipSupported = () => pickMime(false) != null;

interface Slot { rec: MediaRecorder; chunks: Blob[]; startedAt: number }

export class ClipRecorder {
  private slots: (Slot | null)[] = [null, null];
  private timer: number | null = null;
  private stagger: number | null = null;
  private dead = false;
  private readonly mime: string;
  private readonly stream: MediaStream;
  constructor(source: MediaStream, private readonly segmentMs = SEGMENT_MS) {
    const tracks = source.getTracks().filter((t) => t.readyState === 'live');
    this.stream = new MediaStream(tracks);
    const mime = pickMime(tracks.some((t) => t.kind === 'audio'));
    if (!mime || !tracks.some((t) => t.kind === 'video')) throw new Error('Clips need a live video stream in a browser that can record WebM');
    this.mime = mime;
  }
  start() {
    this.slots[0] = this.open();
    this.stagger = window.setTimeout(() => { if (!this.dead) this.slots[1] = this.open(); }, this.segmentMs);
    this.timer = window.setInterval(() => this.rotate(), 1000);
  }
  private open(): Slot | null {
    try {
      const rec = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: 2_500_000 });
      const slot: Slot = { rec, chunks: [], startedAt: Date.now() };
      rec.ondataavailable = (e) => { if (e.data && e.data.size) slot.chunks.push(e.data); };
      rec.start(1000);
      return slot;
    } catch { return null; }
  }
  private drop(slot: Slot | null) {
    if (!slot) return;
    slot.rec.ondataavailable = null;
    try { if (slot.rec.state !== 'inactive') slot.rec.stop(); } catch { /* ignore */ }
    slot.chunks = [];
  }
  private rotate() {
    const now = Date.now();
    this.slots = this.slots.map((s) => {
      if (s && now - s.startedAt >= 2 * this.segmentMs) { this.drop(s); return this.open(); }
      return s;
    });
  }
  /** Seconds the next save would contain (approx.). */
  bufferedSeconds(): number {
    const oldest = this.oldestIndex();
    return oldest < 0 ? 0 : Math.round((Date.now() - this.slots[oldest]!.startedAt) / 1000);
  }
  private oldestIndex(): number {
    let best = -1;
    this.slots.forEach((s, i) => { if (s && (best < 0 || s.startedAt < this.slots[best]!.startedAt)) best = i; });
    return best;
  }
  /** Finalize the longest buffer as one WebM blob and restart that recorder. */
  save(): Promise<{ blob: Blob; seconds: number }> {
    const i = this.oldestIndex();
    const slot = i >= 0 ? this.slots[i] : null;
    if (!slot) return Promise.reject(new Error('Nothing recorded yet'));
    const seconds = Math.round((Date.now() - slot.startedAt) / 1000);
    return new Promise((resolve, reject) => {
      slot.rec.onstop = () => {
        const blob = new Blob(slot.chunks, { type: 'video/webm' });
        slot.chunks = [];
        if (!this.dead) this.slots[i] = this.open();
        if (blob.size) resolve({ blob, seconds }); else reject(new Error('Nothing recorded yet'));
      };
      try { slot.rec.stop(); } catch (e) { reject(e as Error); }
    });
  }
  stop() {
    this.dead = true;
    if (this.timer != null) window.clearInterval(this.timer);
    if (this.stagger != null) window.clearTimeout(this.stagger);
    this.slots.forEach((s) => this.drop(s));
    this.slots = [null, null];
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
