/** batch W: private conversations ("whispers" inbox) shared between server and client. */
export const DM = {
  groupMin: 3, // including the creator
  groupMax: 10,
  nameMax: 40,
  pageSize: 60,
  fileMaxBytes: 10 * 1024 * 1024,
  imageMaxEdge: 2048,
  keepMs: 30 * 24 * 3600_000, // like room whispers
  typingThrottleMs: 2500,
  typingTtlMs: 6000,
  excerptLines: 20,
  disappearOptions: [0, 3600, 86400, 604800] as const,
} as const;
export type DmPolicy = 'everyone' | 'friends' | 'requests';
export const DM_POLICIES: DmPolicy[] = ['everyone', 'friends', 'requests'];
/** Allowed file types: images are re-encoded (EXIF stripped); other types are stored as-is. */
export const DM_FILE_TYPES: Record<string, string> = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'application/pdf': 'file', 'text/plain': 'file', 'application/zip': 'file',
  'audio/mpeg': 'file', 'audio/ogg': 'file', 'video/mp4': 'file',
};
export interface DmMember { userId: number; username: string; chatColor?: string | null; msgColor?: string | null; hasAvatar?: boolean; left?: boolean; online?: boolean; readTs?: number; owner?: boolean }
export interface DmConvo {
  id: string; kind: 'direct' | 'group'; name: string | null; createdBy: number;
  members: DmMember[]; lastTs: number; lastText: string | null; unread: number;
  pinned: boolean; archived: boolean; state: 'active' | 'request' | 'declined';
  /** set when the other side's request is waiting for them (the sender sees "pending") */
  pendingFor?: number[];
  disappearSec: number;
}
export interface DmFileInfo { id: string; name: string; mime: string; bytes: number; width?: number | null; height?: number | null; url: string; image: boolean }
export interface DmMessage {
  id: string; convoId: string; ts: number; fromId: number | null; from: string; text: string;
  kind: 'text' | 'file' | 'voice' | 'system';
  replyTo?: { id: string; from: string; text: string } | null;
  editedAt?: number | null; deleted?: boolean;
  file?: DmFileInfo | null;
  voice?: { url: string; durationMs: number } | null;
  reactions?: { emoji: string; count: number; mine: boolean; users: string[] }[];
  expiresAt?: number | null;
}
export const disappearLabel = (sec: number) => sec === 0 ? 'Off' : sec === 3600 ? '1 hour' : sec === 86400 ? '1 day' : sec === 604800 ? '7 days' : `${sec}s`;
