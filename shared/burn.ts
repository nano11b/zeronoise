/** Burn-after-reading chat messages: shared limits and pure rules. */
export const BURN_TTLS = [10, 30, 60] as const;
export type BurnTtl = (typeof BURN_TTLS)[number];
export const BURN_DEFAULT_TTL: BurnTtl = 10;
/** Content is wiped this long after sending, whatever happens. */
export const BURN_HARD_MS = 10 * 60_000;
export const BURN_HINT = 'Disappears after viewing. Screenshots are still possible.';

export function isBurnTtl(v: unknown): v is BurnTtl {
  return (BURN_TTLS as readonly number[]).includes(v as number);
}
/** A viewer may (re)load content only within ttl of their first reveal. */
export function burnRevealAllowed(firstAt: number, ttlMs: number, now: number): boolean {
  return now < firstAt + ttlMs;
}
/** True once the hard expiry passed, or every recipient present at send time has burned it (needs at least one). */
export function burnExpired(p: { createdAt: number; hardMs: number; ttlMs: number; recipients: readonly string[]; views: ReadonlyMap<string, number>; now: number }): boolean {
  if (p.now >= p.createdAt + p.hardMs) return true;
  if (!p.recipients.length) return false;
  return p.recipients.every((k) => { const f = p.views.get(k); return f !== undefined && p.now >= f + p.ttlMs; });
}
