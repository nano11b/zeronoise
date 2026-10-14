/* zeronoise service worker: Web Push notifications, installable-app support and an offline page.
 *
 * Caching rules (no stale app after an upgrade):
 *   - never cached: page navigations / index.html, /api/*, /socket.io/*, downloads, anything cross-origin
 *   - cache-first:  hashed /assets/* (their names change every build), icons, fonts
 *   - navigations go to the network; only when it fails do we show /offline.html
 * The server stamps BUILD with its build id, so every deploy ships a byte-different sw.js: the browser
 * installs it, it takes over at once, and activate deletes the previous build's caches.
 */
const BUILD = '__BUILD_ID__';
const VERSION = BUILD.startsWith('__') ? 'dev' : BUILD;
const STATIC_CACHE = `zn-static-${VERSION}`;
const OFFLINE_CACHE = `zn-offline-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const OFFLINE_ASSETS = [OFFLINE_URL, '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(OFFLINE_CACHE);
      await cache.addAll(OFFLINE_ASSETS.map((u) => new Request(u, { cache: 'reload' })));
    } catch (_) { /* offline page is a nicety; never block install (push must keep working) */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC_CACHE, OFFLINE_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('zn-') && !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// The page can ask a waiting worker to take over right before its upgrade reload (src/pwa.ts).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

function isCacheable(url) {
  if (url.pathname.startsWith('/assets/')) return true;
  if (/^\/(icon-[\w-]+|apple-touch-icon|badge-\d+|favicon|logo-[\w-]+)\.(png|ico)$/.test(url.pathname)) return true;
  return /\.(woff2?|ttf|otf)$/.test(url.pathname);
}

async function ensureOffline() {
  // The upgrade reload clears every cache; put the offline page back on the next good navigation.
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    if (!(await cache.match(OFFLINE_URL))) await cache.addAll(OFFLINE_ASSETS.map((u) => new Request(u, { cache: 'reload' })));
  } catch (_) { /* ignore */ }
}

async function offlineResponse() {
  const hit = await caches.match(OFFLINE_URL);
  if (hit) return hit;
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · zeronoise</title><body style="background:#0b1220;color:#e7eef8;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><p>You\u0027re offline \u2014 zeronoise will reconnect when you\u0027re back</p><script>addEventListener("online",()=>location.reload())</script>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/download')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req); // never cached: the HTML shell must always be the current build
        event.waitUntil(ensureOffline());
        return res;
      } catch (_) {
        return offlineResponse();
      }
    })());
    return;
  }

  if (!isCacheable(url) || req.headers.has('range')) return;
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
    return res;
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data ? event.data.text() : '' }; }
  const title = typeof data.title === 'string' && data.title ? data.title : 'zeronoise';
  const body = typeof data.body === 'string' && data.body ? data.body : 'New message';
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/';
  event.waitUntil((async () => {
    // A focused tab already shows the message: skip the notification.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.focused && w.visibilityState === 'visible')) return;
    await self.registration.showNotification(title, {
      body,
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      renotify: !!data.tag,
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      data: { url },
    });
  })());
});

// Focus an open window (asking it to open the notification's room), or open the room URL in a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  const target = new URL(raw, self.location.origin);
  event.waitUntil((async () => {
    const wins = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter((w) => new URL(w.url).origin === self.location.origin);
    const exact = wins.find((w) => { const u = new URL(w.url); return u.pathname === target.pathname && u.search === target.search; });
    const win = exact || wins.find((w) => w.focused) || wins[0];
    if (win) {
      try { await win.focus(); } catch (_) { /* focus can be refused; still deliver the message */ }
      win.postMessage({ type: 'open-url', url: target.pathname + target.search });
      return;
    }
    await self.clients.openWindow(target.pathname + target.search);
  })());
});
