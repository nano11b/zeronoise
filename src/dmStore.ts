/** batch W: client state for private conversations (list, open thread, typing, receipts). */
import { useSyncExternalStore } from 'react';
import type { DmConvo, DmMessage, DmPolicy } from '../shared/dm';
import { DM } from '../shared/dm';
import { call, socket } from './socket';

/** dm:* events are not in the typed socket maps; one loose handle keeps the casts in one place. */
export const dmSock = socket as unknown as {
  emit: (ev: string, ...args: unknown[]) => void;
  on: (ev: string, fn: (...a: any[]) => void) => void;
  off: (ev: string, fn: (...a: any[]) => void) => void;
  connected: boolean;
};
export const dmCall = <T,>(ev: string, payload: unknown) => call<T>((ack) => dmSock.emit(ev, payload, ack));

interface State {
  loaded: boolean;
  convos: DmConvo[];
  openId: string | null;
  messages: DmMessage[];
  more: boolean;
  typing: Record<string, { name: string; until: number }[]>;
  policy: DmPolicy; typingOn: boolean; receipts: boolean;
}
let state: State = { loaded: false, convos: [], openId: null, messages: [], more: false, typing: {}, policy: 'requests', typingOn: true, receipts: true };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; for (const f of subs) f(); };
export const dmState = () => state;
export function useDm(): State {
  wire();
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state, () => state);
}
/** Unread across active chats (requests count separately). */
export const totalUnread = (s: State) => s.convos.filter((c) => c.state === 'active' && !c.archived).reduce((n, c) => n + c.unread, 0);
export const requestCount = (s: State) => s.convos.filter((c) => c.state === 'request').length;

const upsert = (c: DmConvo) => {
  const rest = state.convos.filter((x) => x.id !== c.id);
  set({ convos: [c, ...rest].sort((a, b) => b.lastTs - a.lastTs) });
};
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  dmSock.on('dm:convo', (c: DmConvo) => upsert(c));
  dmSock.on('dm:message', (m: DmMessage) => {
    if (m.convoId !== state.openId) return;
    if (state.messages.some((x) => x.id === m.id)) return;
    const typing = { ...state.typing, [m.convoId]: (state.typing[m.convoId] ?? []).filter((t) => t.name !== m.from) };
    set({ messages: [...state.messages, m], typing });
    if (document.visibilityState === 'visible') markRead(m.convoId, m.ts);
  });
  dmSock.on('dm:update', (m: DmMessage) => {
    if (m.convoId !== state.openId) return;
    set({ messages: state.messages.map((x) => (x.id === m.id ? m : x)) });
  });
  dmSock.on('dm:gone', (p: { convoId: string; ids: string[] }) => {
    if (p.convoId !== state.openId) return;
    const gone = new Set(p.ids);
    set({ messages: state.messages.filter((x) => !gone.has(x.id)) });
  });
  dmSock.on('dm:removed', (p: { convoId: string }) => {
    set({ convos: state.convos.filter((c) => c.id !== p.convoId), ...(state.openId === p.convoId ? { openId: null, messages: [] } : {}) });
  });
  dmSock.on('dm:read', (p: { convoId: string; userId: number; ts: number }) => {
    const c = state.convos.find((x) => x.id === p.convoId);
    if (!c) return;
    upsert({ ...c, members: c.members.map((m) => (m.userId === p.userId ? { ...m, readTs: Math.max(m.readTs ?? 0, p.ts) } : m)) });
  });
  dmSock.on('dm:typing', (p: { convoId: string; userId: number; username: string }) => {
    const until = Date.now() + DM.typingTtlMs;
    const list = (state.typing[p.convoId] ?? []).filter((t) => t.name !== p.username && t.until > Date.now());
    set({ typing: { ...state.typing, [p.convoId]: [...list, { name: p.username, until }] } });
    window.setTimeout(() => {
      const l = (state.typing[p.convoId] ?? []).filter((t) => t.until > Date.now());
      set({ typing: { ...state.typing, [p.convoId]: l } });
    }, DM.typingTtlMs + 50);
  });
  // a fresh connection (sign-in, reconnect) reloads the list
  socket.on('connect', () => { if (state.loaded) void loadDm().catch(() => {}); });
}
export async function loadDm() {
  wire();
  const r = await dmCall<{ convos: DmConvo[]; policy: DmPolicy; typing: boolean; receipts: boolean }>('dm:list', {});
  set({ loaded: true, convos: r.convos, policy: r.policy, typingOn: r.typing, receipts: r.receipts });
  if (state.openId && r.convos.some((c) => c.id === state.openId)) await openConvo(state.openId);
}
export async function openConvo(id: string | null) {
  if (!id) return set({ openId: null, messages: [], more: false });
  set({ openId: id, messages: [], more: false });
  const r = await dmCall<{ convo: DmConvo; messages: DmMessage[]; more: boolean }>('dm:open', { convoId: id });
  if (state.openId !== id) return;
  upsert(r.convo);
  set({ messages: r.messages, more: r.more });
  const last = r.messages[r.messages.length - 1];
  if (last) markRead(id, last.ts);
}
export async function loadOlder() {
  const id = state.openId; const first = state.messages[0];
  if (!id || !first) return;
  const r = await dmCall<{ messages: DmMessage[]; more: boolean }>('dm:open', { convoId: id, before: first.ts });
  if (state.openId !== id) return;
  set({ messages: [...r.messages, ...state.messages], more: r.more });
}
export function markRead(convoId: string, ts: number) {
  const c = state.convos.find((x) => x.id === convoId);
  if (c && c.unread) upsert({ ...c, unread: 0 });
  dmSock.emit('dm:read', { convoId, ts });
}
export function setDmPrefs(p: Partial<Pick<State, 'policy' | 'typingOn' | 'receipts'>>) { set(p); }
/** Ask App to add a username to the block list (it syncs the list to the server). */
export function blockLocally(username: string) { window.dispatchEvent(new CustomEvent('zn:block', { detail: { username } })); }
/** Open the whispers sheet from anywhere (profile menu, push notification link, "Whisper" buttons). */
export type WhisperStart = { username: string; call?: boolean; n: number };
/** Open the Whispers inbox, optionally with a 1:1 conversation (message requests and blocks apply server side), optionally ringing a voice call. */
export function openWhispers(withUsername?: string, call = false) {
  window.dispatchEvent(new CustomEvent('zn:open-whispers', { detail: withUsername ? { username: withUsername, call, n: Date.now() } : undefined }));
}
