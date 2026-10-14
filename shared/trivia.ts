/** Room trivia: shared rules (server enforces; client displays). */
export const TRIVIA_CATEGORIES = ['science', 'geography', 'history', 'music', 'games', 'movies', 'food', 'sports', 'tech'] as const;
export type TriviaCategory = (typeof TRIVIA_CATEGORIES)[number];
export type TriviaPick = TriviaCategory | 'mixed';
export const TRIVIA_COUNTS = [5, 10, 15] as const;
export const TRIVIA_DEFAULT_COUNT = 10;
export const TRIVIA_QUESTION_MS = 15_000;
export const TRIVIA_PAUSE_MS = 4_000;
export const TRIVIA_BASE_POINTS = 100;
export const TRIVIA_MAX_BONUS = 50;
export const TRIVIA_TOP = 10;

export const TRIVIA_LABELS: Record<TriviaPick, string> = {
  mixed: 'Mixed', science: 'Science', geography: 'Geography', history: 'History', music: 'Music',
  games: 'Games', movies: 'Movies', food: 'Food', sports: 'Sports', tech: 'Tech',
};

export function isTriviaPick(v: unknown): v is TriviaPick {
  return v === 'mixed' || (TRIVIA_CATEGORIES as readonly string[]).includes(v as string);
}
export function isTriviaCount(v: unknown): v is (typeof TRIVIA_COUNTS)[number] {
  return (TRIVIA_COUNTS as readonly number[]).includes(v as number);
}

/** 100 for a correct answer plus up to 50 for speed, linear in the time left. Wrong or late answers score 0. */
export function triviaPoints(correct: boolean, remainingMs: number, questionMs = TRIVIA_QUESTION_MS): number {
  if (!correct) return 0;
  const frac = Math.max(0, Math.min(1, remainingMs / questionMs));
  return TRIVIA_BASE_POINTS + Math.round(TRIVIA_MAX_BONUS * frac);
}

/** Bots (socket ids "bot:<n>") never play. */
export function canPlayTrivia(socketId: string): boolean {
  return !!socketId && !socketId.startsWith('bot:');
}
