import { useEffect, useRef } from 'react';
import { socket } from './socket';

/**
 * Batch E4: the unsent text in a composer follows you across devices.
 * Every edit is kept on this device at once (localStorage) and, for accounts, sent to the server after a pause;
 * other devices get it live (draft:sync) unless someone is typing there right now. '' clears the draft.
 */
const DEBOUNCE_MS = 700;
const TYPING_GUARD_MS = 1500;
type Local = { text: string; at: number };
const keyOf = (roomId: string, threadId: string) => `zn.draft.${roomId}.${threadId}`;
const readLocal = (k: string): Local | null => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && typeof v.text === 'string' ? v : null; } catch { return null; } };
const writeLocal = (k: string, v: Local) => { try { if (v.text) localStorage.setItem(k, JSON.stringify(v)); else localStorage.removeItem(k); } catch { /* private mode */ } };

export function useDraftSync(roomId: string, threadId: string | null, text: string, setText: (t: string) => void, signedIn: boolean, enabled = true) {
  const tid = threadId ?? '';
  const st = useRef({ applied: null as string | null, lastEdit: 0, timer: 0 as number | undefined, loaded: '', prev: text });
  const live = !!roomId && enabled && (threadId !== null || tid === '');
  // load: local first, then the server copy if it is newer
  useEffect(() => {
    if (!live) return;
    const k = keyOf(roomId, tid);
    const s = st.current; s.loaded = ''; s.applied = null; s.prev = text; // switching rooms/threads is not typing
    const loc = readLocal(k);
    if (loc?.text) { s.applied = loc.text; setText(loc.text); }
    s.loaded = k;
    if (!signedIn) return;
    let gone = false;
    socket.emit('draft:get', { roomId }, (r) => {
      if (gone || !r.ok) return;
      const d = r.drafts.find((x) => x.threadId === tid);
      const cur = readLocal(k);
      if (d && d.updatedAt > (cur?.at ?? 0) && Date.now() - s.lastEdit > TYPING_GUARD_MS) { s.applied = d.text; writeLocal(k, { text: d.text, at: d.updatedAt }); setText(d.text); }
    });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, tid, signedIn, live]);
  // live updates from this account's other devices
  useEffect(() => {
    if (!live || !signedIn) return;
    const on = (p: { roomId: string; threadId: string; text: string; updatedAt: number }) => {
      if (p.roomId !== roomId || p.threadId !== tid) return;
      if (Date.now() - st.current.lastEdit < TYPING_GUARD_MS) return; // don't fight someone typing here
      st.current.applied = p.text; writeLocal(keyOf(roomId, tid), { text: p.text, at: p.updatedAt }); setText(p.text);
    };
    socket.on('draft:sync', on);
    return () => { socket.off('draft:sync', on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, tid, signedIn, live]);
  // save: local now, server after a pause (cleared drafts go at once)
  useEffect(() => {
    const s = st.current; const k = keyOf(roomId, tid);
    const changed = s.prev !== text; s.prev = text;
    if (!changed || !live || s.loaded !== k) return; // mount or re-render: nothing typed
    if (s.applied === text) { s.applied = null; return; } // this change came from load/sync, not the keyboard
    const at = Date.now(); s.lastEdit = at;
    writeLocal(k, { text, at });
    if (!signedIn) return;
    window.clearTimeout(s.timer);
    const send = () => socket.emit('draft:save', { roomId, threadId: tid, text, at }, () => {});
    if (!text) send(); else s.timer = window.setTimeout(send, DEBOUNCE_MS);
    return () => window.clearTimeout(s.timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
}
