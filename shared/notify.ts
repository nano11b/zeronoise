/** Per-room notification level. "mentions" is the default (push only for @mentions and whispers). */
export type NotifyLevel = 'all' | 'mentions' | 'mute';
export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['all', 'mentions', 'mute'];
export const isNotifyLevel = (v: unknown): v is NotifyLevel => typeof v === 'string' && (NOTIFY_LEVELS as readonly string[]).includes(v);
/** Quiet hours for push, minutes after local midnight in `tz`. start === end means off. */
export interface QuietHours { start: number; end: number; tz: string }

/** Minutes after midnight for `ts` in time zone `tz` (falls back to UTC on a bad zone). */
export function minuteOfDay(ts: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts));
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return (h % 24) * 60 + m;
  } catch {
    const d = new Date(ts);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}
/** Inside quiet hours? Handles windows that cross midnight (e.g. 22:00-07:00). */
export function inQuietHours(q: QuietHours | null | undefined, ts: number): boolean {
  if (!q || q.start === q.end) return false;
  const m = minuteOfDay(ts, q.tz);
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end;
}
export function validTz(tz: unknown): string | null {
  if (typeof tz !== 'string' || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}
