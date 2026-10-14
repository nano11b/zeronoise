import type { RoomState } from '../shared/types';
import { api } from './api';
import { call, socket } from './socket';
import { clearPendingInvite } from './invite';

/** Redeem a followed invite and join its room (loaded on demand; most visits never follow an invite). */
export async function followInvite(code: string, d: {
  currentRoom: () => string | null;
  leave: () => void;
  askPassword: (room: { id: string; name: string }) => void;
  joined: (room: RoomState) => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
}) {
  try {
    const r = await api<{ roomId: string; roomName: string; skipPassword: boolean; passwordRequired: boolean }>(`/api/invites/${encodeURIComponent(code)}/redeem`, {});
    clearPendingInvite();
    if (d.currentRoom() === r.roomId) return;
    if (r.passwordRequired && !r.skipPassword) {
      if (d.currentRoom()) d.leave();
      d.askPassword({ id: r.roomId, name: r.roomName });
      return;
    }
    const j = await call<{ room: RoomState }>((ack) => socket.emit('room:join', { roomId: r.roomId, invite: code }, ack));
    d.joined(j.room);
  } catch (e) {
    // still unconfirmed: keep the invite for after the email step
    if (!/confirm your email|add an email/i.test((e as Error).message)) clearPendingInvite();
    d.toast((e as Error).message, 'error');
  }
}
