/** Lay camera tiles out so they all fit in the video pane. */

export const TILE_GAP = 10;
export const TILE_MAX = 480;
export const TILE_MIN_W = 160;
const AUDIO_W = 240;
const AUDIO_H = 180;

export interface FitTile {
  id: string;
  /** width / height */
  ar: number;
  audioOnly?: boolean;
  /** Spotlight may grow past 480, still inside the pane. */
  big?: boolean;
}

export interface FitSize {
  id: string;
  w: number;
  h: number;
}

export interface FitResult {
  sizes: FitSize[];
  /** Content does not fit without going under the minimum tile width. */
  scroll: boolean;
  /** Narrow pane: one horizontal row instead of a wrap that would have to scroll. */
  row: boolean;
}

interface Box { id: string; w: number; h: number }

function preferred(ar: number, maxW: number, maxH: number): { w: number; h: number } {
  const safe = ar > 0.05 ? ar : 4 / 3;
  const h = Math.min(maxH, maxW / safe);
  return { w: h * safe, h };
}

function baseBox(tile: FitTile, paneW: number, paneH: number): Box {
  if (tile.audioOnly) return { id: tile.id, ...preferred(4 / 3, AUDIO_W, AUDIO_H) };
  const ar = tile.ar > 0.05 ? tile.ar : 4 / 3;
  if (tile.big) return { id: tile.id, ...preferred(ar, paneW, Math.min(paneH, 720)) };
  return { id: tile.id, ...preferred(ar, TILE_MAX, TILE_MAX) };
}

/** Height of a left-to-right wrap. Width of a tile may not exceed the pane. */
function wrapHeight(boxes: Box[], paneW: number, gap: number): number | null {
  let x = 0;
  let rowH = 0;
  let height = 0;
  let rows = 0;
  for (const b of boxes) {
    if (b.w > paneW + 0.5) return null;
    if (x > 0 && x + b.w > paneW + 0.5) {
      height += rowH + gap;
      x = 0;
      rowH = 0;
      rows += 1;
    }
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  if (rowH > 0) {
    height += rowH;
    rows += 1;
  }
  return rows ? height : 0;
}

function scaleBoxes(bases: Box[], scale: number): Box[] {
  return bases.map((b) => ({
    id: b.id,
    w: Math.max(1, Math.floor(b.w * scale)),
    h: Math.max(1, Math.floor(b.h * scale)),
  }));
}

/**
 * Largest uniform scale in (0, 1] that fits every tile in the pane.
 * Scale stops at the point where the widest tile would be under `minW`,
 * and the pane scrolls instead of shrinking further.
 * On a narrow pane, that scroll is a single horizontal row (tiles stay as
 * tall as the pane) rather than a vertical stack hidden under the chat.
 */
export function fitTiles(
  tiles: FitTile[],
  paneW: number,
  paneH: number,
  opts?: { gap?: number; minW?: number; narrow?: boolean },
): FitResult {
  const gap = opts?.gap ?? TILE_GAP;
  const minW = opts?.minW ?? TILE_MIN_W;
  const narrow = opts?.narrow ?? false;
  if (tiles.length === 0 || paneW < 40 || paneH < 40) {
    return { sizes: [], scroll: false, row: false };
  }
  const W = Math.max(40, paneW - 2);
  const H = Math.max(40, paneH - 2);
  const bases = tiles.map((t) => baseBox(t, W, H));
  const videoBases = bases.filter((_, i) => !tiles[i].audioOnly);
  const widest = Math.max(1, ...videoBases.map((b) => b.w), ...(videoBases.length ? [] : bases.map((b) => b.w)));
  const floor = Math.min(1, minW / widest);

  const fits = (scale: number) => {
    const height = wrapHeight(scaleBoxes(bases, scale), W, gap);
    return height != null && height <= H + 1;
  };

  let scale = 1;
  if (!fits(1)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    scale = lo;
  }

  if (scale >= floor - 0.004) {
    return { sizes: scaleBoxes(bases, scale), scroll: false, row: false };
  }

  if (narrow) {
    // One row as tall as the pane (still capped at 480). Sideways scroll if they don't all fit.
    const rowScale = Math.min(1, H / Math.max(...bases.map((b) => b.h)), W / Math.max(...bases.map((b) => b.w)));
    const sizes = scaleBoxes(bases, rowScale);
    const total = sizes.reduce((sum, b) => sum + b.w, 0) + gap * Math.max(0, sizes.length - 1);
    return { sizes, scroll: total > W + 1, row: true };
  }

  return { sizes: scaleBoxes(bases, floor), scroll: true, row: false };
}
