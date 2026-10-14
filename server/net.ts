import type { IncomingMessage } from 'http';
import net from 'net';
import proxyaddr from 'proxy-addr';
import { CORS_ORIGINS, PUBLIC_URL, TRUST_PROXY } from './env';

/** Same semantics as Express 'trust proxy' (true/false, hop count, or comma list like "loopback, uniquelocal"). */
export const trustSetting: boolean | number | string[] =
  TRUST_PROXY === 'true' ? true : TRUST_PROXY === 'false' ? false : /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY)
    : TRUST_PROXY.split(',').map((s) => s.trim()).filter(Boolean);

const trustFn: (addr: string, i: number) => boolean =
  trustSetting === true ? () => true : trustSetting === false ? () => false
    : typeof trustSetting === 'number' ? (_a, i) => i < (trustSetting as number)
      : proxyaddr.compile(trustSetting as string[]);

export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return 'unknown';
  const s = ip.trim();
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

export function fromTrustedProxy(req: IncomingMessage): boolean {
  return trustFn(normalizeIp(req.socket.remoteAddress), 0);
}

/**
 * Real client IP. CF-Connecting-IP (set by Cloudflare / cloudflared) is only believed when the
 * TCP peer is a trusted proxy; otherwise X-Forwarded-For is walked through trusted hops only
 * (proxy-addr), falling back to the socket address.
 */
export function clientIp(req: IncomingMessage): string {
  if (fromTrustedProxy(req)) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && net.isIP(cf.trim())) return normalizeIp(cf);
  }
  try { return normalizeIp(proxyaddr(req as any, trustFn)); } catch { return normalizeIp(req.socket.remoteAddress); }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
  }
  return out;
}

export function isHttps(req: IncomingMessage): boolean {
  if ((req.socket as any).encrypted) return true;
  if (!fromTrustedProxy(req)) return false;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  if (proto) return proto === 'https';
  // Cloudflare tunnel sets CF-Visitor: {"scheme":"https"}
  return /"scheme":"https"/.test(String(req.headers['cf-visitor'] ?? ''));
}

const hostOf = (u: string) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
const staticAllowed = new Set([PUBLIC_URL, ...CORS_ORIGINS].map(hostOf).filter(Boolean));

/**
 * CSRF / cross-site WebSocket hijacking guard: a browser request that carries an Origin must come
 * from our own host (Host / trusted X-Forwarded-Host), PUBLIC_URL or CORS_ORIGIN. Non-browser
 * clients send no Origin and have no ambient cookies to abuse.
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const oh = hostOf(origin);
  if (!oh) return false;
  if (staticAllowed.has(oh)) return true;
  if (oh === String(req.headers.host ?? '').toLowerCase()) return true;
  if (fromTrustedProxy(req)) {
    const fh = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim().toLowerCase();
    if (fh && oh === fh) return true;
  }
  return false;
}

export const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
