/** Simple token bucket: `burst` tokens, refilled continuously over `windowMs`. */
export class RateLimiter {
  private tokens: number;
  last = Date.now();
  constructor(private burst: number, readonly windowMs: number) {
    this.tokens = burst;
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / this.windowMs) * this.burst);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** One token bucket per key (e.g. per IP). Idle buckets are swept so memory stays bounded. */
export class KeyedLimiter {
  private buckets = new Map<string, RateLimiter>();
  constructor(private burst: number, private windowMs: number) {
    setInterval(() => {
      try {
        const cutoff = Date.now() - this.windowMs * 2;
        for (const [k, b] of this.buckets) if (b.last < cutoff) this.buckets.delete(k);
      } catch (err) { console.error('[timer] rate limit sweep failed', err); }
    }, Math.max(30_000, windowMs)).unref();
  }
  take(key: string, n = 1): boolean {
    let b = this.buckets.get(key);
    if (!b) { b = new RateLimiter(this.burst, this.windowMs); this.buckets.set(key, b); }
    return b.take(n);
  }
}
