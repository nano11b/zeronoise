/** Moderation queue counts shared by the top bar badge, the admin queue and the room Reports view. */
import { useEffect, useState } from 'react';
import type { QueueCounts } from '../shared/modq';

const EMPTY: QueueCounts = { open: 0, review: 0, resolved: 0, dismissed: 0 };
let staffCounts: QueueCounts = EMPTY;
const roomCounts = new Map<string, QueueCounts>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setStaffCounts(c: QueueCounts) { staffCounts = c; emit(); }
export function setRoomCounts(roomId: string, c: QueueCounts) { roomCounts.set(roomId, c); emit(); }

function useStore<T>(read: () => T): T {
  const [v, setV] = useState(read);
  useEffect(() => {
    const l = () => setV(read);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}
/** Site staff: items waiting (open + in review). */
export const useStaffCounts = () => useStore(() => staffCounts);
export const useRoomCounts = (roomId: string) => useStore(() => roomCounts.get(roomId) ?? EMPTY);
