import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { hardReload } from './refresh';

const RELOAD_KEY = 'camchat.chunkReloadAt';

/** True for the errors a browser gives when a hashed chunk is gone after an upgrade. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk .* failed/i.test(msg);
}

/**
 * A stale page asked for a chunk the new build no longer has. Reload once onto the new build.
 * Returns false when we already tried within the last minute, so a broken deploy cannot loop.
 */
let reloading = false;
export function recoverFromChunkError(): boolean {
  if (reloading) return true; // already on the way to the new build
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch { /* storage off: still try once per document */ }
  reloading = true;
  void (async () => {
    let id = '';
    try {
      const r = await fetch('/api/build', { cache: 'no-store' });
      if (r.ok) id = String(((await r.json()) as { build?: unknown }).build ?? '');
    } catch { /* ignore */ }
    await hardReload(id || String(Date.now()));
  })();
  return true;
}

/** React.lazy with upgrade recovery. While the reload starts, the Suspense fallback stays up. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithReload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() => load().catch((err) => {
    if (isChunkLoadError(err) && recoverFromChunkError()) return new Promise<{ default: T }>(() => { /* page is navigating */ });
    throw err;
  }));
}

/** Pick one named export as a lazy component. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  type C = M[K] extends ComponentType<any> ? M[K] : never;
  return lazyWithReload<C>(() => load().then((m) => ({ default: m[name] as unknown as C })));
}

type BoundaryState = { failed: boolean };

/** Last line when a chunk still cannot load: a small notice instead of a blank app. */
export class ChunkBoundary extends Component<{ children: ReactNode; inline?: boolean }, BoundaryState> {
  state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState { return { failed: true }; }
  componentDidCatch(err: unknown) { console.error(err); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={this.props.inline ? 'chunk-error inline' : 'chunk-error'} role="alert">
        <p>This part of the app did not load.</p>
        <button type="button" className="btn ghost" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

/** Suspense plus the boundary, for one lazily loaded piece. */
export function Lazy({ children, fallback = null, inline }: { children: ReactNode; fallback?: ReactNode; inline?: boolean }) {
  return <ChunkBoundary inline={inline}><Suspense fallback={fallback}>{children}</Suspense></ChunkBoundary>;
}
