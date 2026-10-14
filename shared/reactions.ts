/** Emoji allowed on a chat message. Whitelist only. */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
const SET = new Set<string>(REACTION_EMOJIS);
export function isReactionEmoji(v: unknown): v is ReactionEmoji {
  return typeof v === 'string' && SET.has(v);
}
export interface ReactionCount {
  emoji: string;
  count: number;
  mine: boolean;
}
