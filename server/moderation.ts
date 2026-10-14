import { WORDS } from './env';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = WORDS.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${WORDS.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;

/** Masks filtered words: "shit" -> "s***". */
export function maskWords(text: string): string {
  return wordRe ? text.replace(wordRe, (w) => w[0] + '*'.repeat(Math.max(1, [...w].length - 1))) : text;
}
export function hasFilteredWord(text: string): boolean {
  if (!wordRe) return false;
  wordRe.lastIndex = 0;
  const r = wordRe.test(text);
  wordRe.lastIndex = 0;
  return r;
}

const linkRe = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]{0,62}\.(?:com|net|org|io|gg|ru|xyz|me|tv|co|info|biz|link|app|dev|ly|to|cc|site|online|live|top|club|shop)\b(?:\/\S*)?/gi;
export function countLinks(text: string): number {
  return (text.match(linkRe) || []).length;
}
