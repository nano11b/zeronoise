import { APP_NAME } from '../shared/config';

export function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function colorFor(nick: string) {
  let h = 0;
  for (const c of nick.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 68%)`;
}
const IGNORE_KEY = `${APP_NAME.toLowerCase()}.ignored`;
export function loadIgnored(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(IGNORE_KEY) || '[]')); } catch { return new Set(); }
}
export function saveIgnored(s: Set<string>) {
  localStorage.setItem(IGNORE_KEY, JSON.stringify([...s]));
}

/** Cap a client-side unread count for display. */
export function unreadBadge(n: number): string {
  return n > 99 ? '99+' : String(n);
}
