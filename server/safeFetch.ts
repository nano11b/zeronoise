/**
 * Outbound HTTP with strict SSRF protection (link previews, web push).
 * - only http/https, no credentials in the URL, default or explicit ports only for http(s)
 * - DNS is resolved here; every address must be public (private, loopback, link-local, CGNAT, metadata,
 *   multicast, reserved, IPv4-mapped/NAT64 forms of those, ULA, documentation ranges are all refused)
 * - the socket connects to the address that was checked (no second lookup, so no DNS rebinding)
 * - redirects are followed by hand (max 3), each hop re-checked; total timeout; body size cap
 */
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';

/** Test-only escape hatch: exact "host:port" pairs allowed even though they resolve to loopback. Never set in production. */
const TEST_ALLOW = new Set((process.env.OUTBOUND_TEST_ALLOW || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));

/** True for an exact test-allowed host:port (tests only; empty in production). */
export function isTestAllowed(u: URL): boolean {
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  return TEST_ALLOW.has(`${u.hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${port}`);
}

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
];
function blockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}
/** Expand an IPv6 literal to 8 16-bit groups. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  // trailing dotted IPv4
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const n = v4ToInt(dotted[1]);
    s = s.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8) return null;
  const nums = all.map((g) => parseInt(g, 16));
  return nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : nums;
}
function blockedV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return blockedV4(embedded()); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::a.b.c.d (deprecated compat)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedV4(embedded()); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF protocol assignments (Teredo, ORCHID, ...)
  if (g[0] === 0x2002) return blockedV4(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64 discard
  if ((g[0] & 0xe000) !== 0x2000) return true; // only global unicast 2000::/3
  return false;
}
/** True when this address must never be contacted. Non-IP strings count as blocked. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return blockedV4(ip);
  if (net.isIPv6(ip)) return blockedV6(ip);
  return true;
}

export class FetchError extends Error {
  constructor(message: string, public code: string) { super(message); }
}

/** Validate a URL string for outbound use. Returns the parsed URL or throws FetchError. */
export function checkOutboundUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchError('Bad URL', 'bad_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('Only http and https', 'bad_scheme');
  if (u.username || u.password) throw new FetchError('Credentials in URL', 'bad_url');
  if (!u.hostname) throw new FetchError('Bad URL', 'bad_url');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const testOk = TEST_ALLOW.has(`${u.hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${port}`);
  if (!testOk && port !== 80 && port !== 443) throw new FetchError('Port not allowed', 'bad_port');
  return u;
}

/** Resolve and pick one public address (or the test-allowed literal). */
async function resolveSafe(u: URL): Promise<{ address: string; family: 4 | 6 }> {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const testOk = TEST_ALLOW.has(`${host.toLowerCase()}:${port}`);
  if (net.isIP(host)) {
    if (!testOk && isBlockedAddress(host)) throw new FetchError('Address not allowed', 'blocked');
    return { address: host, family: net.isIPv6(host) ? 6 : 4 };
  }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host) && !testOk) throw new FetchError('Host not allowed', 'blocked');
  let addrs: dns.LookupAddress[];
  try { addrs = await dns.promises.lookup(host, { all: true, verbatim: true }); }
  catch { throw new FetchError('DNS lookup failed', 'dns'); }
  if (!addrs.length) throw new FetchError('DNS lookup failed', 'dns');
  // every answer must be public: a mixed answer is a rebinding / split-horizon trick
  if (!testOk && addrs.some((a) => isBlockedAddress(a.address))) throw new FetchError('Address not allowed', 'blocked');
  const pick = addrs.find((a) => a.family === 4) ?? addrs[0];
  return { address: pick.address, family: pick.family === 6 ? 6 : 4 };
}

export interface SafeResponse { status: number; url: string; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }
export interface SafeFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** total time budget across redirects (ms) */
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** checked on the final response before reading the body; throw FetchError to reject */
  accept?: (status: number, headers: http.IncomingHttpHeaders) => void;
  /** read past maxBytes? false = stop reading and mark truncated (HTML head is enough) */
  failOnOversize?: boolean;
}

function once(u: URL, target: { address: string; family: 4 | 6 }, opts: SafeFetchOptions, deadline: number, maxBytes: number): Promise<SafeResponse & { location?: string }> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const remaining = Math.max(1, deadline - Date.now());
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: `${u.pathname}${u.search}`,
      method: opts.method ?? 'GET',
      headers: { 'user-agent': 'zeronoise-linkpreview/1.0 (+https://zeronoise)', accept: '*/*', ...opts.headers },
      // pin the checked address: no second DNS lookup between check and connect
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
        if (o && o.all) cb(null, [{ address: target.address, family: target.family }]);
        else cb(null, target.address, target.family);
      }) as unknown as typeof dns.lookup,
      servername: net.isIP(u.hostname.replace(/^\[|\]$/g, '')) ? undefined : u.hostname,
      timeout: remaining,
      agent: false,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ status, url: u.toString(), headers: res.headers, body: Buffer.alloc(0), truncated: false, location: String(res.headers.location) });
        return;
      }
      try { opts.accept?.(status, res.headers); } catch (err) { res.destroy(); reject(err); return; }
      const declared = Number(res.headers['content-length']);
      if (opts.failOnOversize && Number.isFinite(declared) && declared > maxBytes) { res.destroy(); reject(new FetchError('Too large', 'too_large')); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (truncated: boolean) => {
        if (done) return;
        done = true;
        resolve({ status, url: u.toString(), headers: res.headers, body: Buffer.concat(chunks).subarray(0, maxBytes), truncated });
      };
      res.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        chunks.push(c);
        if (size > maxBytes) {
          if (opts.failOnOversize) { done = true; res.destroy(); reject(new FetchError('Too large', 'too_large')); return; }
          finish(true);
          res.destroy();
        }
      });
      res.on('end', () => finish(false));
      res.on('error', (e) => { if (!done) { done = true; reject(new FetchError(e.message, 'network')); } });
    });
    const timer = setTimeout(() => req.destroy(new FetchError('Timed out', 'timeout')), remaining);
    timer.unref?.();
    req.on('timeout', () => req.destroy(new FetchError('Timed out', 'timeout')));
    req.on('error', (e) => { clearTimeout(timer); reject(e instanceof FetchError ? e : new FetchError(e.message, 'network')); });
    req.on('close', () => clearTimeout(timer));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  let url = checkOutboundUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    if (Date.now() >= deadline) throw new FetchError('Timed out', 'timeout');
    const target = await resolveSafe(url);
    const r = await once(url, target, opts, deadline, maxBytes);
    if (!r.location) return r;
    if (hop >= maxRedirects) throw new FetchError('Too many redirects', 'redirects');
    let next: URL;
    try { next = new URL(r.location, url); } catch { throw new FetchError('Bad redirect', 'bad_url'); }
    url = checkOutboundUrl(next.toString());
    if (opts.method === 'POST') throw new FetchError('Redirect on POST', 'redirects');
  }
}
