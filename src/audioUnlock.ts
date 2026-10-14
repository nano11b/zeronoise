import { applyAudioOutputToDocument } from './mediaDevices';

/** Resume autoplay / AudioContext after a user gesture (browsers block unmuted remote audio otherwise). */
export function unlockAudio() {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      ctx.close?.().catch(() => {});
    }
    document.querySelectorAll('video, audio[data-share-audio]').forEach((v) => { (v as HTMLMediaElement).play().catch(() => {}); });
    applyAudioOutputToDocument().catch(() => {});
  } catch { /* ignore */ }
}
