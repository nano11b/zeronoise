/** Whisper rules shared by server (authoritative) and client (UI hints). */
export const WHISPER_MAX_MEMBERS = 5;
export const WHISPER_MIN_MEMBERS = 2;

/** May `targetId` be added to a whisper that currently has `memberIds`? */
export function whisperAddError(p: {
  memberIds: readonly string[];
  targetId: string;
  targetInRoom: boolean;
}): string | null {
  if (!p.targetId || p.targetId.startsWith('bot:')) return 'Bots cannot whisper';
  if (!p.targetInRoom) return 'They are not in this room';
  if (p.memberIds.includes(p.targetId)) return 'Already in this whisper';
  if (p.memberIds.length >= WHISPER_MAX_MEMBERS) return `A whisper holds at most ${WHISPER_MAX_MEMBERS} people`;
  return null;
}
