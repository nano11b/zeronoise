/** Polls: limits and validation shared by server and client. */
export const POLL_QUESTION_MAX = 140;
export const POLL_OPTION_MAX = 60;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 6;
/** Optional auto-close, in minutes. 0 / null = open until closed by hand. */
export const POLL_DURATIONS_MIN = [0, 5, 15, 60, 240, 1440] as const;
export const POLL_MAX_DURATION_MIN = 7 * 1440;

export interface PollInput { question: string; options: string[]; durationMin: number | null }

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max + 1) : '');

export function validatePoll(raw: unknown): { ok: true; value: PollInput } | { ok: false; error: string } {
  const p = (raw ?? {}) as Record<string, unknown>;
  const question = clean(p.question, POLL_QUESTION_MAX);
  if (!question || question.length > POLL_QUESTION_MAX) return { ok: false, error: `Question must be 1-${POLL_QUESTION_MAX} characters.` };
  if (!Array.isArray(p.options)) return { ok: false, error: `Add ${POLL_MIN_OPTIONS}-${POLL_MAX_OPTIONS} options.` };
  const options = p.options.map((o) => clean(o, POLL_OPTION_MAX)).filter(Boolean);
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) return { ok: false, error: `Add ${POLL_MIN_OPTIONS}-${POLL_MAX_OPTIONS} options.` };
  if (options.some((o) => o.length > POLL_OPTION_MAX)) return { ok: false, error: `Options can be at most ${POLL_OPTION_MAX} characters.` };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { ok: false, error: 'Options must be different.' };
  let durationMin: number | null = null;
  if (p.durationMin !== undefined && p.durationMin !== null && p.durationMin !== 0) {
    const d = Number(p.durationMin);
    if (!Number.isInteger(d) || d < 1 || d > POLL_MAX_DURATION_MIN) return { ok: false, error: 'Duration must be 1 minute to 7 days.' };
    durationMin = d;
  }
  return { ok: true, value: { question, options, durationMin } };
}

/** "/poll Question? | Yes | No" -> parts, or null when the text is not a poll command. */
export function parsePollCommand(text: string): { question: string; options: string[] } | null {
  const m = /^\/poll(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const parts = (m[1] ?? '').split('|').map((x) => x.trim());
  return { question: parts[0] ?? '', options: parts.slice(1).filter(Boolean) };
}

/** Chat fallback line stored as the message text (shown by clients that do not render polls). */
export const pollFallbackText = (question: string) => `📊 Poll: ${question}`;
