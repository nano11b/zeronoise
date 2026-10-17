/**
 * At-rest encryption for small secrets (TOTP seeds): AES-256-GCM with a key from CAMCHAT_SECRET_KEY
 * (in /etc/camchat.env, generated on the server by deploy/secret-key-env.sh). Without the key the
 * server keeps working with plaintext secrets and the admin panel shows a warning.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const raw = (process.env.CAMCHAT_SECRET_KEY || '').trim();
const KEY = raw.length >= 32 ? createHash('sha256').update(`zn-secretbox-v1:${raw}`).digest() : null;
export const secretKeySet = () => !!KEY;
export const secretKeyTooShort = () => raw.length > 0 && raw.length < 32;
/** marker left in the old plaintext column once a secret is encrypted (fails closed on an older build) */
export const SCRUBBED = 'ENCRYPTED';

export function seal(plain: string, aad: string): string {
  if (!KEY) throw new Error('no secret key');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}
export function open(box: string, aad: string): string | null {
  if (!KEY) return null;
  const [v, iv, tag, ct] = box.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url')); d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}
