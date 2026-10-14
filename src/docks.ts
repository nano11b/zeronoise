/** Layout and unwatch prefs. Keys are fixed so a rename of APP_NAME does not move them. */

export const DOCK_KEY = 'camchat.docks';
export const UNWATCH_KEY = 'camchat.unwatch';
export const SPLIT_KEY = 'camchat.split';
/** Share of the stage given to cameras. The rest is chat. */
export const DEFAULT_SPLIT = 0.5;
export const PEOPLE_SPLIT_KEY = 'camchat.peopleSplit';
/** People column width in pixels. Matches the old fixed rail. */
export const DEFAULT_PEOPLE_SPLIT = 260;

export type DockItem = 'cams' | 'people';
export interface DockLayout { stage: DockItem }

export const DEFAULT_DOCK: DockLayout = { stage: 'cams' };

export function loadDock(): DockLayout {
  try {
    const raw = localStorage.getItem(DOCK_KEY);
    if (!raw) return DEFAULT_DOCK;
    const stage = (JSON.parse(raw) as { stage?: unknown }).stage;
    if (stage === 'cams' || stage === 'people') return { stage };
  } catch { /* keep the default */ }
  return DEFAULT_DOCK;
}

export function saveDock(layout: DockLayout) {
  try { localStorage.setItem(DOCK_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
}

/** Wide room chrome: two columns, not the phone bottom sheet or the short landscape sheet. */
export function dockWide(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(min-width: 861px)').matches
    && !window.matchMedia('(max-width: 900px) and (max-height: 500px)').matches;
}

function readUnwatch(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(UNWATCH_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, string[]>;
  } catch { return {}; }
}

export function loadUnwatch(roomId: string): Set<string> {
  const list = readUnwatch()[roomId];
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((n) => typeof n === 'string').map((n) => n.toLowerCase()));
}

export function saveUnwatch(roomId: string, nicks: Set<string>) {
  try {
    const all = readUnwatch();
    if (nicks.size === 0) delete all[roomId];
    else all[roomId] = [...nicks];
    localStorage.setItem(UNWATCH_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

/** Keep a drag preview above the chat composer. */
export function clampDockGhost(x: number, y: number): { x: number; y: number } {
  const form = document.querySelector('.room .chat-form');
  const top = form ? form.getBoundingClientRect().top : window.innerHeight;
  const limit = Math.max(8, top - 40);
  return {
    x: Math.min(window.innerWidth - 16, Math.max(8, x)),
    y: Math.min(limit, Math.max(8, y)),
  };
}

export function loadSplit(): number {
  try {
    const n = Number(localStorage.getItem(SPLIT_KEY));
    if (Number.isFinite(n) && n >= 0.18 && n <= 0.82) return n;
  } catch { /* keep the default */ }
  return DEFAULT_SPLIT;
}

export function saveSplit(split: number) {
  try { localStorage.setItem(SPLIT_KEY, String(split)); } catch { /* ignore */ }
}

/** Tall enough to drag a column split. Short phone sheets stay as they are. */
export function splitFits(): boolean {
  if (typeof window === 'undefined') return false;
  return !window.matchMedia('(max-width: 900px) and (max-height: 520px)').matches;
}

export function loadPeopleSplit(): number {
  try {
    const n = Number(localStorage.getItem(PEOPLE_SPLIT_KEY));
    if (Number.isFinite(n) && n >= 160 && n <= 560) return n;
  } catch { /* keep the default */ }
  return DEFAULT_PEOPLE_SPLIT;
}

export function savePeopleSplit(px: number) {
  try { localStorage.setItem(PEOPLE_SPLIT_KEY, String(Math.round(px))); } catch { /* ignore */ }
}
