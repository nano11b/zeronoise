import { createHash } from 'crypto';
import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { BRAND_NAME, TAGLINE } from '../shared/config';
import { DATA_DIR, PUBLIC_URL } from './env';

/** Public files live here so an upgrade that replaces /opt/camchat does not delete them. */
export const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

export type DeviceKind = 'windows' | 'android' | 'ios' | 'other';

interface CatalogEntry {
  version: string;
  file?: string;
  contentType?: string;
  notes?: string;
  minVersion?: string;
  portableFile?: string;
  portableContentType?: string;
  comingSoon?: boolean;
  storeUrl?: string;
}

interface Catalog {
  windows: CatalogEntry;
  android: CatalogEntry;
  ios: CatalogEntry;
}

interface Offer {
  id: Exclude<DeviceKind, 'other'>;
  title: string;
  blurb: string;
  version: string;
  file?: string;
  contentType?: string;
  portableFile?: string;
  portableContentType?: string;
  comingSoon?: boolean;
  notes: string;
  minVersion: string | null;
  steps: string[];
}

const PAGE: Record<Offer['id'], { title: string; blurb: string; steps: string[] }> = {
  windows: {
    title: 'Windows',
    blurb: 'For Windows 10 or later. The installer updates itself after this version.',
    steps: [
      'Download the installer and open it.',
      'If Windows says it protected your PC, choose More info, then Run anyway. The app is not signed yet, so that warning is expected.',
      'If you use the older zip, install this once and you can delete that folder. The zip cannot update itself.',
      'After this install, zeronoise downloads newer versions and asks you to restart.',
    ],
  },
  android: {
    title: 'Android',
    blurb: 'For phones and tablets.',
    steps: [
      'If zeronoise 1.1.0 or newer is already installed, download this file and open it. Android will offer to update.',
      'After that, the app tells you when a newer version is ready. You confirm the install on the next screen.',
      'If your phone asks, allow installs from this browser. That setting is sometimes called unknown sources.',
      'If Android says the signature does not match, uninstall zeronoise and install this file.',
    ],
  },
  ios: {
    title: 'iPhone and iPad',
    blurb: 'App Store release.',
    steps: ['The iPhone and iPad app is not ready for download yet. Safari on this site works today.'],
  },
};

function bundledCatalogPath(): string {
  return path.join(__dirname, '../../../downloads/releases.json');
}

export function loadReleaseCatalog(): Catalog {
  const inData = path.join(DOWNLOADS_DIR, 'releases.json');
  const file = fs.existsSync(inData) ? inData : bundledCatalogPath();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog;
  for (const id of ['windows', 'android', 'ios'] as const) {
    if (!raw[id] || typeof raw[id].version !== 'string') throw new Error(`releases.json is missing ${id}.version`);
  }
  return raw;
}

function offersFrom(catalog: Catalog): Offer[] {
  return (['windows', 'android', 'ios'] as const).map((id) => {
    const row = catalog[id];
    const page = PAGE[id];
    return {
      id,
      title: page.title,
      blurb: page.blurb,
      version: row.version,
      file: row.comingSoon ? undefined : row.file,
      contentType: row.contentType,
      portableFile: row.portableFile,
      portableContentType: row.portableContentType,
      comingSoon: !!row.comingSoon,
      notes: row.notes || '',
      minVersion: row.minVersion || null,
      steps: page.steps,
    };
  });
}

const hashCache = new Map<string, { mtimeMs: number; size: number; sha256: string; sha512: string }>();

export function detectDevice(ua: string, chPlatform = ''): DeviceKind {
  const ch = chPlatform.replace(/"/g, '');
  const s = `${ua} ${ch}`;
  if (/iPad|iPhone|iPod/.test(ua) || /\biOS\b/i.test(ch)) return 'ios';
  if (/Android/i.test(s)) return 'android';
  if (/Windows/i.test(s)) return 'windows';
  return 'other';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  }
  const mb = n / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

interface ReadyFile { abs: string; size: number; sha256: string; sha512: string }

async function readyFile(name: string): Promise<ReadyFile | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const abs = path.join(DOWNLOADS_DIR, name);
  let st: fs.Stats;
  try { st = await fs.promises.stat(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = hashCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { abs, size: st.size, sha256: hit.sha256, sha512: hit.sha512 };
  const sums = await new Promise<{ sha256: string; sha512: string }>((resolve, reject) => {
    const sha256 = createHash('sha256');
    const sha512 = createHash('sha512');
    const stream = fs.createReadStream(abs);
    stream.on('data', (chunk) => { sha256.update(chunk); sha512.update(chunk); });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }));
  });
  hashCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, sha256: sums.sha256, sha512: sums.sha512 });
  return { abs, size: st.size, sha256: sums.sha256, sha512: sums.sha512 };
}

function offerByFile(offers: Offer[], name: string): Offer | undefined {
  return offers.find((o) => !o.comingSoon && (o.file === name || o.portableFile === name));
}

function contentTypeFor(offer: Offer, name: string): string | undefined {
  if (offer.file === name) return offer.contentType;
  if (offer.portableFile === name) return offer.portableContentType;
  return undefined;
}

export async function renderDownloadPage(device: DeviceKind): Promise<string> {
  const rank: DeviceKind[] = ['windows', 'android', 'ios'];
  const offers = offersFrom(loadReleaseCatalog()).sort((a, b) => {
    if (a.id === device) return -1;
    if (b.id === device) return 1;
    return rank.indexOf(a.id) - rank.indexOf(b.id);
  });
  const cards = await Promise.all(offers.map(async (offer) => {
    const you = offer.id === device;
    const file = offer.file && !offer.comingSoon ? await readyFile(offer.file) : null;
    const portable = offer.portableFile ? await readyFile(offer.portableFile) : null;
    const available = !!file && !!offer.file;
    const steps = available || offer.comingSoon
      ? `<ol>${offer.steps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>`
      : '';
    const action = offer.comingSoon
      ? '<button class="btn" type="button" disabled>Coming soon</button>'
      : available
        ? `<a class="btn" href="/download/${esc(offer.file!)}" download>Download for ${esc(offer.title)}</a>`
        : '<p class="waiting">Not on this server yet.</p>';
    const meta = offer.comingSoon
      ? '<p class="meta">Coming soon</p>'
      : available
        ? `<p class="meta">Version ${esc(offer.version)} · ${esc(formatBytes(file!.size))}</p>`
        : `<p class="meta">Version ${esc(offer.version)}</p>`;
    const portableLink = portable && offer.portableFile
      ? `<a class="alt" href="/download/${esc(offer.portableFile)}">Portable zip, ${esc(formatBytes(portable.size))}. This zip does not update itself.</a>`
      : '';
    const hash = file ? `<p class="hash">sha256 <code>${esc(file.sha256)}</code></p>` : '';
    return `<article data-os="${offer.id}" class="card${you ? ' you' : ''}">
      <div class="card-top"><h2>${esc(offer.title)}</h2>${you ? '<span class="pill">Your device</span>' : ''}</div>
      <p class="blurb">${esc(offer.blurb)}</p>
      ${meta}
      ${action}
      ${steps}
      ${portableLink}
      ${hash}
    </article>`;
  }));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Get the app · ${esc(BRAND_NAME)}</title>
  <meta name="description" content="Download ${esc(BRAND_NAME)} for Windows and Android. ${esc(TAGLINE)}">
  <meta name="theme-color" content="#030605">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.png" type="image/png" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      background: radial-gradient(900px 480px at 50% -10%, rgb(57 255 20 / .06), transparent 55%), #030605;
      color: #c8ffc8;
      font: 15px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    }
    a { color: #39ff14; }
    .page { width: min(980px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 64px; }
    .mark { height: 112px; width: auto; display: block; }
    h1 { margin: 18px 0 6px; font-size: 28px; font-weight: 650; letter-spacing: 0; }
    .lead { margin: 0 0 28px; color: #8fdb9a; max-width: 40em; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; align-items: stretch; }
    .card {
      background: rgb(5 14 9 / .92); border: 1px solid #1f6b38; border-radius: 4px;
      padding: 18px; display: flex; flex-direction: column; gap: 10px;
      box-shadow: 0 0 24px rgb(57 255 20 / .05);
    }
    .card.you { border-color: #39ff14; box-shadow: 0 0 24px rgb(57 255 20 / .16); }
    .card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h2 { margin: 0; font-size: 18px; }
    .pill { font-size: 11px; border: 1px solid #39ff14; color: #e7ffe7; border-radius: 999px; padding: 1px 8px; }
    .blurb, .meta { margin: 0; color: #8fdb9a; }
    .meta { font-size: 13px; }
    .btn {
      display: inline-flex; justify-content: center; align-items: center; text-align: center; text-decoration: none;
      border: 1px solid #39ff14; background: #123321; color: #e7ffe7; font-weight: 650;
      border-radius: 10px; padding: 12px 14px; cursor: pointer;
      text-shadow: 0 0 8px rgb(57 255 20 / .35);
    }
    .btn:hover { color: #f3fff3; }
    .btn:disabled, .waiting { opacity: .7; cursor: default; }
    .waiting { margin: 0; color: #8fdb9a; }
    ol { margin: 4px 0 0; padding-left: 1.2em; color: #c8ffc8; }
    li { margin: 0 0 8px; }
    .alt { color: #8fdb9a; font-size: 13px; }
    .hash { margin: auto 0 0; color: #8fdb9a; font-size: 11px; word-break: break-all; }
    code { color: #c8ffc8; }
    .back { margin: 28px 0 0; }
    @media (max-width: 800px) {
      .page { padding-top: 28px; }
      .cards { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body data-device="${device}">
  <main class="page">
    <img class="mark" src="/logo-lockup.png" alt="${esc(BRAND_NAME)}">
    <h1>Get the app</h1>
    <p class="lead">${esc(TAGLINE)} These apps open the same rooms as the website.</p>
    <div class="cards">
      ${cards.join('\n')}
    </div>
    <p class="back"><a href="/">Open ${esc(BRAND_NAME)} in the browser</a></p>
  </main>
  <script>
    (function () {
      var ua = navigator.userAgent || '';
      var os = '';
      var touchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
      if (/iPad|iPhone|iPod/.test(ua) || touchMac) os = 'ios';
      else if (/Android/i.test(ua)) os = 'android';
      else if (/Windows/i.test(ua)) os = 'windows';
      if (!os) return;
      document.body.setAttribute('data-device', os);
      document.querySelectorAll('[data-os]').forEach(function (el) {
        var you = el.getAttribute('data-os') === os;
        el.classList.toggle('you', you);
        var top = el.querySelector('.card-top');
        var pill = top && top.querySelector('.pill');
        if (you && !pill && top) {
          pill = document.createElement('span');
          pill.className = 'pill';
          pill.textContent = 'Your device';
          top.appendChild(pill);
        } else if (!you && pill) {
          pill.remove();
        }
      });
    })();
  </script>
</body>
</html>`;
}

function deviceFrom(req: Request): DeviceKind {
  const ua = String(req.headers['user-agent'] || '');
  const ch = String(req.headers['sec-ch-ua-platform'] || '');
  return detectDevice(ua, ch);
}

function requestBase(req: Request): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

export interface PublishedRelease {
  version: string;
  url: string;
  file: string;
  sha256: string;
  sha512: string;
  size: number;
  notes: string;
  minVersion: string | null;
}

async function published(base: string, offer: Offer): Promise<PublishedRelease | null> {
  if (!offer.file || offer.comingSoon) return null;
  const file = await readyFile(offer.file);
  if (!file) return null;
  return {
    version: offer.version,
    url: `${base}/download/${offer.file}`,
    file: offer.file,
    sha256: file.sha256,
    sha512: file.sha512,
    size: file.size,
    notes: offer.notes,
    minVersion: offer.minVersion,
  };
}

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

/** electron-updater generic provider feed. Not cached: Cloudflare caches /download for hours. */
export async function renderWindowsLatestYml(base: string): Promise<string | null> {
  const windows = offersFrom(loadReleaseCatalog()).find((o) => o.id === 'windows');
  if (!windows) return null;
  const rel = await published(base, windows);
  if (!rel) return null;
  const when = new Date().toISOString();
  return [
    `version: ${rel.version}`,
    'files:',
    `  - url: ${rel.url}`,
    `    sha512: ${rel.sha512}`,
    `    size: ${rel.size}`,
    `path: ${rel.file}`,
    `sha512: ${rel.sha512}`,
    `releaseDate: ${yamlQuote(when)}`,
    `releaseNotes: ${yamlQuote(rel.notes)}`,
    '',
  ].join('\n');
}

export function registerDownloads(app: Express): void {
  const page = async (req: Request, res: Response) => {
    try {
      const html = await renderDownloadPage(deviceFrom(req));
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (err) {
      console.error('[download] page', (err as Error).message);
      res.status(500).type('text').send('Could not load the download page.');
    }
  };
  app.get('/api/updates', async (req, res) => {
    try {
      const base = requestBase(req);
      const offers = offersFrom(loadReleaseCatalog());
      const byId = (id: Offer['id']) => offers.find((o) => o.id === id)!;
      const ios = byId('ios');
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        android: await published(base, byId('android')),
        windows: await published(base, byId('windows')),
        ios: {
          comingSoon: !!ios.comingSoon,
          version: ios.version,
          storeUrl: loadReleaseCatalog().ios.storeUrl || null,
          notes: ios.notes,
        },
      });
    } catch (err) {
      console.error('[updates]', (err as Error).message);
      res.setHeader('Cache-Control', 'no-store');
      res.status(500).json({ ok: false, error: 'Update manifest unavailable' });
    }
  });
  app.get('/api/updates/win/latest.yml', async (req, res) => {
    try {
      const yml = await renderWindowsLatestYml(requestBase(req));
      res.setHeader('Cache-Control', 'no-store');
      if (!yml) { res.status(404).type('text').send('No Windows installer is published.'); return; }
      res.type('text/yaml').send(yml);
    } catch (err) {
      console.error('[updates] yml', (err as Error).message);
      res.setHeader('Cache-Control', 'no-store');
      res.status(500).type('text').send('Update manifest unavailable');
    }
  });
  app.get('/download', page);
  app.get('/download/:file', async (req, res) => {
    const name = String(req.params.file || '');
    const offers = offersFrom(loadReleaseCatalog());
    const offer = offerByFile(offers, name);
    const contentType = offer ? contentTypeFor(offer, name) : undefined;
    if (!offer || !contentType) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).type('text').send('That download is not on this server.');
      return;
    }
    const file = await readyFile(name);
    if (!file) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).type('text').send('That download is not on this server.');
      return;
    }
    res.sendFile(file.abs, {
      dotfiles: 'deny',
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'public, max-age=3600',
      },
    }, (err) => {
      if (err && !res.headersSent) res.status(404).type('text').send('That download is not on this server.');
    });
  });
}
