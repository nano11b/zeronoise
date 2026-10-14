/**
 * Background effect + noise suppression preferences (this browser only), and the registry that maps a
 * processed track back to its raw camera / mic track. Tiny on purpose: the heavy code is in ./bg and
 * ./noise, which load only when an effect is turned on.
 */
export type BgMode = 'off' | 'blur-light' | 'blur-strong' | 'image';
export interface BgPref { mode: BgMode; image: string }
export interface NoisePref { on: boolean; strong: boolean }

export const BG_MODES: { id: BgMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'blur-light', label: 'Blur light' },
  { id: 'blur-strong', label: 'Blur strong' },
  { id: 'image', label: 'Image' },
];
export const BUNDLED_BGS: { id: string; label: string; url: string }[] = [
  { id: 'dusk', label: 'Dusk', url: '/backgrounds/dusk.jpg' },
  { id: 'studio', label: 'Studio', url: '/backgrounds/studio.jpg' },
  { id: 'forest', label: 'Forest', url: '/backgrounds/forest.jpg' },
  { id: 'shelves', label: 'Shelves', url: '/backgrounds/shelves.jpg' },
];
export const CUSTOM_BG = 'custom';

const BG_KEY = 'camchat.background';
const CUSTOM_KEY = 'camchat.bgCustom';
const NOISE_KEY = 'camchat.noise';

function read<T>(key: string): Partial<T> {
  try { return JSON.parse(localStorage.getItem(key) || '{}') as Partial<T>; } catch { return {}; }
}

export function loadBg(): BgPref {
  const v = read<BgPref>(BG_KEY);
  const mode = BG_MODES.some((m) => m.id === v.mode) ? v.mode! : 'off';
  const image = typeof v.image === 'string' && (v.image === CUSTOM_BG || BUNDLED_BGS.some((b) => b.id === v.image)) ? v.image : BUNDLED_BGS[0].id;
  return { mode, image };
}
export function saveBg(p: BgPref) { try { localStorage.setItem(BG_KEY, JSON.stringify(p)); } catch { /* private mode */ } }
export function loadCustomBg(): string | null {
  try { const v = localStorage.getItem(CUSTOM_KEY); return v && v.startsWith('data:image/') ? v : null; } catch { return null; }
}
/** Returns false when the browser refused to store it (quota). */
export function saveCustomBg(dataUrl: string | null): boolean {
  try { if (dataUrl) localStorage.setItem(CUSTOM_KEY, dataUrl); else localStorage.removeItem(CUSTOM_KEY); return true; } catch { return false; }
}
/** URL of the picture behind an Image background (null when the custom one is missing). */
export function bgImageUrl(p: BgPref): string | null {
  if (p.image === CUSTOM_BG) return loadCustomBg();
  return BUNDLED_BGS.find((b) => b.id === p.image)?.url ?? BUNDLED_BGS[0].url;
}

export function loadNoise(): NoisePref {
  const v = read<NoisePref>(NOISE_KEY);
  return { on: v.on !== false, strong: v.on !== false && v.strong === true };
}
export function saveNoise(p: NoisePref) { try { localStorage.setItem(NOISE_KEY, JSON.stringify(p)); } catch { /* private mode */ } }

/** Browser-side processing constraints for the mic (RNNoise replaces the browser's own suppressor). */
export function noiseConstraints(p: NoisePref = loadNoise()): MediaTrackConstraints {
  if (!p.on) return { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  return { echoCancellation: true, noiseSuppression: !p.strong, autoGainControl: true };
}

/** A processed (canvas / worklet) track: its raw source, live option changes, and teardown. */
export interface TrackProcessor {
  raw: MediaStreamTrack;
  /** background only: switch blur / image without a new track */
  update?(p: BgPref): Promise<void>;
  /** stop processing; keepRaw leaves the camera / mic running (for switching the effect off live) */
  dispose(keepRaw: boolean): void;
}
export const trackProcessors = new WeakMap<MediaStreamTrack, TrackProcessor>();
/** The device track behind a possibly processed one (constraints go here). */
export const rawTrack = (t: MediaStreamTrack) => trackProcessors.get(t)?.raw ?? t;
