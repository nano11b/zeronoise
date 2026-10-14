/** Full-screen room effects: fixed whitelist, all drawn by our own client code. */
export const FX = [
  { id: 'confetti', emoji: '🎉', name: 'Confetti' },
  { id: 'fireworks', emoji: '🎆', name: 'Fireworks' },
  { id: 'balloons', emoji: '🎈', name: 'Balloons' },
  { id: 'hearts', emoji: '❤️', name: 'Hearts' },
  { id: 'rain', emoji: '🌧️', name: 'Rain' },
  { id: 'snow', emoji: '❄️', name: 'Snow' },
  { id: 'money', emoji: '💸', name: 'Money rain' },
  { id: 'matrix', emoji: '🟩', name: 'Matrix' },
] as const;
export type FxId = (typeof FX)[number]['id'];
export const FX_USER_COOLDOWN_MS = 10_000;
export const FX_ROOM_COOLDOWN_MS = 3_000;
export const FX_DURATION_MS = 3_500;

export const isFxId = (v: unknown): v is FxId => typeof v === 'string' && FX.some((f) => f.id === v);
export const fxById = (id: string) => FX.find((f) => f.id === id);

/** "/confetti" (any case, surrounding spaces ok) -> 'confetti'; anything else -> null. */
export function fxSlashCommand(text: unknown): FxId | null {
  if (typeof text !== 'string') return null;
  const m = /^\s*\/([a-z]+)\s*$/i.exec(text);
  const id = m?.[1].toLowerCase();
  return id && isFxId(id) ? id : null;
}

/** Cooldown check: per-user first, then room-wide. Returns an error message or null. */
export function fxCooldown(userLast: number | undefined, roomLast: number | undefined, now: number, userMs = FX_USER_COOLDOWN_MS, roomMs = FX_ROOM_COOLDOWN_MS): string | null {
  if (userLast !== undefined && now - userLast < userMs) return `You can play another effect in ${Math.ceil((userMs - (now - userLast)) / 1000)}s.`;
  if (roomLast !== undefined && now - roomLast < roomMs) return `An effect just played here. Try again in ${Math.ceil((roomMs - (now - roomLast)) / 1000)}s.`;
  return null;
}
