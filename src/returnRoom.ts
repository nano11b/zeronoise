import { APP_NAME } from '../shared/config';

const KEY = `${APP_NAME.toLowerCase()}.return`;

/** Room to rejoin after an update reload. Password is not stored. */
export interface RoomReturn {
  roomId: string;
  /** Guest nick. Accounts sign back in from the session cookie. */
  nick: string | null;
  /** Open PM tab, by nick. Socket ids do not survive a reload. */
  pmNick: string | null;
}

export function rememberReturn(v: { roomId: string | null; nick: string | null; pmNick: string | null }): void {
  try {
    if (!v.roomId) {
      sessionStorage.removeItem(KEY);
      return;
    }
    const payload: RoomReturn = {
      roomId: v.roomId,
      nick: v.nick?.trim() || null,
      pmNick: v.pmNick?.trim() || null,
    };
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch { /* private mode */ }
}

export function peekReturn(): RoomReturn | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<RoomReturn>;
    if (!j || typeof j.roomId !== 'string' || !j.roomId) return null;
    return {
      roomId: j.roomId,
      nick: typeof j.nick === 'string' && j.nick.trim() ? j.nick : null,
      pmNick: typeof j.pmNick === 'string' && j.pmNick.trim() ? j.pmNick : null,
    };
  } catch { return null; }
}

export function clearReturn(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
