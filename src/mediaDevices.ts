import { noiseConstraints } from './bgPrefs';
import { APP_NAME } from '../shared/config';

const KEY = `${APP_NAME.toLowerCase()}.avDevices`;

/** Empty string = browser default output device. */
export const DEFAULT_AUDIO_OUTPUT = '';

export interface StoredDevices {
  audioinput?: string;
  videoinput?: string;
  /** Speaker / headphones sink id; omit or '' for default. */
  audiooutput?: string;
}

export function loadStoredDevices(): StoredDevices {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const j = JSON.parse(raw) as StoredDevices;
    return {
      audioinput: typeof j.audioinput === 'string' ? j.audioinput : undefined,
      videoinput: typeof j.videoinput === 'string' ? j.videoinput : undefined,
      audiooutput: typeof j.audiooutput === 'string' ? j.audiooutput : undefined,
    };
  } catch { return {}; }
}

export function saveStoredDevices(partial: StoredDevices) {
  const next: StoredDevices = { ...loadStoredDevices(), ...partial };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
}

export function videoConstraints(deviceId?: string): MediaTrackConstraints {
  const base: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };
  if (deviceId) return { ...base, deviceId: { exact: deviceId } };
  return base;
}

export function audioConstraints(deviceId?: string): MediaTrackConstraints {
  // the A/V settings noise toggle (on by default: browser echo cancellation, noise suppression, gain)
  const base: MediaTrackConstraints = noiseConstraints();
  if (deviceId) return { ...base, deviceId: { exact: deviceId } };
  return base;
}

export async function ensureMediaPermission(kinds: { audio?: boolean; video?: boolean } = { audio: true, video: true }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Media devices unavailable');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: kinds.audio ? true : false,
    video: kinds.video ? true : false,
  });
  stream.getTracks().forEach((t) => t.stop());
}

export async function listDevices(): Promise<{ audio: MediaDeviceInfo[]; video: MediaDeviceInfo[]; output: MediaDeviceInfo[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { audio: [], video: [], output: [] };
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    audio: all.filter((d) => d.kind === 'audioinput'),
    video: all.filter((d) => d.kind === 'videoinput'),
    output: all.filter((d) => d.kind === 'audiooutput'),
  };
}

export function deviceLabel(d: MediaDeviceInfo, index: number) {
  if (d.label) return d.label;
  if (d.kind === 'audioinput') return `Microphone ${index + 1}`;
  if (d.kind === 'audiooutput') return `Speaker ${index + 1}`;
  return `Camera ${index + 1}`;
}

type Sinkable = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };

/** Chrome/Edge support setSinkId; Firefox often does not. */
export function supportsSinkId(): boolean {
  return typeof HTMLMediaElement !== 'undefined'
    && typeof (HTMLMediaElement.prototype as Sinkable).setSinkId === 'function';
}

export function storedAudioOutputId(): string {
  return loadStoredDevices().audiooutput ?? DEFAULT_AUDIO_OUTPUT;
}

/** Apply preferred speaker to one media element (no-op if unsupported). */
export async function applyAudioOutput(el: HTMLMediaElement | null | undefined, sinkId?: string): Promise<void> {
  if (!el || !supportsSinkId()) return;
  const id = sinkId !== undefined ? sinkId : storedAudioOutputId();
  const media = el as Sinkable;
  try {
    if (media.sinkId === id) return;
    await media.setSinkId!(id);
  } catch (e) {
    console.warn('setSinkId failed', e);
  }
}

/** Re-apply stored sink to every audio/video in the document (and optional extra roots). */
export async function applyAudioOutputToDocument(root: ParentNode = document): Promise<void> {
  if (!supportsSinkId()) return;
  const id = storedAudioOutputId();
  const els = root.querySelectorAll('audio, video');
  await Promise.all([...els].map((el) => applyAudioOutput(el as HTMLMediaElement, id)));
}
