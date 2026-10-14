import { useLayoutEffect, useRef, useState } from 'react';
import { fitTiles, type FitResult, type FitTile } from './tileFit';

const EMPTY: FitResult = { sizes: [], scroll: false, row: false };

/**
 * Measure the camera pane (the dock, not the tiles' own content height) and
 * pick a uniform scale so every tile fits. Re-runs when the pane resizes,
 * including the video/chat splitter.
 */
export function useTileFit(tiles: FitTile[]) {
  const ref = useRef<HTMLElement>(null);
  const [fit, setFit] = useState<FitResult>(EMPTY);
  const key = tiles.map((t) => `${t.id}:${t.ar.toFixed(4)}:${t.audioOnly ? 1 : 0}:${t.big ? 1 : 0}`).join('|');

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const dock = el.closest('.dock-slot') as HTMLElement | null;
      const area = el.parentElement as HTMLElement | null;
      const paneW = el.clientWidth;
      const bounds = [dock?.clientHeight, area?.clientHeight].filter((n): n is number => !!n && n > 0);
      const paneH = bounds.length ? Math.min(...bounds) : el.clientHeight;
      const narrow = window.matchMedia('(max-width: 860px)').matches;
      const next = fitTiles(tiles, paneW, paneH, { narrow });
      setFit((prev) => {
        if (prev.scroll === next.scroll && prev.row === next.row && prev.sizes.length === next.sizes.length
          && prev.sizes.every((s, i) => s.id === next.sizes[i].id && s.w === next.sizes[i].w && s.h === next.sizes[i].h)) {
          return prev;
        }
        return next;
      });
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    const dock = el.closest('.dock-slot');
    if (dock) ro.observe(dock);
    const area = el.parentElement;
    if (area && area !== dock) ro.observe(area);
    window.addEventListener('resize', apply);
    apply();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
    };
    // tiles is read from the closure; key tracks the values that change the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { ref, fit };
}
