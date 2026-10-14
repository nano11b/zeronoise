/**
 * Web Push for @mentions, private messages and whispers when the recipient has no connected socket.
 * VAPID keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from the environment, else generated once into DATA_DIR/vapid.json (0600).
 * Requests are built by web-push (encryption + VAPID JWT) and sent through the SSRF-guarded client, only to known push services.
 */
import fs from 'fs';
import path from 'path';
import webpush from 'web-push';
import { DATA_DIR, PUBLIC_URL } from './env';
import * as repo2 from './repo2';
import { safeFetch } from './safeFetch';

/** Browser push services. Endpoints anywhere else are refused at subscribe time. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9.-]+\.notify\.windows\.com$/, /^push\.api\.chrome\.google\.com$/,
];
/** Test-only: extra exact "host:port" endpoints (plain http allowed). Never set in production. */
const TEST_ENDPOINTS = new Set((process.env.OUTBOUND_TEST_ALLOW || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));

function loadKeys(): { publicKey: string; privateKey: string } | null {
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (pub && priv) return { publicKey: pub, privateKey: priv };
  const file = path.join(DATA_DIR, 'vapid.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof j.publicKey === 'string' && typeof j.privateKey === 'string') return j;
  } catch { /* create below */ }
  try {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
    fs.chmodSync(file, 0o600);
    return keys;
  } catch (err) {
    // another process may have created it first
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j.publicKey && j.privateKey) return j; } catch { /* fallthrough */ }
    console.error('[push] could not create VAPID keys', (err as Error).message);
    return null;
  }
}
const keys = loadKeys();
const SUBJECT = process.env.VAPID_SUBJECT || (PUBLIC_URL.startsWith('https://') ? PUBLIC_URL : 'mailto:admin@localhost');
export const pushEnabled = !!keys && process.env.PUSH_DISABLED !== '1';
export const vapidPublicKey = keys?.publicKey ?? null;

/** Accept only https endpoints on a known push service (or a test-allowed host). */
export function validEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  const hostPort = `${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
  if (TEST_ENDPOINTS.has(hostPort) && (u.protocol === 'http:' || u.protocol === 'https:')) return u.toString();
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return null;
  return PUSH_HOSTS.some((re) => re.test(u.hostname.toLowerCase())) ? u.toString() : null;
}
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
export function validKeys(raw: unknown): { p256dh: string; auth: string } | null {
  const k = raw as { p256dh?: unknown; auth?: unknown } | null;
  if (!k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return null;
  if (k.p256dh.length < 40 || k.p256dh.length > 200 || k.auth.length < 8 || k.auth.length > 64) return null;
  if (!B64URL.test(k.p256dh) || !B64URL.test(k.auth)) return null;
  return { p256dh: k.p256dh, auth: k.auth };
}

export interface PushPayload { title: string; body: string; url: string; tag?: string }
let sentCount = 0;
export const pushStats = () => ({ sent: sentCount });

/** Fire-and-forget to every subscription of this account. Expired (404/410) subscriptions are deleted. */
export async function pushToUser(userId: number, payload: PushPayload): Promise<void> {
  if (!pushEnabled || !keys) return;
  const subs = repo2.pushSubsFor(userId);
  const data = JSON.stringify({ ...payload, title: payload.title.slice(0, 120), body: payload.body.slice(0, 240) });
  await Promise.all(subs.map(async (s) => {
    if (!validEndpoint(s.endpoint)) { repo2.deletePushSub(s.endpoint); return; }
    try {
      const d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data, {
        vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600, urgency: 'normal', topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.headers)) headers[k] = String(v);
      const r = await safeFetch(d.endpoint, { method: 'POST', headers, body: d.body as Buffer, timeoutMs: 5000, maxBytes: 16 * 1024, maxRedirects: 0 });
      if (r.status === 404 || r.status === 410) repo2.deletePushSub(s.endpoint);
      else if (r.status >= 200 && r.status < 300) { repo2.pushOk(s.id); sentCount++; }
    } catch (err) {
      console.error('[push] send failed', (err as Error).message);
    }
  }));
}
