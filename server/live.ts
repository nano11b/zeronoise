import type { ReleaseInfo } from './release';
import type { Role } from '../shared/types';
import type { ItemView } from './modq';

export interface BotIdentity { id: number; name: string; ownerUserId: number }
export type BotResult = { ok: true } | { ok: false; status: number; error: string }

export type BotModAction = 'kick' | 'room-ban' | 'site-ban' | 'unban' | 'room-unban' | 'site-unban' | 'mute' | 'delete';
export interface BotModBody {
  action: BotModAction;
  roomId?: string;
  userId?: string;
  username?: string;
  reason?: string;
  minutes?: unknown;
  banId?: number;
  scope?: 'room' | 'site';
  messageId?: string;
}
export interface BotModRoomUser { id: string; nick: string; role: string; accountId: number | null }
export interface BotModRoom { id: string; name: string; topic: string; isPrivate: boolean; users: BotModRoomUser[] }
export interface BotModMessage {
  id: string; ts: number; roomId: string; nick: string; role: string | null; text: string;
  userId: number | null; fromId: string | null;
}
export type BotFeedResult =
  | { ok: true; rooms: BotModRoom[] }
  | { ok: true; messages: BotModMessage[] }
  | { ok: false; status: number; error: string };
export interface BotFeedQuery {
  kind: 'rooms' | 'messages';
  roomId?: string;
  since?: number;
  limit?: number;
}
export interface BotRoomLine {
  id: string;
  ts: number;
  author: string;
  username: string | null;
  isBot: boolean;
  bot: string | null;
  text: string;
}
export type BotRoomReadResult =
  | { ok: true; messages: BotRoomLine[]; cursor: string | null }
  | { ok: false; status: number; error: string };
export interface BotRoomReadQuery {
  after?: string;
  /** Set only when the client passed limit. Omitted means the default page size for an `after` read. */
  limit?: number;
  limitExplicit: boolean;
}

/** Hooks the Socket.IO layer registers so HTTP admin routes can affect live connections. */
export const live = {
  /** disconnect every socket that now matches an active ban */
  enforceBans: () => {},
  /** push a role change to that account's live sockets */
  roleChanged: (_userId: number, _role: Role) => {},
  /** refresh chatColor / hasAvatar on live UserInfo + broadcast user:updated */
  profileChanged: (_userId: number) => {},
  /** shown badges changed: refresh live UserInfo.badges + broadcast user:updated */
  badgesChanged: (_userId: number) => {},
  /** is this nick currently used by a guest from a different device? */
  nickHeldByOther: (_nick: string, _deviceIds: string[]) => false as boolean,
  stats: () => ({ rooms: 0, users: 0 }),
  /** Room banner (theme): who may change it, and the current banner id. */
  roomBannerInfo: (_roomId: string): { ownerUserId: number | null; isPrivate: boolean; bannerId: string | null } | null => null,
  roomBannerChanged: (_roomId: string, _bannerId: string | null, _by: string) => {},
  /** Set once at process start from the server entry mtime. */
  buildId: '',
  /** Package sha256 + commit (see release.ts). Set once at process start. */
  release: { packageSha256: null, commit: null, branch: null, manifestSha256: null, releasedAt: null, installedAt: null } as ReleaseInfo,
  /** Bearer API: put an allowed bot in a room. Cam, mic, and screen stay off. */
  botJoin: (_roomId: string, _bot: BotIdentity): BotResult => ({ ok: false, status: 503, error: 'Not ready' }),
  /** Bearer API: post a chat line as the bot. Rate-limited by the socket layer. */
  botChat: (_roomId: string, _bot: BotIdentity, _text: unknown): BotResult => ({ ok: false, status: 503, error: 'Not ready' }),
  /** Bearer API: resolve a GIF id and send it the same way a person would. */
  botGif: async (_roomId: string, _bot: BotIdentity, _gifId: string): Promise<BotResult> => ({ ok: false, status: 503, error: 'Not ready' }),
  /**
   * Bearer API: read chat in a room this bot is allowed in. Join is not required.
   * Private calls and rooms that have not allowed the bot are rejected.
   */
  botRoomMessages: (_roomId: string, _bot: BotIdentity, _query: BotRoomReadQuery): BotRoomReadResult => ({ ok: false, status: 503, error: 'Not ready' }),
  /** Token revoked or bot deleted: leave every room. */
  botGone: (_botId: number) => {},
  /**
   * Bearer API for the one moderator bot: kick, room ban, site ban, and the matching unban.
   * Regular bots, and mute/delete for every bot, are rejected here.
   */
  botModerate: (_bot: BotIdentity, _body: BotModBody): BotResult => ({ ok: false, status: 503, error: 'Not ready' }),
  /** Bearer API: the moderator bot reads every room and its chat. Regular bots are rejected. */
  botModFeed: (_bot: BotIdentity, _query: BotFeedQuery): BotFeedResult => ({ ok: false, status: 503, error: 'Not ready' }),
  /** Any successful bot-token check. Only the current moderator bot is shown in people lists. */
  noteModBot: (_bot: BotIdentity) => {},
  /** The designated moderator bot was changed or cleared. Drop a stale people-list row at once. */
  modBotChanged: () => {},
  /** True when this account or device has a live socket in the room. Bots do not count. */
  isRoomMember: (_roomId: string, _accountId: number | null, _deviceIds: string[]) => false,
  /** Room creator: owning account, or the guest who created it and is still connected as that nick. */
  isRoomCreator: (_roomId: string, _accountId: number | null, _deviceIds: string[]) => false,
  /** Tell current members the clip list changed. */
  soundsChanged: (_roomId: string) => {},
  /** Connected socket id of this account, if any (profile online status). */
  accountSocket: (_userId: number) => null as string | null,
  /** HTTP thumbnail routes: who may change it, and push the change to lobbies + the room */
  roomThumbInfo: (_roomId: string) => null as null | { ownerUserId: number | null; isPrivate: boolean; thumbId: string | null },
  roomThumbChanged: (_roomId: string, _thumbId: string | null, _by: string) => {},
  /** HTTP room icon routes (same rules as thumbnails) */
  roomIconInfo: (_roomId: string) => null as null | { ownerUserId: number | null; isPrivate: boolean; iconId: string | null },
  roomIconChanged: (_roomId: string, _iconId: string | null, _by: string) => {},
  /** invites + share cards: what an open room looks like from outside (null = no such room) */
  inviteRoom: (_roomId: string) => null as null | {
    id: string; name: string; topic: string; isPrivate: boolean; passwordRequired: boolean; locked: boolean; ownerUserId: number | null;
    modIds: number[]; category: string | null; tags: string[]; users: number; thumbId: string | null; iconId: string | null;
  },
  /** the "room mods can create invites" setting changed */
  inviteSettingsChanged: (_roomId: string, _modsCanInvite: boolean, _by: string) => {},
  /** batch 3: emote list changed (HTTP upload/rename/delete) -> tell the room */
  roomEmotesChanged: (_roomId: string) => {},
  liveCounts: (): { online: number; rooms: number } => ({ online: 0, rooms: 0 }),
  emoteAdded: (_roomId: string, _emote: { id: string; name: string; url: string }, _by: { id: number; username: string }) => {},
  /** moderation queue: how items look to staff (reporter identity, private content) or room managers */
  modqView: (_staff: boolean): ItemView => ({ staff: false, messageExists: () => false, hidden: () => false, roomName: () => null, targetOnline: () => false, targetRole: () => null }),
  /** one-click action on a queue item (site powers) */
  modqAct: (_actor: { id: number; username: string; role: Role }, _reportId: number, _body: { action?: unknown; minutes?: unknown; reason?: unknown; note?: unknown } | undefined):
    { ok: true; resolution: string; status: 'resolved' | 'dismissed'; closed: number } | { ok: false; error: string; status: number } => ({ ok: false, status: 503, error: 'Not ready' }),
  /** claim / release a queue item */
  modqClaim: (_actor: { id: number; username: string }, _reportId: number, _release: boolean, _force: boolean): { ok: true } | { ok: false; status: number; error: string } => ({ ok: false, status: 503, error: 'Not ready' }),
  /** a single report changed status through the legacy route: refresh badges, undo auto-hide when nothing is left open */
  modqStatusChanged: (_reportId: number, _status: string) => {},
};
