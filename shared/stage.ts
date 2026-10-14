/**
 * Stage mode: only speakers publish camera / mic / screen; everyone else is audience (receive only).
 * Pure helpers shared by the server (enforcement) and the client (UI).
 */

export interface StageHand { id: string; nick: string; at: number }
export interface StageState {
  on: boolean;
  /** most speakers at once (each speaker sends to every viewer in the mesh) */
  cap: number;
  /** socket ids of members who may publish now (owner / staff / room mods / invited) */
  speakers: string[];
  /** raised hands, oldest first */
  hands: StageHand[];
}

export const STAGE_CAP_MIN = 2;
export const STAGE_CAP_MAX = 8;
export const STAGE_CAP_DEFAULT = 6;
export const STAGE_CAP_CHOICES = [2, 3, 4, 5, 6, 7, 8];

export function clampStageCap(v: unknown, fallback = STAGE_CAP_DEFAULT): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(STAGE_CAP_MAX, Math.max(STAGE_CAP_MIN, n));
}

export const STAGE_OFF: StageState = { on: false, cap: STAGE_CAP_DEFAULT, speakers: [], hands: [] };

/**
 * True when an SDP offers to SEND media: any audio / video m-section that is not rejected and whose
 * direction is sendonly or sendrecv. A section without its own direction takes the session-level one,
 * and with none at all defaults to sendrecv (RFC 8866), so it counts as sending. Receive-only,
 * inactive and rejected (port 0, not bundle-only) sections are fine; data channels are ignored.
 */
export function sdpPublishes(sdp: unknown): boolean {
  if (typeof sdp !== 'string' || !sdp) return false;
  const parts = sdp.split(/\r?\n(?=m=)/);
  const dirRe = /^a=(sendonly|sendrecv|recvonly|inactive)\s*$/m;
  const sessionDir = parts[0].startsWith('m=') ? undefined : dirRe.exec(parts[0])?.[1];
  for (const sec of parts) {
    if (!sec.startsWith('m=')) continue;
    const [media, port] = sec.slice(2).split(' ');
    if (media !== 'audio' && media !== 'video') continue;
    if (port === '0' && !/^a=bundle-only\s*$/m.test(sec)) continue;
    const dir = dirRe.exec(sec)?.[1] ?? sessionDir ?? 'sendrecv';
    if (dir === 'sendonly' || dir === 'sendrecv') return true;
  }
  return false;
}
