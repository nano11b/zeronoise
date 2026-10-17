/** Room discovery (batch C): browse page sorting + trending score. Private calls and password rooms are never listed. */
export const DISCOVER_SORTS = ['trending', 'members', 'active', 'new'] as const;
export type DiscoverSort = typeof DISCOVER_SORTS[number];
export const isDiscoverSort = (x: unknown): x is DiscoverSort => typeof x === 'string' && (DISCOVER_SORTS as readonly string[]).includes(x);
export interface DiscoverRoom {
  id: string; name: string; topic: string; category: string | null; tags: string[];
  /** online now */
  users: number;
  /** accounts that visited in the last 30 days */
  members: number;
  /** messages in the last 24 h */
  messages24h: number;
  trending: number;
  voice?: boolean;
  thumbUrl?: string; iconUrl?: string;
  createdAt: number;
}
/**
 * Trending: people here now count most, then today's messages, plus growth over yesterday.
 * Diminishing returns on messages so one chatty person cannot top the list.
 */
export function trendingScore(users: number, day: number, prev: number): number {
  const growth = Math.max(0, day - prev);
  return Math.round((users * 10 + Math.sqrt(day) * 4 + Math.sqrt(growth) * 3) * 10) / 10;
}
