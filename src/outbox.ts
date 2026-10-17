import { useCallback, useEffect, useState } from 'react';
import { socket } from './socket';

/**
 * Batch E5: offline outbox. Lines typed while the connection is down (PWA, app webviews, flaky mobile) wait here
 * (localStorage, survives a reload) and go out in order once the room is back. Every line carries a clientId, so a
 * resend after a lost ack is recognised by the server and never posted twice.
 * A line the server refuses for good (muted, filtered, too long) stays as "failed" with Retry / Discard and does
 * not hold up the lines after it.
 */
export interface OutItem { cid: string; roomId: string; text: string; parentId?: string; at: number; state: 'pending' | 'sending' | 'failed'; error?: string }
const KEY = 'zn.outbox';
const read = (): OutItem[] => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
let mem: OutItem[] | null = null;
const all = () => (mem ??= read());
const listeners = new Set<() => void>();
const save = (next: OutItem[]) => { mem = next; try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* full/private: memory only */ } listeners.forEach((f) => f()); };
const patch = (cid: string, p: Partial<OutItem>) => save(all().map((i) => (i.cid === cid ? { ...i, ...p } : i)));
export const newClientId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
/** network-ish errors: keep the line and try again later */
const transient = (e: string) => /did not respond|not in a room|slow down|slow mode|rate|disconnected|timeout/i.test(e);
export function enqueue(roomId: string, text: string, parentId?: string, cid = newClientId()) {
  if (all().some((i) => i.cid === cid)) return;
  save([...all(), { cid, roomId, text, parentId, at: Date.now(), state: 'pending' }]);
  void flush();
}
const sendOne = (i: OutItem) => new Promise<{ ok: boolean; error?: string }>((res) => {
  if (!socket.connected) return res({ ok: false, error: 'disconnected' });
  const t = setTimeout(() => res({ ok: false, error: 'Server did not respond' }), 8000);
  socket.emit('chat:send', { text: i.text, clientId: i.cid, ...(i.parentId ? { parentId: i.parentId } : {}) }, (r) => { clearTimeout(t); res(r ?? { ok: false, error: 'Request failed' }); });
});
let flushing = false; let currentRoom: string | null = null; let retryTimer = 0;
/** Send the waiting lines for the room we are in, oldest first. */
export async function flush() {
  if (flushing || !currentRoom || !socket.connected) return;
  flushing = true;
  try {
    for (;;) {
      const i = all().find((x) => x.roomId === currentRoom && x.state !== 'failed');
      if (!i || !socket.connected) break;
      patch(i.cid, { state: 'sending' });
      const r = await sendOne(i);
      if (r.ok) { save(all().filter((x) => x.cid !== i.cid)); continue; }
      if (transient(r.error || '')) { patch(i.cid, { state: 'pending' }); window.clearTimeout(retryTimer); retryTimer = window.setTimeout(() => void flush(), 1500); break; }
      patch(i.cid, { state: 'failed', error: r.error });
    }
  } finally { flushing = false; }
}
export function useOutbox(roomId: string) {
  const [, bump] = useState(0);
  useEffect(() => {
    currentRoom = roomId;
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    const go = () => { window.setTimeout(() => void flush(), 600); }; // give the room re-join a moment
    socket.on('connect', go); window.addEventListener('online', go);
    go();
    return () => { listeners.delete(f); socket.off('connect', go); window.removeEventListener('online', go); if (currentRoom === roomId) currentRoom = null; };
  }, [roomId]);
  const items = all().filter((i) => i.roomId === roomId);
  const retry = useCallback((cid: string) => { patch(cid, { state: 'pending', error: undefined }); void flush(); }, []);
  const discard = useCallback((cid: string) => save(all().filter((i) => i.cid !== cid)), []);
  return { items, retry, discard };
}
