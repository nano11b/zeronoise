/**
 * Stronger noise suppression (lazy chunk): RNNoise compiled to wasm, running in an AudioWorklet.
 * Size: worklet ~64 KB (~20 KB gzip) + rnnoise_simd.wasm ~157 KB (~95 KB gzip, the non-SIMD build
 * for older browsers). Loaded only when "Stronger" is turned on.
 */
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import { trackProcessors } from './bgPrefs';

let binary: Promise<ArrayBuffer> | null = null;

/** Wrap a raw mic track; the returned track's stop() also closes the audio graph and the mic. */
export async function startRnnoise(raw: MediaStreamTrack): Promise<MediaStreamTrack> {
  binary ??= loadRnnoise({ url: wasmUrl, simdUrl });
  binary.catch(() => { binary = null; });
  const wasmBinary = await binary;
  const ctx = new AudioContext({ sampleRate: 48000 });
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(new MediaStream([raw]));
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    const dst = ctx.createMediaStreamDestination();
    src.connect(node).connect(dst);
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const track = dst.stream.getAudioTracks()[0];
    let alive = true;
    const stopOut = track.stop.bind(track);
    const dispose = (keepRaw: boolean) => {
      if (!alive) return;
      alive = false;
      try { src.disconnect(); node.disconnect(); node.destroy(); } catch { /* already torn down */ }
      void ctx.close().catch(() => {});
      stopOut();
      if (!keepRaw) raw.stop();
    };
    track.stop = () => dispose(false);
    raw.addEventListener('ended', () => dispose(true));
    trackProcessors.set(track, { raw, dispose });
    return track;
  } catch (e) {
    void ctx.close().catch(() => {});
    throw e;
  }
}
