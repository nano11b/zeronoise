import { io, Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient } from '../shared/types';

export type AppSocket = Socket<ServerToClient, ClientToServer>;

/** Connected by App after /api/me has set up the device id (sent in the handshake auth). */
export const socket: AppSocket = io({ autoConnect: false, transports: ['websocket', 'polling'], withCredentials: true });

/** Re-open the socket so the handshake picks up a new session cookie (after sign-in / sign-out). */
export function reconnect() {
  socket.disconnect();
  socket.connect();
}

/** Promise wrapper around ack-style emits. */
export function call<T>(fn: (ack: (r: any) => void) => void, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server did not respond')), timeoutMs);
    fn((res) => {
      clearTimeout(t);
      if (res?.ok) resolve(res as T);
      else reject(new Error(res?.error || 'Request failed'));
    });
  });
}

let iceCache: { servers: RTCIceServer[]; expires: number } | null = null;
function listHasTurn(list: RTCIceServer[]) {
  return list.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).toLowerCase().includes('turn')));
}
/**
 * ICE servers from /api/ice. TURN credentials are time-limited, so refresh at half their TTL.
 * A STUN-only answer (no device cookie yet, or TURN not configured) is cached briefly and retried,
 * otherwise the first fetch would stick for an hour and the call would never learn about TURN.
 */
export async function getIceServers(force = false): Promise<RTCIceServer[]> {
  if (!force && iceCache && iceCache.expires > Date.now()) return iceCache.servers;
  try {
    const r = await fetch('/api/ice', { credentials: 'same-origin' });
    const j = await r.json();
    const servers = (j.iceServers || []) as RTCIceServer[];
    const turn = listHasTurn(servers);
    const ttl = typeof j.ttl === 'number' ? j.ttl : 3600;
    const cacheMs = turn ? (ttl * 1000) / 2 : 20_000;
    iceCache = { servers, expires: Date.now() + cacheMs };
  } catch {
    // A failed refresh must not wipe credentials the peer connection is already using.
    if (iceCache && listHasTurn(iceCache.servers)) return iceCache.servers;
    iceCache = { servers: [{ urls: 'stun:stun.l.google.com:19302' }], expires: Date.now() + 20_000 };
  }
  return iceCache.servers;
}
