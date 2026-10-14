import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const DEFAULT_TTL_MS = 60_000;
const MAX_PENDING = 200;

interface Pending { userId: number; exp: number; challenge: string }

/** In-memory, single Node process (the Debian deploy runs one process). Restart drops pending tokens, which is fine: they live 60s. */
const pending = new Map<string, Pending>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sweep(now = Date.now()) {
  for (const [k, v] of pending) if (v.exp <= now) pending.delete(k);
}

/**
 * One-time token that lets the app webview adopt a session created by OAuth in the system browser.
 * `challenge` is base64url(sha256(verifier)). The verifier stays in the app; the custom-scheme
 * redirect only carries the token and the challenge, so another app that sees the URL cannot redeem it.
 * The raw token is returned once; only its hash is kept.
 */
export function issueNativeHandoff(userId: number, challenge: string, ttlMs = DEFAULT_TTL_MS): string {
  if (!Number.isInteger(userId) || userId < 1) throw new Error('invalid user');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(challenge)) throw new Error('invalid challenge');
  const ttl = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS;
  sweep();
  if (pending.size >= MAX_PENDING) {
    let oldestKey = '';
    let oldestExp = Infinity;
    for (const [k, v] of pending) if (v.exp < oldestExp) { oldestKey = k; oldestExp = v.exp; }
    if (oldestKey) pending.delete(oldestKey);
  }
  const token = randomBytes(32).toString('base64url');
  pending.set(hashToken(token), { userId, exp: Date.now() + ttl, challenge });
  return token;
}

/** Returns the user id and forgets the token. Expired, reused, malformed, or wrong-verifier tokens return null. */
export function consumeNativeHandoff(token: unknown, verifier: unknown): number | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  if (typeof verifier !== 'string' || verifier.length < 16 || verifier.length > 200) return null;
  const now = Date.now();
  sweep(now);
  const key = hashToken(token);
  const row = pending.get(key);
  if (!row) return null;
  pending.delete(key);
  if (row.exp <= now) return null;
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  if (challenge.length !== row.challenge.length) return null;
  if (!timingSafeEqual(Buffer.from(challenge), Buffer.from(row.challenge))) return null;
  return row.userId;
}
