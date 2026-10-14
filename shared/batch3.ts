/** Batch 3 shared rules: room categories/tags, announcements, schedules, emotes, radio, stats. */

// ---- 1. categories + tags ----
export const ROOM_CATEGORIES = ['hangout', 'music', 'gaming', 'creative', 'tech', 'talk', 'other'] as const;
export type RoomCategory = typeof ROOM_CATEGORIES[number];
export const CATEGORY_LABEL: Record<RoomCategory, string> = {
  hangout: 'Hangout', music: 'Music', gaming: 'Gaming', creative: 'Creative', tech: 'Tech', talk: 'Talk', other: 'Other',
};
export const CATEGORY_ICON: Record<RoomCategory, string> = {
  hangout: '🛋', music: '🎵', gaming: '🎮', creative: '🎨', tech: '💻', talk: '💬', other: '✨',
};
export const isRoomCategory = (x: unknown): x is RoomCategory => typeof x === 'string' && (ROOM_CATEGORIES as readonly string[]).includes(x);
export const TAGS_MAX = 5;
export const TAG_RE = /^[a-z0-9][a-z0-9-]{0,18}[a-z0-9]$/;
/** "#Lo Fi" -> "lo-fi"; returns '' when nothing usable is left. */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#+/, '').replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}
/** Accepts an array or a comma/space separated string. Format only; the server also word-filters. */
export function cleanTags(input: unknown): { tags: string[] } | { error: string } {
  let parts: string[] = [];
  if (Array.isArray(input)) parts = input.filter((x) => typeof x === 'string') as string[];
  else if (typeof input === 'string') parts = input.split(/[,\s]+/);
  else if (input == null) parts = [];
  else return { error: 'Tags must be a list' };
  if (parts.length > 20) return { error: `At most ${TAGS_MAX} tags` };
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string' || p.length > 40) return { error: 'Tags are 2-20 characters' };
    const t = normalizeTag(p);
    if (!t) continue;
    if (!TAG_RE.test(t)) return { error: 'Tags are 2-20 characters: letters, numbers and dashes' };
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > TAGS_MAX) return { error: `At most ${TAGS_MAX} tags` };
  return { tags: out };
}

// ---- 3. announcements + scheduled messages ----
export const ANNOUNCE_MAX = 300;
export const SCHEDULE_TEXT_MAX = 500;
export const SCHEDULES_PER_ROOM = 20;
export const SCHEDULE_REPEATS = ['once', 'daily', 'weekly'] as const;
export type ScheduleRepeat = typeof SCHEDULE_REPEATS[number];
export const isScheduleRepeat = (x: unknown): x is ScheduleRepeat => typeof x === 'string' && (SCHEDULE_REPEATS as readonly string[]).includes(x);
/** a missed slot is still posted (once) when it is at most this late; otherwise skipped */
export const SCHEDULE_GRACE_MS = 10 * 60_000;
export const SCHEDULE_MAX_AHEAD_MS = 366 * 24 * 3600_000;

// ---- 6. emotes ----
export const EMOTE_NAME_RE = /^[a-z0-9_]{2,24}$/;
export const EMOTES_PER_ROOM = 50;
export const EMOTE_MAX_BYTES = 512 * 1024;
export const EMOTE_SIZE = 128;
export const EMOTE_ID_RE = /^[a-f0-9]{32}$/;
export const emoteUrl = (id: string) => `/api/room-emotes/${id}.webp`;

// ---- 5. stats ----
export const STATS_KEEP_DAYS = 90;
export const HOUR_MS = 3600_000;
export const DAY_MS = 86_400_000;
