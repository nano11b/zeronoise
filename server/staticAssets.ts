/**
 * Client file serving: brotli/gzip for text assets (compressed once, kept in memory per file version),
 * a year-long immutable cache for hashed /assets/*, and no-cache for the HTML shell.
 * Binary files fall through to express.static.
 */
import type { NextFunction, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { createHash } from 'crypto';
import { promisify } from 'util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt', '.xml', '.map']);
const MIN_COMPRESS = 1024;
const MAX_CACHE = 4 * 1024 * 1024;

export const IMMUTABLE = 'public, max-age=31536000, immutable';

type Entry = { key: string; raw: Buffer; etag: string; mtime: Date; br?: Promise<Buffer | null>; gz?: Promise<Buffer | null> };
const cache = new Map<string, Entry>();

function pickEncoding(header: string | undefined): 'br' | 'gzip' | null {
  const h = (header || '').toLowerCase();
  const accepts = (enc: string) => h.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';');
    if (name.trim() !== enc) return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
  if (accepts('br')) return 'br';
  if (accepts('gzip')) return 'gzip';
  return null;
}

function load(file: string, st: fs.Stats): Entry {
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit;
  const raw = fs.readFileSync(file);
  const etag = `"${createHash('sha1').update(raw).digest('base64url').slice(0, 22)}"`;
  const e: Entry = { key, raw, etag, mtime: st.mtime };
  if (raw.length <= MAX_CACHE) cache.set(file, e);
  return e;
}

function compressed(e: Entry, enc: 'br' | 'gzip'): Promise<Buffer | null> {
  if (enc === 'br') {
    e.br ??= brotli(e.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: e.raw.length } }).catch(() => null);
    return e.br;
  }
  e.gz ??= gzip(e.raw, { level: 9 }).catch(() => null);
  return e.gz;
}

/** Cache-Control for one client path. */
export function cacheControlFor(urlPath: string, isProd: boolean): string {
  if (urlPath === '/index.html' || urlPath === '/' || urlPath === '/sw.js') return 'no-cache';
  // PWA: the manifest and the offline page must follow a deploy promptly.
  if (urlPath === '/manifest.webmanifest' || urlPath === '/offline.html') return 'no-cache';
  if (urlPath.startsWith('/assets/')) return isProd ? IMMUTABLE : 'no-cache';
  return isProd ? 'public, max-age=3600' : 'public, max-age=0';
}

/** Send one text file with negotiated compression. Returns false when it is not ours to serve. */
async function sendText(req: Request, res: Response, file: string, cacheControl: string): Promise<boolean> {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const e = load(file, st);
  const enc = e.raw.length >= MIN_COMPRESS ? pickEncoding(req.headers['accept-encoding']) : null;
  const body = enc ? await compressed(e, enc) : e.raw;
  const useEnc = enc && body ? enc : null;
  const out = useEnc ? body! : e.raw;
  const etag = useEnc ? `${e.etag.slice(0, -1)}-${useEnc}"` : e.etag;
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', e.mtime.toUTCString());
  res.type(path.extname(file));
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag)) {
    res.status(304).end();
    return true;
  }
  if (useEnc) res.setHeader('Content-Encoding', useEnc);
  res.setHeader('Content-Length', String(out.length));
  if (req.method === 'HEAD') res.end();
  else res.end(out);
  return true;
}

/** Middleware for text files under clientDir. */
export function clientTextAssets(clientDir: string, isProd: boolean) {
  const root = path.resolve(clientDir);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel: string;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    if (rel.includes('\0')) return next();
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext)) return next();
    const file = path.resolve(root, `.${path.posix.normalize(rel)}`);
    if (!file.startsWith(root + path.sep)) return next();
    sendText(req, res, file, cacheControlFor(rel, isProd)).then((done) => { if (!done) next(); }, next);
  };
}

/** The SPA shell for client routes: compressed, always revalidated so an upgrade is picked up. */
export function sendIndexHtml(clientDir: string) {
  const file = path.join(clientDir, 'index.html');
  return (req: Request, res: Response, next: NextFunction) => {
    sendText(req, res, file, 'no-cache').then((done) => { if (!done) next(); }, next);
  };
}

/** express.static headers for binary files: hashed assets are immutable. */
export function staticHeaders(isProd: boolean) {
  return (res: Response, filePath: string) => {
    if (isProd && filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', IMMUTABLE);
  };
}

/**
 * Large binaries the build precompressed next to the original (<file>.br / <file>.gz, see the
 * precompress-wasm plugin in vite.config.mts): the background segmenter wasm is ~13 MB raw, ~3 MB
 * brotli. Streamed from disk; falls through to express.static when no precompressed copy exists.
 */
const PRECOMPRESSED_EXT: Record<string, string> = { '.wasm': 'application/wasm' };
export function clientPrecompressed(clientDir: string, isProd: boolean) {
  const root = path.resolve(clientDir);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel: string;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    if (rel.includes('\0')) return next();
    const type = PRECOMPRESSED_EXT[path.extname(rel).toLowerCase()];
    if (!type) return next();
    const file = path.resolve(root, `.${path.posix.normalize(rel)}`);
    if (!file.startsWith(root + path.sep)) return next();
    const enc = pickEncoding(req.headers['accept-encoding']);
    const variant = enc === 'br' ? `${file}.br` : enc === 'gzip' ? `${file}.gz` : null;
    let st: fs.Stats;
    try { st = fs.statSync(variant ?? ''); } catch { return next(); }
    if (!st.isFile()) return next();
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}-${enc}"`;
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', cacheControlFor(rel, isProd));
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', st.mtime.toUTCString());
    res.setHeader('Content-Type', type);
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag)) { res.status(304).end(); return; }
    res.setHeader('Content-Encoding', enc!);
    res.setHeader('Content-Length', String(st.size));
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(variant!).on('error', next).pipe(res);
  };
}
