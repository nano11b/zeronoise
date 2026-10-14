/** Custom room thumbnails (lobby card image). */
export const ROOM_THUMB_MAX_BYTES = 5 * 1024 * 1024;
export const ROOM_THUMB_W = 640;
export const ROOM_THUMB_H = 360;
/** random 128-bit id, hex; a new one on every upload so URLs can be cached forever */
export const ROOM_THUMB_ID_RE = /^[a-f0-9]{32}$/;
export const roomThumbUrl = (id: string) => `/api/room-thumbs/${id}.webp`;
