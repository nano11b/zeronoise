/** Scheduled room events: limits, validation, reminder stages and .ics output. */
export const EVENT_TITLE_MAX = 60;
export const EVENT_DESC_MAX = 300;
export const EVENT_MAX_UPCOMING = 10;
export const EVENT_MAX_AHEAD_MS = 90 * 86_400_000;
export const EVENT_DURATION_MAX_MIN = 24 * 60;
export const EVENT_REMIND_LEAD_MS = 15 * 60_000;
/** a "starting" reminder later than this after the start is skipped (e.g. the server was down) */
export const EVENT_START_GRACE_MS = 10 * 60_000;
export const EVENT_KEEP_PAST_MS = 7 * 86_400_000;
export const EVENT_SOON_MS = 24 * 3_600_000;
export const RSVP_STATUSES = ['going', 'maybe', 'no'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];
export const isRsvp = (v: unknown): v is RsvpStatus => (RSVP_STATUSES as readonly unknown[]).includes(v);

export interface EventInput { title: string; description: string; startsAt: number; durationMin: number | null }

/** Validate + normalise. `now` is injectable for tests. */
export function validateEvent(raw: unknown, now: number): { ok: true; value: EventInput } | { ok: false; error: string } {
  const p = (raw ?? {}) as Record<string, unknown>;
  const title = typeof p.title === 'string' ? p.title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (title.length < 1 || title.length > EVENT_TITLE_MAX) return { ok: false, error: `Title must be 1-${EVENT_TITLE_MAX} characters.` };
  const description = typeof p.description === 'string' ? p.description.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim() : '';
  if (description.length > EVENT_DESC_MAX) return { ok: false, error: `Description can be at most ${EVENT_DESC_MAX} characters.` };
  const startsAt = typeof p.startsAt === 'number' ? Math.round(p.startsAt) : NaN;
  if (!Number.isFinite(startsAt)) return { ok: false, error: 'Pick a start date and time.' };
  if (startsAt <= now) return { ok: false, error: 'The start time must be in the future.' };
  if (startsAt > now + EVENT_MAX_AHEAD_MS) return { ok: false, error: 'Events can be at most 90 days ahead.' };
  let durationMin: number | null = null;
  if (p.durationMin !== undefined && p.durationMin !== null && p.durationMin !== '' && p.durationMin !== 0) {
    const d = Number(p.durationMin);
    if (!Number.isInteger(d) || d < 5 || d > EVENT_DURATION_MAX_MIN) return { ok: false, error: 'Duration must be 5 minutes to 24 hours.' };
    durationMin = d;
  }
  return { ok: true, value: { title, description, startsAt, durationMin } };
}

/** End used for "upcoming / ongoing" lists: start + duration (or 1 h). */
export const eventEnd = (e: { startsAt: number; durationMin: number | null }) => e.startsAt + (e.durationMin ?? 60) * 60_000;

/** Which reminder stages are due now. Late stages are 'skip' (mark done, don't send). */
export function reminderStages(e: { startsAt: number; remindedSoon: boolean; remindedStart: boolean }, now: number, leadMs = EVENT_REMIND_LEAD_MS, graceMs = EVENT_START_GRACE_MS): { soon: 'send' | 'skip' | null; start: 'send' | 'skip' | null } {
  let soon: 'send' | 'skip' | null = null, start: 'send' | 'skip' | null = null;
  if (!e.remindedSoon && now >= e.startsAt - leadMs) soon = now < e.startsAt ? 'send' : 'skip';
  if (!e.remindedStart && now >= e.startsAt) start = now - e.startsAt <= graceMs ? 'send' : 'skip';
  return { soon, start };
}

/** "in 2 days", "in 3 hours", "in 5 min", "now", "5 min ago". */
export function relativeTime(ts: number, now: number): string {
  const d = ts - now, a = Math.abs(d);
  const unit = a >= 86_400_000 ? [Math.round(a / 86_400_000), 'day'] as const
    : a >= 3_600_000 ? [Math.round(a / 3_600_000), 'hour'] as const
      : a >= 60_000 ? [Math.round(a / 60_000), 'min'] as const : null;
  if (!unit) return 'now';
  const s = `${unit[0]} ${unit[1]}${unit[1] !== 'min' && unit[0] !== 1 ? 's' : ''}`;
  return d > 0 ? `in ${s}` : `${s} ago`;
}

const icsDate = (ts: number) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Fold to 75 octets per RFC 5545 (approximated by characters, safe for ASCII; multibyte stays under the limit by using 60). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 60) { out.push(rest.slice(0, 60)); rest = ' ' + rest.slice(60); }
  out.push(rest);
  return out.join('\r\n');
}
/** Minimal single-VEVENT calendar. */
export function eventIcs(e: { id: string; title: string; description: string; startsAt: number; durationMin: number | null }, roomName: string, url: string, now = Date.now()): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//zeronoise//CamChat events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.id}@camchat`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(e.startsAt)}`,
    `DTEND:${icsDate(eventEnd(e))}`,
    `SUMMARY:${icsText(e.title)}`,
    `DESCRIPTION:${icsText([e.description, `Room: #${roomName}`, url].filter(Boolean).join('\n'))}`,
    `LOCATION:${icsText(`#${roomName}`)}`,
    `URL:${url}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---- batch MC2: recurring schedules ----
export const EVENT_RECURS = ['daily', 'weekly', 'biweekly', 'monthly'] as const;
export type EventRecur = (typeof EVENT_RECURS)[number];
export const isRecur = (v: unknown): v is EventRecur => (EVENT_RECURS as readonly unknown[]).includes(v);
export const RECUR_LABELS: Record<EventRecur, string> = { daily: 'Every day', weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Every month' };
/** a series may run at most this far past its first start */
export const EVENT_RECUR_MAX_MS = 366 * 86_400_000;
export function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}
function partsIn(ts: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ts))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}
/** UTC ms for a wall-clock time in `tz` (DST-safe: two correction passes). */
function wallToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = partsIn(guess, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    guess += Date.UTC(y, m - 1, d, h, mi) - asUtc;
  }
  return guess;
}
/** Next start after `ts`, keeping the same local wall-clock time in `tz` (so DST does not shift it). Monthly clamps to the month's last day. */
export function nextOccurrence(ts: number, recur: EventRecur, tz = 'UTC', anchorDay?: number): number {
  const p = partsIn(ts, tz);
  if (recur === 'monthly') {
    const want = anchorDay ?? p.d;
    const y = p.m === 12 ? p.y + 1 : p.y; const m = p.m === 12 ? 1 : p.m + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return wallToUtc(y, m, Math.min(want, last), p.h, p.mi, tz);
  }
  const days = recur === 'daily' ? 1 : recur === 'weekly' ? 7 : 14;
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return wallToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), p.h, p.mi, tz);
}
export interface RecurInput { recur: EventRecur | null; recurUntil: number | null; recurTz: string | null }
export function validateRecur(raw: unknown, startsAt: number): { ok: true; value: RecurInput } | { ok: false; error: string } {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (p.recur === undefined || p.recur === null || p.recur === '' || p.recur === 'none') return { ok: true, value: { recur: null, recurUntil: null, recurTz: null } };
  if (!isRecur(p.recur)) return { ok: false, error: 'Unknown repeat option.' };
  const tz = p.recurTz === undefined ? 'UTC' : validTimeZone(p.recurTz);
  if (!tz) return { ok: false, error: 'Unknown time zone.' };
  let until: number | null = null;
  if (p.recurUntil !== undefined && p.recurUntil !== null && p.recurUntil !== '') {
    const u = Number(p.recurUntil);
    if (!Number.isFinite(u) || u <= startsAt) return { ok: false, error: 'The repeat end must be after the first start.' };
    until = Math.round(u);
  }
  const cap = startsAt + EVENT_RECUR_MAX_MS;
  return { ok: true, value: { recur: p.recur, recurUntil: Math.min(until ?? cap, cap), recurTz: tz } };
}
