import { adoptNewWorker } from './pwa';
/** Drop this origin's cached page so an upgrade cannot keep serving the old bundle. */
export async function dropPageCaches(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      // Keep the app worker (/sw.js): unregistering it would drop push subscriptions. Its caches go below,
      // and its build-stamped script is replaced by the new build's (adoptNewWorker).
      const isPushWorker = (r: ServiceWorkerRegistration) => [r.active, r.waiting, r.installing].some((w) => !!w && new URL(w.scriptURL).pathname === '/sw.js');
      await Promise.all(regs.filter((r) => !isPushWorker(r)).map((r) => r.unregister()));
    }
  } catch { /* ignore */ }
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* ignore */ }
}

let navigating = false;
let beforeNavigate: (() => void) | null = null;

/** Runs once, immediately before the update navigation. Countdown timing is unchanged. */
export function onBeforeHardReload(fn: () => void): void {
  beforeNavigate = fn;
}

/** One hard navigation per page. Query v=buildId bypasses a cached index.html. */
export async function hardReload(buildId: string): Promise<void> {
  if (navigating) return;
  navigating = true;
  try { beforeNavigate?.(); } catch { /* ignore */ }
  const id = buildId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || String(Date.now());
  await dropPageCaches();
  await adoptNewWorker();
  const url = new URL(location.href);
  url.searchParams.set('v', id);
  location.replace(`${url.pathname}${url.search}${url.hash}`);
}

let loadedBuild: string | null = null;
let countdownArmed = false;
let countdownListener: ((seconds: number) => void) | null = null;

/** UI hook for the 5 second countdown. 5 down to 1, then 0 as the reload starts. */
export function bindCountdown(listener: (seconds: number) => void) {
  countdownListener = listener;
}

/**
 * Show the countdown once, then hard-reload. A second call in this document does nothing.
 * The reload waits the full 5 seconds.
 */
export function armHardReload(resolveBuildId: () => Promise<string>): void {
  if (countdownArmed || navigating) return;
  countdownArmed = true;
  let left = 5;
  countdownListener?.(left);
  const timer = window.setInterval(() => {
    left -= 1;
    if (left > 0) {
      countdownListener?.(left);
      return;
    }
    window.clearInterval(timer);
    countdownListener?.(0);
    void (async () => {
      let id = '';
      try { id = await resolveBuildId(); } catch { /* ignore */ }
      await hardReload(id || String(Date.now()));
    })();
  }, 1000);
}

/** Remember the first build id this document saw. One countdown if the server moves on. */
export async function checkBuild(): Promise<void> {
  if (navigating || countdownArmed) return;
  let build = '';
  try {
    const r = await fetch('/api/build', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json() as { build?: unknown };
    if (typeof j.build === 'string') build = j.build;
  } catch { return; }
  if (!build) return;
  if (loadedBuild === null) {
    loadedBuild = build;
    return;
  }
  if (build === loadedBuild) return;
  armHardReload(async () => build);
}
