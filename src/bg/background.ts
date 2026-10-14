/**
 * Background blur / replace for the camera (lazy chunk). MediaPipe's selfie segmenter runs on a small
 * copy of each frame; the person mask is scaled up onto a canvas, the background is drawn behind it,
 * and canvas.captureStream() becomes the track we send (swapped in with replaceTrack, so no
 * renegotiation). Everything is self-hosted: the wasm comes from our own /assets, the model from
 * /models. A device that cannot keep up gets the effect switched off (onSlow).
 */
import { FilesetResolver, ImageSegmenter, type MPMask } from '@mediapipe/tasks-vision';
import simdLoader from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import simdBinary from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import plainLoader from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url';
import plainBinary from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url';
import { bgImageUrl, trackProcessors, type BgPref, type TrackProcessor } from '../bgPrefs';

const MODEL_URL = '/models/selfie_segmenter.tflite';
/** segmentation input width; the mask is upscaled (and softened) onto the full-size frame */
const SEG_W = 256;
const BLUR_DIV: Record<string, number> = { 'blur-light': 10, 'blur-strong': 28 };

let segmenterP: Promise<ImageSegmenter> | null = null;
let users = 0;

async function segmenter(): Promise<ImageSegmenter> {
  if (!segmenterP) {
    segmenterP = (async () => {
      const simd = await FilesetResolver.isSimdSupported();
      const fileset = simd
        ? { wasmLoaderPath: new URL(simdLoader, location.href).href, wasmBinaryPath: new URL(simdBinary, location.href).href }
        : { wasmLoaderPath: new URL(plainLoader, location.href).href, wasmBinaryPath: new URL(plainBinary, location.href).href };
      const opts = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO' as const,
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      try { return await ImageSegmenter.createFromOptions(fileset, opts('GPU')); } catch {
        return await ImageSegmenter.createFromOptions(fileset, opts('CPU'));
      }
    })();
    segmenterP.catch(() => { segmenterP = null; });
  }
  return segmenterP;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Background image failed to load'));
    img.src = url;
  });
}

interface Debug { noSlow?: boolean }
const debug = (): Debug => { try { return JSON.parse(localStorage.getItem('camchat.bgDebug') || '{}') as Debug; } catch { return {}; } };

export interface BgStartOptions {
  /** the device cannot keep up: the caller turns the effect off (with a note) */
  onSlow?: (why: string) => void;
}

/** Wrap a raw camera track. The returned track's stop() also stops the camera and frees the model. */
export async function startBackground(raw: MediaStreamTrack, pref: BgPref, o: BgStartOptions = {}): Promise<MediaStreamTrack> {
  const seg = await segmenter();
  const s = raw.getSettings();
  const fps = Math.max(10, Math.min(30, Math.round(s.frameRate || 24)));

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([raw]);
  await video.play().catch(() => {});

  const out = document.createElement('canvas');
  out.width = s.width || 640;
  out.height = s.height || 360;
  const ctx = out.getContext('2d', { alpha: false })!;
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  const maskCanvas = document.createElement('canvas');
  const mctx = maskCanvas.getContext('2d')!;
  let maskData: ImageData | null = null;
  const fg = document.createElement('canvas');
  const fctx = fg.getContext('2d')!;
  const tiny = document.createElement('canvas');
  const tctx = tiny.getContext('2d')!;

  let mode = pref.mode;
  let image: HTMLImageElement | null = null;
  const setPref = async (p: BgPref) => {
    if (p.mode === 'image') {
      const url = bgImageUrl(p);
      image = url ? await loadImage(url).catch(() => null) : null;
      mode = image ? 'image' : 'blur-strong';
    } else { mode = p.mode; image = null; }
  };
  await setPref(pref);

  const stream = out.captureStream(fps);
  const track = stream.getVideoTracks()[0];
  try { track.contentHint = 'motion'; } catch { /* old browsers */ }

  let alive = true;
  let timer = 0;
  let lastTs = -1;
  let slowSince = 0;
  let avg = 0;
  const budget = Math.max(40, (1000 / fps) * 1.25);
  const noSlow = !!debug().noSlow;

  const frame = () => {
    if (!alive) return;
    const t0 = performance.now();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh && video.readyState >= 2) {
      if (out.width !== vw || out.height !== vh) { out.width = vw; out.height = vh; }
      const sw = SEG_W, sh = Math.max(1, Math.round((SEG_W * vh) / vw));
      if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; maskCanvas.width = sw; maskCanvas.height = sh; maskData = null; }
      sctx.drawImage(video, 0, 0, sw, sh);
      let ts = Math.round(t0);
      if (ts <= lastTs) ts = lastTs + 1;
      lastTs = ts;
      let mask: MPMask | undefined;
      try {
        const r = seg.segmentForVideo(small, ts);
        mask = r.confidenceMasks?.[0];
        if (mask) {
          const conf = mask.getAsFloat32Array();
          if (!maskData || maskData.width !== mask.width || maskData.height !== mask.height) {
            maskData = new ImageData(mask.width, mask.height);
            if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) { maskCanvas.width = mask.width; maskCanvas.height = mask.height; }
          }
          const d = maskData.data;
          for (let i = 0, j = 3; i < conf.length; i++, j += 4) d[j] = conf[i] * 255;
          mctx.putImageData(maskData, 0, 0);
        }
        r.close();
      } catch { /* a dropped frame keeps the previous mask */ }
      // person layer: the mask (scaled up, smoothed) keeps the camera pixels where someone is
      if (fg.width !== vw || fg.height !== vh) { fg.width = vw; fg.height = vh; }
      fctx.globalCompositeOperation = 'copy';
      fctx.filter = 'blur(2px)';
      fctx.drawImage(maskCanvas, 0, 0, vw, vh);
      fctx.filter = 'none';
      fctx.globalCompositeOperation = 'source-in';
      fctx.drawImage(video, 0, 0, vw, vh);
      fctx.globalCompositeOperation = 'source-over';
      // background
      if (mode === 'image' && image) {
        const k = Math.max(vw / image.width, vh / image.height);
        const iw = image.width * k, ih = image.height * k;
        ctx.drawImage(image, (vw - iw) / 2, (vh - ih) / 2, iw, ih);
      } else {
        // blur by shrinking then smoothing back up: cheap, and works where canvas `filter` does not (Safari)
        const k = BLUR_DIV[mode] ?? 16;
        const bw = Math.max(4, Math.round(vw / k)), bh = Math.max(3, Math.round(vh / k));
        if (tiny.width !== bw || tiny.height !== bh) { tiny.width = bw; tiny.height = bh; }
        tctx.imageSmoothingQuality = 'high';
        tctx.drawImage(video, 0, 0, bw, bh);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(tiny, 0, 0, vw, vh);
      }
      ctx.drawImage(fg, 0, 0);
      // too slow for this device? (sustained for ~5 s)
      const took = performance.now() - t0;
      avg = avg ? avg * 0.9 + took * 0.1 : took;
      if (!noSlow && avg > budget) {
        if (!slowSince) slowSince = t0;
        else if (t0 - slowSince > 5000) { o.onSlow?.('slow'); slowSince = Number.POSITIVE_INFINITY; }
      } else if (slowSince !== Number.POSITIVE_INFINITY) slowSince = 0;
    }
    const wait = Math.max(0, 1000 / fps - (performance.now() - t0));
    timer = window.setTimeout(frame, wait);
  };
  frame();
  users += 1;

  const dispose = (keepRaw: boolean) => {
    if (!alive) return;
    alive = false;
    window.clearTimeout(timer);
    video.srcObject = null;
    stopOut();
    if (!keepRaw) raw.stop();
    users -= 1;
    // keep the model warm for a quick re-enable; free it when nothing has used it for a minute
    window.setTimeout(() => {
      if (users === 0 && segmenterP) { const p = segmenterP; segmenterP = null; void p.then((x) => x.close()).catch(() => {}); }
    }, 60_000);
  };
  const stopOut = track.stop.bind(track);
  track.stop = () => dispose(false);
  // if the camera goes away (unplugged, revoked) the processed track ends with it
  raw.addEventListener('ended', () => { dispose(true); track.dispatchEvent(new Event('ended')); });
  const proc: TrackProcessor = { raw, update: setPref, dispose };
  trackProcessors.set(track, proc);
  return track;
}
