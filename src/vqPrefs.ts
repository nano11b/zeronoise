import { APP_NAME } from '../shared/config';
import { DEFAULT_VIDEO_QUALITY, isShareMode, isVideoQuality, type ShareMode, type VideoQuality } from '../shared/videoQuality';

const P = APP_NAME.toLowerCase();
const QKEY = `${P}.videoQuality`;
const SKEY = `${P}.shareMode`;

/** The camera quality preset saved in this browser, or null when never chosen. */
export function storedQuality(): VideoQuality | null {
  try { const v = localStorage.getItem(QKEY); return isVideoQuality(v) ? v : null; } catch { return null; }
}
export const loadQuality = (): VideoQuality => storedQuality() ?? DEFAULT_VIDEO_QUALITY;
export function saveQuality(q: VideoQuality) {
  try { localStorage.setItem(QKEY, q); } catch { /* private mode */ }
}
export function loadShareMode(): ShareMode {
  try { const v = localStorage.getItem(SKEY); return isShareMode(v) ? v : 'detail'; } catch { return 'detail'; }
}
export function saveShareMode(m: ShareMode) {
  try { localStorage.setItem(SKEY, m); } catch { /* private mode */ }
}
