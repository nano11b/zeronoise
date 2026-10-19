import type { RoomAppealInfo } from './appeals';
import type { RoomFilters } from './filters';
import type { StageState } from './stage';
import type { QueueAction, QueueBucket, QueueCounts, QueueItem, QueueSort, ReportCategory } from './modq';
import type { ReactionCount } from './reactions';
import type { FriendOnline, RecentRoom } from './lobby';

export type Role = 'admin' | 'moderator' | 'user' | 'guest';

export interface UserInfo {
  id: string; // socket id
  /** connection dropped; the seat is kept for the reconnect grace period. Treat cam/screen as off. */
  away?: boolean;
  nick: string;
  cam: boolean;
  mic: boolean;
  /** sharing screen (video track is display media) */
  screen: boolean;
  role: Role;
  registered: boolean;
  /** registered account id when known (for avatar URL) */
  accountId?: number;
  /** curated palette id, e.g. "rose"; guests omit */
  chatColor?: string | null;
  /** batch X: message text colour (#rrggbb, readable on every theme) */
  msgColor?: string | null;
  avatarFx?: string | null;
  /** preset effect id: glow | gradient | pulse; guests and "none" omit */
  chatEffect?: string | null;
  hasAvatar?: boolean;
  /** Ghost row for the active moderator bot. Not a member, and not part of people counts. */
  modBot?: boolean;
  /** up to 3 shown badge ids (registered accounts only) */
  badges?: string[];
  /** batch D: XP level (omitted when the account hides it or has no XP yet) */
  level?: number;
}

/** GET /api/me/badges */
export interface BadgesResponse {
  ok: true;
  earned: { id: string; earnedAt: number }[];
  stats: Record<string, number>;
  /** effective threshold per badge id */
  thresholds: Record<string, number>;
  shown: string[];
  chosen: string[] | null;
}

/** GET /api/me */
export interface MeResponse {
  account: {
    id: number;
    username: string;
    role: Role;
    chatColor: string | null;
    chatEffect: string | null;
    hasAvatar: boolean;
    /** batch X: message text colour */
    msgColor?: string | null;
  avatarFx?: string | null;
    /** The signed-in user's own address. Never copied onto other people. */
    email: string | null;
    emailVerified: boolean;
    /** saved camera quality preset (null = never set; the client then uses its local / default value) */
    videoQuality?: string | null;
    uiTheme?: string | null;
    /** show link preview cards under chat lines (default on) */
    linkPreviews?: boolean;
  } | null;
  deviceId: string;
  google: boolean;
  discord: boolean;
  tiktok: boolean;
  /** GIF search configured (Tenor or Giphy key on the server) */
  gifs: boolean;
  guestCamAfterMinutes: number;
  captchaMode: 'builtin' | 'turnstile' | 'hcaptcha';
  captchaSiteKey: string | null;
  /** True only when EMAIL_VERIFY_REQUIRED is on and a mail sender is configured. */
  emailVerifyRequired: boolean;
  mailConfigured: boolean;
  /** batch D: signed in with a password/OAuth but the two-factor code step is still due */
  twoFactorPending?: boolean;
}

export interface RoomSummary {
  id: string;
  name: string;
  topic: string;
  users: number;
  broadcasters: number;
  /** built-in room */
  permanent: boolean;
  /** survives restarts (default rooms + rooms made by registered users) */
  persistent: boolean;
  /** true when a password is required to join; the secret itself is never sent */
  passwordRequired: boolean;
  /** batch C: audio-only voice room */
  voice?: boolean;
  /** next scheduled event starting within 24 h (lobby 📅 tag) */
  eventSoon?: { title: string; startsAt: number };
  /** an event is running right now */
  eventLive?: { title: string; startsAt: number };
  /** custom thumbnail URL (cacheable; changes on every upload) */
  thumbUrl?: string;
  /** custom room icon URL (rail / header / small next to the name); cacheable, changes on every upload */
  iconUrl?: string;
  /** batch 3: one category from ROOM_CATEGORIES and up to 5 tags */
  category?: string | null;
  tags?: string[];
  /** smarter lobby: rolling activity score (people + messages in 10 min + cams/shares live); omitted when 0 */
  activity?: number;
  /** activity at or above LOBBY.activeMin (🔥 active) */
  active?: boolean;
}

/** batch 3 */
export interface RoomAnnouncement { text: string; at: number; by: string }
export interface RoomScheduleInfo { id: string; text: string; repeat: 'once' | 'daily' | 'weekly'; nextAt: number; by: string; createdAt: number; kind?: 'message' | 'banner' | 'poll'; poll?: { options: string[]; durationMin: number | null } }
export interface RoomEmote { id: string; name: string; url: string; animated: boolean }
export interface RadioNowPlaying {
  station: string; title: string; artist: string; album: string;
  /** proxied, re-encoded album art (never the upstream URL) */
  artUrl: string | null;
  listeners: number; elapsed: number; duration: number; playedAt: number;
  isLive: boolean; streamer: string;
  /** upstream unreachable: the card shows "station offline" */
  offline: boolean;
  serverNow: number;
}
export interface RoomStatsWindow {
  days: number; peak: number; visitors: number; registered: number; guests: number; messages: number;
  top: { username: string; messages: number }[];
}
export interface RoomStats {
  /** [utcHour, messages, peak] for the last 30 days; the client buckets by local day/hour */
  hours: [number, number, number][];
  d7: RoomStatsWindow; d30: RoomStatsWindow; serverNow: number;
}

export interface RoomState {
  id: string;
  name: string;
  topic: string;
  ownerNick: string | null;
  permanent: boolean;
  persistent: boolean;
  users: UserInfo[];
  /** batch A: this account's read marker for the room when it joined (null = never read / guest) */
  lastReadTs?: number | null;
  history: ChatMessage[];
  /** what the joining user may do here */
  canModerate: boolean; // site moderator/admin
  isOwner: boolean;
  camAllowedAt: number | null; // null = cam allowed now; ms timestamp; -1 = needs account
  locked: boolean;
  slowModeSec: number;
  isPrivate: boolean;
  /** true when this room has a password; hash is never included */
  passwordRequired: boolean;
  /** currently pinned messages, newest pin first */
  pins: ChatMessage[];
  /** stage mode (speakers publish, audience receives) */
  stage?: StageState;
  /** batch C: audio-only voice room */
  voice?: boolean;
  /** batch F6: a recording is running (everyone is told) */
  recording?: RecState | null;
  /** in-memory whiteboard; gone when the room is empty */
  board: BoardStroke[];
  /** Synced watch party (YouTube / Twitch), or null when nothing is loaded. */
  watch: WatchState | null;
  /** When true only the room creator and moderators control the watch party. */
  watchLocked: boolean;
  /** Server clock at the time this payload was built (ms). Clients use it to correct for clock skew. */
  serverNow: number;
  /** Clips on this room's soundboard. Empty until the creator adds one. */
  sounds: { id: string; name: string }[];
  /** room moderators appointed by the owner */
  mods?: RoomModInfo[];
  /** the joining user is a room moderator here */
  isRoomMod?: boolean;
  /** custom room thumbnail URL, when set */
  thumbUrl?: string | null;
  /** custom room icon URL, when set */
  iconUrl?: string | null;
  /** room setting: room mods may create invite links (owner/staff always can) */
  modsCanInvite?: boolean;
  /** batch 3 */
  category?: string | null;
  tags?: string[];
  announcement?: RoomAnnouncement | null;
  /** owner-set banner, accent color and welcome message */
  theme?: import('./theme').RoomThemeInfo;
  emotes?: RoomEmote[];
  /** room members currently listening to Labs FM */
  radioHere?: number;
}

export type ChatMessage =
  | {
      kind: 'chat'; id: string; ts: number; fromId: string; from: string; role?: Role; text: string;
      accountId?: number; chatColor?: string | null; msgColor?: string | null; avatarFx?: string | null; chatEffect?: string | null; hasAvatar?: boolean; reactions?: ReactionCount[];
      /** batch D: author's XP level (omitted when hidden) */
      level?: number;
      /** set on a thread reply; omitted on top-level lines */
      parentId?: string;
      /** ms timestamp once the author edits; omitted until then */
      editedAt?: number;
      /** direct replies on a top-level message; on a reply this is the parent's new total */
      replyCount?: number;
      /** registered account ids named with @username */
      mentions?: number[];
      /** push-to-talk voice note; `text` then holds a plain fallback like "🎤 Voice note (0:07)" */
      voice?: VoiceNoteInfo;
      /** burn-after-reading: `text` is empty for everyone but the sender until revealed via chat:reveal */
      burn?: BurnInfo;
      /** link preview card for the first URL (never on burn messages) */
      preview?: LinkPreviewInfo;
      /** poll attached to this line; `text` then holds a plain fallback */
      poll?: PollInfo;
      /** batch 3: a scheduled room announcement (posted by the room, attributed to the scheduler) */
      announce?: { by: string };
      /** auto-hidden pending review: reviewers still get the text, everyone else an empty line */
      hidden?: boolean;
      /** room webhooks: posted by an incoming webhook (name is `from`); shown with a webhook badge */
      webhook?: { hookId: string; avatar: string | null; embeds?: import('./webhooks').WebhookEmbed[]; /** text is only a plain fallback of the embeds */ fallback?: boolean };
    }
  | { kind: 'system'; id: string; ts: number; text: string };

export type BoardColor = 'green' | 'white' | 'red';
export interface BoardStroke {
  id: string;
  fromId: string;
  color: BoardColor;
  /** normalized 0..1 */
  points: [number, number][];
}

export interface PrivateMessage {
  id: string;
  ts: number;
  fromId: string;
  from: string;
  toId: string;
  to: string;
  text: string;
}

export type SignalData =
  | { type: 'description'; description: { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp?: string }; /** msid of the sender's screen-share audio stream */ shareStream?: string }
  | { type: 'candidate'; candidate: unknown }
  /** viewer -> sender: how this viewer wants the sender's video (sender adjusts only that peer's encoding) */
  | { type: 'pref'; video: 'full' | 'low' | 'paused' };

export type Ack<T = {}> = (res: ({ ok: true } & T) | { ok: false; error: string; status?: number }) => void;

export type BanKind = 'account' | 'ip' | 'device';

export interface ClientToServer {
  /** resume: same tab reconnecting. Keeps the WebRTC peers instead of leaving the room. */
  login: (p: { nick?: string; resume?: boolean; tz?: string } | undefined, ack: Ack<{ user: UserInfo }>) => void;
  'rooms:list': (ack: Ack<{ rooms: RoomSummary[] }>) => void;
  'room:create': (p: { name: string; topic?: string; password?: string; voice?: boolean; category?: string | null; tags?: string[] | string; template?: string }, ack: Ack<{ roomId: string }>) => void;
  'room:join': (p: { roomId: string; password?: string; invite?: string }, ack: Ack<{ room: RoomState; resumed?: boolean }>) => void;
  'room:leave': () => void;
  'room:kick': (p: { userId: string }, ack: Ack) => void;
  /** room-level ban (owner or mod); minutes null = until lifted */
  'room:ban': (p: { userId: string; minutes: number | null; reason?: string }, ack: Ack) => void;
  'room:topic': (p: { topic: string }, ack: Ack) => void;
  'room:delete': (ack: Ack) => void;
  'chat:send': (p: { text: string; parentId?: string; burnTtl?: number; clientId?: string; sticker?: string }, ack: Ack<{ id?: string; duplicate?: boolean }>) => void;
  /** Reveal a burn message's content (records first view; refused after ttl). */
  'chat:reveal': (p: { messageId: string }, ack: Ack<{ text: string; ttlSec: number; firstAt: number; expiresAt: number; serverNow: number }>) => void;
  /** Post a voice note uploaded via POST /api/rooms/:roomId/voice. */
  'chat:voice': (p: { voiceId: string; durationMs: number; parentId?: string }, ack: Ack) => void;
  'trivia:start': (p: { count: number; category: string }, ack: Ack<{ state: TriviaState }>) => void;
  'trivia:answer': (p: { roundId: string; index: number; choice: number }, ack: Ack) => void;
  'trivia:stop': (ack: Ack) => void;
  'trivia:get': (ack: Ack<{ state: TriviaState | null; myChoice: number | null; board: TriviaScore[] }>) => void;
  'fx:play': (p: { id: string }, ack: Ack) => void;
  'board:stroke': (p: { id: string; color: BoardColor; points: [number, number][] }) => void;
  'board:undo': (p: { id: string }) => void;
  'board:clear': () => void;
  'chat:edit': (p: { messageId: string; text: string }, ack: Ack) => void;
  'chat:delete': (p: { messageId: string }, ack: Ack) => void;
  'chat:typing': (p: { typing: boolean }) => void;
  'chat:pin': (p: { messageId: string; pinned: boolean }, ack: Ack) => void;
  /** room managers / staff: earlier versions of an edited message, oldest first */
  /** batch C: same, from the mod queue (staff anywhere; room managers for their own rooms) */
  'roomappeal:status': (p: { roomId: string }, ack: Ack<{ banned: boolean; ban?: { id: number; reason: string | null; expiresAt: number | null }; appeal?: RoomAppealInfo | null; canAppeal?: boolean }>) => void;
  'roomappeal:submit': (p: { roomId: string; text: string }, ack: Ack<{ appeal: RoomAppealInfo }>) => void;
  /** batch E4: unsent drafts (accounts), keyed by room and thread ('' = main chat) */
  'draft:get': (p: { roomId: string }, ack: Ack<{ drafts: { threadId: string; text: string; updatedAt: number }[] }>) => void;
  'draft:save': (p: { roomId: string; threadId?: string; text: string; at?: number }, ack: Ack<{ updatedAt: number | null }>) => void;
  /** batch F6: room owner starts/stops recording a voice room */
  'rec:start': (p: Record<string, never>, ack: Ack<{ rec: RecState; maxBytes: number }>) => void;
  'rec:stop': (p: Record<string, never>, ack: Ack) => void;
  /** batch F7: a speaker shares live captions (browser speech recognition) as text */
  'caption:send': (p: { text: string; final: boolean }, ack?: Ack) => void;
  'roomappeal:decide': (p: { appealId: number; decision: 'approve' | 'deny'; note?: string }, ack: Ack<{ decision: 'approved' | 'denied' }>) => void;
  'modq:history': (p: { messageId: string }, ack: Ack<{ versions: { text: string; at: number }[]; current: { text: string; at: number } }>) => void;
  'chat:history': (p: { messageId: string }, ack: Ack<{ versions: { text: string; at: number }[]; current: { text: string; at: number } }>) => void;
  // ---- stage mode ----
  /** owner / site staff: turn stage mode on or off, set the speaker cap */
  'stage:set': (p: { on?: boolean; cap?: number }, ack: Ack<{ stage: StageState }>) => void;
  /** audience: raise or lower your hand */
  'stage:hand': (p: { up: boolean }, ack: Ack) => void;
  /** room managers: bring someone up to speak */
  'stage:invite': (p: { userId: string }, ack: Ack) => void;
  /** room managers: move a speaker down or lower a hand; anyone: step down yourself (own id) */
  'stage:down': (p: { userId: string }, ack: Ack) => void;
  'chat:thread': (p: { messageId: string }, ack: Ack<{ messages: ChatMessage[] }>) => void;
  'chat:react': (p: { messageId: string; emoji: string }, ack: Ack<{ reactions: ReactionCount[] }>) => void;
  'pm:send': (p: { toId: string; text: string }, ack: Ack<{ message: PrivateMessage }>) => void;
  'media:state': (p: { cam: boolean; mic: boolean; screen?: boolean }, ack: Ack) => void;
  'room:lock': (p: { locked: boolean }, ack: Ack) => void;
  'room:slowmode': (p: { seconds: number }, ack: Ack) => void;
  'room:purge': (p: { minutes?: number }, ack: Ack) => void;
  /** owner or mod. Blank password clears it. */
  'room:password': (p: { password: string }, ack: Ack) => void;
  /** Watch party: load a link, play, pause, seek, or clear. Anyone in the room unless locked. */
  'watch:update': (p: WatchUpdate, ack: Ack) => void;
  /** Room creator only. Restrict watch-party control to the creator and moderators. */
  'watch:lock': (p: { locked: boolean }, ack: Ack) => void;
  /** Start a whisper with people in your room (2-5 participants including you). */
  'whisper:start': (p: { userIds: string[] }, ack: Ack<{ whisper: WhisperInfo }>) => void;
  /** Participant adds someone else from the room. */
  'whisper:receipts': (p: { on?: boolean }, ack: Ack<{ on: boolean }>) => void;
  'whisper:seen': (p: { whisperId: string; messageId: string }) => void;
  'whisper:add': (p: { whisperId: string; userId: string }, ack: Ack<{ whisper: WhisperInfo }>) => void;
  'whisper:send': (p: { whisperId: string; text: string }, ack: Ack<{ message: WhisperMessage }>) => void;
  'whisper:leave': (p: { whisperId: string }, ack: Ack) => void;
  /** room creator only. Which bots may join this room. */
  'room:bots': (ack: Ack<{ bots: { id: number; name: string }[] }>) => void;
  /** room creator only. Allow a bot by its display name. */
  'room:bot-allow': (p: { name: string }, ack: Ack<{ bot: { id: number; name: string } }>) => void;
  /** room creator only. Remove a bot's allow and drop it from the room. */
  'room:bot-remove': (p: { botId: number }, ack: Ack) => void;
  /** Anyone in the room. Server enforces the 3 second per-user cooldown. */
  'sound:play': (p: { id: string }, ack: Ack) => void;
  // friends + 1:1 calls (registered users)
  'friends:list': (ack: Ack<{ friends: FriendEntry[]; pendingIn: FriendEntry[]; pendingOut: FriendEntry[] }>) => void;
  'friends:request': (p: { username: string }, ack: Ack<{ friend: FriendEntry }>) => void;
  'friends:respond': (p: { userId: number; accept: boolean }, ack: Ack) => void;
  'friends:remove': (p: { userId: number }, ack: Ack) => void;
  'call:invite': (p: { userId: number }, ack: Ack<{ roomId: string; room: RoomState }>) => void;
  'call:respond': (p: { roomId: string; accept: boolean }, ack: Ack<{ room?: RoomState }>) => void;
  'rtc:signal': (p: { to: string; data: SignalData }) => void;
  // site moderation (moderator/admin)
  'mod:camoff': (p: { userId: string; minutes?: number }, ack: Ack) => void;
  'mod:delete': (p: { messageId: string }, ack: Ack) => void;
  'mod:mute': (p: { userId: string; minutes: number }, ack: Ack) => void;
  'mod:ban': (p: { userId: string; minutes: number | null; reason: string; kinds?: BanKind[] }, ack: Ack) => void;
  /** category + optional note (legacy: free-text reason). Exactly one target. */
  report: (p: { userId?: string; messageId?: string; accountId?: number; roomId?: string; whisperMessageId?: string; category?: ReportCategory; note?: string; reason?: string; notify?: boolean }, ack: Ack<{ reportId: number; updated?: boolean }>) => void;
  // ---- moderation queue ----
  'modq:counts': (ack: Ack<{ counts: QueueCounts }>) => void;
  // smarter lobby
  'lobby:friends': (ack: Ack<{ friends: FriendOnline[] }>) => void;
  'lobby:recent': (ack: Ack<{ rooms: RecentRoom[] }>) => void;
  'lobby:recent:remove': (p: { roomId: string }, ack: Ack) => void;
  'presence:get': (ack: Ack<{ showRoom: boolean }>) => void;
  'presence:set': (p: { showRoom: boolean }, ack: Ack<{ showRoom: boolean }>) => void;
  'blocks:get': (ack: Ack<{ usernames: string[] }>) => void;
  'blocks:set': (p: { usernames: string[] }, ack: Ack<{ usernames: string[] }>) => void;
  /** room owners / room mods (and staff): reports about this room's messages; reporter identity only for site staff */
  /** Recent moderator-bot actions: site staff see all rooms (scope "site"); room owners / room mods see their room. */
  'modq:botlog': (p: { scope: 'site' | 'room' }, ack: Ack<{ actions: { id: number; ts: number; actor: string; action: string; target: string | null; roomId: string | null; details: string | null }[] }>) => void;
  'modq:room:list': (p: { status?: QueueBucket; sort?: QueueSort }, ack: Ack<{ items: QueueItem[]; counts: QueueCounts }>) => void;
  'modq:room:claim': (p: { reportId: number; release?: boolean }, ack: Ack) => void;
  'modq:room:act': (p: { reportId: number; action: QueueAction; minutes?: number | null; reason?: string; note?: string }, ack: Ack<{ resolution: string }>) => void;
  // ---- batch 2 ----
  /** Search this room's history (registered members of the room only). */
  /** Room history search. `from` = a nick (exact, case-insensitive); after / before = ms timestamps. */
  'chat:search': (p: { q: string; offset?: number; from?: string; after?: number; before?: number }, ack: Ack<{ hits: SearchHit[]; hasMore: boolean; offset: number }>) => void;
  /** Search whisper lines you received or sent in this room (memory only, since the last restart). */
  /** Your notification level for the room you are in, plus your push quiet hours (registered users). */
  'notify:get': (ack: Ack<{ level: import('./notify').NotifyLevel; quiet: import('./notify').QuietHours | null }>) => void;
  'notify:set': (p: { level: import('./notify').NotifyLevel }, ack: Ack<{ level: import('./notify').NotifyLevel }>) => void;
  /** Quiet hours for push (start === end, or null, turns them off). */
  'notify:quiet': (p: { start: number; end: number; tz: string } | null, ack: Ack<{ quiet: import('./notify').QuietHours | null }>) => void;
  'whisper:search': (p: { q: string; from?: string; after?: number; before?: number }, ack: Ack<{ hits: WhisperMessage[] }>) => void;
  /** batch A: server-side read markers and the mentions inbox (accounts only) */
  'unread:get': (ack: Ack<{ rooms: Record<string, { n: number; mention: boolean }>; mentions: number }>) => void;
  'room:read': (p: { roomId: string; ts?: number }, ack?: Ack) => void;
  'mentions:list': (ack: Ack<{ items: MentionItem[]; unread: number }>) => void;
  'mentions:read': (p: { ids: number[] | 'all'; read?: boolean }, ack: Ack<{ unread: number }>) => void;
  /** Top-level lines around one message (jump to a search hit or bookmark). */
  'chat:context': (p: { messageId: string }, ack: Ack<{ messages: ChatMessage[]; anchorId: string; threadId?: string }>) => void;
  'bookmark:toggle': (p: { messageId: string; on?: boolean }, ack: Ack<{ bookmarked: boolean }>) => void;
  'bookmark:list': (ack: Ack<{ bookmarks: BookmarkEntry[]; ids: string[] }>) => void;
  'events:list': (ack: Ack<{ events: RoomEventInfo[]; canManage: boolean }>) => void;
  'events:create': (p: { title: string; description?: string; startsAt: number; durationMin?: number | null }, ack: Ack<{ event: RoomEventInfo }>) => void;
  'events:update': (p: { id: string; title: string; description?: string; startsAt: number; durationMin?: number | null }, ack: Ack<{ event: RoomEventInfo }>) => void;
  'events:cancel': (p: { id: string }, ack: Ack) => void;
  'events:rsvp': (p: { id: string; status: 'going' | 'maybe' | 'no' | null }, ack: Ack<{ event: RoomEventInfo }>) => void;
  /** room owner (or site staff): appoint / remove a room moderator by account id */
  'room:mod': (p: { accountId: number; on: boolean }, ack: Ack<{ mods: RoomModInfo[] }>) => void;
  /** owner, room mods and site staff: mute someone in this room's chat */
  'room:mute': (p: { userId: string; minutes: number }, ack: Ack) => void;
  'room:template:apply': (p: { template: string }, ack: Ack<{ filters: unknown }>) => void;
  'roles:get': (p: Record<string, never>, ack: Ack<{ roles: RoomRoleInfo[]; members: Record<string, number>; perms: RoomRolePerm[] }>) => void;
  'roles:save': (p: { id?: number; name: string; color: string | null; perms: RoomRolePerm[] }, ack: Ack<{ role: RoomRoleInfo }>) => void;
  'roles:archive': (p: { id: number }, ack: Ack) => void;
  'roles:assign': (p: { accountId: number; roleId: number | null }, ack: Ack) => void;
  'chat:preview-remove': (p: { messageId: string }, ack: Ack) => void;
  'poll:create': (p: { question: string; options: string[]; durationMin?: number | null; parentId?: string }, ack: Ack<{ poll: PollInfo }>) => void;
  'poll:vote': (p: { pollId: string; option: number }, ack: Ack<{ poll: PollInfo }>) => void;
  'poll:close': (p: { pollId: string }, ack: Ack<{ poll: PollInfo }>) => void;
  // ---- batch 3 ----
  /** batch C: browse page (open rooms only) */
  'rooms:discover': (p: { sort?: import('./discover').DiscoverSort; category?: string; tag?: string; q?: string }, ack: Ack<{ rooms: import('./discover').DiscoverRoom[]; sort: string; trending: import('./discover').DiscoverRoom[]; categories: { category: string; count: number }[]; tags: { tag: string; count: number }[] }>) => void;
  /** batch C: owner / staff toggles audio-only voice room mode */
  'room:voice': (p: { on: boolean }, ack: Ack<{ on: boolean }>) => void;
  'room:meta': (p: { category?: string | null; tags?: string[] | string }, ack: Ack<{ category: string | null; tags: string[] }>) => void;
  /** room owner (or site staff): accent color and welcome message. null clears; omitted keeps. */
  'room:theme:set': (p: { accent?: string | null; welcome?: string | null }, ack: Ack<{ theme: import('./theme').RoomThemeInfo }>) => void;
  'announce:set': (p: { text: string }, ack: Ack<{ announcement: RoomAnnouncement | null }>) => void;
  'schedule:list': (ack: Ack<{ schedules: RoomScheduleInfo[] }>) => void;
  'schedule:create': (p: { text: string; at: number; repeat: string; tz?: string; kind?: 'message' | 'banner' | 'poll'; poll?: { options: string[]; durationMin?: number | null } }, ack: Ack<{ schedule: RoomScheduleInfo }>) => void;
  /** batch B: room word / link filters enforced by the moderator bot */
  'room:filters:get': (ack: Ack<{ filters: RoomFilters; bot: string }>) => void;
  'room:filters:set': (p: { words: string[] | string; links: string; allow: string[] | string }, ack: Ack<{ filters: RoomFilters }>) => void;
  'schedule:delete': (p: { id: string }, ack: Ack) => void;
  'radio:listen': (p: { on: boolean }, ack: Ack<{ np: RadioNowPlaying | null }>) => void;
  'radio:get': (ack: Ack<{ np: RadioNowPlaying | null }>) => void;
  'clip:saved': (p: { userId: string }, ack: Ack) => void;
  'stats:get': (ack: Ack<{ stats: RoomStats }>) => void;
  /** batch F8: members, peak times and growth for this room (owner / room mods) */
  'stats:analytics': (ack: Ack<{ analytics: RoomAnalytics; serverNow: number }>) => void;
}

export interface ServerToClient {
  rooms: (rooms: RoomSummary[]) => void;
  /** batch E4: a draft changed on another device of this account */
  /** batch F6: recording started (rec) or stopped (null, with why) */
  /** batch F7: someone's live caption line (interim lines are replaced by the next one from the same speaker) */
  caption: (p: { roomId: string; id: string; nick: string; text: string; final: boolean; ts: number }) => void;
  'rec:state': (p: { roomId: string; rec: RecState | null; reason?: string }) => void;
  'draft:sync': (p: { roomId: string; threadId: string; text: string; updatedAt: number }) => void;
  // ---- moderation queue ----
  /** a line was auto-hidden pending review, or shown again (with the line to restore) */
  'chat:hidden': (p: { id: string; hidden: boolean; message?: ChatMessage }) => void;
  /** staff: queue counts changed; fresh = a new report arrived */
  'modq:counts': (p: { counts: QueueCounts; fresh?: boolean }) => void;
  /** room managers: this room's report counts */
  'modq:room-counts': (p: { roomId: string; counts: QueueCounts; fresh?: boolean }) => void;
  /** a warning from moderators, or a report outcome */
  'user:notice': (p: { kind: 'warn' | 'report'; text: string; at: number }) => void;
  /** room thumbnail changed (set or removed) */
  'room:thumb': (p: { thumbUrl: string | null; by: string }) => void;
  'room:icon': (p: { iconUrl: string | null; by: string }) => void;
  'room:inviteSettings': (p: { modsCanInvite: boolean; by: string }) => void;
  // ---- batch 3 ----
  'room:meta': (p: { category: string | null; tags: string[] }) => void;
  'room:voice': (p: { on: boolean }) => void;
  'room:theme': (p: { theme: import('./theme').RoomThemeInfo }) => void;
  'room:announcement': (p: { announcement: RoomAnnouncement | null }) => void;
  'room:schedules': (p: { schedules: RoomScheduleInfo[] }) => void;
  'room:emotes': (p: { emotes: RoomEmote[] }) => void;
  'radio:np': (p: { np: RadioNowPlaying }) => void;
  'radio:room': (p: { listening: number }) => void;
  'chat:message': (m: ChatMessage) => void;
  'board:stroke': (s: BoardStroke) => void;
  'board:undo': (p: { id: string }) => void;
  'board:clear': () => void;
  /** Lightweight ping so other clients can badge a room. Not stored. */
  'room:activity': (p: { roomId: string; mentions?: number[] }) => void;
  'mentions:new': (p: { item: MentionItem; unread: number }) => void;
  'roles:update': (p: { roles: RoomRoleInfo[]; members: Record<string, number> }) => void;
  'chat:edited': (p: { id: string; text: string; editedAt: number; mentions?: number[] }) => void;
  'chat:deleted': (p: { id: string }) => void;
  'chat:replies': (p: { messageId: string; replyCount: number }) => void;
  'chat:typing': (p: { id: string; nick: string; typing: boolean }) => void;
  'chat:pins': (p: { pins: ChatMessage[] }) => void;
  'stage:state': (p: StageState) => void;
  /** you were moved to the audience: stop camera / mic / screen */
  'stage:demoted': (p: { by: string }) => void;
  /** batch D: you reached a new level */
  'xp:levelup': (p: { level: number; xp: number }) => void;
  /** batch C: the room became a voice room; stop camera and screen share (mic stays) */
  'media:force': (p: { cam: false; screen: false }) => void;
  'chat:reactions': (p: { messageId: string; reactions: { emoji: string; count: number }[] }) => void;
  'user:joined': (u: UserInfo) => void;
  'user:left': (p: { id: string }) => void;
  /** Same person, new socket, within the reconnect grace. Peers must keep the RTCPeerConnection. */
  'user:moved': (p: { from: string; to: string; user: UserInfo }) => void;
  'user:updated': (u: UserInfo) => void;
  'room:kicked': (p: { roomId: string; by: string; reason?: string }) => void;
  'room:topic': (p: { topic: string; by: string }) => void;
  'room:deleted': (p: { roomId: string }) => void;
  'mod:camoff': (p: { by: string; until: number }) => void;
  'mod:muted': (p: { by: string; until: number }) => void;
  'room:settings': (p: { locked: boolean; slowModeSec: number }) => void;
  'room:access': (p: { passwordRequired: boolean }) => void;
  'room:sounds': (p: { sounds: { id: string; name: string }[] }) => void;
  /** Live play. Not a chat message. Only people in the room right now receive it. */
  'sound:played': (p: { id: string; name: string; by: string }) => void;
  /** full-screen effect (whitelisted id) */
  'fx:played': (p: { id: string; by: string }) => void;
  /** you earned a badge */
  'badge:earned': (p: { id: string }) => void;
  /** someone in your room earned one (toast only, never in the chat log) */
  'badge:toast': (p: { nick: string; id: string }) => void;
  /** Watch party changed. `action` says what happened; `serverNow` lets clients correct skew. */
  'watch:state': (p: { watch: WatchState | null; locked: boolean; action: WatchAction | 'lock'; by: string; serverNow: number }) => void;
  /** Whisper created or its participant list changed. Sent only to participants. */
  'whisper:update': (p: { whisper: WhisperInfo }) => void;
  /** Sent only to participants. */
  'whisper:message': (m: WhisperMessage) => void;
  'whisper:seen': (p: { whisperId: string; messageId: string; by: string; nick: string }) => void;
  /** You are no longer in this whisper (it ended, or you left / left the room). */
  'whisper:ended': (p: { whisperId: string; reason: 'ended' | 'left' }) => void;
  'trivia:state': (s: TriviaState) => void;
  'trivia:progress': (p: { roundId: string; index: number; answered: number; players: number }) => void;
  'trivia:ended': (p: { state: TriviaState; winner: TriviaScore | null; board: TriviaScore[]; stopped: boolean; by?: string }) => void;
  /** a burn message's content was wiped for everyone */
  'chat:burned': (p: { id: string }) => void;
  'friend:update': (p: { type: 'request' | 'accepted' | 'removed' | 'declined'; entry: FriendEntry }) => void;
  /** a friend's lobby presence as this account may see it; entry null = hide them */
  'lobby:friend': (p: { userId: number; entry: FriendOnline | null }) => void;
  'call:incoming': (p: { from: FriendEntry; roomId: string; video?: boolean; convoId?: string; group?: string | null }) => void;
  'call:ended': (p: { roomId: string; reason: string }) => void;
  'session:ended': (p: { reason: string }) => void;
  'account:role': (p: { role: Role }) => void;
  pm: (m: PrivateMessage) => void;
  'rtc:signal': (p: { from: string; data: SignalData }) => void;
  'error:rate': (p: { message: string }) => void;
  // ---- batch 2 ----
  'events:changed': (p: { roomId: string }) => void;
  'event:reminder': (r: EventReminder) => void;
  'room:mods': (p: { mods: RoomModInfo[] }) => void;
  'room:muted': (p: { by: string; until: number; roomId: string }) => void;
  'chat:preview': (p: { messageId: string; preview: LinkPreviewInfo | null }) => void;
  /** live results; no per-viewer myVote */
  'poll:update': (p: { poll: PollInfo }) => void;
  'bookmark:changed': (p: { messageId: string; bookmarked: boolean }) => void;
}

// ---- admin panel API ----
export interface AdminReport {
  id: number; createdAt: number; status: 'open' | 'resolved' | 'dismissed';
  reporterNick: string; targetNick: string | null; targetUserId: number | null; roomId: string | null;
  messageId: string | null; messageText: string | null; reason: string;
  context: { ts: number; from: string; text: string }[];
  handledBy: string | null; handledAt: number | null; hasIp: boolean; hasDevice: boolean;
}
export interface AdminBan {
  id: number; kind: BanKind; value: string; label: string | null; reason: string; createdBy: string;
  createdAt: number; expiresAt: number | null;
}
export interface AdminUser { id: number; username: string; role: Role; createdAt: number; lastLoginAt: number | null; google: boolean; discord: boolean; tiktok: boolean; banned: boolean; chatColor: string | null; chatEffect: string | null; hasAvatar: boolean; email: string | null; emailVerified: boolean }
export interface AdminLogEntry { id: number; ts: number; actor: string; action: string; target: string | null; roomId: string | null; details: string | null }

export interface FriendEntry {
  userId: number;
  username: string;
  status: 'pending' | 'accepted';
  online: boolean;
  /** socket id when online (for PMs / call UI); omitted when offline */
  socketId?: string;
  chatColor?: string | null;
  chatEffect?: string | null;
  hasAvatar?: boolean;
}

export interface CaptchaChallenge {
  mode: 'builtin' | 'turnstile' | 'hcaptcha';
  /** builtin only */
  id?: string;
  question?: string;
  /** third-party site key when configured */
  siteKey?: string;
}

// ---- watch party ----
export type WatchProvider = 'youtube' | 'twitch';
/** youtube video, twitch VOD (seekable), or twitch live channel (no seek). */
export type WatchKind = 'video' | 'vod' | 'live';
export interface WatchState {
  provider: WatchProvider;
  kind: WatchKind;
  /** YouTube video id, Twitch VOD id (digits), or Twitch channel login */
  id: string;
  /** canonical link we rebuilt from provider + id */
  url: string;
  playing: boolean;
  /** position at `updatedAt` */
  positionSec: number;
  /** server clock (ms) when positionSec was true */
  updatedAt: number;
  /** nick of whoever made the last change */
  by: string;
}
export type WatchAction = 'load' | 'play' | 'pause' | 'seek' | 'clear';
export type WatchUpdate =
  | { action: 'load'; url: string }
  | { action: 'play' | 'pause' | 'seek'; positionSec: number }
  | { action: 'clear' };

// ---- batch A: mentions inbox ----
export interface MentionItem {
  id: number;
  kind: 'mention' | 'reply';
  roomId: string;
  roomName: string;
  messageId: string;
  from: string;
  ts: number;
  text: string;
  read: boolean;
}

// ---- whispers (in-room side chats; lines are also kept for member accounts, 30 days) ----
export interface WhisperInfo {
  id: string;
  roomId: string;
  members: { id: string; nick: string }[];
}
export interface WhisperMessage {
  id: string;
  whisperId: string;
  ts: number;
  fromId: string;
  from: string;
  text: string;
}

/** A recorded voice note attached to a chat message. Served only to room members. */
export interface VoiceNoteInfo { id: string; url: string; durationMs: number; mime: string }

/** Room trivia (server-run). The correct option is only present once `phase` is 'reveal' or 'ended'. */
export interface TriviaScore { name: string; points: number; guest?: boolean; wins?: number; rounds?: number }
export interface TriviaState {
  roundId: string;
  by: string;
  category: import('./trivia').TriviaPick;
  total: number;
  /** 0-based question index */
  index: number;
  phase: 'question' | 'reveal' | 'ended';
  question: { text: string; options: string[]; category: import('./trivia').TriviaCategory } | null;
  /** server clock: when answering closes (question) or the next question starts (reveal) */
  endsAt: number;
  serverNow: number;
  questionMs: number;
  answered: number;
  players: number;
  reveal?: { correct: number; counts: number[] };
  /** this round's standings, top 10 */
  scores: TriviaScore[];
}

export interface BurnInfo { ttlSec: number; burned?: boolean; mine?: boolean }

// ---- batch 2: search, bookmarks, events, room roles, push, link previews, polls, profiles ----
export interface RoomEventInfo {
  id: string;
  roomId: string;
  title: string;
  description: string;
  startsAt: number;
  durationMin: number | null;
  createdBy: string;
  going: number;
  maybe: number;
  notGoing: number;
  /** first few people going (for avatars) */
  goingUsers: { accountId: number; nick: string; hasAvatar: boolean; chatColor: string | null }[];
  myRsvp?: 'going' | 'maybe' | 'no';
}
export interface EventReminder {
  eventId: string;
  roomId: string;
  roomName: string;
  title: string;
  startsAt: number;
  stage: 'soon' | 'start';
  passwordRequired: boolean;
}
export interface RoomModInfo { accountId: number; username: string }
export interface SearchHit { message: ChatMessage; /** top-level id to open as a thread when the hit is a reply */ threadId?: string }
export interface BookmarkEntry { message: ChatMessage; roomId: string; roomName: string; savedAt: number }
export interface LinkPreviewInfo {
  id: string;
  url: string;
  kind: 'page' | 'youtube' | 'twitch' | 'x' | 'image';
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** same-origin proxied image URL, or null */
  image: string | null;
}
export interface PollInfo {
  id: string;
  messageId: string;
  question: string;
  options: { text: string; votes: number }[];
  total: number;
  closesAt: number | null;
  closed: boolean;
  createdBy: string;
  /** this viewer's choice (only in acks / per-viewer payloads) */
  myVote?: number | null;
}
export interface PublicProfile {
  id: number;
  username: string;
  role: Role;
  chatColor: string | null;
  chatEffect: string | null;
  hasAvatar: boolean;
  bio: string;
  badges: string[];
  joinedAt: number;
  rooms: { id: string; name: string }[];
  friend: 'self' | 'none' | 'friends' | 'pending-in' | 'pending-out';
  online: boolean;
  /** socket id when online, for private messages */
  socketId?: string;
  /** batch D: XP level, null when hidden or none yet */
  level?: number | null;
  /** batch C: profiles 2.0 */
  bannerUrl?: string | null;
  links?: { label: string; url: string }[];
  nowPlaying?: string | null;
  mutualFriends?: { id: number; username: string; hasAvatar: boolean }[];
  mutualRooms?: { id: string; name: string }[];
}

/** batch F6: live recording notice */
export interface RecState { id: string; by: string; startedAt: number; maxMs: number }

/** batch F8 (days are UTC day numbers: floor(ms / 86400000)) */
export interface RoomAnalytics {
  days: { day: number; active: number; chatters: number; guests: number; newMembers: number; peak: number; messages: number }[];
  peakByHour: [number, number, number][];
  totals: { members: number; active7: number; activePrev7: number; growthPct: number | null; new7: number; new30: number; returning7: number; peak30: number };
}

/** Batch G4: custom room roles */
export type RoomRolePerm = 'messages' | 'pin' | 'mute' | 'kick' | 'floor' | 'webhooks';
export interface RoomRoleInfo { id: number; name: string; color: string | null; perms: RoomRolePerm[] }
