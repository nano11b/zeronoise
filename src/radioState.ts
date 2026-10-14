/** Shared Labs FM state: the latest server-relayed "now playing" and whether this tab is playing. */
import { useEffect, useState } from 'react';
import type { RadioNowPlaying } from '../shared/types';
import { call, socket } from './socket';

type State = { np: RadioNowPlaying | null; playing: boolean; at: number };
let state: State = { np: null, playing: false, at: 0 };
const subs = new Set<(s: State) => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const fn of subs) fn(state);
}
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  socket.on('radio:np', ({ np }) => set({ np, at: Date.now() }));
  // a reconnect drops the server's listener mark: restate it
  socket.on('connect', () => { if (state.playing) void call<{ np: RadioNowPlaying | null }>((ack) => socket.emit('radio:listen', { on: true }, ack)).then((r) => { if (r.np) set({ np: r.np, at: Date.now() }); }).catch(() => {}); });
}
export function useRadio(): State {
  const [s, setS] = useState(state);
  useEffect(() => { wire(); subs.add(setS); setS(state); return () => { subs.delete(setS); }; }, []);
  return s;
}
export function setRadioPlaying(on: boolean) {
  wire();
  if (state.playing === on) return;
  set({ playing: on });
  void call<{ np: RadioNowPlaying | null }>((ack) => socket.emit('radio:listen', { on }, ack))
    .then((r) => { if (r.np) set({ np: r.np, at: Date.now() }); }).catch(() => {});
}
/** Ask once for a cached value (the server fetches at most every 15 s). */
export function refreshRadio() {
  wire();
  if (state.np && Date.now() - state.at < 15_000) return;
  void call<{ np: RadioNowPlaying | null }>((ack) => socket.emit('radio:get', ack))
    .then((r) => { if (r.np) set({ np: r.np, at: Date.now() }); }).catch(() => {});
}
