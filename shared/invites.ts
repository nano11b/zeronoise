/** Room invite links: https://<site>/i/<code> */
export { INVITE_CODE_LEN, INVITE_CODE_RE, INVITE_PATH_RE } from './inviteCode';
export const INVITE_EXPIRY = { '30m': 30 * 60_000, '1h': 60 * 60_000, '1d': 24 * 60 * 60_000, '7d': 7 * 24 * 60 * 60_000, never: null } as const;
export type InviteExpiry = keyof typeof INVITE_EXPIRY;
export const INVITE_EXPIRY_LABEL: Record<InviteExpiry, string> = { '30m': '30 minutes', '1h': '1 hour', '1d': '1 day', '7d': '7 days', never: 'Never' };
export const INVITE_MAX_USES = [1, 5, 10, 25, 100, null] as const;
export type InviteMaxUses = (typeof INVITE_MAX_USES)[number];
/** links a room keeps active at once (revoked/expired ones do not count) */
export const INVITES_PER_ROOM = 50;

export type InviteStatus = 'ok' | 'expired' | 'used' | 'revoked' | 'notfound';

export interface InviteInfo {
  code: string;
  roomId: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  uses: number;
  skipPassword: boolean;
  isDefault: boolean;
  revokedAt: number | null;
  status: InviteStatus;
  /** the caller may revoke it */
  canRevoke?: boolean;
}

/** What /api/invites/:code tells anyone holding the link (signed out included). */
export interface InvitePublic {
  status: InviteStatus;
  room?: {
    name: string;
    /** only when the room is public, or the link skips its password */
    topic?: string;
    users?: number;
    category?: string | null;
    tags?: string[];
    iconUrl?: string;
    thumbUrl?: string;
    passwordRequired: boolean;
  };
  skipPassword?: boolean;
  expiresAt?: number | null;
}

export const inviteUrl = (origin: string, code: string) => `${origin.replace(/\/$/, '')}/i/${code}`;
