/** batch MC2: sticker packs per room, built on the custom emoji pipeline. */
export const STICKER_PACKS_PER_ROOM = 3;
export const STICKERS_PER_PACK = 24;
export const STICKER_MAX_BYTES = 1024 * 1024;
export const STICKER_SIZE = 256;
export const STICKER_NAME_RE = /^[a-z0-9_]{2,24}$/;
export const STICKER_PACK_NAME_MAX = 32;
export const STICKER_ID_RE = /^[a-f0-9]{32}$/;
/** a sticker message is exactly this token; anything else is plain text */
export const STICKER_TOKEN_RE = /^\[\[sticker:([a-f0-9]{32})\]\]$/;
export const stickerToken = (id: string) => `[[sticker:${id}]]`;
export type StickerStatus = 'pending' | 'approved' | 'rejected';
export interface StickerInfo { id: string; packId: string; name: string; url: string; animated: boolean; status: StickerStatus; note?: string | null }
export interface StickerPack { id: string; name: string; stickers: StickerInfo[] }
