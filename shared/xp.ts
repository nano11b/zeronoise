/**
 * XP and levels (batch D). Activity based and spam resistant: XP only for real chat lines from signed-in accounts,
 * at most once per cooldown (longer in slow-mode rooms), never for a repeat of your last line, never when you are
 * alone in the room, and capped per day.
 */
export const XP_PER_MESSAGE = 5;
export const XP_COOLDOWN_MS = 30_000;
export const XP_DAILY_CAP = 300;
export const XP_MIN_CHARS = 4;
/** total XP needed to reach a level: L1 0, L2 50, L3 150, L4 300, L5 500 ... */
export const xpForLevel = (level: number) => 25 * level * (level - 1);
export function levelFor(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  return Math.floor((1 + Math.sqrt(1 + (4 * xp) / 25)) / 2);
}
export function levelProgress(xp: number): { level: number; into: number; span: number; next: number } {
  const level = levelFor(xp);
  const base = xpForLevel(level), next = xpForLevel(level + 1);
  return { level, into: xp - base, span: next - base, next };
}
/** duplicate check key: case, spacing, punctuation and repeated letters do not make a line "new" */
export function dupKey(text: string): string {
  return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').replace(/(.)\1{2,}/gu, '$1$1').slice(0, 200);
}
