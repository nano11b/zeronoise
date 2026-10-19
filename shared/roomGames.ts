/** batch MC2: multiplayer room games (shared rules; the server enforces). Trivia lives in shared/trivia.ts. */
export type RoomGameKind = 'ttt' | 'chain';
export const ROOM_GAME_LABELS: Record<RoomGameKind | 'trivia', string> = { ttt: 'Tic-tac-toe', chain: 'Word chain', trivia: 'Trivia' };
export const TTT_IDLE_MS = 120_000;
export const CHAIN_TURN_MS = 30_000;
export const CHAIN_MAX_WORDS = 40;
export const CHAIN_WORD_RE = /^[a-z]{3,20}$/;
export const GAME_BOARD_TOP = 10;

export type TttCell = 'X' | 'O' | null;
export interface TttPublic { id: string; x: string; o: string | null; cells: TttCell[]; turn: 'X' | 'O'; winner: 'X' | 'O' | 'draw' | null; line: number[] | null; endedBy?: string; updatedAt: number }
export interface ChainWord { word: string; by: string; points: number }
export interface ChainPublic { id: string; by: string; words: ChainWord[]; next: string | null; deadline: number; scores: { name: string; points: number }[]; ended: boolean; endedBy?: string; serverNow: number }
export interface GameBoardRow { name: string; points: number; wins: number; played: number }
export interface RoomGamesState { ttt: TttPublic | null; chain: ChainPublic | null }

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
export function tttOutcome(cells: TttCell[]): { winner: 'X' | 'O' | 'draw' | null; line: number[] | null } {
  for (const l of LINES) { const c = cells[l[0]]; if (c && c === cells[l[1]] && c === cells[l[2]]) return { winner: c, line: l }; }
  return { winner: cells.every(Boolean) ? 'draw' : null, line: null };
}
/** Points for a word-chain word: one per letter beyond two. */
export const chainPoints = (w: string) => Math.max(1, w.length - 2);
/** Why a word is not playable, or null when it is. */
export function chainProblem(word: string, words: readonly ChainWord[], by: string): string | null {
  if (!CHAIN_WORD_RE.test(word)) return 'Words are 3–20 letters a–z';
  const last = words[words.length - 1];
  if (last && last.by.toLowerCase() === by.toLowerCase()) return 'Wait for someone else to play a word';
  if (last && word[0] !== last.word[last.word.length - 1]) return `The word must start with "${last.word[last.word.length - 1]}"`;
  if (words.some((w) => w.word === word)) return 'That word was already played';
  return null;
}
