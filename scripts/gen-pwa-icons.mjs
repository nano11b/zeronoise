// Generate the installable-app icons from the zeronoise mark (public/logo-mark.png) with sharp.
//   node scripts/gen-pwa-icons.mjs
// Writes into public/: icon-192.png, icon-512.png (purpose any), icon-maskable-192.png, icon-maskable-512.png
// (mark inside the 80% safe zone), apple-touch-icon.png (180, opaque), badge-96.png (white silhouette for
// notification badges; Android uses only the alpha channel).
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = (f) => path.join(ROOT, 'public', f);
const BG = '#0b1220'; // --bg of the default theme (also manifest theme/background color)
const SRC = pub('logo-mark.png');

async function onSquare(size, markScale, out) {
  const mark = Math.round(size * markScale);
  const art = await sharp(SRC).resize(mark, mark, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: art, gravity: 'center' }])
    .flatten({ background: BG })
    .png({ compressionLevel: 9 })
    .toFile(pub(out));
}

async function badge(size, out) {
  const mark = Math.round(size * 0.86);
  const alpha = await sharp(SRC).resize(mark, mark, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha().extractChannel('alpha').toBuffer();
  const white = await sharp({ create: { width: mark, height: mark, channels: 3, background: '#ffffff' } })
    .joinChannel(alpha, { raw: undefined }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: white, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(pub(out));
}

await onSquare(192, 0.78, 'icon-192.png');
await onSquare(512, 0.78, 'icon-512.png');
await onSquare(192, 0.6, 'icon-maskable-192.png');
await onSquare(512, 0.6, 'icon-maskable-512.png');
await onSquare(180, 0.74, 'apple-touch-icon.png');
await badge(96, 'badge-96.png');
console.log('icons written to public/');
