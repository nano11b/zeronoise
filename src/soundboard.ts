import { storedAudioOutputId } from './mediaDevices';

const VOLUME_KEY = 'camchat.soundboardVolume';
const MAX_PLAYING = 3;

export function loadSoundVolume(): number {
  try {
    const n = Number(localStorage.getItem(VOLUME_KEY));
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  } catch { /* private mode */ }
  return 0.7;
}

export function saveSoundVolume(volume: number) {
  const next = Math.min(1, Math.max(0, volume));
  try { localStorage.setItem(VOLUME_KEY, String(next)); } catch { /* private mode */ }
  return next;
}

let ctx: AudioContext | null = null;
const playing: AudioBufferSourceNode[] = [];

function context(): AudioContext {
  if (!ctx || ctx.state === 'closed') {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
  }
  return ctx;
}

/** Resume the shared context after a gesture so remote clips are not blocked by autoplay. */
export function resumeSoundboard(): void {
  try {
    const c = context();
    if (c.state === 'suspended') void c.resume();
    void routeSink(c);
  } catch { /* ignore */ }
}

async function routeSink(c: AudioContext): Promise<void> {
  const id = storedAudioOutputId();
  const sinkable = c as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
  if (!id || id === 'default' || typeof sinkable.setSinkId !== 'function') return;
  try { await sinkable.setSinkId(id); } catch { /* Firefox and some outputs cannot switch */ }
}

/** Play one clip. Stops the oldest if three are already going. Does not loop. */
export async function playSoundClip(roomId: string, id: string, volume: number): Promise<void> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/sounds/${encodeURIComponent(id)}/file`, { credentials: 'same-origin' });
  if (!r.ok) return;
  const raw = await r.arrayBuffer();
  const c = context();
  if (c.state === 'suspended') await c.resume();
  await routeSink(c);
  const buffer = await c.decodeAudioData(raw.slice(0));
  const src = c.createBufferSource();
  const gain = c.createGain();
  gain.gain.value = Math.min(1, Math.max(0, volume));
  src.buffer = buffer;
  src.loop = false;
  src.connect(gain);
  gain.connect(c.destination);
  src.onended = () => {
    const i = playing.indexOf(src);
    if (i >= 0) playing.splice(i, 1);
  };
  playing.push(src);
  while (playing.length > MAX_PLAYING) {
    const old = playing.shift();
    try { old?.stop(); } catch { /* already stopped */ }
  }
  src.start();
}

export async function fxAudioContext(): Promise<AudioContext | null> {
  try {
    const c = context();
    if (c.state === 'suspended') await c.resume();
    await routeSink(c);
    return c;
  } catch { return null; }
}
