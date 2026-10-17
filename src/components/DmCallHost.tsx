/** W1-2: rings for calls placed from a whisper, wherever you are (lobby, a room, another screen). */
import { useEffect, useState } from 'react';
import type { RoomState } from '../../shared/types';
import { call, socket } from '../socket';
import { dmSock } from '../dmStore';

interface Ring { roomId: string; from: { username: string }; video?: boolean; convoId?: string; group?: string | null }
export function DmCallHost({ onJoinCall, toast }: { onJoinCall?: (r: RoomState) => void; toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [ring, setRing] = useState<Ring | null>(null);
  useEffect(() => {
    const on = (p: Ring) => { if (p.convoId) setRing(p); };
    const ended = (p: { roomId: string }) => setRing((r) => (r && r.roomId === p.roomId ? null : r));
    const declined = (p: { by: string }) => toast(`${p.by} declined`);
    dmSock.on('call:incoming', on); dmSock.on('call:ended', ended); dmSock.on('call:declined', declined);
    return () => { dmSock.off('call:incoming', on); dmSock.off('call:ended', ended); dmSock.off('call:declined', declined); };
  }, [toast]);
  useEffect(() => {
    if (!ring) return;
    const t = window.setTimeout(() => setRing(null), 45000);
    return () => window.clearTimeout(t);
  }, [ring]);
  if (!ring) return null;
  const answer = async (accept: boolean) => {
    const { roomId } = ring;
    setRing(null);
    try {
      const r = await call<{ room?: RoomState }>((ack) => socket.emit('call:respond', { roomId, accept }, ack));
      if (accept && r.room) onJoinCall?.(r.room);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="dm-ring" role="alertdialog" aria-label="Incoming call" data-testid="dm-ring">
      <span>{ring.video ? '📹' : '📞'} <strong>{ring.from.username}</strong> {ring.group ? <>is calling <strong>{ring.group}</strong></> : 'is calling you'}{ring.video ? ' (video)' : ''}</span>
      <button type="button" className="btn primary small-btn" onClick={() => void answer(true)} data-action="dm-ring-accept">Join</button>
      <button type="button" className="btn ghost small-btn" onClick={() => void answer(false)} data-action="dm-ring-decline">Decline</button>
    </div>
  );
}
