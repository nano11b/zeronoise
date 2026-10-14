import { randomUUID } from 'crypto';
import type { TriviaScore, TriviaState } from '../shared/types';
import { TRIVIA_TOP, triviaPoints, type TriviaCategory, type TriviaPick } from '../shared/trivia';
import { TRIVIA_QUESTIONS } from './triviaQuestions';

export interface TriviaPlayer { key: string; name: string; accountId: number | null }
interface LiveQ { text: string; category: TriviaCategory; options: string[]; correct: number }
interface Answer { choice: number; points: number }
interface Score { name: string; points: number; accountId: number | null; guest: boolean; correct: number }

export interface TriviaHooks {
  state: (s: TriviaState) => void;
  progress: (p: { roundId: string; index: number; answered: number; players: number }) => void;
  /** natural end (all questions played) or stop */
  ended: (round: TriviaRound, info: { stopped: boolean; by?: string }) => void;
  /** humans currently able to answer (room members, no bots) */
  players: () => number;
}

function shuffle<T>(a: T[], rnd = Math.random): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Pick `count` questions (by category or mixed) and shuffle each question's options. */
export function pickQuestions(category: TriviaPick, count: number, rnd = Math.random): LiveQ[] {
  const pool = TRIVIA_QUESTIONS.filter((q) => category === 'mixed' || q.category === category);
  return shuffle(pool.slice(), rnd).slice(0, count).map((q) => {
    const order = shuffle([0, 1, 2, 3], rnd);
    return { text: q.text, category: q.category, options: order.map((i) => q.options[i]), correct: order.indexOf(q.answer) };
  });
}

/** One server-run round. All answers are checked here; clients only ever get the correct index at reveal. */
export class TriviaRound {
  readonly id = randomUUID();
  index = -1;
  phase: TriviaState['phase'] = 'question';
  endsAt = 0;
  private answers = new Map<string, Answer>();
  private scores = new Map<string, Score>();
  private timer: NodeJS.Timeout | null = null;
  private lastReveal: TriviaState['reveal'];

  constructor(
    readonly by: string,
    readonly category: TriviaPick,
    private readonly questions: LiveQ[],
    readonly questionMs: number,
    readonly pauseMs: number,
    private readonly hooks: TriviaHooks,
  ) {}

  get total() { return this.questions.length; }
  get active() { return this.phase !== 'ended'; }

  start() { this.next(); }

  private next() {
    this.index++;
    if (this.index >= this.questions.length) { this.finish(false); return; }
    this.phase = 'question';
    this.answers.clear();
    this.lastReveal = undefined;
    this.endsAt = Date.now() + this.questionMs;
    this.arm(this.questionMs, () => this.reveal());
    this.hooks.state(this.publicState());
  }

  private arm(ms: number, fn: () => void) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try { fn(); } catch (err) { console.error('[timer] trivia failed', err); }
    }, ms);
    this.timer.unref?.();
  }

  answer(p: TriviaPlayer, index: number, choice: number): { ok: true } | { ok: false; error: string } {
    if (this.phase !== 'question' || index !== this.index) return { ok: false, error: 'Too late for that question' };
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return { ok: false, error: 'Pick one of the four answers' };
    if (this.answers.has(p.key)) return { ok: false, error: 'You already answered' };
    const q = this.questions[this.index];
    const remaining = Math.max(0, this.endsAt - Date.now());
    // Points are banked now (speed counts from this moment) but only added to the visible scores at reveal.
    this.answers.set(p.key, { choice, points: triviaPoints(choice === q.correct, remaining, this.questionMs) });
    const s = this.scores.get(p.key);
    if (!s) this.scores.set(p.key, { name: p.name, points: 0, accountId: p.accountId, guest: p.accountId == null, correct: 0 });
    else s.name = p.name;
    const players = this.hooks.players();
    this.hooks.progress({ roundId: this.id, index: this.index, answered: this.answers.size, players });
    if (this.answers.size >= players) this.reveal();
    return { ok: true };
  }

  myChoice(key: string): number | null { return this.phase === 'question' || this.phase === 'reveal' ? this.answers.get(key)?.choice ?? null : null; }

  private reveal() {
    if (this.phase !== 'question') return;
    const q = this.questions[this.index];
    const counts = [0, 0, 0, 0];
    for (const [key, a] of this.answers) {
      counts[a.choice]++;
      const s = this.scores.get(key);
      if (s) { s.points += a.points; if (a.choice === q.correct) s.correct++; }
    }
    this.phase = 'reveal';
    this.lastReveal = { correct: q.correct, counts };
    this.endsAt = Date.now() + this.pauseMs;
    this.arm(this.pauseMs, () => this.next());
    this.hooks.state(this.publicState());
  }

  private finish(stopped: boolean, by?: string) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.index = Math.min(this.index, this.questions.length - 1);
    this.endsAt = Date.now();
    this.hooks.ended(this, { stopped, by });
  }
  stop(by?: string) { this.finish(true, by); }

  /** Final (or current) standings, highest first. */
  standings(): Score[] {
    return [...this.scores.values()].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  }

  publicState(): TriviaState {
    const q = this.phase === 'ended' ? null : this.questions[this.index];
    const top: TriviaScore[] = this.standings().slice(0, TRIVIA_TOP).map((s) => ({ name: s.name, points: s.points, ...(s.guest ? { guest: true } : {}) }));
    return {
      roundId: this.id, by: this.by, category: this.category, total: this.questions.length, index: this.index, phase: this.phase,
      question: q ? { text: q.text, options: q.options.slice(), category: q.category } : null,
      endsAt: this.endsAt, serverNow: Date.now(), questionMs: this.questionMs,
      answered: this.phase === 'question' ? this.answers.size : 0, players: this.hooks.players(),
      ...(this.phase === 'reveal' && this.lastReveal ? { reveal: this.lastReveal } : {}),
      scores: top,
    };
  }
}
