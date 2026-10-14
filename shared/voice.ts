/** Push-to-talk voice notes: shared limits and format sniffing (server validates, client picks a recorder type). */
export const VOICE_MAX_MS = 60_000;
export const VOICE_MIN_MS = 500;
export const VOICE_MAX_BYTES = 1024 * 1024;

export type VoiceKind = 'webm' | 'ogg' | 'mp4';
export const VOICE_MIME: Record<VoiceKind, string> = { webm: 'audio/webm', ogg: 'audio/ogg', mp4: 'audio/mp4' };
export const VOICE_EXT: Record<VoiceKind, string> = { webm: 'webm', ogg: 'ogg', mp4: 'm4a' };

/** Identify a recorded clip by its magic bytes, never by the declared type. */
export function sniffVoice(buf: Uint8Array): VoiceKind | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  // WebM: EBML header with the "webm" DocType near the start
  if (buf.length >= 16 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return ascii(4, Math.min(buf.length, 64)).includes('webm') ? 'webm' : null;
  }
  if (buf.length >= 28 && ascii(0, 4) === 'OggS') return 'ogg';
  // ISO-BMFF (MP4 / M4A, Safari's MediaRecorder): size + "ftyp" + brand
  if (buf.length >= 12 && ascii(4, 8) === 'ftyp') return 'mp4';
  return null;
}

/** MediaRecorder types in preference order. */
export const VOICE_RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];
export function pickVoiceMime(isTypeSupported: (t: string) => boolean): string | null {
  for (const t of VOICE_RECORDER_TYPES) { try { if (isTypeSupported(t)) return t; } catch { /* keep looking */ } }
  return null;
}

/** "0:07", "1:00" */
export function fmtVoiceDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
