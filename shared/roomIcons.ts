/** Custom room icons (room rail, room header, small next to the name in the lobby). Separate from the card thumbnail. */
export const ROOM_ICON_MAX_BYTES = 2 * 1024 * 1024;
export const ROOM_ICON_SIZE = 128;
/** random 128-bit id, hex */
export const ROOM_ICON_ID_RE = /^[a-f0-9]{32}$/;
export const roomIconUrl = (id: string) => `/api/room-icons/${id}.webp`;
