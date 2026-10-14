/** Smarter lobby: friends online now, active rooms, jump back in. */

export const LOBBY = {
  /** rows shown in "Jump back in" */
  recentShown: 8,
  /** rows kept per account */
  recentKept: 20,
  /** messages in the last 10 minutes count toward a room's activity */
  activityWindowMs: 10 * 60_000,
  /** rooms at or above this score get the 🔥 active tag */
  activeMin: 5,
  /** server-side recompute interval (production); scores never change more often than this */
  activityTickMs: 10_000,
  /** block list entries synced to the server */
  blocksMax: 500,
} as const;

/** A friend who is online right now, as one viewer may see them. */
export interface FriendOnline {
  userId: number;
  username: string;
  hasAvatar?: boolean;
  chatColor?: string | null;
  chatEffect?: string | null;
  /** socket id, for a private message */
  socketId?: string;
  /** only when the room is public, has no password, and the friend shows their room */
  room?: { id: string; name: string } | null;
}

export interface RecentRoom {
  id: string;
  name: string;
  topic: string;
  thumbUrl?: string;
  iconUrl?: string;
  users: number;
  passwordRequired: boolean;
  visitedAt: number;
  /** messages from others since the last visit (capped at 99) */
  unread: number;
  /** messages since the last visit that @mention you */
  mentions: number;
}

/** Activity score: people in the room + messages in the last 10 minutes + cams/mics/shares live. */
export function activityScore(people: number, recentMessages: number, live: number): number {
  return people + recentMessages + live;
}
