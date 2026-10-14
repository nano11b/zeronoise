/**
 * Camera quality presets, per-viewer receive preferences and the Auto step-down state machine.
 * Pure (no DOM, no WebRTC objects) so the server can validate values and the tests can drive it directly.
 */

export type VideoQuality = 'auto' | 'high' | 'medium' | 'low' | 'saver';
export const VIDEO_QUALITIES: readonly VideoQuality[] = ['auto', 'high', 'medium', 'low', 'saver'];
export const DEFAULT_VIDEO_QUALITY: VideoQuality = 'auto';
export const VIDEO_QUALITY_LABEL: Record<VideoQuality, string> = {
  auto: 'Auto (recommended)',
  high: 'High · 720p',
  medium: 'Medium · 480p',
  low: 'Low · 360p',
  saver: 'Data saver · 240p, 15 fps',
};
export const isVideoQuality = (v: unknown): v is VideoQuality => VIDEO_QUALITIES.includes(v as VideoQuality);

/** A fixed send level. Order matters: index 0 is the best. */
export type LevelId = 'high' | 'medium' | 'low' | 'saver';
export const LEVEL_ORDER: readonly LevelId[] = ['high', 'medium', 'low', 'saver'];
export interface Level { height: number; fps: number; /** bits per second */ maxBitrate: number }
export const LEVELS: Record<LevelId, Level> = {
  high: { height: 720, fps: 30, maxBitrate: 1_500_000 },
  medium: { height: 480, fps: 24, maxBitrate: 700_000 },
  low: { height: 360, fps: 20, maxBitrate: 400_000 },
  saver: { height: 240, fps: 15, maxBitrate: 150_000 },
};
/**
 * Auto never sends above Medium (today's capture size): in a full mesh every viewer gets its own
 * encode, so upload grows with the room. Pick High by hand for 720p.
 */
export const AUTO_CEILING: LevelId = 'medium';

/** Structural subsets of the DOM types, so this file also compiles for the server (no DOM lib). */
export interface CaptureConstraints { width: { ideal: number }; height: { ideal: number }; frameRate: { ideal: number; max: number }; deviceId?: { exact: string } }
export type DegradationPref = 'maintain-framerate' | 'maintain-resolution' | 'balanced';

/** getUserMedia constraints for a preset. Auto / Medium keep the long-standing 640x480 @ 24 capture. */
export function captureConstraints(q: VideoQuality, deviceId?: string): CaptureConstraints {
  const base: CaptureConstraints =
    q === 'high' ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
      : q === 'low' ? { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 20 } }
        : q === 'saver' ? { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } }
          : { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
}

/** What a viewer asked one sender to do for them. */
export type ViewPref = 'full' | 'low' | 'paused';
export const VIEW_PREFS: readonly ViewPref[] = ['full', 'low', 'paused'];
export const isViewPref = (v: unknown): v is ViewPref => VIEW_PREFS.includes(v as ViewPref);

export interface EncodingParams { active: boolean; maxBitrate?: number; scaleResolutionDownBy?: number; maxFramerate?: number }

/**
 * Encoding for one camera sender. `level` null = no cap (keeps the browser defaults);
 * a viewer's "low" means at most Low for that viewer; "paused" turns that viewer's encoding off.
 */
export function cameraEncoding(level: LevelId | null, trackHeight: number, pref: ViewPref = 'full'): EncodingParams {
  if (pref === 'paused') return { active: false };
  let id = level;
  if (pref === 'low') id = !id || LEVEL_ORDER.indexOf(id) < LEVEL_ORDER.indexOf('low') ? 'low' : id;
  if (!id) return { active: true };
  const L = LEVELS[id];
  const h = trackHeight > 0 ? trackHeight : L.height;
  return { active: true, maxBitrate: L.maxBitrate, scaleResolutionDownBy: Math.max(1, Math.round((h / L.height) * 100) / 100), maxFramerate: L.fps };
}

/** Screen share: "sharpness" keeps resolution (text stays crisp), "smoothness" keeps the frame rate. */
export type ShareMode = 'detail' | 'motion';
export const isShareMode = (v: unknown): v is ShareMode => v === 'detail' || v === 'motion';
export function shareSettings(mode: ShareMode, pref: ViewPref = 'full'): { contentHint: 'detail' | 'motion'; degradationPreference: DegradationPref; encoding: EncodingParams } {
  const degradationPreference: DegradationPref = mode === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
  const encoding: EncodingParams = pref === 'paused' ? { active: false }
    : pref === 'low' ? { active: true, scaleResolutionDownBy: 2, maxBitrate: 600_000, maxFramerate: mode === 'motion' ? 15 : 5 }
      : { active: true };
  return { contentHint: mode, degradationPreference, encoding };
}

// ---------------------------------------------------------------- Auto step-down

/** One aggregated getStats sample (worst across peers). */
export interface StatSample {
  /** outbound-rtp qualityLimitationReason */
  limitation: 'none' | 'bandwidth' | 'cpu' | 'other';
  /** remote-inbound-rtp fractionLost, as a percentage */
  lossPct: number;
  /** milliseconds; 0 when unknown */
  rttMs: number;
  /** candidate-pair availableOutgoingBitrate in bits/s; null when the browser does not report it */
  availBps: number | null;
}
export type LimitReason = 'bandwidth' | 'cpu';
export interface AutoState {
  /** index into LEVEL_ORDER */
  level: number;
  bad: number;
  good: number;
  lastChangeAt: number;
  lastUpAt: number;
  /** grows each time a step up is undone quickly (hysteresis against flapping) */
  upHoldMs: number;
  /** why we are below the ceiling, or null at the ceiling */
  reason: LimitReason | null;
}
export const AUTO_TUNING = {
  /** ms between samples */
  intervalMs: 3000,
  /** consecutive bad samples before stepping down (~9 s) */
  badToStepDown: 3,
  /** consecutive good samples before stepping up (~30 s) */
  goodToStepUp: 10,
  /** no further change this soon after any change */
  cooldownMs: 8000,
  /** base wait below the ceiling before trying to step up */
  upHoldMs: 30_000,
  upHoldMaxMs: 240_000,
  /** a step down this soon after a step up counts as a flap */
  flapWindowMs: 20_000,
  badLossPct: 8,
  goodLossPct: 2,
  badRttMs: 600,
  goodRttMs: 300,
};
const CEILING = LEVEL_ORDER.indexOf(AUTO_CEILING);
const FLOOR = LEVEL_ORDER.length - 1;

export function initialAuto(now = 0): AutoState {
  return { level: CEILING, bad: 0, good: 0, lastChangeAt: now, lastUpAt: -Infinity, upHoldMs: AUTO_TUNING.upHoldMs, reason: null };
}
export const autoLevel = (s: AutoState): LevelId => LEVEL_ORDER[s.level];

/** Classify one sample against the current level. */
export function judge(sample: StatSample, level: LevelId, t = AUTO_TUNING): { bad: LimitReason | null; good: boolean } {
  const need = LEVELS[level].maxBitrate;
  if (sample.limitation === 'cpu') return { bad: 'cpu', good: false };
  const netBad = sample.limitation === 'bandwidth' || sample.lossPct >= t.badLossPct || sample.rttMs >= t.badRttMs
    || (sample.availBps !== null && sample.availBps < need * 0.6);
  if (netBad) return { bad: 'bandwidth', good: false };
  const up = LEVEL_ORDER[Math.max(0, LEVEL_ORDER.indexOf(level) - 1)];
  const good = sample.limitation === 'none' && sample.lossPct < t.goodLossPct && (sample.rttMs === 0 || sample.rttMs < t.goodRttMs)
    && (sample.availBps === null || sample.availBps >= LEVELS[up].maxBitrate * 1.5);
  return { bad: null, good };
}

/**
 * Feed one sample. Steps down one level after `badToStepDown` bad samples in a row, steps up one level
 * after `goodToStepUp` good samples in a row and at least `upHoldMs` since the last change. A step down
 * shortly after a step up doubles `upHoldMs` (up to `upHoldMaxMs`); a calm step up resets it slowly.
 */
export function autoStep(prev: AutoState, sample: StatSample, now: number, t = AUTO_TUNING): { state: AutoState; change: 'down' | 'up' | null } {
  const s: AutoState = { ...prev };
  const v = judge(sample, LEVEL_ORDER[s.level], t);
  if (v.bad) { s.bad += 1; s.good = 0; } else if (v.good) { s.good += 1; s.bad = 0; } else { s.bad = 0; s.good = 0; }
  const cooled = now - s.lastChangeAt >= t.cooldownMs;
  if (v.bad && s.bad >= t.badToStepDown && cooled && s.level < FLOOR) {
    if (now - s.lastUpAt < t.flapWindowMs) s.upHoldMs = Math.min(t.upHoldMaxMs, s.upHoldMs * 2);
    s.level += 1; s.bad = 0; s.good = 0; s.lastChangeAt = now; s.reason = v.bad;
    return { state: s, change: 'down' };
  }
  if (v.bad && s.level < FLOOR) return { state: s, change: null };
  if (v.bad && s.level === FLOOR) { s.reason = v.bad; return { state: s, change: null }; }
  if (s.level > CEILING && s.good >= t.goodToStepUp && now - s.lastChangeAt >= s.upHoldMs) {
    s.level -= 1; s.good = 0; s.bad = 0; s.lastChangeAt = now; s.lastUpAt = now;
    if (s.level === CEILING) s.reason = null;
    s.upHoldMs = Math.max(t.upHoldMs, Math.round(s.upHoldMs * 0.75));
    return { state: s, change: 'up' };
  }
  return { state: s, change: null };
}

/** Short status for the own-tile indicator (null = nothing to show). */
export function autoNotice(s: AutoState): string | null {
  if (s.level <= CEILING || !s.reason) return null;
  return s.reason === 'cpu' ? 'Lowered quality: device is busy' : 'Lowered quality: weak connection';
}
