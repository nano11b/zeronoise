/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) with RFC 4648 base32 secrets. No dependencies. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of clean) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(randomBytes(20));
export const STEP_MS = 30_000;
export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
export const stepAt = (t = Date.now()) => Math.floor(t / STEP_MS);
/** Returns the matching time step (±1 for clock drift) or null. Callers reject steps <= the last one used (replay). */
export function verifyTotp(secret: string, code: string, t = Date.now()): number | null {
  const c = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepAt(t);
  for (const s of [now - 1, now, now + 1]) {
    const exp = Buffer.from(hotp(secret, s)), got = Buffer.from(c);
    if (timingSafeEqual(exp, got)) return s;
  }
  return null;
}
export function otpauthUrl(secret: string, account: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
/** 10 recovery codes like "k7f3-9qzm" (lowercase base32, ~40 bits each). */
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => { const s = base32Encode(randomBytes(5)).toLowerCase(); return `${s.slice(0, 4)}-${s.slice(4, 8)}`; });
}
export const normalizeRecovery = (c: string) => c.toLowerCase().replace(/[^a-z2-7]/g, '');
