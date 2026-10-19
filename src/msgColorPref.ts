/** batch X: viewer setting "ignore custom message colours" (this device). */
import { useSyncExternalStore } from 'react';
import { MSG_COLOR_KEY, safeMsgStyle } from '../shared/msgColor';

const subs = new Set<() => void>();
const read = () => { try { return localStorage.getItem(MSG_COLOR_KEY) === '1'; } catch { return false; } };
export function setIgnoreMsgColors(on: boolean) {
  try { if (on) localStorage.setItem(MSG_COLOR_KEY, '1'); else localStorage.removeItem(MSG_COLOR_KEY); } catch { /* private mode */ }
  subs.forEach((f) => f());
}
export function useIgnoreMsgColors(): boolean {
  return useSyncExternalStore((f) => { subs.add(f); const st = (e: StorageEvent) => { if (e.key === MSG_COLOR_KEY) f(); }; window.addEventListener('storage', st); return () => { subs.delete(f); window.removeEventListener('storage', st); }; }, read, () => false);
}
/** the stored colour/gradient to paint a line with, or null (viewer opted out, or a stop is not readable) */
export function useMsgColor(v: string | null | undefined): string | null {
  const ignore = useIgnoreMsgColors();
  return ignore || !safeMsgStyle(v) ? null : (v as string);
}
