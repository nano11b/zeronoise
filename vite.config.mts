import { defineConfig } from 'vite';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { APP_NAME, BRAND_NAME, TAGLINE } from './shared/config';

const api = `http://localhost:${process.env.PORT || 3000}`;

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'app-name-html',
      transformIndexHtml: (html) =>
        html.replace(/%BRAND_NAME%/g, BRAND_NAME).replace(/%APP_NAME%/g, APP_NAME).replace(/%TAGLINE%/g, TAGLINE),
    },
    {
      // Background-effect / RNNoise wasm is large (the segmenter ~13 MB). Precompress once at build
      // so the server can send .br / .gz instead of compressing per request.
      name: 'precompress-wasm',
      apply: 'build',
      closeBundle() {
        const dir = join(__dirname, 'dist/client/assets');
        let files: string[] = [];
        try { files = readdirSync(dir).filter((f) => f.endsWith('.wasm') || f.endsWith('.tflite')); } catch { return; }
        for (const f of files) {
          const buf = readFileSync(join(dir, f));
          writeFileSync(join(dir, `${f}.br`), brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length } }));
          writeFileSync(join(dir, `${f}.gz`), gzipSync(buf, { level: 9 }));
        }
      },
    },
  ],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks: an app-only deploy leaves these hashes (and browser caches) alone.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          if (/\/node_modules\/(socket\.io-client|socket\.io-parser|engine\.io-client|engine\.io-parser|@socket\.io|debug|ms|xmlhttprequest-ssl)\//.test(id)) return 'socket';
          return undefined;
        },
      },
    },
  },
  server: {
    port: Number(process.env.CLIENT_PORT) || 5173,
    strictPort: true,
    proxy: {
      '/socket.io': { target: api, ws: true },
      '/api': api,
      '/download': api,
      '/terms': api,
      '/privacy': api,
    },
  },
});
