/**
 * Screen-share audio is sent on its own transceiver tied to a dedicated MediaStream
 * (separate msid from the cam/mic stream). Each description signal carries that stream
 * id so the receiver can tell display audio apart from the microphone.
 *
 * Only Chrome tab audio (`displaySurface: 'browser'`) is kept. Entire-screen
 * "system audio" is every sound on the PC, so we strip it. Window shares never
 * include audio.
 */
export type RemoteTrackRole = 'media' | 'shareAudio';

export function classifyRemoteTrack(
  kind: string,
  streamIds: readonly string[],
  shareStreamId: string | null | undefined,
): RemoteTrackRole {
  if (kind !== 'audio' || !shareStreamId) return 'media';
  return streamIds.includes(shareStreamId) ? 'shareAudio' : 'media';
}

/** Chrome getDisplayMedia displaySurface values we care about. */
export type DisplaySurface = 'browser' | 'window' | 'monitor' | string;

export type ShareAudioDecision = {
  /** Whether to put the display audio track on the mesh. */
  keepAudio: boolean;
  /** Optional sharer-only toast. */
  notice: string | null;
};

export const NO_SHARE_AUDIO_NOTICE =
  'No audio in this share. In Chrome, share that tab and tick Share tab audio.';

export const SYSTEM_AUDIO_STRIPPED_NOTICE =
  'System audio sends everything on your PC. For one app\'s sound, share that Chrome tab and tick Share tab audio.';

export const WINDOW_SHARE_NO_AUDIO_NOTICE =
  'Window shares have no audio. Share a Chrome tab and tick Share tab audio for sound.';

/**
 * Decide whether display audio from getDisplayMedia should be forwarded.
 * `displaySurface` comes from videoTrack.getSettings().displaySurface (or audio).
 */
export function decideShareAudio(
  displaySurface: string | undefined | null,
  hasAudio: boolean,
): ShareAudioDecision {
  const surface = (displaySurface || '').toLowerCase();
  if (surface === 'monitor') {
    if (hasAudio) return { keepAudio: false, notice: SYSTEM_AUDIO_STRIPPED_NOTICE };
    return { keepAudio: false, notice: null };
  }
  if (surface === 'window') {
    return { keepAudio: false, notice: WINDOW_SHARE_NO_AUDIO_NOTICE };
  }
  if (surface === 'browser') {
    if (hasAudio) return { keepAudio: true, notice: null };
    return { keepAudio: false, notice: NO_SHARE_AUDIO_NOTICE };
  }
  // Unknown / missing surface: keep audio only if present (old browsers).
  if (hasAudio) return { keepAudio: true, notice: null };
  return { keepAudio: false, notice: NO_SHARE_AUDIO_NOTICE };
}
