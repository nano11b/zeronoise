/** Cosmetic activity badges. No permissions attach to any of these. */
export type BadgeStat =
  | 'night_messages' | 'messages' | 'onair_sec' | 'sounds' | 'trivia_wins' | 'trivia_perfect'
  | 'voice_notes' | 'watch_starts' | 'burns' | 'friends' | 'rooms_created';

export interface BadgeDef {
  id: string;
  emoji: string;
  name: string;
  description: string;
  /** counter that earns it; absent = granted another way (Early Bird) */
  stat?: BadgeStat;
  threshold?: number;
  /** how to show progress for this stat */
  unit?: 'minutes';
}

export const BADGES: readonly BadgeDef[] = [
  { id: 'owl', emoji: '🦉', name: 'Night Owl', description: 'Sent 25 messages between 1 and 5 AM', stat: 'night_messages', threshold: 25 },
  { id: 'chatter', emoji: '💬', name: 'Chatterbox', description: 'Sent 500 room messages', stat: 'messages', threshold: 500 },
  { id: 'onair', emoji: '🎙️', name: 'On Air', description: '30 minutes with cam or mic on', stat: 'onair_sec', threshold: 30 * 60, unit: 'minutes' },
  { id: 'menace', emoji: '🔊', name: 'Soundboard Menace', description: 'Played 50 soundboard sounds', stat: 'sounds', threshold: 50 },
  { id: 'brain', emoji: '🧠', name: 'Trivia Brain', description: 'Won 3 trivia rounds', stat: 'trivia_wins', threshold: 3 },
  { id: 'sharp', emoji: '🎯', name: 'Sharpshooter', description: 'Answered every question right in a trivia round', stat: 'trivia_perfect', threshold: 1 },
  { id: 'voicepro', emoji: '🎤', name: 'Voice Note Pro', description: 'Sent 20 voice notes', stat: 'voice_notes', threshold: 20 },
  { id: 'movie', emoji: '🍿', name: 'Movie Night', description: 'Started 5 watch-party videos', stat: 'watch_starts', threshold: 5 },
  { id: 'pyro', emoji: '🔥', name: 'Pyro', description: 'Sent 25 burn messages', stat: 'burns', threshold: 25 },
  { id: 'social', emoji: '🤝', name: 'Social', description: 'Has 10 friends', stat: 'friends', threshold: 10 },
  { id: 'host', emoji: '🏠', name: 'Host', description: 'Created 5 rooms', stat: 'rooms_created', threshold: 5 },
  { id: 'early', emoji: '⭐', name: 'Early Bird', description: 'Had an account before badges arrived' },
];

export const BADGE_SHOW_MAX = 3;
export const BADGE_IDS: ReadonlySet<string> = new Set(BADGES.map((b) => b.id));
export const badgeById = (id: string): BadgeDef | undefined => BADGES.find((b) => b.id === id);
export const BADGE_STATS: readonly BadgeStat[] = [...new Set(BADGES.flatMap((b) => (b.stat ? [b.stat] : [])))];
export const isBadgeStat = (s: string): s is BadgeStat => (BADGE_STATS as readonly string[]).includes(s);

/** Effective threshold. `div` > 1 only in tests (BADGE_THRESHOLD_DIV). */
export function badgeThreshold(b: BadgeDef, div = 1): number {
  return Math.max(1, Math.ceil((b.threshold ?? 1) / Math.max(1, div)));
}

/** Badges whose threshold is crossed going from `before` to `after` on `stat`. */
export function crossedBadges(stat: BadgeStat, before: number, after: number, div = 1): BadgeDef[] {
  return BADGES.filter((b) => b.stat === stat && before < badgeThreshold(b, div) && after >= badgeThreshold(b, div));
}

/** Validate a "show these" pick: known, owned, unique, at most 3. Returns null if invalid. */
export function cleanShownBadges(raw: unknown, owned: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(raw) || raw.length > BADGE_SHOW_MAX) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !BADGE_IDS.has(v) || !owned.has(v) || out.includes(v)) return null;
    out.push(v);
  }
  return out;
}

/** What others see: the explicit pick (still owned) or the 3 most recent. `earned` is newest first. */
export function shownBadges(chosen: string[] | null, earnedNewestFirst: readonly string[]): string[] {
  const owned = new Set(earnedNewestFirst);
  if (chosen) return chosen.filter((id) => owned.has(id)).slice(0, BADGE_SHOW_MAX);
  return earnedNewestFirst.slice(0, BADGE_SHOW_MAX);
}

/** 1–5 AM (hours 1,2,3,4) in the given IANA zone; falls back to server local time. */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
export function hourIn(ts: number, tz?: string | null): number {
  if (!tz) return new Date(ts).getHours();
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
    if (fmtCache.size > 500) fmtCache.clear();
    fmtCache.set(tz, f);
  }
  return Number(f.formatToParts(ts).find((p) => p.type === 'hour')?.value ?? new Date(ts).getHours()) % 24;
}
export const isNightOwlHour = (h: number) => h >= 1 && h < 5;
