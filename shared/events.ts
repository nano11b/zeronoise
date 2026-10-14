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
