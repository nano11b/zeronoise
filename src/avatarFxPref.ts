/** batch MC2: viewer setting "hide avatar frames and glows" (this device). Sets html.no-avatar-fx. */
import { useSyncExternalStore } from 'react';
import { AVATAR_FX_KEY } from '../shared/avatarFx';

const subs = new Set<() => void>();
const read = () => { try { return localStorage.getItem(AVATAR_FX_KEY) === '1'; } catch { return false; } };
const apply = () => { try { document.documentElement.classList.toggle('no-avatar-fx', read()); } catch { /* ssr */ } };
apply();
export function setHideAvatarFx(on: boolean) {
  try { if (on) localStorage.setItem(AVATAR_FX_KEY, '1'); else localStorage.removeItem(AVATAR_FX_KEY); } catch { /* private mode */ }
  apply(); subs.forEach((f) => f());
}
export function useHideAvatarFx(): boolean {
  return useSyncExternalStore((f) => { subs.add(f); const st = (e: StorageEvent) => { if (e.key === AVATAR_FX_KEY) { apply(); f(); } }; window.addEventListener('storage', st); return () => { subs.delete(f); window.removeEventListener('storage', st); }; }, read, () => false);
}
