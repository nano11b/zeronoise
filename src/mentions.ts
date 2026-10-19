/** Mentions inbox state for the signed-in account: unread count (bell badge) and the list (dialog). */
import { useSyncExternalStore } from 'react';
import type { MentionItem } from '../shared/types';
import { call, socket } from './socket';

interface State { unread: number; items: MentionItem[] | null }
let state: State = { unread: 0, items: null };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; for (const f of subs) f(); };

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  socket.on('mentions:new', ({ item, unread }) => {
    set({ unread, items: state.items ? [item, ...state.items.filter((i) => i.id !== item.id)].slice(0, 100) : null });
  });
}
export function setMentionUnread(n: number) { wire(); set({ unread: n }); }
export async function loadMentions(): Promise<void> {
  wire();
  const r = await call<{ items: MentionItem[]; unread: number }>((ack) => socket.emit('mentions:list', ack));
  set({ items: r.items, unread: r.unread });
}
export async function markMentions(ids: number[] | 'all', read = true): Promise<void> {
  const r = await call<{ unread: number }>((ack) => socket.emit('mentions:read', { ids, read }, ack));
  const pick = ids === 'all' ? null : new Set(ids);
  set({ unread: r.unread, items: state.items?.map((i) => (!pick || pick.has(i.id) ? { ...i, read } : i)) ?? null });
}
/** Opening a room reads its mentions on the server; mirror that locally. */
export function readRoomLocally(roomId: string) {
  if (!state.items) return;
  const had = state.items.filter((i) => i.roomId === roomId && !i.read).length;
  if (!had) return;
  set({ items: state.items.map((i) => (i.roomId === roomId ? { ...i, read: true } : i)), unread: Math.max(0, state.unread - had) });
}
export function useMentions(): State {
  wire();
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state, () => state);
}
/** Ask App to open a room (jump from the inbox). */
export function openRoomById(roomId: string) {
  window.dispatchEvent(new CustomEvent('zn:open-room', { detail: { roomId } }));
}

/** batch MC2: open a room (if needed) and jump to a message there. The room picks the pending jump up when it mounts. */
let pendingJump: { roomId: string; messageId: string; at: number } | null = null;
export function openMessage(roomId: string, messageId: string) {
  pendingJump = { roomId, messageId, at: Date.now() };
  window.dispatchEvent(new CustomEvent('zn:jump-message', { detail: { roomId, messageId } }));
  openRoomById(roomId);
}
/** the pending jump for this room (taken once, valid for 20 s) */
export function takePendingJump(roomId: string): string | null {
  const p = pendingJump;
  if (!p || p.roomId !== roomId || Date.now() - p.at > 20_000) return null;
  pendingJump = null;
  return p.messageId;
}
