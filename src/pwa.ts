/**
 * Installable-app glue: service-worker registration, the install prompt, the app badge and
 * notification clicks that should open a room in an already-open window.
 */
import { useEffect, useState } from 'react';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type BadgeNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void>; standalone?: boolean };

const DISMISS_KEY = 'camchat.installDismissed';
let deferred: InstallEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || (navigator as BadgeNavigator).standalone === true;
  } catch { return false; }
}

/** iOS / iPadOS Safari: no beforeinstallprompt, installing goes through Share -> Add to Home Screen. */
export function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios && /Safari\//.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|GSA)\//.test(ua);
}

function dismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

/** Call once at startup, before React renders: the browser fires beforeinstallprompt early. */
export function initPwa(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // no browser mini-infobar: we offer a quiet menu item instead
    deferred = e as InstallEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => { deferred = null; installed = true; emit(); });
  try { window.matchMedia('(display-mode: standalone)').addEventListener('change', emit); } catch { /* old Safari */ }

  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // The same script and scope as the push opt-in, so this is one registration, not two.
  const register = () => { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* offline or blocked */ }); };
  if (import.meta.env.PROD) {
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (d?.type !== 'open-url' || typeof d.url !== 'string') return;
    const roomId = roomFromUrl(d.url);
    if (roomId) openRoomListener?.(roomId);
  });
}

/** `/?room=<id>` from a notification link, or null. */
export function roomFromUrl(href: string): string | null {
  try {
    const id = new URL(href, location.origin).searchParams.get('room');
    return id && /^[\w-]{1,80}$/.test(id) ? id : null;
  } catch { return null; }
}

/** Read and strip `?room=` from the address bar (a notification opened a fresh window). */
export function takeRoomParam(): string | null {
  const id = roomFromUrl(location.href);
  if (!new URL(location.href).searchParams.has('room')) return null;
  const url = new URL(location.href);
  url.searchParams.delete('room');
  try { history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`); } catch { /* ignore */ }
  return id;
}

let openRoomListener: ((roomId: string) => void) | null = null;
export function onOpenRoom(fn: ((roomId: string) => void) | null) { openRoomListener = fn; }

/**
 * Right before the upgrade reload: make sure the new build's worker (byte-different sw.js) is the one
 * that will serve the next page. Bounded, so a slow network never delays the reload by much.
 */
export async function adoptNewWorker(timeoutMs = 1500): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg) return;
    await Promise.race([
      (async () => {
        await reg.update();
        const w = reg.installing || reg.waiting;
        if (!w) return;
        await new Promise<void>((resolve) => {
          const done = () => { if (w.state === 'activated' || w.state === 'redundant') resolve(); };
          w.addEventListener('statechange', done);
          w.postMessage({ type: 'skip-waiting' });
          done();
        });
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch { /* ignore: the reload goes ahead regardless */ }
}

export type InstallOffer = { mode: 'prompt' | 'ios' | null; install: () => Promise<void>; dismiss: () => void };

function currentMode(): InstallOffer['mode'] {
  if (installed || isStandalone() || dismissed()) return null;
  if (deferred) return 'prompt';
  if (isIosSafari()) return 'ios';
  return null;
}

/** What the profile / More menu should offer: the browser prompt, an iOS hint, or nothing. */
export function useInstallOffer(): InstallOffer {
  const [mode, setMode] = useState(currentMode);
  useEffect(() => {
    const l = () => setMode(currentMode());
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);
  return {
    mode,
    install: async () => {
      const e = deferred;
      if (!e) return;
      deferred = null;
      try {
        await e.prompt();
        const choice = await e.userChoice;
        if (choice.outcome === 'accepted') installed = true;
      } catch { /* prompt can only be used once */ }
      emit();
    },
    dismiss: () => {
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
      emit();
    },
  };
}

/** Unread count on the installed app's icon, where supported. Cleared while the app is in front. */
export function setAppBadge(n: number): void {
  const nav = navigator as BadgeNavigator;
  if (!nav.setAppBadge) return;
  const front = document.visibilityState === 'visible' && document.hasFocus();
  if (n > 0 && !front) nav.setAppBadge(n).catch(() => {});
  else nav.clearAppBadge?.().catch(() => {});
}

export function clearAppBadge(): void {
  (navigator as BadgeNavigator).clearAppBadge?.().catch(() => {});
}
