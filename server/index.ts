import './quiet';
import http from 'http';
import { createHash, randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import { readReleaseInfo } from './release';
import * as repo4 from './repo4';
import * as repo5 from './repo5';
import * as repo6 from './repo6';
import * as repo7 from './repo7';
import * as repo8 from './repo8';
import { APPEAL_MAX, APPEAL_MIN, type RoomAppealInfo } from '../shared/appeals';
import { dupKey, XP_COOLDOWN_MS, XP_MIN_CHARS, XP_PER_MESSAGE } from '../shared/xp';
import { isDiscoverSort, trendingScore, type DiscoverRoom } from '../shared/discover';
import { blockedLink, cleanDomains, cleanWords, isLinkMode, matchWord } from '../shared/filters';
import { EMOTE_NAME_RE } from '../shared/batch3';
import { accentReadable, roomBannerUrl, THEME_ACCENT_RE, THEME_WELCOME_MAX, type RoomThemeInfo } from '../shared/theme';
import { inQuietHours, isNotifyLevel, validTz } from '../shared/notify';
import { Server, Socket } from 'socket.io';
import { BRAND_NAME, DEFAULT_ROOMS, LIMITS } from '../shared/config';
import { gifMarkdown } from '../shared/gifs';
import type { BanKind, BoardColor, BoardStroke, ChatMessage, ClientToServer, PrivateMessage, Role, RoomState, RoomSummary, ServerToClient, UserInfo, WatchAction, WatchState, WhisperInfo, WhisperMessage, VoiceNoteInfo, TriviaScore } from '../shared/types';
import { WHISPER_MIN_MEMBERS, whisperAddError } from '../shared/whisper';
import { canControlWatch, cleanPosition, parseWatchUrl } from '../shared/watch';
import { publicChatEffect } from '../shared/colors';
import { isReactionEmoji } from '../shared/reactions';
import { migrate } from './db';
import {
  ADMIN_USERNAMES, CORS_ORIGINS, DATA_DIR, GUEST_CAM_AFTER_MINUTES, HOST, isProd, MAX_CONN_PER_IP, MOD_BOT_PRESENCE_MS, PORT, PUBLIC_URL, RECONNECT_GRACE_MS, TURN_SECRET, TURN_URLS,
  gifsEnabled, BADGE_THRESHOLD_DIV,
} from './env';
import { gifById } from './gifs';
import { COOKIE_SID, checkSecret, createApp, deviceIdsOf, hashSecret, iceServers, isStaffRole } from './http';
import * as recs from './recordings';
import { live, type BotFeedQuery, type BotIdentity, type BotModBody, type BotModMessage, type BotResult, type BotRoomLine } from './live';
import { deleteRoomSoundFiles, soundPlayAllowed } from './sounds';
import { deleteVoiceForMessages, deleteVoiceForRoom, isVoiceUploader, sweepVoiceNotes } from './voiceNotes';
import { TriviaRound, pickQuestions, type TriviaPlayer } from './trivia';
import { canPlayTrivia, isTriviaCount, isTriviaPick, TRIVIA_PAUSE_MS, TRIVIA_QUESTION_MS, TRIVIA_TOP } from '../shared/trivia';
import { BADGES, badgeById, crossedBadges, hourIn, isNightOwlHour, isValidTimeZone, shownBadges, type BadgeDef, type BadgeStat } from '../shared/badges';
import { fxCooldown, isFxId, fxSlashCommand } from '../shared/fx';
import { BURN_HARD_MS, burnExpired, burnRevealAllowed, isBurnTtl } from '../shared/burn';
import { claimChatImagesInText, deleteImagesForMessages, deleteImagesForRoom, sweepChatImages } from './chatImages';
import { fmtVoiceDuration, VOICE_MAX_MS, VOICE_MIN_MS } from '../shared/voice';
import { countLinks, hasFilteredWord, maskWords } from './moderation';
import { clientIp, originAllowed, parseCookies } from './net';
import { KeyedLimiter, RateLimiter } from './rateLimit';
import * as repo from './repo';
import { cleanText, isValidNick, isValidRoomName } from './validate';
import { roomEntryError } from './gate';
import { crashTestHooks, guardSocketHandlers, guardTimer, installProcessGuards } from './guard';
import { initBackups } from './backup';
import * as repo2 from './repo2';
import { EVENT_KEEP_PAST_MS, EVENT_MAX_UPCOMING, EVENT_REMIND_LEAD_MS, EVENT_SOON_MS, isRsvp, reminderStages, validateEvent } from '../shared/events';
import { pollFallbackText, validatePoll } from '../shared/polls';
import { firstPreviewUrl, getPreview, previewInfo } from './linkPreview';
import { pushToUser } from './push';
import type { EventReminder, MentionItem, LinkPreviewInfo, PollInfo, RoomEventInfo, RoomModInfo, SearchHit } from '../shared/types';
import { deleteRoomThumb, sweepRoomThumbs } from './roomThumbs';
import { roomThumbUrl } from '../shared/roomThumbs';
import { deleteRoomIcon, sweepRoomIcons } from './roomIcons';
import { roomIconUrl } from '../shared/roomIcons';
import { isViewPref } from '../shared/videoQuality';
import * as invites from './invites';
import * as repo3 from './repo3';
import { ANNOUNCE_MAX, cleanTags, emoteUrl, HOUR_MS, isRoomCategory, isScheduleRepeat, SCHEDULE_GRACE_MS, SCHEDULE_MAX_AHEAD_MS, SCHEDULE_TEXT_MAX, SCHEDULES_PER_ROOM } from '../shared/batch3';
import type { RoomAnnouncement, RoomEmote, RoomScheduleInfo, RecState } from '../shared/types';
import { deleteEmoteFile, sweepEmoteFiles } from './roomEmotes';
import { getNowPlaying, initRadio, syncRadioPolling } from './radio';
import * as modq from './modq';
import * as lobby from './lobby';
import { LOBBY, activityScore, type FriendOnline, type RecentRoom } from '../shared/lobby';
import { MODQ, REPORT_CATEGORY_LABELS, REPORTER_THANKS, isReportCategory, type QueueAction, type ReportAttachment, type ReportContextLine, type ReportSnapshot } from '../shared/modq';
import { uploadPath } from './chatImages';
import { clampStageCap, sdpPublishes, STAGE_CAP_DEFAULT, type StageState } from '../shared/stage';
import { voiceFilePath } from './voiceNotes';

// Log stray rejections; exit cleanly on an uncaught throw (systemd restarts). Handler-level guards make this rare.
installProcessGuards();

// ---------- startup: database ----------
migrate();
repo.promoteBootstrapAdmins();
{
  // batch E: rollback-safe two-factor storage
  const moved = repo.hardenPendingSessions();
  if (moved) console.log(`[2fa] moved ${moved} pending sign-in(s) under the mfa: prefix`);
  for (const r of repo8.passkeyUsers()) repo8.syncPasskeyMarker(r);
  const sealed = repo8.sealPlaintextSecrets();
  if (sealed) console.log(`[2fa] encrypted ${sealed} TOTP secret(s) with CAMCHAT_SECRET_KEY`);
  const st = repo8.secretStatus();
  if (!st.keySet) console.warn(`[2fa] CAMCHAT_SECRET_KEY is ${st.keyTooShort ? 'too short (min 32 characters)' : 'not set'}: TOTP secrets are stored unencrypted${st.encrypted ? `; ${st.encrypted} sealed secret(s) cannot be read until it is restored` : ''}`);
  else if (st.unreadable) console.warn(`[2fa] ${st.unreadable} TOTP secret(s) were sealed with a different key; those users need recovery codes`);
}
for (const id of repo.ephemeralRoomIds()) { deleteRoomSoundFiles(id); deleteVoiceForRoom(id); deleteImagesForRoom(id); }
const removed = repo.deleteEphemeralRooms();
if (removed) console.log(`[db] removed ${removed} leftover guest room(s)`);
{
  const existing = new Set(repo.allRooms().map((r) => r.id));
  for (const r of DEFAULT_ROOMS) {
    const id = slug(r.name);
    if (!existing.has(id) && !repo.roomNameTaken(r.name))
      repo.insertRoom({ id, name: r.name, topic: r.topic, owner_user_id: null, owner_nick: null, permanent: 1, persistent: 1 });
  }
}

// ---------- in-memory live state ----------
interface Room {
  id: string;
  name: string;
  topic: string;
  ownerUserId: number | null;
  ownerNick: string | null; // display name of owner (username or guest nick); null = system room
  permanent: boolean;
  persistent: boolean;
  locked: boolean;
  slowModeSec: number;
  isPrivate: boolean;
  /** bcrypt hash; null = open. Never send this to clients. */
  passwordHash: string | null;
  /** custom lobby thumbnail (random id), null = default card */
  thumbId: string | null;
  /** custom room icon (random id), null = first letter */
  iconId: string | null;
  /** batch 3 */
  category: string | null;
  tags: string[];
  announcement: RoomAnnouncement | null;
  /** for private call rooms: the two account ids allowed to join */
  callPeers: [number, number] | null;
  members: Set<string>; // socket ids
  /** recent join/leave/moderation notices (not persisted) */
  notices: ChatMessage[];
  /** last chat timestamps for slow mode: socket id -> ms */
  lastChatAt: Map<string, number>;
  /** whiteboard strokes; cleared when the room has no members. Not stored. */
  board: BoardStroke[];
  /** last soundboard play, user key -> ms. Not stored. */
  soundLast: Map<string, number>;
  /** full-screen effects: last play per user key, and room-wide. Not stored. */
  fxLast: Map<string, number>;
  fxRoomLast: number;
  /** synced watch party; cleared when the room empties. Not stored. */
  watch: WatchState | null;
  /** creator toggle: only creator + moderators control the watch party. Not stored. */
  watchLocked: boolean;
  /** whisper id -> participant socket ids. Memory only; nobody else (mods included) can read them. */
  whispers: Map<string, Set<string>>;
  /** the running trivia round, if any (one per room) */
  trivia: TriviaRound | null;
  /** guest trivia totals by lowercase nick; memory only, never stored */
  triviaGuests: Map<string, { name: string; points: number; wins: number; rounds: number }>;
  /** account ids of room moderators appointed by the owner (stored in room_mods) */
  mods: Set<number>;
  /** stage mode: on / cap stored; invited speakers and raised hands (by user key) live in memory */
  stage: { on: boolean; cap: number; speakers: Set<string>; hands: Map<string, number> };
  /** batch C: audio-only voice room (no cameras / screen share; raise-hand talk queue) */
  voice: boolean;
}
interface Session {
  user: UserInfo | null;
  roomId: string | null;
  account: repo.Account | null;
  ip: string;
  deviceIds: string[];
  connectedAt: number;
  linkTimes: number[];
  /** IANA zone the client reported at login (Night Owl); null = server local */
  tz?: string | null;
  /** On Air tracking: when cam/mic/screen went on (or was last flushed) */
  airSince?: number | null;
}
type AppSocket = Socket<ClientToServer, ServerToClient>;

const rooms = new Map<string, Room>();
const sessions = new Map<string, Session>();
const nicksInUse = new Map<string, string>(); // lowercase nick -> socket id
const botUsers = new Map<string, UserInfo>();
const botRooms = new Map<number, Set<string>>();
/** batch E5: clientId -> posted message, so a resent outbox line is not posted twice (10 min, at most 20k) */
const sentClientIds = new Map<string, { id: string; at: number }>();
function rememberClientId(key: string, id: string) {
  const now = Date.now();
  sentClientIds.set(key, { id, at: now });
  if (sentClientIds.size > 20_000) for (const [k, v] of sentClientIds) { if (now - v.at > 600_000 || sentClientIds.size > 15_000) sentClientIds.delete(k); else break; }
}
setInterval(() => { const now = Date.now(); for (const [k, v] of sentClientIds) { if (now - v.at > 600_000) sentClientIds.delete(k); else break; } }, 60_000).unref();
const botPostRl = new KeyedLimiter(LIMITS.chatBurst, LIMITS.chatWindowMs);
/** batch C: browse page queries per IP */
const discoverRl = new KeyedLimiter(30, 10_000);
/** watch-party control: ~5 actions per second per user */
const watchRl = new KeyedLimiter(5, 1000);
const accountSockets = new Map<number, string>(); // account id -> socket id
const connsPerIp = new Map<string, number>();
/** cam blocks from "force cam off": key (u:/g: user key or d:device) -> until */
const camBlocks = new Map<string, number>();
/** default speaker cap for stage mode (env STAGE_SPEAKER_CAP, 2-8) */
const STAGE_CAP_ENV = clampStageCap(process.env.STAGE_SPEAKER_CAP, STAGE_CAP_DEFAULT);

function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room';
}
function loadRoom(r: repo.RoomRow): Room {
  const room: Room = {
    id: r.id, name: r.name, topic: r.topic, ownerUserId: r.owner_user_id,
    ownerNick: r.owner_user_id ? repo.userById(r.owner_user_id)?.username ?? r.owner_nick : r.owner_nick,
    permanent: !!r.permanent, persistent: !!r.persistent,
    locked: !!r.locked, slowModeSec: r.slow_mode_sec || 0, isPrivate: !!r.is_private,
    passwordHash: r.password_hash || null,
    thumbId: r.thumb_id || null,
    iconId: r.icon_id || null,
    category: isRoomCategory(r.category) ? r.category : null,
    tags: repo3.parseTags(r.tags),
    announcement: r.announcement && r.announcement_at ? { text: r.announcement, at: r.announcement_at, by: r.announcement_by ?? '' } : null,
    callPeers: null, members: new Set(), notices: [], lastChatAt: new Map(), board: [], soundLast: new Map(), fxLast: new Map(), fxRoomLast: 0, watch: null, watchLocked: false, whispers: new Map(), trivia: null, triviaGuests: new Map(),
    mods: new Set(),
    stage: { on: !!r.stage_mode && !r.is_private, cap: clampStageCap(r.stage_cap, STAGE_CAP_ENV), speakers: new Set(), hands: new Map() },
    voice: !!r.voice && !r.is_private,
  };
  rooms.set(room.id, room);
  return room;
}
repo.allRooms().forEach(loadRoom);
for (const r of repo2.allRoomMods()) rooms.get(r.room_id)?.mods.add(r.user_id);
/** Lobby tags: next event within 24 h, and events running now. Refreshed by eventTick(). */
const eventsSoonCache = new Map<string, { title: string; startsAt: number }>();
const eventsLiveCache = new Map<string, { title: string; startsAt: number }>();

const identOf = (s: Session): repo.Ident => ({ userId: s.account?.id ?? null, nick: s.user?.nick ?? '', ip: s.ip, deviceIds: s.deviceIds });
const roleOf = (s: Session): Role => s.account?.role ?? 'guest';
const rank: Record<Role, number> = { guest: 0, user: 1, moderator: 2, admin: 3 };
const isStaff = (s: Session) => isStaffRole(roleOf(s));
const isOwner = (s: Session, room: Room) =>
  room.ownerUserId ? s.account?.id === room.ownerUserId : !!room.ownerNick && !s.account && s.user?.nick === room.ownerNick;
/** room moderator appointed by the owner (registered accounts only) */
const isRoomMod = (s: Session, room: Room) => !!s.account && room.mods.has(s.account.id);
/** site staff, the room owner, or a room moderator: the room-level moderation powers */
const canRoomManage = (s: Session, room: Room) => isStaff(s) || isOwner(s, room) || isRoomMod(s, room);
// ---------- stage mode ----------
const stageKey = (s: Session) => repo.userKey(identOf(s));
/** may publish camera / mic / screen in this room right now */
const isStageSpeaker = (s: Session, room: Room) => !room.stage.on || canRoomManage(s, room) || room.stage.speakers.has(stageKey(s));
function stageStateOf(room: Room): StageState {
  const speakers: string[] = [];
  const hands: StageState['hands'] = [];
  if (room.stage.on || room.voice) {
    for (const id of room.members) {
      const m = sessions.get(id);
      if (!m?.user) continue;
      if (room.stage.on && isStageSpeaker(m, room)) speakers.push(id);
      else if (room.stage.on || room.voice) {
        const at = room.stage.hands.get(stageKey(m));
        if (at != null) hands.push({ id, nick: m.user.nick, at });
      }
    }
    hands.sort((a, b) => a.at - b.at);
  }
  return { on: room.stage.on, cap: room.stage.cap, speakers, hands };
}
function emitStage(room: Room) {
  io.to(`room:${room.id}`).emit('stage:state', stageStateOf(room));
}
/** Move one member to the audience: drop their media flags and tell their client to stop sending. */
function stageDemote(room: Room, id: string, by: string) {
  const m = sessions.get(id);
  if (!m?.user) return;
  const had = m.user.cam || m.user.mic || m.user.screen;
  if (had) {
    m.user = { ...m.user, cam: false, mic: false, screen: false };
    io.to(`room:${room.id}`).emit('user:updated', m.user);
    airTrack(id, m);
  }
  io.to(id).emit('stage:demoted', { by });
}
const stagePublishers = (room: Room) => roomUsers(room).filter((u) => u.cam || u.mic || u.screen).length;
const stageSpeakerCount = (room: Room) => stageStateOf(room).speakers.length;

/** staff can act on lower ranks; room owners can act on non-staff in their room; room mods on regular members only */
function canModerate(actor: Session, target: Session, room: Room | null, ownerAllowed: boolean): boolean {
  if (actor === target) return false;
  if (isStaff(actor)) return rank[roleOf(actor)] > rank[roleOf(target)];
  if (!ownerAllowed || !room) return false;
  if (isOwner(actor, room)) return !isStaff(target);
  if (isRoomMod(actor, room)) return !isStaff(target) && !isOwner(target, room) && !isRoomMod(target, room);
  return false;
}
function actorLabel(s: Session) { return s.account?.username ?? s.user?.nick ?? 'unknown'; }
function profileOf(account: repo.Account | null): Pick<UserInfo, 'accountId' | 'chatColor' | 'chatEffect' | 'hasAvatar'> {
  if (!account) return {};
  return { accountId: account.id, chatColor: account.chatColor, chatEffect: publicChatEffect(account.chatEffect), hasAvatar: account.hasAvatar };
}
function makeUser(socketId: string, nick: string, role: Role, registered: boolean, account: repo.Account | null): UserInfo {
  const u: UserInfo = { id: socketId, nick, cam: false, mic: false, screen: false, role, registered, ...profileOf(account) };
  if (account) { const b = badgesShownFor(account.id); if (b.length) u.badges = b; const lv = levelShownFor(account.id); if (lv) u.level = lv; }
  return u;
}
// ---------- XP and levels (batch D) ----------
const XP_COOLDOWN = Math.max(0, Number(process.env.XP_COOLDOWN_MS ?? XP_COOLDOWN_MS));
function levelShownFor(userId: number): number | undefined {
  try { return repo8.shownLevel(repo.userById(userId)); } catch { return undefined; }
}
/** Push the shown level into every live session of this account. */
function refreshLevel(userId: number) {
  const lv = levelShownFor(userId);
  for (const s of sessions.values()) {
    if (s.account?.id !== userId || !s.user) continue;
    if (lv) s.user.level = lv; else delete s.user.level;
    if (s.roomId) io.to(`room:${s.roomId}`).emit('user:updated', s.user);
  }
}
/** XP for a chat line, if the anti-spam rules allow it (see shared/xp.ts). */
function maybeXp(socketId: string, s: Session, room: Room, text: string) {
  const uid = badgeEarner(socketId, s);
  if (uid == null) return;
  const key = dupKey(text);
  if (key.length < XP_MIN_CHARS) return;
  // talking to yourself earns nothing: another person must be in the room
  const others = [...room.members].filter((id) => id !== socketId && !id.startsWith('bot:') && sessions.get(id)?.user).length;
  if (others === 0) return;
  const r = repo8.tryAwardXp(uid, XP_PER_MESSAGE, repo8.hashKey(key), Math.max(XP_COOLDOWN, room.slowModeSec * 1000));
  if ('reason' in r && r.reason) return;
  const ok = r as { xp: number; level: number; leveledUp: boolean };
  if (ok.leveledUp) {
    refreshLevel(uid);
    io.to(socketId).emit('xp:levelup', { level: ok.level, xp: ok.xp });
  } else if (!s.user?.level && !repo.userById(uid)?.xp_hidden) refreshLevel(uid);
}

// ---------- badges (cosmetic; registered accounts only, never bots) ----------
/** Test-only: divide every threshold (default 1 = real thresholds). */
const BADGE_DIV = BADGE_THRESHOLD_DIV;
function badgesShownFor(userId: number): string[] {
  try { return shownBadges(repo.shownBadgeChoice(userId), repo.badgesFor(userId).map((b) => b.id)); } catch { return []; }
}
/** account id that may earn badges for this socket, or null (guest / bot) */
function badgeEarner(socketId: string, s: Session | undefined): number | null {
  if (!s?.account || !s.user || socketId.startsWith('bot:') || !s.user.registered) return null;
  return s.account.id;
}
/** Push the current shown badges into every live session of this account. */
function refreshBadges(userId: number) {
  const shown = badgesShownFor(userId);
  for (const [sid, s] of sessions) {
    if (s.account?.id !== userId || !s.user) continue;
    if (shown.length) s.user.badges = shown; else delete s.user.badges;
    if (s.roomId) io.to(`room:${s.roomId}`).emit('user:updated', s.user);
    void sid;
  }
}
function grantBadge(userId: number, b: BadgeDef) {
  if (!repo.awardBadge(userId, b.id, Date.now())) return;
  refreshBadges(userId);
  for (const [sid, s] of sessions) {
    if (s.account?.id !== userId || !s.user) continue;
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;
    sock.emit('badge:earned', { id: b.id });
    if (s.roomId) sock.to(`room:${s.roomId}`).emit('badge:toast', { nick: s.user.nick, id: b.id });
  }
}
/** Increment a counter (single UPSERT) and award any badge whose threshold was just crossed. */
function bumpStat(userId: number | null, stat: BadgeStat, delta = 1) {
  if (userId == null || delta <= 0) return;
  try {
    const after = repo.bumpStat(userId, stat, delta);
    for (const b of crossedBadges(stat, after - delta, after, BADGE_DIV)) grantBadge(userId, b);
  } catch (err) { console.error('[badges]', (err as Error).message); }
}
/** Set an absolute counter (friends) and award if at/over the threshold. */
function setStat(userId: number, stat: BadgeStat, value: number) {
  try {
    const prev = repo.setStat(userId, stat, value);
    for (const b of crossedBadges(stat, Math.min(prev, value - 1), value, BADGE_DIV)) grantBadge(userId, b);
  } catch (err) { console.error('[badges]', (err as Error).message); }
}
/** Coarse On Air accounting: call after any cam/mic/screen change, on leave, and from the periodic flush. */
function airTrack(socketId: string, s: Session | undefined, now = Date.now()) {
  if (!s) return;
  const on = !!s.user && !!s.roomId && (s.user.cam || s.user.mic || s.user.screen);
  const uid = badgeEarner(socketId, s);
  if (s.airSince != null && uid != null) {
    const sec = Math.floor((now - s.airSince) / 1000);
    if (sec > 0) { bumpStat(uid, 'onair_sec', sec); s.airSince += sec * 1000; }
  }
  if (!on) s.airSince = null;
  else if (s.airSince == null) s.airSince = now;
}

function userOf(id: string): UserInfo | null {
  return botUsers.get(id) ?? sessions.get(id)?.user ?? null;
}
function botUserId(botId: number) { return `bot:${botId}`; }
function roomUsers(room: Room): UserInfo[] {
  return [...room.members].map(userOf).filter((u): u is UserInfo => !!u);
}
/** In-memory last-seen for the moderator bot. Not a room member, so lobby counts ignore it. */
type ModSeen = { botId: number; name: string; timer: NodeJS.Timeout };
let modSeen: ModSeen | null = null;
function modBotInfo(botId: number, name: string): UserInfo {
  return { id: botUserId(botId), nick: name, cam: false, mic: false, screen: false, role: 'user', registered: false, modBot: true };
}
function activeModGhost(): UserInfo | null {
  if (!modSeen || repo.moderatorBotId() !== modSeen.botId) return null;
  return modBotInfo(modSeen.botId, modSeen.name);
}
/** People-list payload. Membership (and therefore the lobby count) stays in roomUsers. */
function roomUsersWithGhost(room: Room): UserInfo[] {
  const users = roomUsers(room);
  const ghost = activeModGhost();
  if (!ghost || room.members.has(ghost.id)) return users;
  return [ghost, ...users];
}
// lobby activity state (declared early: summary() reads it)
/** Messages per room in the last 10 minutes (timestamps; memory only). */
const recentMsgTs = new Map<string, number[]>();
/** Scores are recomputed on a timer only, so list broadcasts never carry a fresher score than ACTIVITY_TICK_MS allows. */
const ACTIVITY_TICK_MS = Math.max(1000, Number(process.env.ACTIVITY_TICK_MS) || LOBBY.activityTickMs);
let activityCache = new Map<string, number>();
function summary(room: Room): RoomSummary {
  const users = roomUsers(room);
  return {
    id: room.id, name: room.name, topic: room.topic, users: users.length,
    broadcasters: users.filter((u) => u.cam || u.mic || u.screen).length, permanent: room.permanent, persistent: room.persistent,
    passwordRequired: !!room.passwordHash,
    ...(room.voice ? { voice: true } : {}),
    ...(eventsSoonCache.has(room.id) ? { eventSoon: eventsSoonCache.get(room.id)! } : {}),
    ...(eventsLiveCache.has(room.id) ? { eventLive: eventsLiveCache.get(room.id)! } : {}),
    ...(room.thumbId && !room.isPrivate ? { thumbUrl: roomThumbUrl(room.thumbId) } : {}),
    ...(room.iconId && !room.isPrivate ? { iconUrl: roomIconUrl(room.iconId) } : {}),
    ...(room.category ? { category: room.category } : {}),
    ...(room.tags.length ? { tags: room.tags } : {}),
    ...(activityOf(room) ? { activity: activityOf(room), ...(activityOf(room) >= LOBBY.activeMin ? { active: true } : {}) } : {}),
  };
}
function roomModsOf(room: Room): RoomModInfo[] {
  return repo2.roomModList(room.id).map((r) => ({ accountId: r.user_id, username: r.username }));
}
function roomState(room: Room, s: Session): RoomState {
  return {
    id: room.id, name: room.name, topic: room.topic, ownerNick: room.ownerNick, permanent: room.permanent, persistent: room.persistent,
    lastReadTs: s.account ? repo5.readTs(s.account.id, room.id) : null,
    users: roomUsersWithGhost(room), history: history(room, repo.userKey(identOf(s)), s), canModerate: isStaff(s), isOwner: isOwner(s, room), camAllowedAt: camAllowedAt(s),
    locked: room.locked, slowModeSec: room.slowModeSec, isPrivate: room.isPrivate, passwordRequired: !!room.passwordHash,
    pins: pinsOf(room.id, repo.userKey(identOf(s))),
    stage: stageStateOf(room),
    voice: room.voice,
    recording: recStateOf(room.id),
    board: room.board,
    watch: room.watch,
    watchLocked: room.watchLocked,
    serverNow: Date.now(),
    sounds: repo.listSounds(room.id).map((row) => ({ id: row.id, name: row.name })),
    mods: roomModsOf(room),
    isRoomMod: isRoomMod(s, room),
    thumbUrl: room.thumbId && !room.isPrivate ? roomThumbUrl(room.thumbId) : null,
    iconUrl: room.iconId && !room.isPrivate ? roomIconUrl(room.iconId) : null,
    modsCanInvite: !room.isPrivate && invites.modsCanInvite(room.id),
    category: room.category,
    tags: room.tags,
    announcement: room.announcement,
    theme: themeOf(room),
    emotes: room.isPrivate ? [] : emotesOf(room.id),
    radioHere: radioHereCount(room),
  };
}
/** Blank or whitespace means open. Otherwise enforce the same length bounds as account passwords. */
function roomPasswordInput(raw: unknown): { error: string } | { password: string } {
  const password = typeof raw === 'string' ? raw.trim() : '';
  if (!password) return { password: '' };
  if (password.length < LIMITS.passwordMin || password.length > LIMITS.passwordMax)
    return { error: `Room password must be ${LIMITS.passwordMin}-${LIMITS.passwordMax} characters, or blank to leave the room open.` };
  return { password };
}
function roomList(): RoomSummary[] {
  return [...rooms.values()]
    .filter((r) => !r.isPrivate)
    .map(summary)
    .sort((a, b) => Number(b.permanent) - Number(a.permanent) || b.users - a.users || a.name.localeCompare(b.name));
}
function friendEntryFor(viewerId: number, otherId: number, status: 'pending' | 'accepted'): import('../shared/types').FriendEntry {
  const other = repo.userById(otherId);
  const sid = accountSockets.get(otherId);
  return {
    userId: otherId, username: other?.username ?? '?', status, online: !!sid, socketId: sid,
    chatColor: other?.chat_color ?? null, chatEffect: publicChatEffect(other?.chat_effect), hasAvatar: !!other?.has_avatar,
  };
}
function emitToAccount(userId: number, ev: keyof ServerToClient, ...args: any[]) {
  const sid = accountSockets.get(userId);
  if (!sid) return;
  const sock = io.sockets.sockets.get(sid);
  if (sock) (sock as any).emit(ev, ...args);
}
/** Tell accepted friends this account's online flag changed (list UI refreshes on friend:update). */
function presencePing(userId: number) {
  for (const r of repo.listFriendships(userId)) {
    if (r.status !== 'accepted') continue;
    const other = r.user_id === userId ? r.peer_id : r.user_id;
    emitToAccount(other, 'friend:update', { type: 'accepted', entry: friendEntryFor(other, userId, 'accepted') });
  }
  friendRoomPing(userId);
}
/** A stored line as the viewer may see it. Lines auto-hidden pending review keep their text only for reviewers. */
function chatFromRow(m: repo.MsgRow, reactions?: { emoji: string; count: number; mine: boolean }[], replyCount = 0, viewer?: Session): ChatMessage {
  const msg = chatFromRowRaw(m, reactions, replyCount, viewer);
  if (msg.kind !== 'chat' || !hiddenMsgs.has(m.id)) return msg;
  if (viewer && canReview(viewer, m.room_id)) return { ...msg, hidden: true };
  return {
    kind: 'chat', id: msg.id, ts: msg.ts, fromId: msg.fromId, from: msg.from, role: msg.role, text: '', accountId: msg.accountId,
    chatColor: msg.chatColor, chatEffect: msg.chatEffect, hasAvatar: msg.hasAvatar, reactions: [], parentId: msg.parentId, mentions: [], hidden: true,
  };
}
function chatFromRowRaw(m: repo.MsgRow, reactions?: { emoji: string; count: number; mine: boolean }[], replyCount = 0, viewer?: Session): ChatMessage {
  const u = m.user_id ? repo.userById(m.user_id) : undefined;
  if (m.burn_ttl != null) {
    // burn-after-reading: content only for its sender (until wiped); everyone else must chat:reveal
    const burned = m.burned_at != null;
    const mine = !!viewer && isMessageAuthor(viewer, m);
    return {
      kind: 'chat', id: m.id, ts: m.ts, fromId: '', from: m.nick, role: (m.role as Role) ?? undefined, text: !burned && mine ? m.text : '',
      accountId: m.user_id ?? undefined, chatColor: u?.chat_color ?? null, chatEffect: publicChatEffect(u?.chat_effect), hasAvatar: !!u?.has_avatar,
      reactions: [], parentId: m.parent_id || undefined, mentions: [],
      burn: { ttlSec: m.burn_ttl, ...(burned ? { burned: true } : {}), ...(mine ? { mine: true } : {}) },
    };
  }
  const mentions = repo.mentionIds(m.text);
  return {
    kind: 'chat', id: m.id, ts: m.ts, fromId: '', from: m.nick, role: (m.role as Role) ?? undefined, text: m.text,
    accountId: m.user_id ?? undefined,
    chatColor: u?.chat_color ?? null,
    chatEffect: publicChatEffect(u?.chat_effect),
    hasAvatar: !!u?.has_avatar,
    ...(repo8.shownLevel(u) ? { level: repo8.shownLevel(u) } : {}),
    reactions: reactions ?? [],
    parentId: m.parent_id || undefined,
    editedAt: m.edited_at || undefined,
    replyCount: replyCount || undefined,
    mentions,
    voice: voiceInfo(m),
    ...extrasFor(m, viewer),
  };
}
/** Link preview and poll attached to a (non-burn) line. */
function extrasFor(m: repo.MsgRow, viewer?: Session): { preview?: LinkPreviewInfo; poll?: PollInfo; announce?: { by: string } } {
  const out: { preview?: LinkPreviewInfo; poll?: PollInfo; announce?: { by: string } } = {};
  try {
    const ann = repo3.announceFor(m.id);
    if (ann) out.announce = { by: ann };
    const pv = repo2.previewsForMessages([m.id]).get(m.id);
    if (pv) out.preview = previewInfo(pv);
    const poll = repo2.pollsForMessages([m.id]).get(m.id);
    if (poll) out.poll = pollInfo(poll, viewer);
  } catch (err) { console.error('[extras]', (err as Error).message); }
  return out;
}
/** Poll voter identity: account, else device (guests get one vote per device). */
function pollVoterKeys(s: Session | undefined): string[] {
  if (!s) return [];
  if (s.account) return [`u:${s.account.id}`];
  return s.deviceIds.slice(0, 1).map((d) => `d:${d}`);
}
function pollInfo(row: repo2.PollRow, viewer?: Session): PollInfo {
  let options: string[] = [];
  try { options = JSON.parse(row.options) as string[]; } catch { /* empty */ }
  const counts = repo2.pollCounts(row.id, options.length);
  const info: PollInfo = {
    id: row.id, messageId: row.message_id, question: row.question, options: options.map((text, i) => ({ text, votes: counts[i] ?? 0 })),
    total: counts.reduce((a, b) => a + b, 0), closesAt: row.closes_at, closed: row.closed_at != null || (row.closes_at != null && row.closes_at <= Date.now()), createdBy: row.created_by_nick,
  };
  if (viewer) info.myVote = repo2.myPollVote(row.id, pollVoterKeys(viewer));
  return info;
}
function voiceInfo(m: repo.MsgRow): VoiceNoteInfo | undefined {
  if (!m.voice_id) return undefined;
  const v = repo.voiceNoteById(m.voice_id);
  if (!v) return undefined;
  return { id: v.id, url: `/api/voice/${v.id}`, durationMs: m.voice_ms ?? 0, mime: v.mime };
}
function pinsOf(roomId: string, viewerKey: string): ChatMessage[] {
  // rooms pinned under the old limit (10) keep showing them; new pins stop at LIMITS.maxPins
  const rows = repo.pinsForRoom(roomId, Math.max(10, LIMITS.maxPins));
  const rx = repo.reactionsFor(rows.map((m) => m.id), viewerKey);
  const counts = repo.replyCounts(rows.map((m) => m.id));
  return rows.map((m) => chatFromRow(m, rx.get(m.id), counts.get(m.id) ?? 0));
}
function history(room: Room, viewerKey: string, viewer?: Session): ChatMessage[] {
  const rows = repo.recentMessages(room.id, LIMITS.historySize, false, true);
  const rx = repo.reactionsFor(rows.map((m) => m.id), viewerKey);
  const counts = repo.replyCounts(rows.map((m) => m.id));
  const chat = rows.map((m) => chatFromRow(m, rx.get(m.id), counts.get(m.id) ?? 0, viewer));
  return [...chat, ...room.notices].sort((a, b) => a.ts - b.ts);
}

function isMessageAuthor(s: Session, m: repo.MsgRow): boolean {
  if (!s.user) return false;
  if (m.user_id != null) return s.account?.id === m.user_id;
  return !s.account && m.nick.toLowerCase() === s.user.nick.toLowerCase();
}
/** Same cleaning as a new chat line: length, mute, guest links, word filter. */
function prepareChatText(s: Session, raw: unknown): { error: string } | { text: string } {
  if (typeof raw === 'string' && raw.length > LIMITS.messageMax + 50)
    return { error: `Max ${LIMITS.messageMax} characters` };
  let text = cleanText(raw, LIMITS.messageMax);
  if (!text) return { error: 'Empty message' };
  const muted = repo.activeMuteUntil(identOf(s));
  if (muted) return { error: `You are muted for ${Math.ceil((muted - Date.now()) / 60_000)} more minute(s).` };
  if (!s.account) {
    const links = countLinks(text);
    if (links > LIMITS.guestLinksPerMessage) return { error: `Guests can post at most ${LIMITS.guestLinksPerMessage} link per message. Register to lift this.` };
    if (links) {
      const cutoff = Date.now() - 60_000;
      s.linkTimes = s.linkTimes.filter((t) => t > cutoff);
      if (s.linkTimes.length >= LIMITS.guestLinkMessagesPerMin) return { error: 'Too many links - wait a minute (or register).' };
      s.linkTimes.push(Date.now());
    }
  }
  return { text: maskWords(text) };
}
/** Guests may be barred from camera; returns null when allowed, -1 = needs account, else ms timestamp */
function camAllowedAt(s: Session): number | null {
  if (s.account) return null;
  if (GUEST_CAM_AFTER_MINUTES < 0) return -1;
  const at = s.connectedAt + GUEST_CAM_AFTER_MINUTES * 60_000;
  return at > Date.now() ? at : null;
}
function camBlockedUntil(s: Session): number {
  const keys = [repo.userKey(identOf(s)), ...s.deviceIds.map((d) => `d:${d}`)];
  return Math.max(0, ...keys.map((k) => camBlocks.get(k) ?? 0));
}

// ---------- scheduled events ----------
/** Test-only overrides: reminder lead (default 15 min) and the due-check interval (default 30 s). */
const EVENT_LEAD = Math.max(500, Number(process.env.EVENT_REMIND_LEAD_MS) || EVENT_REMIND_LEAD_MS);
const EVENT_TICK = Math.max(200, Number(process.env.EVENT_TICK_MS) || 30_000);
/** Recompute the lobby tags; true if anything changed. */
function refreshEventCaches(): boolean {
  const at = Date.now();
  const soon = new Map<string, { title: string; startsAt: number }>();
  const liveNow = new Map<string, { title: string; startsAt: number }>();
  try {
    for (const r of repo2.eventsSoon(at, EVENT_SOON_MS)) soon.set(r.room_id, { title: r.title, startsAt: r.starts_at });
    for (const r of repo2.eventsLive(at)) liveNow.set(r.room_id, { title: r.title, startsAt: r.starts_at });
  } catch (err) { console.error('[events] refresh failed', (err as Error).message); return false; }
  const same = (a: Map<string, { title: string; startsAt: number }>, b: Map<string, { title: string; startsAt: number }>) =>
    a.size === b.size && [...a].every(([k, v]) => { const o = b.get(k); return !!o && o.title === v.title && o.startsAt === v.startsAt; });
  if (same(soon, eventsSoonCache) && same(liveNow, eventsLiveCache)) return false;
  eventsSoonCache.clear(); for (const [k, v] of soon) eventsSoonCache.set(k, v);
  eventsLiveCache.clear(); for (const [k, v] of liveNow) eventsLiveCache.set(k, v);
  return true;
}
function eventInfos(rows: repo2.EventRow[], viewerId: number | null): RoomEventInfo[] {
  const rs = repo2.rsvpsFor(rows.map((r) => r.id));
  return rows.map((r) => {
    const mine = rs.filter((x) => x.event_id === r.id);
    const going = mine.filter((x) => x.status === 'going');
    const me = viewerId != null ? mine.find((x) => x.user_id === viewerId) : undefined;
    return {
      id: r.id, roomId: r.room_id, title: r.title, description: r.description, startsAt: r.starts_at, durationMin: r.duration_min, createdBy: r.created_by_nick,
      going: going.length, maybe: mine.filter((x) => x.status === 'maybe').length, notGoing: mine.filter((x) => x.status === 'no').length,
      goingUsers: going.slice(0, 8).map((x) => ({ accountId: x.user_id, nick: x.username, hasAvatar: !!x.has_avatar, chatColor: x.chat_color ?? null })),
      ...(me ? { myRsvp: me.status } : {}),
    };
  });
}
function eventsChanged(roomId: string) {
  io.to(`room:${roomId}`).emit('events:changed', { roomId });
  if (refreshEventCaches()) broadcastRooms();
}
function sendReminder(row: repo2.EventRow, stage: 'soon' | 'start') {
  const room = rooms.get(row.room_id);
  const payload: EventReminder = { eventId: row.id, roomId: row.room_id, roomName: room?.name ?? row.room_id, title: row.title, startsAt: row.starts_at, stage, passwordRequired: !!room?.passwordHash };
  for (const uid of repo2.reminderTargets(row.id)) {
    const sid = accountSockets.get(uid);
    if (sid) io.to(sid).emit('event:reminder', payload);
  }
  // same system line as before (kept in history like other system lines); old clients and tests rely on this text
  if (room) systemMsg(room, stage === 'start' ? `📅 ${row.title} is starting!` : `📅 ${row.title} starts in 15 minutes`);
}
/** Due-reminder check. Each stage is claimed in SQLite first, so a restart never re-sends. */
function eventTick(at = Date.now()) {
  try {
    for (const row of repo2.eventsPendingReminder(at + EVENT_LEAD)) {
      const st = reminderStages({ startsAt: row.starts_at, remindedSoon: row.reminded_soon != null, remindedStart: row.reminded_start != null }, at, EVENT_LEAD);
      if (st.soon && repo2.claimReminder(row.id, 'soon', at) && st.soon === 'send') sendReminder(row, 'soon');
      if (st.start && repo2.claimReminder(row.id, 'start', at) && st.start === 'send') sendReminder(row, 'start');
    }
  } catch (err) { console.error('[events] tick failed', (err as Error).message); }
  if (refreshEventCaches()) broadcastRooms();
}

// ---------- polls ----------
/** Test-only: length of a poll "minute" (default 60 s). */
const POLL_MINUTE = Math.max(100, Number(process.env.POLL_MINUTE_MS) || 60_000);
const pollTimers = new Map<string, NodeJS.Timeout>();
function schedulePollClose(row: repo2.PollRow) {
  if (row.closes_at == null || row.closed_at != null) return;
  const prev = pollTimers.get(row.id);
  if (prev) clearTimeout(prev);
  // long polls are re-checked by the sweep; timers only cover the next 24 h
  const wait = row.closes_at - Date.now();
  if (wait > 86_400_000) return;
  const t = setTimeout(guardTimer('poll close', () => { pollTimers.delete(row.id); closePollNow(row.id); }), Math.max(0, wait) + 20);
  t.unref?.();
  pollTimers.set(row.id, t);
}
function closePollNow(id: string, by?: string): repo2.PollRow | null {
  const row = repo2.pollById(id);
  if (!row) return null;
  if (repo2.closePoll(id)) {
    const t = pollTimers.get(id);
    if (t) { clearTimeout(t); pollTimers.delete(id); }
    const fresh = repo2.pollById(id)!;
    io.to(`room:${row.room_id}`).emit('poll:update', { poll: pollInfo(fresh) });
    const room = rooms.get(row.room_id);
    if (room) {
      const info = pollInfo(fresh);
      const top = Math.max(0, ...info.options.map((o) => o.votes));
      const winners = top > 0 ? info.options.filter((o) => o.votes === top).map((o) => o.text) : [];
      systemMsg(room, `📊 Poll closed${by ? ` by ${by}` : ''}: ${row.question}${winners.length ? ` - ${winners.join(' / ')} (${top} vote${top === 1 ? '' : 's'})` : ' - no votes'}`);
    }
    return fresh;
  }
  return row;
}
function sweepPolls() {
  for (const row of repo2.duePolls()) closePollNow(row.id);
  for (const row of repo2.duePolls(Date.now() + 86_400_000)) schedulePollClose(row);
}

// ---------- link previews ----------
const OWN_ORIGINS = PUBLIC_URL ? [new URL(PUBLIC_URL).origin] : [];
/** Fetch (or reuse) a preview for the first URL and attach it. Never for burn messages or voice notes. */
function queuePreview(roomId: string, messageId: string, text: string) {
  const url = firstPreviewUrl(text, OWN_ORIGINS);
  if (!url) return;
  void getPreview(url).then((row) => {
    if (!row) return;
    const m = repo.messageById(messageId);
    if (!m || m.deleted || m.burn_ttl != null || m.voice_id || firstPreviewUrl(m.text, OWN_ORIGINS) !== url) return;
    repo2.attachPreview(messageId, row.id);
    io.to(`room:${roomId}`).emit('chat:preview', { messageId, preview: previewInfo(row) });
  }).catch((err) => console.error('[preview]', (err as Error).message));
}

// ---------- web push ----------
function accountConnected(userId: number): boolean {
  const sid = accountSockets.get(userId);
  return !!sid && !!io.sockets.sockets.get(sid)?.connected;
}
/** Push only when the person has no live socket (they would see it in the app otherwise). */
function pushIfAway(userId: number, payload: { title: string; body: string; url: string; tag?: string }, roomId?: string, kind: 'mention' | 'message' = 'mention') {
  if (accountConnected(userId)) return;
  try {
    if (roomId) {
      const level = repo4.notifyLevel(userId, roomId);
      if (level === 'mute' || (kind === 'message' && level !== 'all')) return;
    }
    if (inQuietHours(repo4.quietHours(userId), Date.now())) return;
  } catch (err) { console.error('[push] notify prefs', (err as Error).message); }
  void pushToUser(userId, payload).catch((err) => console.error('[push]', (err as Error).message));
}

// ---------- room word / link filters, enforced by the moderator bot (batch B) ----------
function modBotName(): string {
  const id = repo.moderatorBotId();
  return (id != null ? repo.botById(id)?.name : null) ?? 'Meowington';
}
const ownHosts = (() => { try { return [new URL(PUBLIC_URL).hostname.toLowerCase().replace(/^www\./, '')]; } catch { return []; } })();
/** Null when the line may be posted; otherwise the refusal. A blocked line goes to the room's mod queue. */
function filterVerdict(s: Session, room: Room, text: string): string | null {
  if (room.isPrivate || isStaff(s) || canRoomManage(s, room)) return null;
  const f = repo6.filtersFor(room.id);
  if (!f.words.length && f.links === 'off') return null;
  const word = matchWord(text, f.words);
  const host = word ? null : blockedLink(text, f, ownHosts);
  if (!word && !host) return null;
  const bot = modBotName();
  try {
    const key = `filter:${room.id}:${s.account ? `u${s.account.id}` : `n:${s.user!.nick.toLowerCase()}`}`;
    const note = word ? `Blocked by the room word filter ("${word}")` : `Blocked by the room link filter (${host})`;
    const dup = modq.findDuplicate({ reporterUserId: null, reporterIp: 'filter', reporterNick: bot, key });
    if (dup) modq.updateDuplicate(dup.id, word ? 'other' : 'spam', note, false);
    else {
      const id = modq.insertReport({
        reporterUserId: null, reporterNick: bot, reporterIp: 'filter',
        targetUserId: s.account?.id ?? null, targetNick: s.user!.nick, targetIp: s.ip, targetDevice: s.deviceIds[0] ?? null,
        roomId: room.id, messageId: null, messageText: text.slice(0, 2000), kind: 'user', key, category: word ? 'other' : 'spam', note,
        snapshot: { text: text.slice(0, 2000), attachments: [], senderAccountId: s.account?.id ?? null, senderNick: s.user!.nick, roomId: room.id, roomName: room.name, ts: Date.now() },
        privateKind: null, context: repo.recentMessages(room.id, MODQ.contextSize, false).map((m) => ({ ts: m.ts, from: m.nick, text: m.burn_ttl != null ? '[burn message]' : m.text })), notify: false,
      });
      const row = modq.reportById(id);
      if (row) afterNewReport(row);
    }
    repo.logAction(bot, null, 'filter-block', s.user!.nick, room.id, word ? `word "${word}"` : `link ${host}`);
  } catch (err) { console.error('[filters] log', (err as Error).message); }
  return word ? `${bot} blocked that message: it contains a word this room filters.` : `${bot} blocked that message: links to ${host} are not allowed in this room.`;
}

// ---------- mentions inbox (batch A) ----------
function mentionItemOf(r: repo5.MentionRow): MentionItem {
  return {
    id: r.id, kind: r.kind === 'reply' ? 'reply' : 'mention', roomId: r.room_id,
    roomName: rooms.get(r.room_id)?.name ?? repo.roomRowById(r.room_id)?.name ?? r.room_id,
    messageId: r.message_id, from: r.from_nick, ts: r.ts, text: r.deleted || r.text == null ? '' : r.text.slice(0, 300), read: r.read_at != null,
  };
}
/** @mentions and replies to an account's message go to that account's inbox (public rooms, or rooms they are in). */
function recordMentions(room: Room, msg: { id: string; ts: number; from: string; mentions?: number[] }, s: Session, parentId: string | null) {
  try {
    const targets = new Map<number, 'mention' | 'reply'>();
    if (parentId) {
      const parent = repo.messageById(parentId);
      if (parent?.user_id) targets.set(parent.user_id, 'reply');
    }
    for (const uid of msg.mentions ?? []) targets.set(uid, 'mention');
    for (const [uid, kind] of targets) {
      if (uid === s.account?.id) continue;
      if (s.account && lobby.blockedEitherWay(uid, s.account.id)) continue;
      const live = liveAccount(uid);
      if ((room.isPrivate || room.passwordHash) && !(live && live.ts.roomId === room.id)) continue;
      if (!repo5.addMention(uid, msg.id, room.id, kind, msg.from, msg.ts)) continue;
      if (live) {
        const row = repo5.listMentions(uid, 1)[0];
        if (row) live.sock.emit('mentions:new', { item: mentionItemOf(row), unread: repo5.unreadMentionCount(uid) });
      }
    }
  } catch (err) { console.error('[mentions] record', (err as Error).message); }
}

// ---------- whispers ----------
function whisperInfo(room: Room, id: string): WhisperInfo | null {
  const set = room.whispers.get(id);
  if (!set) return null;
  return { id, roomId: room.id, members: [...set].map((sid) => ({ id: sid, nick: userOf(sid)?.nick ?? '?' })) };
}
function emitWhisperUpdate(room: Room, id: string) {
  const info = whisperInfo(room, id);
  if (!info) return;
  for (const m of info.members) io.to(m.id).emit('whisper:update', { whisper: info });
}
/** Drop a participant from one whisper; ends it for everyone when fewer than 2 remain. */
function leaveWhisper(room: Room, id: string, socketId: string) {
  const set = room.whispers.get(id);
  if (!set || !set.delete(socketId)) return;
  io.to(socketId).emit('whisper:ended', { whisperId: id, reason: 'left' });
  if (set.size < WHISPER_MIN_MEMBERS) {
    room.whispers.delete(id);
    for (const sid of set) io.to(sid).emit('whisper:ended', { whisperId: id, reason: 'ended' });
    return;
  }
  emitWhisperUpdate(room, id);
}
function leaveAllWhispers(room: Room, socketId: string) {
  for (const id of [...room.whispers.keys()]) leaveWhisper(room, id, socketId);
}

// ---------- burn-after-reading ----------
/** Test-only overrides: hard expiry (default 10 min) and a ttl multiplier (default 1). */
const BURN_HARD = Math.max(200, Number(process.env.BURN_HARD_MS) || BURN_HARD_MS);
const BURN_TTL_SCALE = Math.min(1, Math.max(0.01, Number(process.env.BURN_TTL_SCALE) || 1));
const burnTtlMs = (ttlSec: number) => Math.round(ttlSec * 1000 * BURN_TTL_SCALE);
/** One reveal identity per person: account, else device, else guest nick. */
function burnViewerKey(s: Session): string {
  if (s.account) return `u:${s.account.id}`;
  if (s.deviceIds[0]) return `d:${s.deviceIds[0]}`;
  return `g:${(s.user?.nick ?? '').toLowerCase()}`;
}
const burnTimers = new Map<string, NodeJS.Timeout>();
function scheduleBurnCheck(id: string, at: number) {
  const prev = burnTimers.get(id);
  if (prev) clearTimeout(prev);
  const t = setTimeout(guardTimer('burn check', () => { burnTimers.delete(id); checkBurn(id); }), Math.max(0, at - Date.now()) + 25);
  t.unref?.();
  burnTimers.set(id, t);
}
function checkBurn(id: string, row = repo.messageById(id)) {
  if (!row || row.burn_ttl == null || row.burned_at != null || row.deleted) return;
  let recipients: string[] = [];
  try { recipients = JSON.parse(row.burn_recipients || '[]') as string[]; } catch { /* none */ }
  const now = Date.now();
  if (burnExpired({ createdAt: row.ts, hardMs: BURN_HARD, ttlMs: burnTtlMs(row.burn_ttl), recipients, views: repo.burnViews(id), now })) expireBurn(row, now);
  else scheduleBurnCheck(id, Math.min(row.ts + BURN_HARD, now + 60_000));
}
/** Wipe content + attached files; history then shows "Burned". */
function expireBurn(row: repo.MsgRow, now = Date.now()) {
  repo.burnMessage(row.id, now);
  deleteImagesForMessages([row.id]);
  deleteVoiceForMessages([row.id]);
  const t = burnTimers.get(row.id);
  if (t) { clearTimeout(t); burnTimers.delete(row.id); }
  io.to(`room:${row.room_id}`).emit('chat:burned', { id: row.id });
}
function sweepBurns() {
  try { for (const row of repo.liveBurnMessages()) checkBurn(row.id, row); } catch (err) { console.error('[burn] sweep failed', err); }
}

// ---------- trivia ----------
/** Test-only overrides (default 15 s / 4 s). */
const TRIVIA_Q_MS = Math.min(60_000, Math.max(500, Number(process.env.TRIVIA_QUESTION_MS) || TRIVIA_QUESTION_MS));
const TRIVIA_P_MS = Math.min(20_000, Math.max(200, Number(process.env.TRIVIA_PAUSE_MS) || TRIVIA_PAUSE_MS));
function triviaHumans(room: Room): number {
  let n = 0;
  for (const id of room.members) if (canPlayTrivia(id) && sessions.get(id)?.user) n++;
  return n;
}
function triviaPlayerOf(s: Session): TriviaPlayer {
  return s.account ? { key: `a:${s.account.id}`, name: s.user!.nick, accountId: s.account.id } : { key: `g:${s.user!.nick.toLowerCase()}`, name: s.user!.nick, accountId: null };
}
/** All-time room board: stored registered players plus this server session's guests. */
function triviaBoard(room: Room): TriviaScore[] {
  const stored: TriviaScore[] = repo.triviaTop(room.id, TRIVIA_TOP).map((r) => ({ name: r.username, points: r.points, wins: r.wins, rounds: r.rounds }));
  const guests: TriviaScore[] = [...room.triviaGuests.values()].map((g) => ({ name: g.name, points: g.points, wins: g.wins, rounds: g.rounds, guest: true }));
  return [...stored, ...guests].sort((a, b) => b.points - a.points || (b.wins ?? 0) - (a.wins ?? 0)).slice(0, TRIVIA_TOP);
}
function startTriviaRound(room: Room, by: string, category: Parameters<typeof pickQuestions>[0], count: number): TriviaRound {
  const round = new TriviaRound(by, category, pickQuestions(category, count), TRIVIA_Q_MS, TRIVIA_P_MS, {
    state: (st) => io.to(`room:${room.id}`).emit('trivia:state', st),
    progress: (p) => io.to(`room:${room.id}`).emit('trivia:progress', p),
    players: () => triviaHumans(room),
    ended: (r, info) => {
      if (room.trivia === r) room.trivia = null;
      const standings = r.standings();
      const top = standings[0] && standings[0].points > 0 ? standings[0] : null;
      if (!info.stopped) {
        try {
          repo.recordTriviaRound(room.id, standings.filter((x) => x.accountId != null).map((x) => ({ userId: x.accountId!, points: x.points, won: x === top })));
        } catch (err) { console.error('[trivia] save failed', (err as Error).message); }
        for (const x of standings) {
          if (x.accountId != null) continue;
          const k = x.name.toLowerCase();
          const g = room.triviaGuests.get(k) ?? { name: x.name, points: 0, wins: 0, rounds: 0 };
          g.name = x.name; g.points += x.points; g.rounds++; if (x === top) g.wins++;
          room.triviaGuests.set(k, g);
        }
        if (top) systemMsg(room, `Trivia: ${top.name} won with ${top.points}`);
        // badges: registered winners / perfect rounds only (guests have no accountId; bots never play)
        if (top?.accountId != null) bumpStat(top.accountId, 'trivia_wins');
        for (const x of standings) if (x.accountId != null && r.total > 0 && x.correct === r.total) bumpStat(x.accountId, 'trivia_perfect');
      }
      io.to(`room:${room.id}`).emit('trivia:ended', {
        state: r.publicState(), winner: top ? { name: top.name, points: top.points, ...(top.accountId == null ? { guest: true } : {}) } : null,
        board: triviaBoard(room), stopped: info.stopped, ...(info.by ? { by: info.by } : {}),
      });
    },
  });
  room.trivia = round;
  round.start();
  return round;
}
function stopTrivia(room: Room, by: string | null) {
  room.trivia?.stop(by ?? undefined);
  room.trivia = null;
}

// ---------- HTTP + Socket.IO ----------
live.buildId = createHash('sha1').update(String(fs.statSync(__filename).mtimeMs)).digest('hex').slice(0, 12);
live.release = readReleaseInfo();

const app = createApp(roomList);
const httpServer = http.createServer(app);
const io = new Server<ClientToServer, ServerToClient>(httpServer, {
  maxHttpBufferSize: 64 * 1024, // SDP fits comfortably; blocks junk floods
  cors: CORS_ORIGINS.length ? { origin: CORS_ORIGINS, credentials: true } : undefined,
  // cross-site WebSocket hijacking guard (cookies are ambient)
  allowRequest: (req, cb) => cb(null, originAllowed(req)),
  // Ping well inside Cloudflare's ~100s idle WebSocket timeout. A missed pong
  // still has to outlast a short blip before the socket is declared dead.
  pingInterval: 20_000,
  pingTimeout: 20_000,
});

let listTimer: NodeJS.Timeout | null = null;
function broadcastRooms() {
  // debounce so join storms don't spam everyone
  if (listTimer) return;
  listTimer = setTimeout(guardTimer('rooms broadcast', () => {
    listTimer = null;
    io.to('lobby').emit('rooms', roomList());
  }), 250);
}

// ---------- batch F6: voice-room recordings ----------
function recStateOf(roomId: string): RecState | null {
  const r = recs.activeRec(roomId);
  return r ? { id: r.id, by: r.started_nick, startedAt: r.started_at, maxMs: recs.REC_MAX_MS } : null;
}
const REC_REASONS: Record<string, string> = { stop: 'stopped recording', size: 'recording reached its size limit', time: 'recording reached its time limit', idle: 'recording stopped (the recorder went offline)', left: 'recording stopped (the owner left)', voiceoff: 'recording stopped (no longer a voice room)' };
function recEnded(roomId: string, nick: string, reason: string) {
  io.to(`room:${roomId}`).emit('rec:state', { roomId, rec: null, reason });
  const room = rooms.get(roomId);
  if (room) systemMsg(room, reason === 'stop' ? `⏹ ${nick} stopped recording` : `⏹ ${REC_REASONS[reason] ?? 'recording stopped'}`);
}
live.recordingEnded = (roomId, reason) => { const r = recs.recsOf(roomId)[0]; recEnded(roomId, r?.started_nick ?? '', reason); };
live.roomOwnerId = (roomId) => rooms.get(roomId)?.ownerUserId ?? null;
setInterval(guardTimer('recordings', () => {
  for (const r of recs.idleRecs()) { recs.endRec(r.id, 'done', 'idle'); recEnded(r.room_id, r.started_nick, 'idle'); }
}), 5_000).unref();
setInterval(guardTimer('recording retention', () => { const n = recs.sweepRecordings(); if (n) console.log(`[rec] removed ${n} recording(s) past retention`); }), 3_600_000).unref();
setTimeout(() => { try { recs.sweepRecordings(); } catch (e) { console.error('[rec] sweep', e); } }, 30_000).unref();

function systemMsg(room: Room, text: string) {
  const msg: ChatMessage = { kind: 'system', id: randomUUID(), ts: Date.now(), text };
  room.notices.push(msg);
  if (room.notices.length > 20) room.notices.shift();
  io.to(`room:${room.id}`).emit('chat:message', msg);
}

function dropRoom(room: Room) {
  deleteRoomSoundFiles(room.id);
  deleteVoiceForRoom(room.id);
  deleteImagesForRoom(room.id);
  deleteRoomThumb(room.thumbId);
  deleteRoomIcon(room.iconId);
  try { for (const e of repo3.emotesForRoom(room.id)) deleteEmoteFile(e.id); repo3.deleteRoomData3(room.id); } catch (err) { console.error('[rooms] batch-3 cleanup failed', (err as Error).message); }
  stopTrivia(room, null);
  rooms.delete(room.id);
  repo.deleteRoom(room.id);
  try { invites.forgetRoom(room.id); } catch (err) { console.error('[rooms] invite cleanup failed', (err as Error).message); }
  try { lobby.forgetRoom(room.id); } catch (err) { console.error('[rooms] recent cleanup failed', (err as Error).message); }
  try { repo2.deleteRoomData(room.id); } catch (err) { console.error('[rooms] cleanup failed', (err as Error).message); }
  try { repo4.forgetRoomNotify(room.id); } catch (err) { console.error('[rooms] notify cleanup failed', (err as Error).message); }
  try { repo6.forgetRoomFilters(room.id); } catch (err) { console.error('[rooms] filter cleanup failed', (err as Error).message); }
  try { repo5.forgetRoomReads(room.id); repo5.forgetRoomMentions(room.id); } catch (err) { console.error('[rooms] unread cleanup failed', (err as Error).message); }
  if (refreshEventCaches()) broadcastRooms();
}
function maybeRemoveRoom(room: Room) {
  if (!room.persistent && room.members.size === 0 && rooms.get(room.id) === room) dropRoom(room);
}

function dropMembership(id: string, s: Session, notice: string) {
  const roomId = s.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  s.roomId = null;
  if (s.user) { s.user.cam = false; s.user.mic = false; s.user.screen = false; }
  if (!room) return;
  room.members.delete(id);
  leaveAllWhispers(room, id);
  if (s.user) room.stage.hands.delete(stageKey(s));
  if (room.members.size === 0) { room.stage.speakers.clear(); room.stage.hands.clear(); }
  else if (room.stage.on) emitStage(room);
  if (room.trivia && triviaHumans(room) === 0) stopTrivia(room, null);
  if (room.members.size === 0) { room.board = []; room.watch = null; room.whispers.clear(); room.triviaGuests.clear(); }
  if (s.user) io.to(`room:${room.id}`).emit('chat:typing', { id, nick: s.user.nick, typing: false });
  io.to(`room:${room.id}`).emit('user:left', { id });
  if (s.user) systemMsg(room, `${s.user.nick} ${notice}`);
  if (radioOn.has(id)) radioRoomPing(room);
  if (s.account) lobbyLeft(room, s.account.id);
  maybeRemoveRoom(room);
  broadcastRooms();
}
function leaveRoom(socket: AppSocket, notice = 'left') {
  const s = sessions.get(socket.id);
  if (!s?.roomId) return;
  const roomId = s.roomId;
  cancelPark(socket.id);
  airTrack(socket.id, s);
  dropMembership(socket.id, s, notice);
  socket.leave(`room:${roomId}`);
  socket.join('lobby');
}

/** Shared room kick / room ban used by room owners, staff, and the moderator bot. */
function punishRoom(opts: {
  by: string;
  byAccountId: number | null;
  byNick: string;
  room: Room;
  targetSock: AppSocket;
  targetSession: Session;
  minutes: number | null;
  reason: string;
  kickOnly: boolean;
  details: string | null;
}) {
  const minutes = opts.kickOnly ? 10 : opts.minutes;
  repo.addRoomBan(opts.room.id, identOf(opts.targetSession), opts.reason, opts.by, minutes);
  repo.logAction(opts.by, opts.byAccountId, opts.kickOnly ? 'kick' : 'room-ban', opts.targetSession.user?.nick ?? '', opts.room.id, opts.details);
  opts.targetSock.emit('room:kicked', { roomId: opts.room.id, by: opts.byNick, reason: opts.reason || undefined });
  leaveRoom(opts.targetSock, opts.kickOnly ? `was kicked by ${opts.byNick}` : `was banned from the room by ${opts.byNick}`);
}

/** Shared site ban used by staff sockets and the moderator bot. Disconnects anyone the new ban matches. */
function applySiteBan(opts: {
  by: string;
  byAccountId: number | null;
  nick: string;
  accountId: number | null;
  ip: string;
  deviceIds: string[];
  roomId: string | null;
  reason: string;
  minutes: number | null;
  kinds: BanKind[];
  /** appended to the action log details (e.g. the report id) */
  extra?: string;
}): { ok: true } | { ok: false; error: string } {
  let n = 0;
  if (opts.kinds.includes('account') && opts.accountId) { repo.addBan('account', String(opts.accountId), opts.nick, opts.reason, opts.by, opts.minutes); n++; }
  if (opts.kinds.includes('ip') && opts.ip !== 'unknown') { repo.addBan('ip', opts.ip, opts.nick, opts.reason, opts.by, opts.minutes); n++; }
  if (opts.kinds.includes('device')) for (const d of opts.deviceIds) { repo.addBan('device', d, opts.nick, opts.reason, opts.by, opts.minutes); n++; }
  if (!n) return { ok: false, error: 'Nothing to ban with those options' };
  repo.logAction(opts.by, opts.byAccountId, 'ban', opts.nick, opts.roomId, `${opts.kinds.join('+')}; ${opts.minutes ? `${opts.minutes} min` : 'permanent'}; ${opts.reason}${opts.extra ? `; ${opts.extra}` : ''}`);
  live.enforceBans();
  return { ok: true };
}

/** Same account, or same guest device + nick, while their previous socket is still in a room. */
function presenceKey(s: Session): string | null {
  if (!s.user || !s.roomId) return null;
  if (s.account) return `a:${s.account.id}`;
  return `g:${s.deviceIds[0] || ''}:${s.user.nick.toLowerCase()}`;
}
const parked = new Map<string, { oldId: string; timer: NodeJS.Timeout }>();
function cancelPark(oldId: string) {
  for (const [k, v] of parked) if (v.oldId === oldId) { clearTimeout(v.timer); parked.delete(k); }
}
function forgetSession(id: string, s: Session) {
  if (s.user && nicksInUse.get(s.user.nick.toLowerCase()) === id) nicksInUse.delete(s.user.nick.toLowerCase());
  if (s.account && accountSockets.get(s.account.id) === id) {
    accountSockets.delete(s.account.id);
    presencePing(s.account.id);
  }
  sessions.delete(id);
}
function expirePark(oldId: string) {
  cancelPark(oldId);
  const s = sessions.get(oldId);
  if (!s) return;
  if (s.roomId) dropMembership(oldId, s, 'left');
  forgetSession(oldId, s);
}
/** Keep the room seat and the peer id so a short socket blip does not tear down WebRTC. */
function parkSession(id: string) {
  const s = sessions.get(id);
  const key = s ? presenceKey(s) : null;
  if (!s || !key) {
    if (s) forgetSession(id, s);
    return;
  }
  const prev = parked.get(key);
  if (prev && prev.oldId !== id) expirePark(prev.oldId);
  const timer = setTimeout(guardTimer('expire park', () => expirePark(id)), RECONNECT_GRACE_MS);
  timer.unref();
  parked.set(key, { oldId: id, timer });
  // others hide this person's camera tile right away; the seat stays for the grace period
  if (s.roomId && s.user) {
    s.user.away = true;
    io.to(`room:${s.roomId}`).emit('user:updated', s.user);
  }
}
function takePark(key: string): { oldId: string; session: Session } | null {
  const p = parked.get(key);
  if (!p) return null;
  clearTimeout(p.timer);
  parked.delete(key);
  const old = sessions.get(p.oldId);
  if (!old?.user || !old.roomId || !rooms.has(old.roomId)) {
    if (old) {
      if (old.roomId) dropMembership(p.oldId, old, 'left');
      forgetSession(p.oldId, old);
    }
    return null;
  }
  return { oldId: p.oldId, session: old };
}

function prepareBotText(raw: unknown): { error: string } | { text: string } {
  if (typeof raw === 'string' && raw.length > LIMITS.messageMax + 50)
    return { error: `Max ${LIMITS.messageMax} characters` };
  const text = cleanText(raw, LIMITS.messageMax);
  if (!text) return { error: 'Empty message' };
  return { text: maskWords(text) };
}
function openBotRoom(roomId: string, botId: number): { ok: true; room: Room } | { ok: false; status: number; error: string } {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, status: 404, error: 'Room not found' };
  if (room.isPrivate) return { ok: false, status: 403, error: 'Bots cannot join a private call' };
  if (!repo.botAllowed(room.id, botId)) return { ok: false, status: 403, error: 'This bot is not allowed in that room' };
  return { ok: true, room };
}
function claimBotNick(uid: string, nick: string): boolean {
  const key = nick.toLowerCase();
  const holder = nicksInUse.get(key);
  if (holder && holder !== uid) return false;
  nicksInUse.set(key, uid);
  return true;
}
function publishBotLine(room: Room, uid: string, text: string): BotResult {
  const user = botUsers.get(uid);
  if (!user) return { ok: false, status: 403, error: 'Join the room first' };
  const msg: ChatMessage = {
    kind: 'chat', id: randomUUID(), ts: Date.now(), fromId: uid, from: user.nick, role: 'user', text,
    mentions: repo.mentionIds(text),
  };
  const botId = Number(uid.slice('bot:'.length));
  repo.insertMessage({
    id: msg.id, room_id: room.id, ts: msg.ts, user_id: null, nick: user.nick, role: 'user', text,
    ip: null, device_id: null, bot_id: Number.isInteger(botId) ? botId : null,
  });
  room.lastChatAt.set(uid, msg.ts);
  io.to(`room:${room.id}`).emit('chat:message', msg);
  if (!room.isPrivate) io.emit('room:activity', { roomId: room.id, mentions: msg.mentions });
  return { ok: true };
}
function botPostGate(roomId: string, bot: BotIdentity): { ok: true; room: Room; uid: string } | { ok: false; status: number; error: string } {
  const gate = openBotRoom(roomId, bot.id);
  if (!gate.ok) return gate;
  const uid = botUserId(bot.id);
  if (!gate.room.members.has(uid)) restoreBotSeat(gate.room, bot);
  if (!gate.room.members.has(uid) || !botUsers.has(uid)) return { ok: false, status: 403, error: 'Join the room first' };
  if (gate.room.slowModeSec > 0) {
    const last = gate.room.lastChatAt.get(uid) ?? 0;
    const wait = gate.room.slowModeSec * 1000 - (Date.now() - last);
    if (wait > 0) return { ok: false, status: 429, error: `Slow mode: wait ${Math.ceil(wait / 1000)}s.` };
  }
  if (!botPostRl.take(uid)) return { ok: false, status: 429, error: 'Slow down' };
  return { ok: true, room: gate.room, uid };
}
/** Drop a bot from one room, or from every room when `only` is omitted. */
function removeBot(botId: number, only?: Room) {
  const uid = botUserId(botId);
  const ids = only ? [only.id] : [...(botRooms.get(botId) ?? [])];
  const user = botUsers.get(uid);
  try { repo.forgetBotJoin(botId, only?.id); } catch (err) { console.error('[bots] forget join failed', (err as Error).message); }
  for (const rid of ids) {
    const room = rooms.get(rid);
    const set = botRooms.get(botId);
    set?.delete(rid);
    if (!room || !room.members.has(uid)) continue;
    room.members.delete(uid);
    room.lastChatAt.delete(uid);
    io.to(`room:${rid}`).emit('user:left', { id: uid });
    if (user) systemMsg(room, `${user.nick} left`);
    if (room.members.size === 0) room.board = [];
    maybeRemoveRoom(room);
  }
  const set = botRooms.get(botId);
  if (!set || set.size === 0) {
    botRooms.delete(botId);
    if (user && nicksInUse.get(user.nick.toLowerCase()) === uid) nicksInUse.delete(user.nick.toLowerCase());
    botUsers.delete(uid);
  }
  broadcastRooms();
}
/** Put a bot in a room's member list. `announce` posts the "joined" line (not done when restoring after a restart). */
function seatBot(room: Room, bot: { id: number; name: string }, announce: boolean): BotResult {
  const uid = botUserId(bot.id);
  if (room.members.has(uid)) return { ok: true };
  if (room.members.size >= LIMITS.maxUsersPerRoom) return { ok: false, status: 403, error: 'Room is full' };
  if (!claimBotNick(uid, bot.name)) return { ok: false, status: 409, error: 'That name is in use' };
  const user: UserInfo = botUsers.get(uid) ?? { id: uid, nick: bot.name, cam: false, mic: false, screen: false, role: 'user', registered: false };
  botUsers.set(uid, user);
  let set = botRooms.get(bot.id);
  if (!set) { set = new Set(); botRooms.set(bot.id, set); }
  set.add(room.id);
  room.members.add(uid);
  io.to(`room:${room.id}`).emit('user:joined', user);
  if (announce) systemMsg(room, `${bot.name} joined`);
  broadcastRooms();
  return { ok: true };
}
/** A join remembered in the DB from before a restart: seat the bot quietly. False when there is nothing to restore. */
function restoreBotSeat(room: Room, bot: { id: number; name: string }): boolean {
  if (room.members.has(botUserId(bot.id))) return true;
  let remembered = false;
  try { remembered = repo.botJoinRemembered(bot.id, room.id); } catch { remembered = false; }
  return remembered && seatBot(room, bot, false).ok;
}
live.botJoin = (roomId, bot) => {
  const gate = openBotRoom(roomId, bot.id);
  if (!gate.ok) return gate;
  const r = seatBot(gate.room, bot, true);
  if (r.ok) {
    try { repo.rememberBotJoin(bot.id, gate.room.id); } catch (err) { console.error('[bots] remember join failed', (err as Error).message); }
  }
  return r;
};
live.botChat = (roomId, bot, raw) => {
  const gate = botPostGate(roomId, bot);
  if (!gate.ok) return gate;
  const prepared = prepareBotText(raw);
  if ('error' in prepared) return { ok: false, status: 400, error: prepared.error };
  return publishBotLine(gate.room, gate.uid, prepared.text);
};
live.botGif = async (roomId, bot, gifId) => {
  const opened = openBotRoom(roomId, bot.id);
  if (!opened.ok) return opened;
  if (!opened.room.members.has(botUserId(bot.id))) restoreBotSeat(opened.room, bot);
  if (!opened.room.members.has(botUserId(bot.id))) return { ok: false, status: 403, error: 'Join the room first' };
  if (!gifsEnabled) return { ok: false, status: 503, error: 'GIF search is not configured' };
  const gate = botPostGate(roomId, bot);
  if (!gate.ok) return gate;
  const id = gifId.trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return { ok: false, status: 400, error: 'Unknown GIF' };
  let hit: Awaited<ReturnType<typeof gifById>> = null;
  try { hit = await gifById(id); }
  catch { return { ok: false, status: 502, error: 'GIF search failed' }; }
  if (!hit) return { ok: false, status: 404, error: 'Unknown GIF' };
  return publishBotLine(gate.room, gate.uid, gifMarkdown(hit.url));
};
function botRoomLine(row: repo.MsgRow): BotRoomLine {
  const isBot = row.bot_id != null;
  const account = row.user_id != null ? repo.userById(row.user_id) : undefined;
  const botName = isBot ? (repo.botById(row.bot_id!)?.name ?? row.nick) : null;
  return {
    id: row.id,
    ts: row.ts,
    author: row.nick,
    username: account?.username ?? null,
    isBot,
    bot: botName,
    text: row.text,
  };
}
live.botRoomMessages = (roomId, bot, query) => {
  const gate = openBotRoom(roomId, bot.id);
  if (!gate.ok) return gate;
  const page = (rows: repo.MsgRow[], cursor: string | null) => ({ ok: true as const, messages: rows.map(botRoomLine), cursor });
  if (query.after !== undefined) {
    if (query.after.length > 80) return { ok: false, status: 400, error: 'Unknown cursor' };
    const anchor = repo.messageAnchor(gate.room.id, query.after);
    if (!anchor) return { ok: false, status: 400, error: 'Unknown cursor' };
    const rows = repo.messagesAfter(gate.room.id, anchor, query.limit ?? 50);
    return page(rows, rows.length ? rows[rows.length - 1].id : query.after);
  }
  if (!query.limitExplicit) return page([], repo.newestMessageId(gate.room.id));
  const rows = repo.messagesAfter(gate.room.id, null, query.limit ?? 50);
  return page(rows, rows.length ? rows[rows.length - 1].id : repo.newestMessageId(gate.room.id));
};
live.botGone = (botId) => { removeBot(botId); };
/** Startup: re-seat bots whose join was remembered (quietly; no "joined" line). Stale rows are dropped. */
function restoreBotJoins() {
  let restored = 0;
  let rows: ReturnType<typeof repo.rememberedBotJoins> = [];
  try { rows = repo.rememberedBotJoins(); } catch (err) { console.error('[bots] restore joins failed', (err as Error).message); return; }
  for (const row of rows) {
    const room = rooms.get(row.room_id);
    if (!row.name || !room || room.isPrivate || !repo.botAllowed(row.room_id, row.bot_id)) {
      repo.forgetBotJoin(row.bot_id, row.room_id);
      continue;
    }
    if (seatBot(room, { id: row.bot_id, name: row.name }, false).ok) restored++;
  }
  if (rows.length) console.log(`[bots] restored ${restored} of ${rows.length} bot room join(s)`);
}

function emitModPresence(present: boolean, user: UserInfo) {
  for (const room of rooms.values()) {
    if (room.members.has(user.id)) continue;
    if (present) io.to(`room:${room.id}`).emit('user:joined', user);
    else io.to(`room:${room.id}`).emit('user:left', { id: user.id });
  }
}
function clearModPresence() {
  if (!modSeen) return;
  clearTimeout(modSeen.timer);
  const user = modBotInfo(modSeen.botId, modSeen.name);
  modSeen = null;
  emitModPresence(false, user);
}
function armModTimer() {
  if (!modSeen) return;
  clearTimeout(modSeen.timer);
  const seen = modSeen;
  seen.timer = setTimeout(guardTimer('mod bot presence', () => {
    if (modSeen !== seen) return;
    const user = modBotInfo(seen.botId, seen.name);
    modSeen = null;
    emitModPresence(false, user);
  }), MOD_BOT_PRESENCE_MS);
  seen.timer.unref();
}
function noteModeratorSeen(bot: { id: number; name: string }) {
  const current = repo.moderatorBotId();
  if (bot.id !== current) {
    if (modSeen && modSeen.botId !== current) clearModPresence();
    return;
  }
  if (modSeen && modSeen.botId === bot.id) {
    modSeen.name = bot.name;
    armModTimer();
    return;
  }
  if (modSeen) clearModPresence();
  const timer = setTimeout(() => {}, MOD_BOT_PRESENCE_MS);
  timer.unref();
  modSeen = { botId: bot.id, name: bot.name, timer };
  armModTimer();
  emitModPresence(true, modBotInfo(bot.id, bot.name));
}
live.noteModBot = (bot) => { noteModeratorSeen(bot); };
live.modBotChanged = () => {
  const id = repo.moderatorBotId();
  if (modSeen && modSeen.botId !== id) clearModPresence();
};

const BOT_MOD_DENIED = 'Only the moderator bot can do that';
const BOT_MOD_FORBIDDEN = 'Bots cannot mute, delete messages, or run that moderation action';
function botIsModerator(bot: BotIdentity): boolean {
  return repo.moderatorBotId() === bot.id;
}
function accountIsAdmin(username: string, role: string): boolean {
  return role === 'admin' || ADMIN_USERNAMES.includes(username.toLowerCase());
}
/** Admins (including bootstrap names) and the bot itself are never a valid target. */
function botTargetRefusal(bot: BotIdentity, userId?: string, username?: string): string | null {
  const uid = userId?.trim() ?? '';
  const name = username?.trim().toLowerCase() ?? '';
  if (uid === botUserId(bot.id) || (name && name === bot.name.toLowerCase())) return 'You cannot do that to yourself';
  if (name) {
    const u = repo.userByName(name);
    if (u && accountIsAdmin(u.username, u.role)) return 'You cannot do that to an admin';
  }
  if (uid && !uid.startsWith('bot:')) {
    const s = sessions.get(uid);
    const usernameOf = s?.account?.username ?? s?.user?.nick;
    const roleOfTarget = s?.account?.role ?? s?.user?.role;
    if (usernameOf && roleOfTarget && accountIsAdmin(usernameOf, roleOfTarget)) return 'You cannot do that to an admin';
  }
  return null;
}
function parseModMinutes(v: unknown, max: number): { ok: true; minutes: number | null } | { ok: false } {
  if (v === undefined || v === null || v === '' || v === 0) return { ok: true, minutes: null };
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > max) return { ok: false };
  return { ok: true, minutes: Math.round(n) };
}
function humanInRoom(room: Room, userId?: string, username?: string): { sock: AppSocket; session: Session } | null {
  const wantId = userId?.trim() ?? '';
  const wantName = username?.trim().toLowerCase() ?? '';
  for (const id of room.members) {
    if (id.startsWith('bot:')) continue;
    const session = sessions.get(id);
    const sock = io.sockets.sockets.get(id);
    if (!session?.user || !sock) continue;
    if ((wantId && id === wantId) || (wantName && session.user.nick.toLowerCase() === wantName)) return { sock, session };
  }
  return null;
}
function modMessage(m: repo.MsgRow): BotModMessage {
  const room = rooms.get(m.room_id);
  let fromId: string | null = null;
  if (room) {
    for (const id of room.members) {
      const u = userOf(id);
      if (!u) continue;
      if ((m.user_id && u.accountId === m.user_id) || u.nick.toLowerCase() === m.nick.toLowerCase()) { fromId = id; break; }
    }
  }
  return { id: m.id, ts: m.ts, roomId: m.room_id, nick: m.nick, role: m.role, text: m.text, userId: m.user_id, fromId };
}
function requireModTarget(bot: BotIdentity, userId?: string, username?: string): BotResult | null {
  if (!userId?.trim() && !username?.trim()) return { ok: false, status: 400, error: 'userId or username is required' };
  const refusal = botTargetRefusal(bot, userId, username);
  if (refusal) return { ok: false, status: 403, error: refusal };
  return null;
}

live.botModerate = (bot, body: BotModBody): BotResult => {
  if (body.action === 'mute' || body.action === 'delete') return { ok: false, status: 403, error: BOT_MOD_FORBIDDEN };
  if (!botIsModerator(bot)) return { ok: false, status: 403, error: BOT_MOD_DENIED };
  const reason = cleanText(body.reason, LIMITS.banReasonMax);
  if (body.action === 'kick' || body.action === 'room-ban') {
    if (!body.roomId) return { ok: false, status: 400, error: 'roomId is required' };
    const refused = requireModTarget(bot, body.userId, body.username);
    if (refused) return refused;
    const room = rooms.get(body.roomId);
    if (!room) return { ok: false, status: 404, error: 'Room not found' };
    const human = humanInRoom(room, body.userId, body.username);
    if (!human || !human.session.user) return { ok: false, status: 404, error: 'User not in room' };
    if (human.session.account && accountIsAdmin(human.session.account.username, human.session.account.role)) {
      return { ok: false, status: 403, error: 'You cannot do that to an admin' };
    }
    if (body.action === 'kick') {
      punishRoom({
        by: bot.name, byAccountId: null, byNick: bot.name, room, targetSock: human.sock, targetSession: human.session,
        minutes: 10, reason, kickOnly: true, details: reason || null,
      });
      return { ok: true };
    }
    const parsed = parseModMinutes(body.minutes, 525_600);
    if (!parsed.ok) return { ok: false, status: 400, error: 'Bad duration' };
    punishRoom({
      by: bot.name, byAccountId: null, byNick: bot.name, room, targetSock: human.sock, targetSession: human.session,
      minutes: parsed.minutes, reason, kickOnly: false,
      details: `${parsed.minutes ? `${parsed.minutes} min` : 'until lifted'}${reason ? `; ${reason}` : ''}`,
    });
    return { ok: true };
  }
  if (body.action === 'site-ban') {
    if (!reason) return { ok: false, status: 400, error: 'A reason is required' };
    const refused = requireModTarget(bot, body.userId, body.username);
    if (refused) return refused;
    const parsed = parseModMinutes(body.minutes, 5_256_000);
    if (!parsed.ok) return { ok: false, status: 400, error: 'Bad duration' };
    let account = body.username?.trim() ? repo.userByName(body.username.trim()) : undefined;
    if (!account && body.userId) {
      const s = sessions.get(body.userId);
      if (s?.account) account = repo.userById(s.account.id);
    }
    if (!account) return { ok: false, status: 404, error: 'No such user' };
    if (accountIsAdmin(account.username, account.role)) return { ok: false, status: 403, error: 'You cannot do that to an admin' };
    const liveSessions = [...sessions.values()].filter((s) => s.account?.id === account!.id);
    const ip = liveSessions.find((s) => s.ip && s.ip !== 'unknown')?.ip ?? 'unknown';
    const deviceIds = [...new Set(liveSessions.flatMap((s) => s.deviceIds))];
    const roomId = liveSessions.find((s) => s.roomId)?.roomId ?? null;
    const applied = applySiteBan({
      by: bot.name, byAccountId: null, nick: account.username, accountId: account.id, ip, deviceIds, roomId,
      reason, minutes: parsed.minutes, kinds: ['account', 'ip', 'device'],
    });
    if (!applied.ok) return { ok: false, status: 400, error: applied.error };
    return { ok: true };
  }
  if (body.action === 'unban') {
    if (body.scope === 'room') body = { ...body, action: 'room-unban' };
    else if (body.scope === 'site') body = { ...body, action: 'site-unban' };
    else return { ok: false, status: 400, error: 'scope must be room or site' };
  }
  if (body.action === 'room-unban') {
    if (!body.roomId) return { ok: false, status: 400, error: 'roomId is required' };
    const name = body.username?.trim() ?? '';
    if (!name && !body.userId?.trim()) return { ok: false, status: 400, error: 'userId or username is required' };
    const refusal = botTargetRefusal(bot, body.userId, name);
    if (refusal) return { ok: false, status: 403, error: refusal };
    const room = rooms.get(body.roomId);
    if (!room) return { ok: false, status: 404, error: 'Room not found' };
    const account = name ? repo.userByName(name) : undefined;
    if (account && accountIsAdmin(account.username, account.role)) return { ok: false, status: 403, error: 'You cannot do that to an admin' };
    const nick = account?.username ?? name;
    if (!nick) return { ok: false, status: 400, error: 'username is required' };
    const key = repo.userKey({ userId: account?.id ?? null, nick });
    const lifted = repo.liftRoomBans(room.id, key, nick);
    if (!lifted) return { ok: false, status: 404, error: 'No active room ban' };
    repo.logAction(bot.name, null, 'room-unban', nick, room.id, reason || null);
    return { ok: true };
  }
  if (body.action === 'site-unban') {
    if (body.banId) {
      const row = repo.activeBanById(body.banId);
      if (!row) return { ok: false, status: 404, error: 'No active ban' };
      if (row.kind === 'account') {
        const u = repo.userById(Number(row.value));
        if (u && accountIsAdmin(u.username, u.role)) return { ok: false, status: 403, error: 'You cannot do that to an admin' };
      }
      if (row.label && row.label.toLowerCase() === bot.name.toLowerCase()) return { ok: false, status: 403, error: 'You cannot do that to yourself' };
      if (!repo.liftBan(body.banId, bot.name)) return { ok: false, status: 404, error: 'No active ban' };
      repo.logAction(bot.name, null, 'unban', row.label ?? `#${row.id}`, null, reason || `ban #${row.id}`);
      return { ok: true };
    }
    const name = body.username?.trim() ?? '';
    if (!name) return { ok: false, status: 400, error: 'username is required' };
    const refusal = botTargetRefusal(bot, undefined, name);
    if (refusal) return { ok: false, status: 403, error: refusal };
    const u = repo.userByName(name);
    if (!u) return { ok: false, status: 404, error: 'No such user' };
    if (accountIsAdmin(u.username, u.role)) return { ok: false, status: 403, error: 'You cannot do that to an admin' };
    const lifted = repo.liftBansForAccount(u.id, u.username, bot.name);
    if (!lifted) return { ok: false, status: 404, error: 'No active ban' };
    repo.logAction(bot.name, null, 'unban', u.username, null, reason || `lifted ${lifted}`);
    return { ok: true };
  }
  return { ok: false, status: 403, error: BOT_MOD_FORBIDDEN };
};

live.botModFeed = (bot, query: BotFeedQuery) => {
  if (!botIsModerator(bot)) return { ok: false, status: 403, error: BOT_MOD_DENIED };
  if (query.kind === 'rooms') {
    const list = [...rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      topic: room.topic,
      isPrivate: room.isPrivate,
      users: roomUsers(room).map((u) => ({ id: u.id, nick: u.nick, role: u.role, accountId: u.accountId ?? null })),
    }));
    return { ok: true, rooms: list };
  }
  const limit = Math.max(1, Math.min(query.limit && Number.isFinite(query.limit) ? Math.round(query.limit) : 100, 200));
  if (query.roomId && !rooms.has(query.roomId)) return { ok: false, status: 404, error: 'Room not found' };
  const rows = query.since == null
    ? (query.roomId ? repo.recentMessages(query.roomId, limit) : repo.recentMessagesAll(limit))
    : repo.messagesSince(query.since, limit, query.roomId);
  return { ok: true, messages: rows.map(modMessage) };
};

function sessionInRoom(roomId: string, accountId: number | null, deviceIds: string[]): Session | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  for (const id of room.members) {
    if (id.startsWith('bot:')) continue;
    const s = sessions.get(id);
    if (!s?.user) continue;
    if (accountId && s.account?.id === accountId) return s;
    if (deviceIds.some((d) => s.deviceIds.includes(d))) return s;
  }
  return null;
}
function publishSounds(roomId: string) {
  const sounds = repo.listSounds(roomId).map((row) => ({ id: row.id, name: row.name }));
  io.to(`room:${roomId}`).emit('room:sounds', { sounds });
}
live.isRoomMember = (roomId, accountId, deviceIds) => !!sessionInRoom(roomId, accountId, deviceIds);
live.isRoomCreator = (roomId, accountId, deviceIds) => {
  const room = rooms.get(roomId);
  if (!room) return false;
  if (accountId && room.ownerUserId === accountId) return true;
  const s = sessionInRoom(roomId, accountId, deviceIds);
  return !!s && isOwner(s, room);
};
live.soundsChanged = (roomId) => { publishSounds(roomId); };
live.roomThumbInfo = (roomId) => {
  const room = rooms.get(roomId);
  return room ? { ownerUserId: room.ownerUserId, isPrivate: room.isPrivate, thumbId: room.thumbId } : null;
};
live.roomThumbChanged = (roomId, thumbId, by) => {
  const room = rooms.get(roomId);
  if (!room) return;
  room.thumbId = thumbId;
  const thumbUrl = thumbId ? roomThumbUrl(thumbId) : null;
  io.to(`room:${room.id}`).emit('room:thumb', { thumbUrl, by });
  systemMsg(room, thumbId ? `${by} updated the room thumbnail` : `${by} removed the room thumbnail`);
  broadcastRooms();
};
function themeOf(room: Room): RoomThemeInfo {
  if (room.isPrivate) return { bannerUrl: null, accent: null, welcome: null };
  const t = repo4.roomTheme(room.id);
  return { bannerUrl: t.bannerId ? roomBannerUrl(t.bannerId) : null, accent: t.accent, welcome: t.welcome };
}
live.roomBannerInfo = (roomId) => {
  const room = rooms.get(roomId);
  return room ? { ownerUserId: room.ownerUserId, isPrivate: room.isPrivate, bannerId: repo4.roomTheme(roomId).bannerId } : null;
};
live.roomBannerChanged = (roomId, bannerId, by) => {
  const room = rooms.get(roomId);
  if (!room) return;
  repo4.setRoomTheme(roomId, { bannerId });
  io.to(`room:${room.id}`).emit('room:theme', { theme: themeOf(room) });
  systemMsg(room, bannerId ? `${by} updated the room banner` : `${by} removed the room banner`);
};
live.roomIconInfo = (roomId) => {
  const room = rooms.get(roomId);
  return room ? { ownerUserId: room.ownerUserId, isPrivate: room.isPrivate, iconId: room.iconId } : null;
};
live.roomIconChanged = (roomId, iconId, by) => {
  const room = rooms.get(roomId);
  if (!room) return;
  room.iconId = iconId;
  const iconUrl = iconId ? roomIconUrl(iconId) : null;
  io.to(`room:${room.id}`).emit('room:icon', { iconUrl, by });
  systemMsg(room, iconId ? `${by} updated the room icon` : `${by} removed the room icon`);
  broadcastRooms();
};
live.inviteRoom = (roomId) => {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    id: room.id, name: room.name, topic: room.topic, isPrivate: room.isPrivate, passwordRequired: !!room.passwordHash, locked: room.locked,
    ownerUserId: room.ownerUserId, modIds: [...room.mods], category: room.category, tags: room.tags, users: roomUsers(room).length,
    thumbId: room.thumbId, iconId: room.iconId,
  };
};
live.inviteSettingsChanged = (roomId, on, by) => {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(`room:${room.id}`).emit('room:inviteSettings', { modsCanInvite: on, by });
};
live.accountSocket = (userId) => {
  const sid = accountSockets.get(userId);
  return sid && io.sockets.sockets.get(sid)?.connected ? sid : null;
};

// ================= batch 3: module-level helpers =================
/** Category from the fixed list (or none) plus up to 5 cleaned, word-filtered tags. */
function roomMetaInput(category: unknown, tags: unknown): { error: string } | { category: string | null; tags: string[] } {
  let cat: string | null = null;
  if (category != null && category !== '') {
    if (!isRoomCategory(category)) return { error: 'Pick a category from the list' };
    cat = category;
  }
  const t = cleanTags(tags);
  if ('error' in t) return t;
  if (t.tags.some((x) => hasFilteredWord(x) || hasFilteredWord(x.replace(/-/g, ' ')))) return { error: 'Please pick other tags' };
  return { category: cat, tags: t.tags };
}
function emotesOf(roomId: string): RoomEmote[] {
  try { return repo3.emotesForRoom(roomId).map((e) => ({ id: e.id, name: e.name, url: emoteUrl(e.id), animated: !!e.animated })); } catch { return []; }
}
/** A new custom emoji goes to the site moderation queue (filed by the moderator bot) so staff can review it. */
live.liveCounts = () => ({ online: [...sessions.values()].filter((x) => x.user).length, rooms: [...rooms.values()].filter((r) => r.members.size > 0).length });
live.emoteAdded = (roomId, emote, by) => {
  try {
    const room = rooms.get(roomId);
    const bot = modBotName();
    const id = modq.insertReport({
      reporterUserId: null, reporterNick: bot, reporterIp: 'emote', targetUserId: by.id, targetNick: by.username, targetIp: null, targetDevice: null,
      roomId, messageId: null, messageText: `:${emote.name}:`, kind: 'room', key: `emote:${emote.id}`, category: 'other',
      note: `New custom emoji :${emote.name}: in #${room?.name ?? roomId} by ${by.username}. Review: ${emote.url}`,
      snapshot: null, privateKind: null, context: [], notify: false,
    });
    const row = modq.reportById(id);
    if (row) afterNewReport(row);
  } catch (err) { console.error('[emotes] review entry', (err as Error).message); }
};
live.roomEmotesChanged = (roomId) => {
  const room = rooms.get(roomId);
  if (room) io.to(`room:${room.id}`).emit('room:emotes', { emotes: emotesOf(room.id) });
};

// ---- radio ("now playing") ----
const radioOn = new Set<string>(); // socket ids that are playing Labs FM
function radioHereCount(room: Room): number { let n = 0; for (const id of room.members) if (radioOn.has(id)) n++; return n; }
const radioPinged = new Map<string, number>();
function radioRoomPing(room: Room) {
  const n = radioHereCount(room);
  if ((radioPinged.get(room.id) ?? 0) === n) return;
  if (n) radioPinged.set(room.id, n); else radioPinged.delete(room.id);
  io.to(`room:${room.id}`).emit('radio:room', { listening: n });
}
initRadio({
  onUpdate: (np) => {
    io.to('radio').emit('radio:np', { np });
    // rooms where someone is listening show the card to everyone in the room
    for (const room of rooms.values()) if (radioHereCount(room) > 0) io.to(`room:${room.id}`).except('radio').emit('radio:np', { np });
  },
  shouldPoll: () => radioOn.size > 0,
  guard: (label, fn) => guardTimer(label, fn),
});

// ---- room stats ----
const STATS_SAMPLE_MS = Math.max(200, Number(process.env.STATS_SAMPLE_MS) || 60_000);
const humanCount = (room: Room) => { let n = 0; for (const id of room.members) if (!id.startsWith('bot:')) n++; return n; };
/** per-day guest uniqueness lives only in memory; the DB keeps a bare count */
const guestDays = new Map<string, Set<string>>();
function statVisit(room: Room, s: Session) {
  if (room.isPrivate || !s.user) return;
  try {
    repo3.statPeak(room.id, humanCount(room));
    if (s.account) { repo3.statVisitor(room.id, s.account.id); return; }
    const day = repo3.dayOf(Date.now());
    const key = `${room.id}:${day}`;
    let set = guestDays.get(key);
    if (!set) {
      for (const k of guestDays.keys()) if (!k.endsWith(`:${day}`)) guestDays.delete(k);
      set = new Set();
      guestDays.set(key, set);
    }
    const who = s.deviceIds[0] ?? s.ip;
    if (!set.has(who)) { set.add(who); repo3.statGuest(room.id); }
  } catch (err) { console.error('[stats] visit', (err as Error).message); }
}
function statMsg(room: Room, s: Session) {
  if (room.isPrivate) return;
  noteActivityMsg(room.id);
  try { repo3.statMessage(room.id, s.account?.id ?? null); } catch (err) { console.error('[stats] message', (err as Error).message); }
}
function statsSample() {
  for (const room of rooms.values()) {
    if (room.isPrivate) continue;
    const n = humanCount(room);
    if (n) repo3.statPeak(room.id, n);
  }
}

// ---- smarter lobby: friends online now, active rooms, jump back in ----
/** A friend as `viewer` may see them: online, not blocked either way; the room only when public, open and shown. */
function friendOnlineFor(viewer: number, friendId: number): FriendOnline | null {
  const sid = accountSockets.get(friendId);
  const ts = sid ? sessions.get(sid) : undefined;
  if (!sid || !ts?.user) return null;
  if (lobby.blockedEitherWay(viewer, friendId)) return null;
  const u = repo.userById(friendId);
  let room: FriendOnline['room'] = null;
  if (ts.roomId && lobby.showRoom(friendId)) {
    const r = rooms.get(ts.roomId);
    if (r && !r.isPrivate && !r.passwordHash && !r.callPeers) room = { id: r.id, name: r.name };
  }
  return {
    userId: friendId, username: u?.username ?? ts.user.nick, hasAvatar: !!u?.has_avatar,
    chatColor: u?.chat_color ?? null, chatEffect: publicChatEffect(u?.chat_effect), socketId: sid, room,
  };
}
function acceptedFriendIds(userId: number): number[] {
  return repo.listFriendships(userId).filter((r) => r.status === 'accepted').map((r) => (r.user_id === userId ? r.peer_id : r.user_id));
}
function friendsOnlineFor(viewer: number): FriendOnline[] {
  return acceptedFriendIds(viewer).map((id) => friendOnlineFor(viewer, id)).filter((f): f is FriendOnline => !!f)
    .sort((a, b) => Number(!!b.room) - Number(!!a.room) || a.username.localeCompare(b.username));
}
/** Tell each online friend how this account now looks to them (room changed, went on/offline, privacy, blocks). */
function friendRoomPing(userId: number) {
  for (const other of acceptedFriendIds(userId)) {
    if (!accountSockets.has(other)) continue;
    emitToAccount(other, 'lobby:friend', { userId, entry: friendOnlineFor(other, userId) });
  }
}
function pingRoomFriends(room: Room) {
  for (const sid of room.members) { const a = sessions.get(sid)?.account; if (a) friendRoomPing(a.id); }
}
function lobbyJoined(room: Room, s: Session) {
  if (!s.account) return;
  try { if (!room.isPrivate && !room.callPeers) lobby.touchRecent(s.account.id, room.id); } catch (err) { console.error('[lobby] recent', (err as Error).message); }
  friendRoomPing(s.account.id);
}
function lobbyLeft(room: Room, accountId: number) {
  try { repo5.markRead(accountId, room.id); repo5.readMentionsInRoom(accountId, room.id); } catch (err) { console.error('[unread] mark', (err as Error).message); }
  // the visit ends now: unread counts start from here
  try { if (!room.isPrivate && !room.callPeers && rooms.get(room.id) === room) lobby.touchRecent(accountId, room.id); } catch (err) { console.error('[lobby] recent', (err as Error).message); }
  friendRoomPing(accountId);
}
function recentRoomsFor(s: Session): RecentRoom[] {
  if (!s.account) return [];
  const out: RecentRoom[] = [];
  const ident = identOf(s);
  for (const r of lobby.recentRows(s.account.id)) {
    if (out.length >= LOBBY.recentShown) break;
    const room = rooms.get(r.room_id);
    if (!room || room.isPrivate || room.callPeers) continue;
    if (repo.activeRoomBan(room.id, ident)) continue;
    const sum = summary(room);
    const u = lobby.unreadSince(room.id, r.visited_at, s.account.id, s.account.username);
    out.push({
      id: room.id, name: room.name, topic: room.topic, users: sum.users, passwordRequired: sum.passwordRequired,
      ...(sum.thumbUrl ? { thumbUrl: sum.thumbUrl } : {}), ...(sum.iconUrl ? { iconUrl: sum.iconUrl } : {}), visitedAt: r.visited_at, unread: u.unread, mentions: u.mentions,
    });
  }
  return out;
}

function noteActivityMsg(roomId: string) {
  let a = recentMsgTs.get(roomId);
  if (!a) { a = []; recentMsgTs.set(roomId, a); }
  a.push(Date.now());
  if (a.length > 500) a.splice(0, a.length - 500);
}
function activityOf(room: Room): number { return activityCache.get(room.id) ?? 0; }
function activityTick() {
  const cut = Date.now() - LOBBY.activityWindowMs;
  const next = new Map<string, number>();
  for (const room of rooms.values()) {
    if (room.isPrivate) continue;
    const ts = recentMsgTs.get(room.id);
    if (ts) { while (ts.length && ts[0] < cut) ts.shift(); if (!ts.length) recentMsgTs.delete(room.id); }
    let people = 0, live = 0;
    for (const id of room.members) {
      if (id.startsWith('bot:')) continue;
      const u = sessions.get(id)?.user;
      if (!u) continue;
      people++;
      if (u.cam || u.screen) live++;
    }
    const score = activityScore(people, ts?.length ?? 0, live);
    if (score) next.set(room.id, score);
  }
  for (const id of recentMsgTs.keys()) if (!rooms.has(id)) recentMsgTs.delete(id);
  let changed = next.size !== activityCache.size;
  if (!changed) for (const [id, v] of next) if (activityCache.get(id) !== v) { changed = true; break; }
  activityCache = next;
  if (changed) broadcastRooms();
}

// ---- scheduled messages ----
const SCHEDULE_TICK = Math.max(100, Number(process.env.SCHEDULE_TICK_MS) || 15_000);
/** test-only: shorten a "day" so daily/weekly repeats can be observed */
const SCHEDULE_DAY_MS = Math.max(500, Number(process.env.SCHEDULE_DAY_MS) || 86_400_000);
function tzOffsetMin(ts: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts));
    const g = (t: string) => Number(parts.find((x) => x.type === t)?.value);
    return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ts / 1000) * 1000) / 60_000);
  } catch { return 0; }
}
/** First repeat slot strictly after `after`; keeps the creator's wall-clock time across DST when a zone is known. */
function nextSlotAfter(prev: number, repeat: 'daily' | 'weekly', tz: string | null, after: number): number {
  const step = (repeat === 'weekly' ? 7 : 1) * SCHEDULE_DAY_MS;
  const k = Math.max(1, Math.floor((after - prev) / step) + 1);
  let next = prev + k * step;
  if (tz && SCHEDULE_DAY_MS === 86_400_000) next += (tzOffsetMin(prev, tz) - tzOffsetMin(next, tz)) * 60_000;
  if (next <= after) next += step;
  return next;
}
function scheduleInfo(r: repo3.ScheduleRow): RoomScheduleInfo {
  let poll: RoomScheduleInfo['poll'];
  if (r.kind === 'poll') { try { const j = JSON.parse(r.poll ?? '{}'); poll = { options: Array.isArray(j.options) ? j.options.map(String) : [], durationMin: Number(j.durationMin) || null }; } catch { poll = { options: [], durationMin: null }; } }
  return { id: r.id, text: r.text, repeat: r.repeat, nextAt: r.next_at, by: r.created_by_nick, createdAt: r.created_at, kind: r.kind === 'banner' ? 'banner' : r.kind === 'poll' ? 'poll' : 'message', ...(poll ? { poll } : {}) };
}
/** Only people who can manage the room see the schedule list. */
function emitSchedules(room: Room) {
  const list = repo3.schedulesForRoom(room.id).map(scheduleInfo);
  for (const id of room.members) {
    const sess = sessions.get(id);
    const sock = io.sockets.sockets.get(id);
    if (sess && sock && canRoomManage(sess, room)) sock.emit('room:schedules', { schedules: list });
  }
}
/** An announcement line in chat that is kept in history (scheduled posts, event reminders). */
/** Post a poll line (top level or in a thread). Used by poll:create and scheduled polls. */
function postPoll(room: Room, by: { fromId: string; nick: string; role?: Role; userId: number | null; profile: ReturnType<typeof profileOf>; key: string; ip: string | null; device: string | null },
  rawQuestion: string, rawOptions: string[], durationMin: number | null, parentId: string | null): repo2.PollRow {
  const question = maskWords(rawQuestion);
  const options = rawOptions.map(maskWords);
  const text = pollFallbackText(question);
  const msg: ChatMessage = { kind: 'chat', id: randomUUID(), ts: Date.now(), fromId: by.fromId, from: by.nick, role: by.role, text, ...by.profile, mentions: [], ...(parentId ? { parentId } : {}) };
  repo.insertMessage({ id: msg.id, room_id: room.id, ts: msg.ts, user_id: by.userId, nick: by.nick, role: by.role ?? 'user', text, ip: by.ip, device_id: by.device, parent_id: parentId });
  const row: Omit<repo2.PollRow, 'closed_at'> = {
    id: randomUUID(), room_id: room.id, message_id: msg.id, question, options: JSON.stringify(options), created_by_user: by.userId,
    created_by_key: by.key, created_by_nick: by.nick, created_at: msg.ts,
    closes_at: durationMin ? msg.ts + durationMin * POLL_MINUTE : null,
  };
  repo2.insertPoll(row);
  const stored = repo2.pollById(row.id)!;
  schedulePollClose(stored);
  msg.poll = pollInfo(stored);
  msg.reactions = [];
  if (parentId) msg.replyCount = repo.replyCount(parentId);
  io.to(`room:${room.id}`).emit('chat:message', msg);
  if (parentId) io.to(`room:${room.id}`).emit('chat:replies', { messageId: parentId, replyCount: msg.replyCount ?? 0 });
  if (!room.isPrivate) io.emit('room:activity', { roomId: room.id, mentions: [] });
  return stored;
}
function postScheduled(room: Room, r: repo3.ScheduleRow) {
  if (r.kind === 'poll') {
    let spec: { options?: unknown; durationMin?: unknown } = {};
    try { spec = JSON.parse(r.poll ?? '{}'); } catch { /* bad row: skip */ }
    const v = validatePoll({ question: r.text, options: spec.options, durationMin: spec.durationMin ?? null });
    if (!v.ok) { console.error('[schedule] bad poll row', r.id, v.error); return; }
    postPoll(room, { fromId: '', nick: r.created_by_nick, role: 'user', userId: r.created_by_user, profile: r.created_by_user ? profileOf(repo.accountById(r.created_by_user) ?? null) : {},
      key: r.created_by_user ? `u:${r.created_by_user}` : `n:${r.created_by_nick.toLowerCase()}`, ip: null, device: null }, v.value.question, v.value.options, v.value.durationMin ?? null, null);
    return;
  }
  if (r.kind === 'banner') {
    // scheduled banner: replaces the room's announcement banner at that time
    room.announcement = { text: r.text, at: Date.now(), by: r.created_by_nick };
    repo3.setAnnouncement(room.id, r.text, r.created_by_nick);
    io.to(`room:${room.id}`).emit('room:announcement', { announcement: room.announcement });
    return;
  }
  const msg: ChatMessage = {
    kind: 'chat', id: randomUUID(), ts: Date.now(), fromId: '', from: r.created_by_nick, role: 'user', text: r.text,
    accountId: r.created_by_user ?? undefined, mentions: [], reactions: [], announce: { by: r.created_by_nick },
  };
  repo.insertMessage({ id: msg.id, room_id: room.id, ts: msg.ts, user_id: r.created_by_user, nick: r.created_by_nick, role: 'user', text: r.text, ip: null, device_id: null });
  repo3.markAnnounce(msg.id, room.id, r.id, r.created_by_nick);
  io.to(`room:${room.id}`).emit('chat:message', msg);
  if (!room.isPrivate) io.emit('room:activity', { roomId: room.id, mentions: [] });
}
/**
 * Due rows: post when at most SCHEDULE_GRACE_MS late (so a restart posts a missed one at most once),
 * otherwise skip. One-time rows are then removed; repeats jump to their next future slot.
 */
function scheduleTick(at = Date.now()) {
  const touched = new Set<Room>();
  for (const r of repo3.dueSchedules(at)) {
    const room = rooms.get(r.room_id);
    const post = !!room && at - r.next_at <= SCHEDULE_GRACE_MS;
    try { if (post) postScheduled(room!, r); } catch (err) { console.error('[schedule] post failed', (err as Error).message); }
    if (r.repeat === 'once') repo3.deleteSchedule(r.id);
    else repo3.advanceSchedule(r.id, nextSlotAfter(r.next_at, r.repeat, r.tz, at), post ? at : null);
    if (room) touched.add(room);
  }
  for (const room of touched) emitSchedules(room);
}

function endSocket(sock: AppSocket, reason: string) {
  sock.emit('session:ended', { reason });
  setTimeout(guardTimer('end socket', () => sock.disconnect(true)), 50);
}

// hooks used by the HTTP admin API
live.enforceBans = () => {
  for (const sock of io.sockets.sockets.values()) {
    const s = sessions.get(sock.id);
    if (!s) continue;
    const ban = repo.activeBan({ userId: s.account?.id ?? null, ip: s.ip, deviceIds: s.deviceIds, staff: isStaff(s) });
    if (ban) { leaveRoom(sock, 'was banned'); endSocket(sock, repo.banMessage(ban)); }
  }
};
live.profileChanged = (userId) => {
  const fresh = repo.accountById(userId);
  if (!fresh) return;
  for (const s of sessions.values()) {
    if (s.account?.id !== userId) continue;
    s.account = fresh;
    if (s.user) {
      s.user.chatColor = fresh.chatColor;
      s.user.chatEffect = fresh.chatEffect;
      s.user.hasAvatar = fresh.hasAvatar;
      s.user.accountId = fresh.id;
      if (s.roomId) io.to(`room:${s.roomId}`).emit('user:updated', s.user);
    }
  }
};
live.badgesChanged = (userId) => { refreshBadges(userId); };
live.levelChanged = (userId) => { refreshLevel(userId); };
live.appealFiled = (a) => {
  try {
    const id = modq.insertReport({
      reporterUserId: a.userId, reporterNick: a.username ?? 'banned visitor', reporterIp: 'appeal', targetUserId: a.userId, targetNick: a.username, targetIp: null, targetDevice: null,
      roomId: null, messageId: null, messageText: a.text.slice(0, 2000), kind: 'user', key: `appeal:${a.id}`, category: 'other',
      note: `Ban appeal #${a.id}${a.username ? ` from ${a.username}` : ''} (ban reason: ${a.reason}): ${a.text}`.slice(0, 1200),
      snapshot: null, privateKind: null, context: [], notify: false,
    });
    const row = modq.reportById(id);
    if (row) afterNewReport(row);
  } catch (err) { console.error('[appeals] queue entry', (err as Error).message); }
};
live.appealDecided = (id, status, by, note) => {
  try { modq.closeGroup(`appeal:${id}`, status === 'approved' ? 'resolved' : 'dismissed', by, note, status === 'approved' ? 'appeal approved: ban lifted' : 'appeal denied'); } catch (err) { console.error('[appeals] close', (err as Error).message); }
  emitStaffCounts(true);
};
live.roleChanged = (userId, role) => {
  for (const [id, s] of sessions) {
    if (s.account?.id !== userId) continue;
    s.account.role = role as repo.AccountRole;
    if (s.user) {
      s.user.role = role;
      if (s.roomId) io.to(`room:${s.roomId}`).emit('user:updated', s.user);
    }
    io.to(id).emit('account:role', { role });
  }
};
live.nickHeldByOther = (nick, deviceIds) => {
  const sid = nicksInUse.get(nick.toLowerCase());
  if (!sid) return false;
  const s = sessions.get(sid);
  return !!s && (!!s.account || !s.deviceIds.some((d) => deviceIds.includes(d)));
};
live.stats = () => ({ rooms: rooms.size, users: sessions.size });

// per-IP buckets (shared by all sockets from one address)
const ipChat = new KeyedLimiter(LIMITS.ipChatBurst, LIMITS.chatWindowMs);
const ipAct = new KeyedLimiter(LIMITS.ipActionBurst, LIMITS.actionWindowMs);
const ipSig = new KeyedLimiter(LIMITS.ipSignalBurst, LIMITS.signalWindowMs);
const ipConnect = new KeyedLimiter(LIMITS.connectPerIpPerMin, 60_000);
// ---------- moderation queue ----------
/** auto-hidden message ids (pending review); mirrored in hidden_messages */
const hiddenMsgs = new Set<string>(modq.hiddenIds().map((h) => h.message_id));
/** from / after / before from a search request, validated. */
function searchFilterOf(p: unknown): repo2.SearchFilter {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const from = typeof o.from === 'string' ? o.from.trim().replace(/^@/, '').slice(0, LIMITS.nickMax ?? 32) : '';
  const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e14 ? Math.floor(v) : null);
  return { from: from || null, after: ms(o.after), before: ms(o.before) };
}
/** Recent whisper lines per room, memory only, so a recipient can report what they saw. */
interface WhisperLogEntry { m: WhisperMessage; members: Set<string>; accountId: number | null; ip: string; device: string | null; roomId: string }
const whisperLog = new Map<string, WhisperLogEntry>();
const WHISPER_LOG_MAX = 2000;
function logWhisper(e: WhisperLogEntry) {
  whisperLog.set(e.m.id, e);
  if (whisperLog.size > WHISPER_LOG_MAX) whisperLog.delete(whisperLog.keys().next().value as string);
}
const reportUserRl = new KeyedLimiter(MODQ.perUserPerHour, 60 * 60_000);
const staffPushAt = new Map<number, number>();

/** Site staff, or a room owner / room mod for lines in their room. */
function canReview(s: Session | undefined, roomId: string): boolean {
  if (!s?.user) return false;
  if (isStaff(s)) return true;
  const room = rooms.get(roomId);
  return !!room && canRoomManage(s, room);
}
function liveAccount(id: number): { sock: AppSocket; ts: Session } | null {
  const sid = accountSockets.get(id);
  const sock = sid ? io.sockets.sockets.get(sid) : undefined;
  const ts = sid ? sessions.get(sid) : undefined;
  return sock && ts?.user ? { sock, ts } : null;
}
function liveReportTarget(r: modq.ReportRowFull): { sock: AppSocket; ts: Session } | null {
  if (r.target_user_id) return liveAccount(r.target_user_id);
  if (!r.target_nick) return null;
  const sid = nicksInUse.get(r.target_nick.toLowerCase());
  const sock = sid ? io.sockets.sockets.get(sid) : undefined;
  const ts = sid ? sessions.get(sid) : undefined;
  return sock && ts?.user && !ts.account ? { sock, ts } : null;
}
function identOfReport(r: modq.ReportRowFull): repo.Ident {
  const t = liveReportTarget(r);
  if (t) return identOf(t.ts);
  return { userId: r.target_user_id, nick: r.target_nick ?? '', ip: r.target_ip ?? 'unknown', deviceIds: r.target_device ? [r.target_device] : [] };
}
function modqView(staff: boolean): modq.ItemView {
  return {
    staff,
    messageExists: (id) => { const m = repo.messageById(id); return !!m && !m.deleted && m.burned_at == null; },
    hidden: (id) => hiddenMsgs.has(id),
    roomName: (id) => rooms.get(id)?.name ?? repo.roomRowById(id)?.name ?? null,
    targetOnline: (r) => !!liveReportTarget(r),
    targetRole: (uid) => (uid ? repo.userById(uid)?.role ?? null : null),
  };
}
/** Up to 10 lines around a message (5 before / 5 after when available), the message itself marked. */
function contextAround(m: repo.MsgRow): ReportContextLine[] {
  const total = MODQ.contextSize;
  const before = modq.messagesBefore(m.room_id, m.ts, m.id, total);
  const after = modq.messagesAfter(m.room_id, m.ts, m.id, total);
  const nAfter = Math.min(after.length, Math.max(total / 2, total - before.length));
  const nBefore = Math.min(before.length, total - nAfter);
  const line = (r: repo.MsgRow, target = false): ReportContextLine => ({
    ts: r.ts, from: r.nick,
    text: r.burn_ttl != null && !target ? '[burn message]' : r.text,
    ...(target ? { target: true } : {}), ...(r.deleted ? { deleted: true } : {}),
  });
  return [...before.slice(0, nBefore).reverse().map((r) => line(r)), line(m, true), ...after.slice(0, nAfter).map((r) => line(r))];
}
function attachmentsOf(m: repo.MsgRow): { list: ReportAttachment[]; files: { src: string; name: string; i: number }[] } {
  const list: ReportAttachment[] = [];
  const files: { src: string; name: string; i: number }[] = [];
  for (const img of repo.chatImagesForMessages([m.id])) {
    files.push({ src: uploadPath(img.name), name: img.name, i: list.length });
    list.push({ kind: 'image', ref: img.name });
  }
  if (m.voice_id) {
    const v = repo.voiceNotesForMessages([m.id])[0];
    const src = v ? voiceFilePath(v.id, v.ext) : null;
    if (v && src) files.push({ src, name: `${v.id}.${v.ext}`, i: list.length });
    list.push({ kind: 'voice', ref: m.voice_id, ms: m.voice_ms ?? undefined, mime: v?.mime });
  }
  return { list, files };
}
function emitStaffCounts(fresh: boolean) {
  const counts = modq.counts();
  for (const [sid, ts] of sessions) if (ts.user && isStaff(ts)) io.to(sid).emit('modq:counts', { counts, ...(fresh ? { fresh: true } : {}) });
}
function emitRoomCounts(roomId: string, fresh: boolean) {
  const room = rooms.get(roomId);
  if (!room) return;
  const counts = modq.counts({ roomId });
  for (const sid of room.members) {
    const ts = sessions.get(sid);
    if (ts?.user && canRoomManage(ts, room)) io.to(sid).emit('modq:room-counts', { roomId, counts, ...(fresh ? { fresh: true } : {}) });
  }
}
function pushStaffNewReport() {
  const t = Date.now();
  for (const id of modq.staffAccountIds()) {
    if ((staffPushAt.get(id) ?? 0) > t - 2 * 60_000) continue;
    if (accountConnected(id)) continue;
    staffPushAt.set(id, t);
    pushIfAway(id, { title: 'New report', body: 'New report', url: '/admin', tag: 'modq' });
  }
}
function setHidden(messageId: string, roomId: string, hidden: boolean) {
  if (hidden) { hiddenMsgs.add(messageId); io.to(`room:${roomId}`).emit('chat:hidden', { id: messageId, hidden: true }); return; }
  hiddenMsgs.delete(messageId);
  const m = repo.messageById(messageId);
  io.to(`room:${roomId}`).emit('chat:hidden', { id: messageId, hidden: false, ...(m && !m.deleted ? { message: chatFromRow(m, [], repo.replyCount(m.id)) } : {}) });
}
function afterNewReport(rep: modq.ReportRowFull) {
  if (rep.message_id && rep.room_id && !hiddenMsgs.has(rep.message_id)) {
    const n = modq.recentRegisteredReporters(rep.message_id);
    if (n >= MODQ.autoHideReporters) {
      modq.hideMessage(rep.message_id, rep.room_id, rep.id);
      setHidden(rep.message_id, rep.room_id, true);
      repo.logAction('auto-safety', null, 'auto-hide', rep.target_nick, rep.room_id, `report #${rep.id}; ${n} registered reporters within ${MODQ.autoHideWindowMs / 60_000} min`);
    }
  }
  emitStaffCounts(true);
  if (rep.room_id && (rep.target_kind ?? 'message') === 'message' && rep.private_kind !== 'whisper') emitRoomCounts(rep.room_id, true);
  pushStaffNewReport();
}
/** One line to each reporter who asked to hear back (no details). */
function notifyReporters(rows: modq.ReportRowFull[], tookAction: boolean) {
  const text = tookAction ? REPORTER_THANKS.action : REPORTER_THANKS.reviewed;
  const done = new Set<number>();
  const ids: number[] = [];
  for (const r of rows) {
    if (!r.notify_reporter || r.reporter_user_id == null || r.reporter_notified_at != null) continue;
    ids.push(r.id);
    if (done.has(r.reporter_user_id)) continue;
    done.add(r.reporter_user_id);
    const live = liveAccount(r.reporter_user_id);
    modq.addNotice(r.reporter_user_id, 'report', text, !!live);
    if (live) live.sock.emit('user:notice', { kind: 'report', text, at: Date.now() });
  }
  modq.markReporterNotified(ids);
}

interface QueueActor { label: string; accountId: number | null; role: Role; nick: string; site: boolean; room: Room | null }
type QueueResult = { ok: true; resolution: string; status: 'resolved' | 'dismissed'; closed: number } | { ok: false; error: string; status: number };
const QUEUE_ACTIONS: QueueAction[] = ['delete', 'mute', 'kick', 'ban', 'warn', 'dismiss', 'resolve'];
const durLabel = (minutes: number | null) => (minutes ? `${minutes} min` : 'permanent');

function queueAct(actor: QueueActor, reportId: number, body: { action?: unknown; minutes?: unknown; reason?: unknown; note?: unknown } | undefined): QueueResult {
  const fail = (status: number, error: string): QueueResult => ({ ok: false, status, error });
  const rep = modq.reportById(Math.floor(Number(reportId)));
  if (!rep) return fail(404, 'No such report');
  const key = modq.groupKeyOf(rep);
  const rows = modq.groupRows(key, 'active');
  if (!rows.length) return fail(409, 'This report was already handled');
  const action = body?.action as QueueAction;
  if (!QUEUE_ACTIONS.includes(action)) return fail(400, 'Unknown action');
  const kind = rep.target_kind ?? (rep.message_id ? 'message' : 'user');
  const room = actor.site ? null : actor.room;
  if (!actor.site) {
    const filterEntry = (rep.target_key ?? '').startsWith(`filter:${room?.id}:`);
    if (!room || rep.room_id !== room.id || (kind !== 'message' && !filterEntry) || rep.private_kind === 'whisper') return fail(403, 'Not a report about this room');
    if (action === 'warn') return fail(403, 'Warnings are sent by site staff');
  }
  const note = cleanText(body?.note, MODQ.resolutionNoteMax) || null;
  const refs = `report #${rep.id}${rows.length > 1 ? ` (+${rows.length - 1} more)` : ''}`;
  const tgt = rep.target_user_id ? repo.userById(rep.target_user_id) : undefined;
  const actorIsStaff = isStaffRole(actor.role);
  if (['mute', 'kick', 'ban', 'warn'].includes(action)) {
    if (!rep.target_user_id && !rep.target_nick) return fail(400, 'Nobody to act on');
    if (tgt && actor.accountId === tgt.id) return fail(403, 'You cannot act on yourself');
    if (actorIsStaff) {
      if (tgt && rank[tgt.role] >= rank[actor.role]) return fail(403, 'You cannot act on that user');
    } else if (room) {
      const isOwnerActor = room.ownerUserId != null && room.ownerUserId === actor.accountId;
      if (tgt && isStaffRole(tgt.role)) return fail(403, 'You cannot act on site staff');
      if (!isOwnerActor && tgt && (room.ownerUserId === tgt.id || room.mods.has(tgt.id))) return fail(403, 'Only the room owner can act on room moderators');
      if (!tgt && rep.target_nick && room.ownerNick && rep.target_nick === room.ownerNick && !isOwnerActor) return fail(403, 'You cannot act on the room owner');
    }
  }
  const minutesIn = (max: number): number | null | undefined => {
    const v = body?.minutes;
    if (v === null || v === undefined || v === '' || v === 0) return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= max ? n : undefined;
  };
  let resolution = '';
  switch (action) {
    case 'delete': {
      if (!rep.message_id) return fail(400, 'Not a message report');
      const m = repo.messageById(rep.message_id);
      if (!m || m.deleted) return fail(409, 'The message is already gone');
      if (room && !actorIsStaff) {
        if (m.role === 'admin' || m.role === 'moderator') return fail(403, 'You cannot delete site staff messages');
        const isOwnerActor = room.ownerUserId != null && room.ownerUserId === actor.accountId;
        if (!isOwnerActor && m.user_id != null && (room.ownerUserId === m.user_id || room.mods.has(m.user_id))) return fail(403, 'Only the room owner can delete room moderator messages');
      }
      const parentId = m.parent_id;
      dropMessageBy(actor.label, actor.accountId, m, 'delete-message', refs);
      if (parentId) io.to(`room:${m.room_id}`).emit('chat:replies', { messageId: parentId, replyCount: repo.replyCount(parentId) });
      hiddenMsgs.delete(m.id);
      modq.unhideMessage(m.id);
      resolution = 'message deleted';
      break;
    }
    case 'mute': {
      const minutes = minutesIn(10080);
      if (!minutes) return fail(400, 'Mute for 1 minute to 7 days');
      const ident = identOfReport(rep);
      const t = liveReportTarget(rep);
      if (room) {
        const until = repo2.addRoomMute(room.id, ident, actor.label, minutes);
        if (t) t.sock.emit('room:muted', { by: actor.nick, until, roomId: room.id });
        repo.logAction(actor.label, actor.accountId, 'room-mute', rep.target_nick, room.id, `${minutes} min; ${refs}`);
        resolution = `room-muted ${minutes} min`;
      } else {
        const until = repo.addMute(ident, actor.label, minutes);
        if (t) t.sock.emit('mod:muted', { by: actor.nick, until });
        repo.logAction(actor.label, actor.accountId, 'mute', rep.target_nick, rep.room_id, `${minutes} min; ${refs}`);
        resolution = `muted ${minutes} min`;
      }
      break;
    }
    case 'kick': {
      const t = liveReportTarget(rep);
      if (!t) return fail(409, 'That user is offline');
      const where = room ?? (t.ts.roomId ? rooms.get(t.ts.roomId) ?? null : null);
      if (!where || t.ts.roomId !== where.id) return fail(409, room ? 'That user is not in this room' : 'That user is not in a room');
      punishRoom({ by: actor.label, byAccountId: actor.accountId, byNick: actor.nick, room: where, targetSock: t.sock, targetSession: t.ts, minutes: 10, reason: note ?? '', kickOnly: true, details: refs });
      resolution = `kicked from #${where.name}`;
      break;
    }
    case 'ban': {
      const minutes = minutesIn(room ? 525_600 : 5_256_000);
      if (minutes === undefined) return fail(400, 'Bad duration');
      const cat = isReportCategory(rep.category) ? REPORT_CATEGORY_LABELS[rep.category] : 'report';
      const reason = cleanText(body?.reason, LIMITS.banReasonMax) || `Reported: ${cat}`;
      const ident = identOfReport(rep);
      if (room) {
        const t = liveReportTarget(rep);
        if (t && t.ts.roomId === room.id) {
          punishRoom({ by: actor.label, byAccountId: actor.accountId, byNick: actor.nick, room, targetSock: t.sock, targetSession: t.ts, minutes, reason, kickOnly: false, details: `${durLabel(minutes)}; ${reason}; ${refs}` });
        } else {
          repo.addRoomBan(room.id, ident, reason, actor.label, minutes);
          repo.logAction(actor.label, actor.accountId, 'room-ban', rep.target_nick, room.id, `${durLabel(minutes)}; ${reason}; ${refs}`);
        }
        resolution = `room-banned (${durLabel(minutes)})`;
      } else {
        const applied = applySiteBan({
          by: actor.label, byAccountId: actor.accountId, nick: rep.target_nick ?? ident.nick, accountId: rep.target_user_id,
          ip: ident.ip, deviceIds: ident.deviceIds, roomId: rep.room_id, reason, minutes, kinds: ['account', 'ip', 'device'], extra: refs,
        });
        if (!applied.ok) return fail(400, applied.error);
        resolution = `banned (${durLabel(minutes)})`;
      }
      break;
    }
    case 'warn': {
      const text = cleanText(body?.reason, LIMITS.banReasonMax);
      if (!text) return fail(400, 'Write the warning the user will see');
      const t = liveReportTarget(rep);
      const msg = `Warning from the moderators: ${text}`;
      if (rep.target_user_id) modq.addNotice(rep.target_user_id, 'warn', msg, !!t);
      else if (!t) return fail(409, 'That guest is offline');
      if (t) t.sock.emit('user:notice', { kind: 'warn', text: msg, at: Date.now() });
      repo.logAction(actor.label, actor.accountId, 'warn', rep.target_nick, rep.room_id, `${text}; ${refs}`);
      resolution = t ? 'warned' : 'warned (delivered at next sign-in)';
      break;
    }
    case 'dismiss':
      repo.logAction(actor.label, actor.accountId, 'report:dismissed', rep.target_nick, rep.room_id, `${refs}${note ? `; ${note}` : ''}`);
      resolution = 'dismissed';
      break;
    case 'resolve':
      repo.logAction(actor.label, actor.accountId, 'report:resolved', rep.target_nick, rep.room_id, `${refs}${note ? `; ${note}` : ''}`);
      resolution = 'resolved without action';
      break;
  }
  const status = action === 'dismiss' ? 'dismissed' : 'resolved';
  const closed = modq.closeGroup(key, status, actor.label, note, resolution);
  if (status === 'dismissed' && rep.message_id && hiddenMsgs.has(rep.message_id)) {
    modq.unhideMessage(rep.message_id);
    setHidden(rep.message_id, rep.room_id ?? '', false);
    repo.logAction(actor.label, actor.accountId, 'auto-hide-undo', rep.target_nick, rep.room_id, refs);
  }
  notifyReporters(closed, action !== 'dismiss' && action !== 'resolve');
  emitStaffCounts(false);
  if (rep.room_id) emitRoomCounts(rep.room_id, false);
  return { ok: true, resolution, status, closed: closed.length };
}
function queueClaim(actor: { label: string; accountId: number | null }, reportId: number, release: boolean, force: boolean, roomId?: string): { ok: true } | { ok: false; status: number; error: string } {
  const rep = modq.reportById(Math.floor(Number(reportId)));
  if (!rep) return { ok: false, status: 404, error: 'No such report' };
  if (roomId && (rep.room_id !== roomId || (rep.target_kind ?? 'message') !== 'message' || rep.private_kind === 'whisper')) return { ok: false, status: 403, error: 'Not a report about this room' };
  const r = modq.claim(modq.groupKeyOf(rep), actor.label, actor.accountId, release, force);
  if (!r.ok) return { ok: false, status: 409, error: r.heldBy ? `${r.heldBy} is already on it` : 'This report was already handled' };
  emitStaffCounts(false);
  if (rep.room_id) emitRoomCounts(rep.room_id, false);
  return { ok: true };
}
live.modqView = (staff) => modqView(staff);
live.modqAct = (a, reportId, body) => queueAct({ label: a.username, accountId: a.id, role: a.role, nick: a.username, site: true, room: null }, reportId, body);
live.modqClaim = (a, reportId, release, force) => queueClaim({ label: a.username, accountId: a.id }, reportId, release, force);
live.modqStatusChanged = (reportId, status) => {
  const rep = modq.reportById(reportId);
  if (rep?.message_id && status === 'dismissed' && hiddenMsgs.has(rep.message_id) && modq.openOnMessage(rep.message_id) === 0) {
    modq.unhideMessage(rep.message_id);
    setHidden(rep.message_id, rep.room_id ?? '', false);
  }
  emitStaffCounts(false);
  if (rep?.room_id) emitRoomCounts(rep.room_id, false);
};

const ipReport = new KeyedLimiter(30, 60 * 60_000);
/** room-password guesses, same budget as login attempts */
const ipRoomPw = new KeyedLimiter(LIMITS.authAttemptsPerIp, 10 * 60_000);

// connection gate: per-IP cap + rate, session cookie, bans
io.use((socket, next) => {
  try { connectionGate(socket, next); }
  catch (err) { console.error('[socket] connection gate failed', err); next(new Error('Server error. Try again.')); }
});
function connectionGate(socket: Parameters<Parameters<typeof io.use>[0]>[0], next: (err?: Error) => void) {
  const req = socket.request;
  const ip = clientIp(req);
  if ((connsPerIp.get(ip) ?? 0) >= MAX_CONN_PER_IP) return next(new Error('Too many connections from your network.'));
  if (!ipConnect.take(ip)) return next(new Error('Too many connection attempts. Wait a minute.'));
  const account = repo.sessionAccount(parseCookies(req.headers.cookie)[COOKIE_SID]);
  const deviceIds = deviceIdsOf(req.headers.cookie, (socket.handshake.auth as { deviceId?: unknown })?.deviceId);
  const ban = repo.activeBan({ userId: account?.id ?? null, ip, deviceIds, staff: account ? isStaffRole(account.role) : false });
  if (ban) return next(new Error(`banned: ${repo.banMessage(ban)}`));
  socket.data = { ip, account, deviceIds };
  next();
}


function dropMessage(actor: Session, m: repo.MsgRow, action: string) {
  dropMessageBy(actorLabel(actor), actor.account?.id ?? null, m, action);
}
function dropMessageBy(by: string, byId: number | null, m: repo.MsgRow, action: string, extra?: string) {
  const ids = repo.deleteMessageTree(m.id);
  deleteVoiceForMessages(ids);
  deleteImagesForMessages(ids);
  for (const id of ids) io.to(`room:${m.room_id}`).emit('chat:deleted', { id });
  io.to(`room:${m.room_id}`).emit('chat:pins', { pins: pinsOf(m.room_id, '') });
  repo.logAction(by, byId, action, m.nick, m.room_id, `${m.text.slice(0, 200)}${extra ? ` [${extra}]` : ''}`);
}

io.on('connection', (socket) => {
  try { onConnection(socket); }
  catch (err) { console.error('[socket] connection failed', err); try { socket.disconnect(true); } catch { /* already gone */ } }
});
function onConnection(socket: AppSocket) {
  // Every socket.on below is wrapped: a throw or rejection is logged and the ack gets an error instead of crashing.
  guardSocketHandlers(socket as unknown as Parameters<typeof guardSocketHandlers>[0]);
  const { ip, account, deviceIds } = socket.data as { ip: string; account: repo.Account | null; deviceIds: string[] };
  connsPerIp.set(ip, (connsPerIp.get(ip) ?? 0) + 1);
  sessions.set(socket.id, { user: null, roomId: null, account, ip, deviceIds, connectedAt: Date.now(), linkTimes: [] });
  socket.join('lobby');
  const chatRl = new RateLimiter(LIMITS.chatBurst, LIMITS.chatWindowMs);
  const actRl = new RateLimiter(LIMITS.actionBurst, LIMITS.actionWindowMs);
  const sigRl = new RateLimiter(LIMITS.signalBurst, LIMITS.signalWindowMs);
  let strikes = 0;
  const limited = (rl: RateLimiter, ipRl: KeyedLimiter) => {
    if (rl.take() && ipRl.take(ip)) return false;
    strikes++;
    socket.emit('error:rate', { message: 'Slow down - you are sending too fast.' });
    if (strikes > 50) socket.disconnect(true); // persistent flooder
    return true;
  };
  const session = () => sessions.get(socket.id)!;
  const safeAck = (ack: unknown) => (typeof ack === 'function' ? (ack as (r: unknown) => void) : () => {});
  socket.use((packet, next) => {
    const event = packet[0];
    if (event === 'login') return next();
    if (session().account) return next();
    const ack = packet[packet.length - 1];
    if (typeof ack === 'function') ack({ ok: false, error: 'Sign in to continue.' });
  });
  /** resolve a target socket for moderation; must be logged in */
  const target = (userId: unknown) => {
    const id = String(userId ?? '');
    const sock = io.sockets.sockets.get(id);
    const ts = sessions.get(id);
    return sock && ts?.user ? { sock, ts, user: ts.user } : null;
  };

  const adoptParked = async (oldId: string, old: Session) => {
    const s = session();
    const room = rooms.get(old.roomId!)!;
    const user: UserInfo = { ...old.user!, id: socket.id, away: false };
    s.user = user;
    s.roomId = room.id;
    room.members.delete(oldId);
    room.members.add(socket.id);
    const last = room.lastChatAt.get(oldId);
    if (last != null) { room.lastChatAt.delete(oldId); room.lastChatAt.set(socket.id, last); }
    nicksInUse.set(user.nick.toLowerCase(), socket.id);
    if (s.account) accountSockets.set(s.account.id, socket.id);
    sessions.delete(oldId);
    // Join before the notice so this socket is in the room and cannot miss its own id change.
    await socket.leave('lobby');
    await socket.join(`room:${room.id}`);
    io.to(`room:${room.id}`).emit('user:moved', { from: oldId, to: socket.id, user });
    if (room.stage.on) emitStage(room);
  };
  /** Warnings / report outcomes stored while this account was away. */
  const deliverNotices = (accountId: number) => {
    for (const n of modq.takeNotices(accountId)) socket.emit('user:notice', { kind: n.kind, text: n.text, at: n.created_at });
  };
  socket.on('login', async (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    {
      const s0 = sessions.get(socket.id);
      if (s0 && typeof p?.tz === 'string' && isValidTimeZone(p.tz)) s0.tz = p.tz;
    }
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const s = session();
    if (s.user) return ack({ ok: false, error: 'Already logged in' });
    if (s.account) {
      // accounts always use their username; a newer tab/device takes over an older connection
      const fresh = repo.touchLogin(s.account.id, ip);
      if (!fresh) return ack({ ok: false, error: 'Account not found' });
      s.account = fresh;
      if (p?.resume) {
        let park = takePark(`a:${fresh.id}`);
        if (!park) {
          const holder = nicksInUse.get(fresh.username.toLowerCase());
          if (holder && holder !== socket.id && !io.sockets.sockets.get(holder)) {
            await new Promise((r) => setTimeout(r, 200));
            park = takePark(`a:${fresh.id}`);
          }
        }
        if (park) {
          await adoptParked(park.oldId, park.session);
          s.user = { ...s.user!, id: socket.id, nick: fresh.username, role: fresh.role, registered: true, ...profileOf(fresh), away: false };
          if (s.roomId) io.to(`room:${s.roomId}`).emit('user:updated', s.user);
          presencePing(fresh.id);
          ack({ ok: true, user: s.user });
          return deliverNotices(fresh.id);
        }
      }
      const key = fresh.username.toLowerCase();
      const holder = nicksInUse.get(key);
      if (holder && holder !== socket.id) {
        const hs = sessions.get(holder);
        const hsock = io.sockets.sockets.get(holder);
        if (hs?.account?.id !== fresh.id) return ack({ ok: false, error: 'That name is in use right now.' });
        if (hsock) { leaveRoom(hsock); hs.user = null; endSocket(hsock, 'You signed in from another tab or device.'); }
        else expirePark(holder);
      }
      nicksInUse.set(key, socket.id);
      accountSockets.set(fresh.id, socket.id);
      s.user = makeUser(socket.id, fresh.username, fresh.role, true, fresh);
      presencePing(fresh.id);
      ack({ ok: true, user: s.user });
      return deliverNotices(fresh.id);
    }
    ack({ ok: false, error: 'Sign in or register to continue.' });
  });

  socket.on('rooms:list', (ackRaw) => safeAck(ackRaw)({ ok: true, rooms: roomList() }));

  socket.on('room:create', async (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    try {
      const s = session();
      if (!s.user || !s.account) return ack({ ok: false, error: 'Sign in to continue.' });
      const fresh = repo.accountById(s.account.id);
      if (fresh) s.account = fresh;
      const gate = roomEntryError(s.account);
      if (gate) return ack({ ok: false, error: gate });
      if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
      const name = cleanText(p?.name, LIMITS.roomNameMax).replace(/[<>]/g, '');
      const topic = maskWords(cleanText(p?.topic, LIMITS.roomTopicMax).replace(/[<>]/g, ''));
      if (!isValidRoomName(name))
        return ack({ ok: false, error: `Room name must be ${LIMITS.roomNameMin}-${LIMITS.roomNameMax} characters.` });
      if (hasFilteredWord(name)) return ack({ ok: false, error: 'Please pick another room name.' });
      const pw = roomPasswordInput(p?.password);
      if ('error' in pw) return ack({ ok: false, error: pw.error });
      const meta = roomMetaInput((p as { category?: unknown })?.category, (p as { tags?: unknown })?.tags);
      if ('error' in meta) return ack({ ok: false, error: meta.error });
      if (rooms.size >= LIMITS.maxRooms) return ack({ ok: false, error: 'Too many rooms right now.' });
      if (repo.roomNameTaken(name)) return ack({ ok: false, error: 'A room with that name exists.' });
      const persistent = !!s.account;
      if (s.account && !isStaff(s) && repo.roomsOwnedBy(s.account.id) >= LIMITS.maxRoomsPerUser)
        return ack({ ok: false, error: `You already own ${LIMITS.maxRoomsPerUser} rooms. Delete one first.` });
      let id = slug(name);
      if (rooms.has(id) || id === 'lobby') id = `${id}-${randomUUID().slice(0, 4)}`;
      const password_hash = pw.password ? await hashSecret(pw.password) : null;
      const row = { id, name, topic, owner_user_id: s.account?.id ?? null, owner_nick: s.user.nick, permanent: 0, persistent: persistent ? 1 : 0, created_at: Date.now(), locked: 0, slow_mode_sec: 0, is_private: 0, password_hash };
      repo.insertRoom(row);
      if (meta.category || meta.tags.length) repo3.setRoomMeta(row.id, meta.category, meta.tags);
      const voice = !!(p as { voice?: unknown })?.voice;
      if (voice) repo.setRoomVoice(row.id, true);
      const room = loadRoom({ ...row, category: meta.category, tags: meta.tags.length ? JSON.stringify(meta.tags) : null, voice: voice ? 1 : 0 });
      broadcastRooms();
      ack({ ok: true, roomId: room.id });
      bumpStat(badgeEarner(socket.id, s), 'rooms_created');
      // an empty guest room is removed if nobody joins soon
      if (!persistent) setTimeout(guardTimer('empty room removal', () => { maybeRemoveRoom(room); broadcastRooms(); }), 60_000);
    } catch (err) {
      console.error('[room:create]', (err as Error).message);
      ack({ ok: false, error: 'Could not create room' });
    }
  });

  socket.on('room:join', async (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    try {
      const s = session();
      if (!s.user || !s.account) return ack({ ok: false, error: 'Sign in to continue.' });
      const fresh = repo.accountById(s.account.id);
      if (fresh) s.account = fresh;
      const gate = roomEntryError(s.account);
      if (gate) return ack({ ok: false, error: gate });
      if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
      const room = rooms.get(String(p?.roomId ?? ''));
      if (!room) return ack({ ok: false, error: 'Room not found' });
      if (room.isPrivate) {
        if (!s.account || !room.callPeers || !room.callPeers.includes(s.account.id))
          return ack({ ok: false, error: 'This is a private call.' });
      }
      if (room.locked && !isStaff(s) && !isOwner(s, room) && !room.members.has(socket.id)) {
        if (!room.members.has(socket.id))
          return ack({ ok: false, error: 'This room is locked.' });
      }
      if (!isStaff(s)) {
        const ban = repo.activeRoomBan(room.id, identOf(s));
        if (ban) return ack({ ok: false, error: ban.expires_at && ban.expires_at - Date.now() <= 10 * 60_000 ? 'You were kicked from this room. Try again later.' : `You are banned from this room${ban.reason ? `: ${ban.reason}` : '.'}` });
      }
      if (s.roomId === room.id && room.members.has(socket.id)) {
        await socket.leave('lobby');
        await socket.join(`room:${room.id}`);
        return ack({ ok: true, room: roomState(room, s), resumed: true });
      }
      // An invite link that skips the password counts only for an account that redeemed it (bans were checked above).
      const viaInvite = !!room.passwordHash && typeof p?.invite === 'string' && invites.bypassesPassword(p.invite, room.id, s.account.id);
      if (room.passwordHash && !viaInvite) {
        const supplied = typeof p?.password === 'string' ? p.password.trim() : '';
        if (!supplied) return ack({ ok: false, error: 'This room needs a password.' });
        if (supplied.length > LIMITS.passwordMax) return ack({ ok: false, error: 'Wrong room password.' });
        if (!ipRoomPw.take(ip)) return ack({ ok: false, error: 'Too many password attempts. Try again later.' });
        const match = await checkSecret(supplied, room.passwordHash);
        if (!match) return ack({ ok: false, error: 'Wrong room password.' });
      }
      if (room.members.size >= LIMITS.maxUsersPerRoom && !isStaff(s) && !room.members.has(socket.id)) return ack({ ok: false, error: 'Room is full' });
      if (s.roomId === room.id) return ack({ ok: false, error: 'Already in this room' });
      if (s.roomId) leaveRoom(socket);
      socket.leave('lobby');
      socket.join(`room:${room.id}`);
      room.members.add(socket.id);
      s.roomId = room.id;
      socket.to(`room:${room.id}`).emit('user:joined', s.user);
      systemMsg(room, `${s.user.nick} joined`);
      ack({ ok: true, room: roomState(room, s) });
      if (room.stage.on) emitStage(room);
      broadcastRooms();
      statVisit(room, s);
      lobbyJoined(room, s);
      radioRoomPing(room);
    } catch (err) {
      console.error('[room:join]', (err as Error).message);
      ack({ ok: false, error: 'Could not join room' });
    }
  });

  socket.on('room:leave', () => leaveRoom(socket));

  const roomBan = (p: { userId: string; minutes: number | null; reason?: string }, ackRaw: unknown, kickOnly: boolean) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const room = rooms.get(s.roomId)!;
    if (!canRoomManage(s, room)) return ack({ ok: false, error: kickOnly ? 'Only the room owner or a moderator can kick' : 'Only the room owner or a moderator can ban' });
    const t = target(p?.userId);
    if (!t || !room.members.has(t.sock.id)) return ack({ ok: false, error: 'User not in room' });
    if (!canModerate(s, t.ts, room, true)) return ack({ ok: false, error: 'You cannot do that to this user' });
    const minutes = kickOnly ? 10 : p?.minutes && Number(p.minutes) > 0 ? Math.min(Math.round(Number(p.minutes)), 525_600) : null;
    const reason = cleanText(p?.reason, LIMITS.banReasonMax);
    punishRoom({
      by: actorLabel(s), byAccountId: s.account?.id ?? null, byNick: s.user.nick, room,
      targetSock: t.sock, targetSession: t.ts, minutes, reason, kickOnly,
      details: kickOnly ? null : `${minutes ? `${minutes} min` : 'until lifted'}${reason ? `; ${reason}` : ''}`,
    });
    ack({ ok: true });
  };
  socket.on('room:kick', (p, ack) => roomBan({ userId: p?.userId, minutes: 10 }, ack, true));
  socket.on('room:ban', (p, ack) => roomBan(p, ack, false));

  socket.on('room:topic', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const room = rooms.get(s.roomId)!;
    if (!isStaff(s) && !isOwner(s, room)) return ack({ ok: false, error: 'Only the room owner or a moderator can set the topic' });
    const topic = maskWords(cleanText(p?.topic, LIMITS.roomTopicMax).replace(/[<>]/g, ''));
    room.topic = topic;
    repo.setRoomTopic(room.id, topic);
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'topic', null, room.id, topic);
    io.to(`room:${room.id}`).emit('room:topic', { topic, by: s.user.nick });
    systemMsg(room, `${s.user.nick} set the topic: ${topic || '(none)'}`);
    broadcastRooms();
    ack({ ok: true });
  });

  socket.on('sound:play', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (socket.id.startsWith('bot:')) return ack({ ok: false, error: 'Bots do not play sounds' });
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return ack({ ok: false, error: 'Not in a room' });
    const id = String(p?.id ?? '');
    const row = repo.soundById(room.id, id);
    if (!row) return ack({ ok: false, error: 'Sound not found' });
    const key = repo.userKey(identOf(s));
    const now = Date.now();
    const last = room.soundLast.get(key) ?? 0;
    if (!soundPlayAllowed(last, now)) return ack({ ok: false, error: 'Wait 3 seconds between sounds.', status: 429 });
    room.soundLast.set(key, now);
    io.to(`room:${room.id}`).emit('sound:played', { id: row.id, name: row.name, by: s.user.nick });
    ack({ ok: true });
    bumpStat(badgeEarner(socket.id, s), 'sounds');
  });

  // ---------- watch party ----------
  const emitWatch = (room: Room, action: WatchAction | 'lock', by: string) => {
    io.to(`room:${room.id}`).emit('watch:state', { watch: room.watch, locked: room.watchLocked, action, by, serverNow: Date.now() });
  };
  socket.on('watch:update', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (socket.id.startsWith('bot:')) return ack({ ok: false, error: 'Bots cannot control the watch party' });
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return ack({ ok: false, error: 'Not in a room' });
    if (!canControlWatch({ locked: room.watchLocked, isCreator: isOwner(s, room), isModerator: isStaff(s) })) {
      return ack({ ok: false, error: 'Only the room creator or a moderator controls playback here', status: 403 });
    }
    if (!watchRl.take(repo.userKey(identOf(s)))) return ack({ ok: false, error: 'Slow down', status: 429 });
    const action = p?.action;
    const now = Date.now();
    const by = s.user.nick;
    if (action === 'load') {
      const parsed = parseWatchUrl((p as { url?: unknown }).url);
      if (!parsed) return ack({ ok: false, error: 'Paste a YouTube or Twitch link' });
      room.watch = {
        provider: parsed.provider, kind: parsed.kind, id: parsed.id, url: parsed.url,
        playing: true, positionSec: parsed.startSec, updatedAt: now, by,
      };
      emitWatch(room, 'load', by);
      ack({ ok: true });
      bumpStat(badgeEarner(socket.id, s), 'watch_starts');
      return;
    }
    if (action === 'clear') {
      if (!room.watch) return ack({ ok: true });
      room.watch = null;
      emitWatch(room, 'clear', by);
      return ack({ ok: true });
    }
    if (action === 'play' || action === 'pause' || action === 'seek') {
      const w = room.watch;
      if (!w) return ack({ ok: false, error: 'Nothing is playing' });
      if (w.kind === 'live') {
        if (action === 'seek') return ack({ ok: false, error: 'Live streams cannot seek' });
        room.watch = { ...w, playing: action === 'play', positionSec: 0, updatedAt: now, by };
        emitWatch(room, action, by);
        return ack({ ok: true });
      }
      const pos = cleanPosition((p as { positionSec?: unknown }).positionSec);
      if (pos === null) return ack({ ok: false, error: 'Bad position' });
      const playing = action === 'play' ? true : action === 'pause' ? false : w.playing;
      room.watch = { ...w, playing, positionSec: pos, updatedAt: now, by };
      emitWatch(room, action, by);
      return ack({ ok: true });
    }
    return ack({ ok: false, error: 'Unknown action' });
  });
  socket.on('watch:lock', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return ack({ ok: false, error: 'Not in a room' });
    if (!isOwner(s, room)) return ack({ ok: false, error: 'Only the room creator can lock playback controls', status: 403 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    room.watchLocked = !!p?.locked;
    emitWatch(room, 'lock', s.user.nick);
    ack({ ok: true });
  });

  const playFx = (rawId: unknown): { ok: true } | { ok: false; error: string; status?: number } => {
    const s = session();
    if (socket.id.startsWith('bot:')) return { ok: false, error: 'Bots cannot play effects', status: 403 };
    if (!s.user || !s.roomId) return { ok: false, error: 'Not in a room' };
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return { ok: false, error: 'Not in a room' };
    if (!isFxId(rawId)) return { ok: false, error: 'Unknown effect', status: 400 };
    const muted = repo.activeMuteUntil(identOf(s));
    if (muted) return { ok: false, error: `You are muted for ${Math.ceil((muted - Date.now()) / 60_000)} more minute(s).`, status: 403 };
    const key = repo.userKey(identOf(s));
    const now = Date.now();
    const wait = fxCooldown(room.fxLast.get(key), room.fxRoomLast || undefined, now);
    if (wait) return { ok: false, error: wait, status: 429 };
    room.fxLast.set(key, now);
    room.fxRoomLast = now;
    io.to(`room:${room.id}`).emit('fx:played', { id: rawId, by: s.user.nick });
    return { ok: true };
  };
  socket.on('fx:play', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    ack(playFx(p?.id));
  });

  const triviaRl = new RateLimiter(4, 2000);
  const triviaCtx = () => {
    const s = session();
    if (!canPlayTrivia(socket.id)) return { error: 'Bots cannot play trivia' } as const;
    if (!s.user || !s.roomId) return { error: 'Not in a room' } as const;
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return { error: 'Not in a room' } as const;
    return { s, room } as const;
  };
  socket.on('trivia:start', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = triviaCtx();
    if ('error' in c) return ack({ ok: false, error: c.error });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const count = p?.count === undefined ? 10 : Number(p.count);
    const category = p?.category === undefined ? 'mixed' : p.category;
    if (!isTriviaCount(count)) return ack({ ok: false, error: 'Pick 5, 10 or 15 questions' });
    if (!isTriviaPick(category)) return ack({ ok: false, error: 'Unknown category' });
    if (c.room.trivia?.active) return ack({ ok: false, error: 'A trivia round is already running', status: 409 });
    const round = startTriviaRound(c.room, c.s.user!.nick, category, count);
    ack({ ok: true, state: round.publicState() });
  });
  socket.on('trivia:answer', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = triviaCtx();
    if ('error' in c) return ack({ ok: false, error: c.error });
    if (!triviaRl.take()) return ack({ ok: false, error: 'Slow down', status: 429 });
    const round = c.room.trivia;
    if (!round?.active || p?.roundId !== round.id) return ack({ ok: false, error: 'No trivia round running' });
    const r = round.answer(triviaPlayerOf(c.s), Number(p?.index), Number(p?.choice));
    ack(r.ok ? { ok: true } : { ok: false, error: r.error });
  });
  socket.on('trivia:stop', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = triviaCtx();
    if ('error' in c) return ack({ ok: false, error: c.error });
    if (!isStaff(c.s) && !isOwner(c.s, c.room)) return ack({ ok: false, error: 'Only the room creator or a moderator can stop trivia', status: 403 });
    if (!c.room.trivia?.active) return ack({ ok: false, error: 'No trivia round running' });
    stopTrivia(c.room, c.s.user!.nick);
    ack({ ok: true });
  });
  socket.on('trivia:get', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return ack({ ok: false, error: 'Not in a room' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const round = room.trivia?.active ? room.trivia : null;
    ack({ ok: true, state: round ? round.publicState() : null, myChoice: round ? round.myChoice(triviaPlayerOf(s).key) : null, board: triviaBoard(room) });
  });

  socket.on('chat:voice', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (socket.id.startsWith('bot:')) return ack({ ok: false, error: 'Bots cannot send voice notes' });
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return ack({ ok: false, error: 'Not in a room' });
    if (limited(chatRl, ipChat)) return ack({ ok: false, error: 'Slow down' });
    if (room.slowModeSec > 0 && !isStaff(s) && !isOwner(s, room)) {
      const wait = room.slowModeSec * 1000 - (Date.now() - (room.lastChatAt.get(socket.id) ?? 0));
      if (wait > 0) return ack({ ok: false, error: `Slow mode: wait ${Math.ceil(wait / 1000)}s.` });
    }
    const muted = repo.activeMuteUntil(identOf(s));
    if (muted) return ack({ ok: false, error: `You are muted for ${Math.ceil((muted - Date.now()) / 60_000)} more minute(s).` });
    {
      const rm = repo2.activeRoomMuteUntil(room.id, identOf(s));
      if (rm && !isStaff(s)) return ack({ ok: false, error: `You are muted in this room for ${Math.ceil((rm - Date.now()) / 60_000)} more minute(s).` });
    }
    const v = repo.voiceNoteById(String(p?.voiceId ?? ''));
    if (!v || v.room_id !== room.id || v.message_id || !isVoiceUploader(v, s.account?.id ?? null, s.deviceIds))
      return ack({ ok: false, error: 'Voice note not found' });
    const rawMs = Number(p?.durationMs);
    if (!Number.isFinite(rawMs) || rawMs < VOICE_MIN_MS) return ack({ ok: false, error: 'Voice note too short' });
    const durationMs = Math.min(Math.round(rawMs), VOICE_MAX_MS);
    let parentId: string | null = null;
    if (p?.parentId) {
      const parent = repo.messageById(String(p.parentId));
      if (!parent || parent.deleted || parent.room_id !== room.id || parent.parent_id || parent.burn_ttl != null) return ack({ ok: false, error: 'Thread not found' });
      parentId = parent.id;
    }
    const text = `🎤 Voice note (${fmtVoiceDuration(durationMs)})`;
    const msg: ChatMessage = {
      kind: 'chat', id: randomUUID(), ts: Date.now(), fromId: socket.id, from: s.user.nick, role: s.user.role, text,
      ...profileOf(s.account), mentions: [], parentId: parentId ?? undefined,
      voice: { id: v.id, url: `/api/voice/${v.id}`, durationMs, mime: v.mime },
    };
    if (!repo.claimVoiceNote(v.id, msg.id)) return ack({ ok: false, error: 'Voice note not found' });
    repo.insertMessage({ id: msg.id, room_id: room.id, ts: msg.ts, user_id: s.account?.id ?? null, nick: s.user.nick, role: s.user.role, text, ip: s.ip, device_id: s.deviceIds[0] ?? null, parent_id: parentId, voice_id: v.id, voice_ms: durationMs });
    if (parentId) msg.replyCount = repo.replyCount(parentId);
    room.lastChatAt.set(socket.id, msg.ts);
    io.to(`room:${room.id}`).emit('chat:message', msg);
    statMsg(room, s);
    bumpStat(badgeEarner(socket.id, s), 'voice_notes');
    if (!room.isPrivate) socket.broadcast.emit('room:activity', { roomId: room.id, mentions: [] });
    if (parentId) io.to(`room:${room.id}`).emit('chat:replies', { messageId: parentId, replyCount: msg.replyCount ?? 0 });
    ack({ ok: true });
  });

  socket.on('chat:reveal', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return ack({ ok: false, error: 'Not in a room' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down', status: 429 });
    const m = repo.messageById(String(p?.messageId ?? ''));
    if (!m || m.deleted || m.room_id !== room.id || m.burn_ttl == null) return ack({ ok: false, error: 'Message not found', status: 404 });
    if (m.burned_at != null) return ack({ ok: false, error: 'Burned', status: 410 });
    const now = Date.now();
    const ttlMs = burnTtlMs(m.burn_ttl);
    if (isMessageAuthor(s, m)) return ack({ ok: true, text: m.text, ttlSec: m.burn_ttl, firstAt: now, expiresAt: m.ts + BURN_HARD, serverNow: now });
    const firstAt = repo.burnFirstView(m.id, burnViewerKey(s), now);
    if (!burnRevealAllowed(firstAt, ttlMs, now)) return ack({ ok: false, error: 'Burned', status: 410 });
    scheduleBurnCheck(m.id, Math.min(firstAt + ttlMs, m.ts + BURN_HARD));
    ack({ ok: true, text: m.text, ttlSec: m.burn_ttl, firstAt, expiresAt: Math.min(firstAt + ttlMs, m.ts + BURN_HARD), serverNow: now });
  });

  const whisperCtx = () => {
    const s = session();
    if (!s.user || !s.roomId) return { error: 'Not in a room' } as const;
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return { error: 'Not in a room' } as const;
    return { s, room } as const;
  };
  socket.on('whisper:start', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = whisperCtx();
    if ('error' in c) return ack({ ok: false, error: c.error });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const { room } = c;
    const raw = Array.isArray(p?.userIds) ? p.userIds.map(String).filter((id) => id !== socket.id) : [];
    const want = [...new Set(raw)];
    if (want.length < 1) return ack({ ok: false, error: 'Pick someone to whisper with' });
    const members: string[] = [socket.id];
    for (const id of want) {
      const err = whisperAddError({ memberIds: members, targetId: id, targetInRoom: room.members.has(id) && sessions.has(id) });
      if (err) return ack({ ok: false, error: err });
      members.push(id);
    }
    const id = randomUUID();
    room.whispers.set(id, new Set(members));
    emitWhisperUpdate(room, id);
    ack({ ok: true, whisper: whisperInfo(room, id)! });
  });
  socket.on('whisper:add', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = whisperCtx();
    if ('error' in c) return ack({ ok: false, error: c.error });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const { room } = c;
    const id = String(p?.whisperId ?? '');
    const set = room.whispers.get(id);
    if (!set || !set.has(socket.id)) return ack({ ok: false, error: 'Whisper not found' });
    const target = String(p?.userId ?? '');
    const err = whisperAddError({ memberIds: [...set], targetId: target, targetInRoom: room.members.has(target) && sessions.has(target) });
    if (err) return ack({ ok: false, error: err });
    set.add(target);
    emitWhisperUpdate(room, id);
    ack({ ok: true, whisper: whisperInfo(room, id)! });
  });
  socket.on('whisper:send', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = whisperCtx();
    if ('error' in c) return ack({ ok: false, error: c.error });
    const { s, room } = c;
    const id = String(p?.whisperId ?? '');
    const set = room.whispers.get(id);
    if (!set || !set.has(socket.id)) return ack({ ok: false, error: 'Whisper not found' });
    if (limited(chatRl, ipChat)) return ack({ ok: false, error: 'Slow down' });
    const prepared = prepareChatText(s, p?.text);
    if ('error' in prepared) return ack({ ok: false, error: prepared.error });
    const message: WhisperMessage = { id: randomUUID(), whisperId: id, ts: Date.now(), fromId: socket.id, from: s.user!.nick, text: prepared.text };
    for (const sid of set) io.to(sid).emit('whisper:message', message);
    logWhisper({ m: message, members: new Set(set), accountId: s.account?.id ?? null, ip: s.ip, device: s.deviceIds[0] ?? null, roomId: room.id });
    try {
      // kept for the member accounts only (guests have nothing to come back to); pruned after 30 days
      const accts = [...set].map((sid) => sessions.get(sid)?.account?.id).filter((x): x is number => typeof x === 'number');
      repo5.saveWhisper({ id: message.id, whisper_id: id, room_id: room.id, ts: message.ts, from_user_id: s.account?.id ?? null, from_nick: message.from, text: message.text }, accts);
    } catch (err) { console.error('[whisper] save', (err as Error).message); }
    ack({ ok: true, message });
    for (const sid of set) {
      if (sid === socket.id) continue;
      const acct = sessions.get(sid)?.account?.id;
      if (acct) pushIfAway(acct, { title: `Whisper from ${s.user!.nick} in #${room.name}`, body: 'New message', url: `/?room=${encodeURIComponent(room.id)}`, tag: `whisper-${id}` }, room.id);
    }
  });
  socket.on('whisper:leave', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = whisperCtx();
    if ('error' in c) return ack({ ok: false, error: c.error });
    const id = String(p?.whisperId ?? '');
    if (!c.room.whispers.get(id)?.has(socket.id)) return ack({ ok: false, error: 'Whisper not found' });
    leaveWhisper(c.room, id, socket.id);
    ack({ ok: true });
  });

  socket.on('room:delete', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId)!;
    if (room.permanent) return ack({ ok: false, error: 'Built-in rooms cannot be deleted' });
    if (!isStaff(s) && !isOwner(s, room)) return ack({ ok: false, error: 'Only the room owner or a moderator can delete this room' });
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'room-delete', room.name, room.id);
    for (const id of [...room.members]) if (id.startsWith('bot:')) removeBot(Number(id.slice(4)), room);
    for (const id of [...room.members]) {
      const sock = io.sockets.sockets.get(id);
      if (sock) { sock.emit('room:deleted', { roomId: room.id }); leaveRoom(sock, 'left'); }
    }
    dropRoom(room);
    broadcastRooms();
    ack({ ok: true });
  });

  // ---------- draft sync (batch E4) ----------
  const draftRl = new Map<string, number[]>();
  socket.on('draft:get', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const acc = session()?.account;
    if (!acc) return ack({ ok: true, drafts: [] });
    const roomId = typeof p?.roomId === 'string' ? p.roomId.slice(0, 80) : '';
    void socket.join(`acct:${acc.id}`);
    ack({ ok: true, drafts: repo8.draftsOf(acc.id, roomId).map((d) => ({ threadId: d.thread_id, text: d.text, updatedAt: d.updated_at })) });
  });
  socket.on('draft:save', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const acc = session()?.account;
    if (!acc) return ack({ ok: false, error: 'Sign in to sync drafts' });
    const now = Date.now(); const hits = (draftRl.get('d') ?? []).filter((t) => now - t < 10_000); hits.push(now); draftRl.set('d', hits);
    if (hits.length > 40) return ack({ ok: false, error: 'Slow down' });
    const roomId = typeof p?.roomId === 'string' ? p.roomId.slice(0, 80) : '';
    const threadId = typeof p?.threadId === 'string' ? p.threadId.slice(0, 80) : '';
    if (!roomId || !rooms.has(roomId)) return ack({ ok: false, error: 'Unknown room' });
    const text = typeof p?.text === 'string' ? p.text.slice(0, LIMITS.messageMax) : '';
    // the device's own clock orders its edits; never trust a time far ahead of ours
    const at = Math.min(Number.isFinite(p?.at) ? Number(p.at) : now, now + 5_000);
    const stored = repo8.saveDraft(acc.id, roomId, threadId, text, at);
    void socket.join(`acct:${acc.id}`);
    if (stored != null) socket.to(`acct:${acc.id}`).emit('draft:sync', { roomId, threadId, text, updatedAt: stored });
    ack({ ok: true, updatedAt: stored });
  });
  socket.on('chat:send', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    // batch E5: the offline outbox may resend a line whose ack was lost; same clientId = already posted
    const clientId = typeof p?.clientId === 'string' && /^[\w-]{8,64}$/.test(p.clientId) ? `${identOf(s)}|${p.clientId}` : null;
    if (clientId) { const seen = sentClientIds.get(clientId); if (seen) return ack({ ok: true, id: seen.id, duplicate: true }); }
    if (limited(chatRl, ipChat)) return ack({ ok: false, error: 'Slow down' });
    {
      // "/confetti" etc. play an effect and are never posted as chat (thread replies included)
      const fx = fxSlashCommand(p?.text);
      if (fx) return ack(playFx(fx));
    }
    {
      const room0 = rooms.get(s.roomId!);
      if (room0 && room0.slowModeSec > 0 && !isStaff(s) && !isOwner(s, room0)) {
        const last = room0.lastChatAt.get(socket.id) ?? 0;
        const wait = room0.slowModeSec * 1000 - (Date.now() - last);
        if (wait > 0) return ack({ ok: false, error: `Slow mode: wait ${Math.ceil(wait / 1000)}s.` });
      }
    }
    let burnTtl: number | null = null;
    if (p?.burnTtl !== undefined && p?.burnTtl !== null) {
      if (socket.id.startsWith('bot:')) return ack({ ok: false, error: 'Bots cannot send burn messages' });
      if (!isBurnTtl(p.burnTtl)) return ack({ ok: false, error: 'Burn timer must be 10, 30 or 60 seconds' });
      burnTtl = p.burnTtl;
    }
    const prepared = prepareChatText(s, p?.text);
    if ('error' in prepared) return ack({ ok: false, error: prepared.error });
    const text = prepared.text;
    const room = rooms.get(s.roomId)!;
    {
      const verdict = filterVerdict(s, room, text);
      if (verdict) return ack({ ok: false, error: verdict });
    }
    {
      const rm = repo2.activeRoomMuteUntil(room.id, identOf(s));
      if (rm && !isStaff(s)) return ack({ ok: false, error: `You are muted in this room for ${Math.ceil((rm - Date.now()) / 60_000)} more minute(s).` });
    }
    let parentId: string | null = null;
    if (p?.parentId) {
      const parent = repo.messageById(String(p.parentId));
      if (!parent || parent.deleted || parent.room_id !== room.id || parent.parent_id || parent.burn_ttl != null)
        return ack({ ok: false, error: 'Thread not found' });
      parentId = parent.id;
    }
    const msg: ChatMessage = {
      kind: 'chat', id: randomUUID(), ts: Date.now(), fromId: socket.id, from: s.user.nick, role: s.user.role, text,
      ...profileOf(s.account), mentions: burnTtl ? [] : repo.mentionIds(text), parentId: parentId ?? undefined,
      ...(s.user.level ? { level: s.user.level } : {}),
    };
    // burn: remember who was here to read it (people, not bots; not the sender)
    const burnRecipients = burnTtl ? [...new Set([...room.members].filter((id) => id !== socket.id && !id.startsWith('bot:'))
      .map((id) => sessions.get(id)).filter((x): x is Session => !!x?.user).map(burnViewerKey).filter((k) => k !== burnViewerKey(s)))] : null;
    repo.insertMessage({ id: msg.id, room_id: room.id, ts: msg.ts, user_id: s.account?.id ?? null, nick: s.user.nick, role: s.user.role, text, ip: s.ip, device_id: s.deviceIds[0] ?? null, parent_id: parentId, burn_ttl: burnTtl, burn_recipients: burnRecipients });
    claimChatImagesInText(room.id, msg.id, text, s.account?.id ?? null, s.deviceIds);
    if (parentId) msg.replyCount = repo.replyCount(parentId);
    room.lastChatAt.set(socket.id, msg.ts);
    if (burnTtl) {
      msg.reactions = [];
      socket.emit('chat:message', { ...msg, burn: { ttlSec: burnTtl, mine: true } });
      socket.to(`room:${room.id}`).emit('chat:message', { ...msg, text: '', burn: { ttlSec: burnTtl } });
      scheduleBurnCheck(msg.id, msg.ts + BURN_HARD);
    } else io.to(`room:${room.id}`).emit('chat:message', msg);
    statMsg(room, s);
    if (!burnTtl) maybeXp(socket.id, s, room, text);
    {
      const uid = badgeEarner(socket.id, s);
      if (uid != null) {
        bumpStat(uid, 'messages');
        if (isNightOwlHour(hourIn(msg.ts, s.tz))) bumpStat(uid, 'night_messages');
        if (burnTtl) bumpStat(uid, 'burns');
      }
    }
    if (!room.isPrivate) socket.broadcast.emit('room:activity', { roomId: room.id, mentions: msg.mentions });
    if (parentId) io.to(`room:${room.id}`).emit('chat:replies', { messageId: parentId, replyCount: msg.replyCount ?? 0 });
    socket.to(`room:${room.id}`).emit('chat:typing', { id: socket.id, nick: s.user.nick, typing: false });
    if (clientId) rememberClientId(clientId, msg.id);
    ack({ ok: true, id: msg.id });
    if (!burnTtl) {
      queuePreview(room.id, msg.id, text);
      // @mentions for people who are away: content only when the room is open to anyone
      const open = !room.passwordHash && !room.isPrivate;
      const mentioned = new Set(msg.mentions ?? []);
      recordMentions(room, msg, s, parentId);
      for (const uid of mentioned) {
        if (uid === s.account?.id) continue;
        pushIfAway(uid, { title: `${s.user.nick} mentioned you in #${room.name}`, body: open ? text.slice(0, 200) : 'New mention', url: `/?room=${encodeURIComponent(room.id)}`, tag: `room-${room.id}` }, room.id, 'mention');
      }
      // "Everything" for this room: one collapsing push per room (same tag) for every line
      if (!room.isPrivate) {
        for (const uid of repo4.notifyAllUsers(room.id)) {
          if (uid === s.account?.id || mentioned.has(uid)) continue;
          pushIfAway(uid, { title: `#${room.name}`, body: open ? `${s.user.nick}: ${text.slice(0, 180)}` : 'New message', url: `/?room=${encodeURIComponent(room.id)}`, tag: `room-${room.id}` }, room.id, 'message');
        }
      }
    }
  });


  const boardRl = new RateLimiter(LIMITS.boardBurst, LIMITS.boardWindowMs);
  const BOARD_COLORS = new Set<BoardColor>(['green', 'white', 'red']);
  const parseBoardPoints = (raw: unknown): [number, number][] | null => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > LIMITS.boardPoints) return null;
    const pts: [number, number][] = [];
    for (const pair of raw) {
      if (!Array.isArray(pair) || pair.length < 2) return null;
      const x = Number(pair[0]);
      const y = Number(pair[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      pts.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
    }
    return pts;
  };
  socket.on('board:stroke', (p) => {
    const s = session();
    if (!s.user || !s.roomId) return;
    if (!boardRl.take()) return;
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return;
    const id = typeof p?.id === 'string' ? p.id.slice(0, 64) : '';
    if (!id || !BOARD_COLORS.has(p?.color)) return;
    const points = parseBoardPoints(p?.points);
    if (!points) return;
    const stroke: BoardStroke = { id, fromId: socket.id, color: p.color, points };
    const existing = room.board.findIndex((x) => x.id === id);
    if (existing >= 0) {
      if (room.board[existing].fromId !== socket.id) return;
      room.board[existing] = stroke;
    } else {
      room.board.push(stroke);
      while (room.board.length > LIMITS.boardHistory) room.board.shift();
    }
    socket.to(`room:${room.id}`).emit('board:stroke', stroke);
  });
  socket.on('board:undo', (p) => {
    const s = session();
    if (!s.user || !s.roomId) return;
    if (!boardRl.take()) return;
    const room = rooms.get(s.roomId);
    if (!room) return;
    const id = typeof p?.id === 'string' ? p.id.slice(0, 64) : '';
    if (!id) return;
    for (let i = room.board.length - 1; i >= 0; i--) {
      if (room.board[i].fromId !== socket.id) continue;
      if (room.board[i].id !== id) return;
      room.board.splice(i, 1);
      io.to(`room:${room.id}`).emit('board:undo', { id });
      return;
    }
  });
  socket.on('board:clear', () => {
    const s = session();
    if (!s.user || !s.roomId) return;
    const room = rooms.get(s.roomId);
    if (!room || (!isStaff(s) && !isOwner(s, room))) return;
    room.board = [];
    io.to(`room:${room.id}`).emit('board:clear');
  });

  socket.on('chat:edit', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    if (limited(chatRl, ipChat)) return ack({ ok: false, error: 'Slow down' });
    const m = repo.messageById(String(p?.messageId ?? ''));
    if (!m || m.deleted || m.room_id !== s.roomId) return ack({ ok: false, error: 'Message not found' });
    if (!isMessageAuthor(s, m)) return ack({ ok: false, error: 'You can only edit your own messages.' });
    if (m.voice_id) return ack({ ok: false, error: 'Voice notes cannot be edited.' });
    if (m.burn_ttl != null) return ack({ ok: false, error: 'Burn messages cannot be edited.' });
    if (hiddenMsgs.has(m.id)) return ack({ ok: false, error: 'This message is hidden pending review.' });
    if (Date.now() - m.ts > LIMITS.editWindowMs) return ack({ ok: false, error: `Messages can only be edited for ${Math.round(LIMITS.editWindowMs / 60_000)} minutes.` });
    const prepared = prepareChatText(s, p?.text);
    if ('error' in prepared) return ack({ ok: false, error: prepared.error });
    if (prepared.text === m.text) return ack({ ok: true });
    {
      const room = rooms.get(m.room_id);
      const verdict = room ? filterVerdict(s, room, prepared.text) : null;
      if (verdict) return ack({ ok: false, error: verdict });
    }
    const editedAt = Date.now();
    repo.recordEdit(m, editedAt, s.account?.id ?? null);
    repo.editMessage(m.id, prepared.text, editedAt);
    const mentions = repo.mentionIds(prepared.text);
    io.to(`room:${m.room_id}`).emit('chat:edited', { id: m.id, text: prepared.text, editedAt, mentions });
    {
      const oldUrl = firstPreviewUrl(m.text, OWN_ORIGINS);
      const newUrl = firstPreviewUrl(prepared.text, OWN_ORIGINS);
      if (oldUrl !== newUrl) {
        repo2.detachPreview(m.id);
        io.to(`room:${m.room_id}`).emit('chat:preview', { messageId: m.id, preview: null });
        if (newUrl) queuePreview(m.room_id, m.id, prepared.text);
      }
    }
    if (repo.isPinned(m.id)) io.to(`room:${m.room_id}`).emit('chat:pins', { pins: pinsOf(m.room_id, '') });
    ack({ ok: true });
  });

  socket.on('chat:delete', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    if (limited(chatRl, ipChat)) return ack({ ok: false, error: 'Slow down' });
    const m = repo.messageById(String(p?.messageId ?? ''));
    if (!m || m.deleted || m.room_id !== s.roomId) return ack({ ok: false, error: 'Message not found' });
    if (!isMessageAuthor(s, m) && !isStaff(s)) {
      // room owner / room moderators may remove other people's lines in their room (not site staff's; mods not the owner's)
      const room = rooms.get(s.roomId);
      const authorRoom = room && m.user_id != null && (room.ownerUserId === m.user_id || room.mods.has(m.user_id));
      const allowed = !!room && canRoomManage(s, room) && m.role !== 'admin' && m.role !== 'moderator'
        && (isOwner(s, room) || !authorRoom);
      if (!allowed) return ack({ ok: false, error: 'You can only delete your own messages.' });
    }
    const parentId = m.parent_id;
    dropMessage(s, m, isMessageAuthor(s, m) ? 'delete-own' : 'delete-message');
    if (parentId) io.to(`room:${m.room_id}`).emit('chat:replies', { messageId: parentId, replyCount: repo.replyCount(parentId) });
    ack({ ok: true });
  });

  socket.on('chat:typing', (p) => {
    const s = session();
    if (!s.user || !s.roomId) return;
    if (limited(actRl, ipAct)) return;
    socket.to(`room:${s.roomId}`).emit('chat:typing', { id: socket.id, nick: s.user.nick, typing: !!p?.typing });
  });

  socket.on('chat:thread', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down' });
    const parent = repo.messageById(String(p?.messageId ?? ''));
    if (!parent || parent.deleted || parent.room_id !== s.roomId || parent.parent_id || parent.burn_ttl != null)
      return ack({ ok: false, error: 'Thread not found' });
    const rows = repo.threadMessages(parent.id, LIMITS.historySize);
    const key = repo.userKey(identOf(s));
    const rx = repo.reactionsFor(rows.map((m) => m.id), key);
    ack({ ok: true, messages: rows.map((m) => chatFromRow(m, rx.get(m.id), 0)) });
  });

  /** batch C: edit history from the mod queue (site staff anywhere; room owner / mods for their rooms), without being in the room */
  // ---------- room-ban appeals (batch E): same flow as site bans, decided by the room's managers ----------
  const roomAppealView = (a: repo8.RoomAppealRow): RoomAppealInfo => ({ id: a.id, roomId: a.room_id, username: a.username, text: a.text, createdAt: a.created_at, status: a.status, decidedBy: a.decided_by, decidedAt: a.decided_at, note: a.decision_note });
  socket.on('roomappeal:status', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user) return ack({ ok: false, error: 'Sign in first' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down' });
    const room = rooms.get(String(p?.roomId ?? ''));
    if (!room || room.isPrivate) return ack({ ok: false, error: 'Room not found' });
    const ban = repo.activeRoomBan(room.id, identOf(s));
    if (!ban) return ack({ ok: true, banned: false });
    const a = repo8.roomAppealForBan(ban.id);
    ack({ ok: true, banned: true, ban: { id: ban.id, reason: ban.reason, expiresAt: ban.expires_at }, appeal: a ? roomAppealView(a) : null, canAppeal: !!s.account });
  });
  socket.on('roomappeal:submit', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user) return ack({ ok: false, error: 'Sign in first' });
    if (!s.account) return ack({ ok: false, error: 'Sign in with an account to appeal.' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down' });
    const room = rooms.get(String(p?.roomId ?? ''));
    if (!room || room.isPrivate) return ack({ ok: false, error: 'Room not found' });
    const ban = repo.activeRoomBan(room.id, identOf(s));
    if (!ban) return ack({ ok: false, error: 'You are not banned from this room.' });
    const text = String(p?.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < APPEAL_MIN) return ack({ ok: false, error: `Please write at least ${APPEAL_MIN} characters.` });
    if (text.length > APPEAL_MAX) return ack({ ok: false, error: `Keep it under ${APPEAL_MAX} characters.` });
    const a = repo8.insertRoomAppeal({ banId: ban.id, roomId: room.id, userId: s.account.id, username: s.account.username, text });
    if (!a) return ack({ ok: false, error: 'You already appealed this ban.' });
    repo.logAction(s.account.username, s.account.id, 'room-appeal', `room ban #${ban.id}`, room.id, text.slice(0, 200));
    try {
      const id = modq.insertReport({
        reporterUserId: s.account.id, reporterNick: s.account.username, reporterIp: 'appeal', targetUserId: s.account.id, targetNick: s.account.username, targetIp: null, targetDevice: null,
        roomId: room.id, messageId: null, messageText: text.slice(0, 2000), kind: 'user', key: `rappeal:${a.id}`, category: 'other',
        note: `Room ban appeal #${a.id} from ${s.account.username} for #${room.name}${ban.reason ? ` (ban reason: ${ban.reason})` : ''}: ${text}`.slice(0, 1200),
        snapshot: null, privateKind: null, context: [], notify: false,
      });
      const row = modq.reportById(id);
      if (row) afterNewReport(row);
      emitRoomCounts(room.id, true);
    } catch (err) { console.error('[appeals] room queue entry', (err as Error).message); }
    ack({ ok: true, appeal: roomAppealView(a) });
  });
  socket.on('roomappeal:decide', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user) return ack({ ok: false, error: 'Sign in first' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down' });
    const a = repo8.roomAppealById(Number(p?.appealId));
    if (!a) return ack({ ok: false, error: 'No such appeal' });
    const room = rooms.get(a.room_id);
    if (!room || !canRoomManage(s, room)) return ack({ ok: false, error: 'Only this room\'s owner, its moderators or site staff can decide.' });
    if (a.status !== 'open') return ack({ ok: false, error: `Already ${a.status}` });
    if (p?.decision !== 'approve' && p?.decision !== 'deny') return ack({ ok: false, error: 'decision must be approve or deny' });
    const status = p.decision === 'approve' ? 'approved' : 'denied';
    const note = p?.note ? String(p.note).trim().slice(0, 300) || null : null;
    const by = actorLabel(s);
    if (!repo8.decideRoomAppeal(a.id, status, by, note)) return ack({ ok: false, error: 'Already decided' });
    if (status === 'approved') repo.expireRoomBan(a.room_ban_id);
    repo.logAction(by, s.account?.id ?? null, status === 'approved' ? 'room-appeal-approve' : 'room-appeal-deny', `${a.username} (room appeal #${a.id})`, room.id, note);
    try { modq.closeGroup(`rappeal:${a.id}`, status === 'approved' ? 'resolved' : 'dismissed', by, note, status === 'approved' ? 'appeal approved: room ban lifted' : 'appeal denied'); } catch (err) { console.error('[appeals] close', (err as Error).message); }
    emitStaffCounts(true); emitRoomCounts(room.id, false);
    ack({ ok: true, decision: status });
  });
  socket.on('modq:history', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user) return ack({ ok: false, error: 'Sign in first' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down' });
    const m = repo.messageById(String(p?.messageId ?? ''));
    if (!m || m.deleted || m.burn_ttl != null) return ack({ ok: false, error: 'Message not found' });
    const room = rooms.get(m.room_id);
    if (!isStaff(s) && !(room && !room.isPrivate && canRoomManage(s, room))) return ack({ ok: false, error: 'Only moderators can see edit history.' });
    ack({ ok: true, versions: repo.editHistory(m), current: { text: m.text, at: m.edited_at ?? m.ts } });
  });
  socket.on('chat:history', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId);
    if (!room || !canRoomManage(s, room)) return ack({ ok: false, error: 'Only staff can see edit history.' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down' });
    const m = repo.messageById(String(p?.messageId ?? ''));
    if (!m || m.deleted || m.room_id !== room.id || m.burn_ttl != null) return ack({ ok: false, error: 'Message not found' });
    ack({ ok: true, versions: repo.editHistory(m), current: { text: m.text, at: m.edited_at ?? m.ts } });
  });

  // ---------- stage mode ----------
  const stageRoom = (ack: (r: { ok: false; error: string }) => void) => {
    const s = session();
    if (!s.user || !s.roomId) { ack({ ok: false, error: 'Not in a room' }); return null; }
    const room = rooms.get(s.roomId);
    if (!room) { ack({ ok: false, error: 'Not in a room' }); return null; }
    if (limited(actRl, ipAct)) { ack({ ok: false, error: 'Slow down' }); return null; }
    return { s, room };
  };
  socket.on('stage:set', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const g = stageRoom(ack);
    if (!g) return;
    const { s, room } = g;
    if (!isOwner(s, room) && !isStaff(s)) return ack({ ok: false, error: 'Only the room owner or staff can change stage mode.' });
    if (room.isPrivate) return ack({ ok: false, error: 'Private calls have no stage mode.' });
    const wasOn = room.stage.on;
    if (typeof p?.on === 'boolean') room.stage.on = p.on;
    if (p?.cap !== undefined) room.stage.cap = clampStageCap(p.cap, room.stage.cap);
    if (!room.stage.on) { room.stage.speakers.clear(); room.stage.hands.clear(); }
    repo.setRoomStage(room.id, room.stage.on, room.stage.cap);
    if (room.stage.on !== wasOn) {
      repo.logAction(actorLabel(s), s.account?.id ?? null, room.stage.on ? 'stage-on' : 'stage-off', null, room.id, `cap ${room.stage.cap}`);
      systemMsg(room, room.stage.on ? `${s.user!.nick} turned on stage mode: only speakers can use camera and mic` : `${s.user!.nick} turned off stage mode`);
    }
    if (room.stage.on && !wasOn) {
      for (const id of room.members) {
        const m = sessions.get(id);
        if (m?.user && !isStageSpeaker(m, room)) stageDemote(room, id, s.user!.nick);
      }
    }
    emitStage(room);
    broadcastRooms();
    ack({ ok: true, stage: stageStateOf(room) });
  });
  socket.on('stage:hand', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const g = stageRoom(ack);
    if (!g) return;
    const { s, room } = g;
    if (!room.stage.on && !room.voice) return ack({ ok: false, error: 'Stage mode is off.' });
    if (room.stage.on && isStageSpeaker(s, room)) return ack({ ok: false, error: 'You are already a speaker.' });
    if (p?.up) { if (!room.stage.hands.has(stageKey(s))) room.stage.hands.set(stageKey(s), Date.now()); }
    else room.stage.hands.delete(stageKey(s));
    emitStage(room);
    ack({ ok: true });
  });
  socket.on('stage:invite', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const g = stageRoom(ack);
    if (!g) return;
    const { s, room } = g;
    if (!canRoomManage(s, room)) return ack({ ok: false, error: 'Only the room owner or moderators can bring people up.' });
    if (!room.stage.on && !room.voice) return ack({ ok: false, error: 'Stage mode is off.' });
    const id = String(p?.userId ?? '');
    const t = room.members.has(id) ? sessions.get(id) : undefined;
    if (!t?.user) return ack({ ok: false, error: 'User not found' });
    if (!room.stage.on) {
      // voice room talk queue: give the floor to the oldest (or chosen) raised hand
      room.stage.hands.delete(stageKey(t));
      systemMsg(room, `🎙 ${t.user.nick} has the floor`);
      emitStage(room);
      return ack({ ok: true });
    }
    if (isStageSpeaker(t, room)) return ack({ ok: true });
    if (stageSpeakerCount(room) >= room.stage.cap) return ack({ ok: false, error: `Stage is full: at most ${room.stage.cap} speakers. Move someone down first.` });
    room.stage.hands.delete(stageKey(t));
    room.stage.speakers.add(stageKey(t));
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'stage-up', t.user.nick, room.id, null);
    emitStage(room);
    ack({ ok: true });
  });
  socket.on('stage:down', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const g = stageRoom(ack);
    if (!g) return;
    const { s, room } = g;
    if (!room.stage.on && !room.voice) return ack({ ok: false, error: 'Stage mode is off.' });
    const id = String(p?.userId ?? '');
    const self = id === socket.id;
    if (!self && !canRoomManage(s, room)) return ack({ ok: false, error: 'Only the room owner or moderators can move people down.' });
    const t = room.members.has(id) ? sessions.get(id) : undefined;
    if (!t?.user) return ack({ ok: false, error: 'User not found' });
    const key = stageKey(t);
    if (room.stage.hands.delete(key)) { emitStage(room); return ack({ ok: true }); }
    if (!room.stage.on) return ack({ ok: false, error: 'No hand raised.' });
    if (!room.stage.speakers.has(key)) {
      return ack({ ok: false, error: canRoomManage(t, room) ? 'The owner, room moderators and staff are always speakers.' : 'Not a speaker.' });
    }
    room.stage.speakers.delete(key);
    stageDemote(room, id, self ? t.user.nick : s.user!.nick);
    if (!self) repo.logAction(actorLabel(s), s.account?.id ?? null, 'stage-down', t.user.nick, room.id, null);
    emitStage(room);
    ack({ ok: true });
  });

  socket.on('chat:pin', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId);
    if (!room) return ack({ ok: false, error: 'Not in a room' });
    if (!canRoomManage(s, room)) return ack({ ok: false, error: 'Only the room owner or a moderator can pin messages.' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down' });
    const m = repo.messageById(String(p?.messageId ?? ''));
    if (!m || m.deleted || m.room_id !== room.id) return ack({ ok: false, error: 'Message not found' });
    const pinned = !!p?.pinned;
    if (pinned && m.burn_ttl != null) return ack({ ok: false, error: 'Burn messages cannot be pinned' });
    if (pinned) {
      if (!repo.isPinned(m.id) && repo.pinCount(room.id) >= LIMITS.maxPins)
        return ack({ ok: false, error: `You can pin at most ${LIMITS.maxPins} messages.` });
      repo.pinMessage(m.id, room.id, s.user.nick);
    } else repo.unpinMessage(m.id);
    repo.logAction(actorLabel(s), s.account?.id ?? null, pinned ? 'pin' : 'unpin', m.nick, room.id, m.text.slice(0, 120));
    io.to(`room:${room.id}`).emit('chat:pins', { pins: pinsOf(room.id, repo.userKey(identOf(s))) });
    ack({ ok: true });
  });

  socket.on('chat:react', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    // the built-in set, or one of this room's custom emoji as :name:
    const custom = typeof p?.emoji === 'string' && /^:[a-z0-9_]{2,24}:$/.test(p.emoji) && EMOTE_NAME_RE.test(p.emoji.slice(1, -1))
      && repo3.emotesForRoom(s.roomId).some((e) => e.name === p.emoji.slice(1, -1));
    if (!isReactionEmoji(p?.emoji) && !custom) return ack({ ok: false, error: 'Pick a reaction from the list' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down' });
    const id = String(p?.messageId ?? '');
    const m = repo.messageById(id);
    if (!m || m.deleted || m.room_id !== s.roomId) return ack({ ok: false, error: 'Message not found' });
    if (m.burn_ttl != null) return ack({ ok: false, error: 'Burn messages cannot take reactions' });
    const key = repo.userKey(identOf(s));
    repo.toggleReaction(m.id, key, p.emoji);
    const reactions = repo.reactionsFor([m.id], key).get(m.id) ?? [];
    // Sender applies `mine` from the ack. Broadcasting the same event back to them
    // races the ack and can wipe that flag (counts only, no per-viewer mine).
    socket.to(`room:${s.roomId}`).emit('chat:reactions', {
      messageId: m.id,
      reactions: reactions.map((r) => ({ emoji: r.emoji, count: r.count })),
    });
    ack({ ok: true, reactions });
  });

  socket.on('pm:send', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user) return ack({ ok: false, error: 'Log in first' });
    if (limited(chatRl, ipChat)) return ack({ ok: false, error: 'Slow down' });
    if (String(p?.toId ?? '').startsWith('bot:')) return ack({ ok: false, error: 'Bots do not take private messages' });
    const to = userOf(String(p?.toId ?? ''));
    if (!to || to.id === socket.id) return ack({ ok: false, error: 'User is not online' });
    const muted = repo.activeMuteUntil(identOf(s));
    if (muted) return ack({ ok: false, error: 'You are muted.' });
    let text = cleanText(p?.text, LIMITS.messageMax);
    if (!text) return ack({ ok: false, error: 'Empty message' });
    if (!s.account && countLinks(text) > LIMITS.guestLinksPerMessage) return ack({ ok: false, error: 'Too many links.' });
    text = maskWords(text);
    const message: PrivateMessage = { id: randomUUID(), ts: Date.now(), fromId: socket.id, from: s.user.nick, toId: to.id, to: to.nick, text };
    io.to(to.id).emit('pm', message);
    ack({ ok: true, message });
    {
      const toAcct = sessions.get(to.id)?.account?.id;
      if (toAcct) pushIfAway(toAcct, { title: `Message from ${s.user.nick}`, body: text.slice(0, 200), url: '/', tag: `pm-${s.user.nick}` });
    }
  });

  socket.on('media:state', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const room = rooms.get(s.roomId)!;
    const wantCam = !!p?.cam, wantMic = !!p?.mic, wantScreen = !!p?.screen;
    const videoOn = wantCam || wantScreen;
    const alreadyVideo = !!(s.user.cam || s.user.screen);
    if (room.voice && videoOn) return ack({ ok: false, error: 'This is a voice room: audio only (no camera or screen share).' });
    if (room.stage.on && (wantCam || wantMic || wantScreen)) {
      if (!isStageSpeaker(s, room)) return ack({ ok: false, error: 'Stage mode: only speakers can use their camera or mic. Raise your hand to ask to speak.' });
      const publishing = !!(s.user.cam || s.user.mic || s.user.screen);
      if (!publishing && stagePublishers(room) >= room.stage.cap) return ack({ ok: false, error: `Stage is full: at most ${room.stage.cap} speakers at once.` });
    }
    // Screen share counts as video. Re-check the guest timer and cam block on every
    // video request so a stuck `screen` flag cannot skip a moderator cam-off.
    if (videoOn) {
      const allowed = camAllowedAt(s);
      if (allowed === -1) return ack({ ok: false, error: 'Create a free account (or sign in) to broadcast your camera.' });
      if (allowed) return ack({ ok: false, error: `Guests can start their camera in ${Math.ceil((allowed - Date.now()) / 60_000)} minute(s), or right away with a free account.` });
      const blocked = camBlockedUntil(s);
      if (blocked > Date.now()) return ack({ ok: false, error: `A moderator turned your camera off. You can start it again in ${Math.ceil((blocked - Date.now()) / 60_000)} minute(s).` });
      if (!alreadyVideo) {
        const broadcasters = roomUsers(room).filter((u) => u.cam || u.mic || u.screen).length;
        if (broadcasters >= LIMITS.maxBroadcastersPerRoom) return ack({ ok: false, error: `At most ${LIMITS.maxBroadcastersPerRoom} people can broadcast at once.` });
      }
    }
    s.user = { ...s.user, cam: wantCam && !wantScreen, mic: wantMic, screen: wantScreen };
    io.to(`room:${room.id}`).emit('user:updated', s.user);
    airTrack(socket.id, s);
    ack({ ok: true });
    broadcastRooms();
  });

  // Relay WebRTC signaling only between members of the same room.
  socket.on('rtc:signal', (p) => {
    const s = session();
    if (!s.user || !s.roomId || !p || typeof p.to !== 'string') return;
    if (limited(sigRl, ipSig)) return;
    const room = rooms.get(s.roomId);
    if (!room?.members.has(p.to) || p.to === socket.id) return;
    if (p.to.startsWith('bot:')) return;
    const d = p.data as { type?: unknown; video?: unknown } | undefined;
    if (d?.type === 'pref') {
      // receive preference: relay only the validated value
      if (!isViewPref(d.video)) return;
      io.to(p.to).emit('rtc:signal', { from: socket.id, data: { type: 'pref', video: d.video } });
      return;
    }
    if (!d || (d.type !== 'description' && d.type !== 'candidate')) return;
    // stage mode: the audience receives only; drop any description that offers to send media
    if (d.type === 'description' && room.stage.on && !isStageSpeaker(s, room)
      && sdpPublishes((p.data as { description?: { sdp?: unknown } }).description?.sdp)) return;
    io.to(p.to).emit('rtc:signal', { from: socket.id, data: p.data });
  });

  // ---------- site moderation (moderators / admins) ----------
  const staffGuard = (ack: (r: unknown) => void) => {
    const s = session();
    if (!s.user) { ack({ ok: false, error: 'Log in first' }); return null; }
    if (!isStaff(s)) { ack({ ok: false, error: 'Moderators only' }); return null; }
    if (limited(actRl, ipAct)) { ack({ ok: false, error: 'Rate limited' }); return null; }
    return s;
  };

  socket.on('mod:camoff', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = staffGuard(ack);
    if (!s) return;
    const t = target(p?.userId);
    if (!t) return ack({ ok: false, error: 'User not found' });
    if (!canModerate(s, t.ts, null, false)) return ack({ ok: false, error: 'You cannot do that to this user' });
    const minutes = Math.min(Math.max(Number(p?.minutes) || 5, 1), 1440);
    const until = Date.now() + minutes * 60_000;
    for (const k of [repo.userKey(identOf(t.ts)), ...t.ts.deviceIds.map((d) => `d:${d}`)]) camBlocks.set(k, until);
    t.user.cam = false;
    t.user.screen = false;
    t.sock.emit('mod:camoff', { by: s.user!.nick, until });
    if (t.ts.roomId) {
      io.to(`room:${t.ts.roomId}`).emit('user:updated', t.user);
      const room = rooms.get(t.ts.roomId);
      if (room) systemMsg(room, `${s.user!.nick} turned off ${t.user.nick}'s camera`);
    }
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'cam-off', t.user.nick, t.ts.roomId, `${minutes} min`);
    broadcastRooms();
    ack({ ok: true });
  });

  socket.on('mod:delete', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = staffGuard(ack);
    if (!s) return;
    const m = repo.messageById(String(p?.messageId ?? ''));
    if (!m || m.deleted) return ack({ ok: false, error: 'Message not found' });
    const parentId = m.parent_id;
    dropMessage(s, m, 'delete-message');
    if (parentId) io.to(`room:${m.room_id}`).emit('chat:replies', { messageId: parentId, replyCount: repo.replyCount(parentId) });
    ack({ ok: true });
  });

  socket.on('mod:mute', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = staffGuard(ack);
    if (!s) return;
    const t = target(p?.userId);
    if (!t) return ack({ ok: false, error: 'User not found' });
    if (!canModerate(s, t.ts, null, false)) return ack({ ok: false, error: 'You cannot do that to this user' });
    const minutes = Math.round(Number(p?.minutes));
    if (!(minutes >= 1 && minutes <= 10080)) return ack({ ok: false, error: 'Mute for 1 minute to 7 days' });
    const until = repo.addMute(identOf(t.ts), actorLabel(s), minutes);
    t.sock.emit('mod:muted', { by: s.user!.nick, until });
    const room = t.ts.roomId ? rooms.get(t.ts.roomId) : null;
    if (room) systemMsg(room, `${t.user.nick} was muted for ${minutes} min by ${s.user!.nick}`);
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'mute', t.user.nick, t.ts.roomId, `${minutes} min`);
    ack({ ok: true });
  });

  socket.on('mod:ban', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = staffGuard(ack);
    if (!s) return;
    const t = target(p?.userId);
    if (!t) return ack({ ok: false, error: 'User not found' });
    if (!canModerate(s, t.ts, null, false)) return ack({ ok: false, error: 'You cannot do that to this user' });
    const reason = cleanText(p?.reason, LIMITS.banReasonMax);
    if (!reason) return ack({ ok: false, error: 'A reason is required' });
    const minutes = p?.minutes && Number(p.minutes) > 0 ? Math.min(Math.round(Number(p.minutes)), 5_256_000) : null;
    const kinds: BanKind[] = Array.isArray(p?.kinds) && p.kinds.length ? p.kinds.filter((k): k is BanKind => k === 'account' || k === 'ip' || k === 'device') : ['account', 'ip', 'device'];
    const applied = applySiteBan({
      by: actorLabel(s), byAccountId: s.account?.id ?? null, nick: t.user.nick,
      accountId: t.ts.account?.id ?? null, ip: t.ts.ip, deviceIds: t.ts.deviceIds, roomId: t.ts.roomId,
      reason, minutes, kinds,
    });
    if (!applied.ok) return ack({ ok: false, error: applied.error });
    ack({ ok: true });
  });

  socket.on('report', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user) return ack({ ok: false, error: 'Log in first' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    // Legacy clients send a free-text reason; the queue uses a category + optional note.
    const legacy = typeof p?.reason === 'string' && p?.category === undefined;
    const category = isReportCategory(p?.category) ? p.category : legacy ? 'other' : null;
    if (!category) return ack({ ok: false, error: 'Pick a reason' });
    const rawNote = typeof p?.note === 'string' ? p.note : legacy ? String(p?.reason ?? '') : '';
    if (rawNote.length > MODQ.noteMax) return ack({ ok: false, error: `Keep the note under ${MODQ.noteMax} characters` });
    const note = cleanText(rawNote, MODQ.noteMax) || null;
    if (legacy && !note) return ack({ ok: false, error: 'Please say what is wrong' });
    const notify = !!p?.notify && !!s.account;
    let targetUserId: number | null = null, targetNick: string | null = null, targetIp: string | null = null, targetDevice: string | null = null;
    let roomId: string | null = s.roomId, messageId: string | null = null, messageText: string | null = null;
    let kind: 'message' | 'user' | 'room' | 'whisper';
    let key: string;
    let snapshot: ReportSnapshot | null = null;
    let privateKind: 'burn' | 'whisper' | null = null;
    let context: ReportContextLine[] = [];
    let files: { src: string; name: string; i: number }[] = [];
    if (p?.messageId) {
      const m = repo.messageById(String(p.messageId));
      if (!m || m.deleted) return ack({ ok: false, error: 'Message not found' });
      if (isMessageAuthor(s, m)) return ack({ ok: false, error: 'You cannot report your own message' });
      if (m.burn_ttl != null) {
        // burn: reportable only while the reporter can still see it; the report keeps the text for site staff
        const seen = repo.burnViews(m.id).get(burnViewerKey(s));
        if (m.burned_at != null || (seen != null && !burnRevealAllowed(seen, burnTtlMs(m.burn_ttl), Date.now())))
          return ack({ ok: false, error: 'This message already burned' });
        if (seen == null && !canReview(s, m.room_id)) return ack({ ok: false, error: 'Reveal the message before reporting it' });
        privateKind = 'burn';
      }
      messageId = m.id; messageText = m.text; roomId = m.room_id;
      targetUserId = m.user_id; targetNick = m.nick; targetIp = m.ip; targetDevice = m.device_id;
      kind = 'message'; key = `m:${m.id}`;
      const att = attachmentsOf(m);
      files = att.files;
      snapshot = {
        text: m.text, attachments: att.list, senderAccountId: m.user_id, senderNick: m.nick, roomId: m.room_id,
        roomName: rooms.get(m.room_id)?.name ?? repo.roomRowById(m.room_id)?.name ?? null, ts: m.ts, editedAt: m.edited_at, private: privateKind,
      };
      context = contextAround(m);
    } else if (p?.whisperMessageId) {
      const w = whisperLog.get(String(p.whisperMessageId));
      // Only someone the whisper was sent to may report it, and only what they saw.
      if (!w || !w.members.has(socket.id)) return ack({ ok: false, error: 'Message not found' });
      if (w.m.fromId === socket.id) return ack({ ok: false, error: 'You cannot report your own message' });
      privateKind = 'whisper';
      messageText = w.m.text; roomId = w.roomId;
      targetUserId = w.accountId; targetNick = w.m.from; targetIp = w.ip; targetDevice = w.device;
      kind = 'whisper'; key = `w:${w.m.id}`;
      snapshot = { text: w.m.text, attachments: [], senderAccountId: w.accountId, senderNick: w.m.from, roomId: w.roomId, roomName: rooms.get(w.roomId)?.name ?? null, ts: w.m.ts, private: 'whisper' };
      context = [...whisperLog.values()].filter((e) => e.m.whisperId === w.m.whisperId && e.members.has(socket.id))
        .slice(-MODQ.contextSize - 1).map((e) => ({ ts: e.m.ts, from: e.m.from, text: e.m.text, ...(e.m.id === w.m.id ? { target: true } : {}) }));
    } else if (p?.roomId) {
      const room = rooms.get(String(p.roomId));
      if (!room || (room.isPrivate && !room.members.has(socket.id))) return ack({ ok: false, error: 'Room not found' });
      if (isOwner(s, room)) return ack({ ok: false, error: 'You cannot report your own room' });
      roomId = room.id;
      targetUserId = room.ownerUserId; targetNick = room.ownerNick || null;
      const ownerLive = room.ownerUserId ? liveAccount(room.ownerUserId) : null;
      if (ownerLive) { targetIp = ownerLive.ts.ip; targetDevice = ownerLive.ts.deviceIds[0] ?? null; }
      kind = 'room'; key = `r:${room.id}`;
      snapshot = { text: null, attachments: [], senderAccountId: room.ownerUserId, senderNick: room.ownerNick || null, roomId: room.id, roomName: room.name, ts: null, topic: room.topic || null };
      context = repo.recentMessages(room.id, MODQ.contextSize, false).map((m) => ({ ts: m.ts, from: m.nick, text: m.burn_ttl != null ? '[burn message]' : m.text }));
    } else if (p?.accountId != null) {
      const acct = repo.accountById(Math.floor(Number(p.accountId)));
      if (!acct) return ack({ ok: false, error: 'User not found' });
      if (acct.id === s.account?.id) return ack({ ok: false, error: 'You cannot report yourself' });
      const t = liveAccount(acct.id);
      targetUserId = acct.id; targetNick = acct.username; targetIp = t?.ts.ip ?? null; targetDevice = t?.ts.deviceIds[0] ?? null;
      roomId = t?.ts.roomId ?? s.roomId;
      kind = 'user'; key = `u:${acct.id}`;
      snapshot = { text: null, attachments: [], senderAccountId: acct.id, senderNick: acct.username, roomId, roomName: roomId ? rooms.get(roomId)?.name ?? null : null, ts: null };
      context = roomId ? repo.recentMessages(roomId, MODQ.contextSize, false).map((m) => ({ ts: m.ts, from: m.nick, text: m.burn_ttl != null ? '[burn message]' : m.text })) : [];
    } else {
      const t = target(p?.userId);
      if (!t || t.sock.id === socket.id) return ack({ ok: false, error: 'User not found' });
      targetUserId = t.ts.account?.id ?? null; targetNick = t.user.nick; targetIp = t.ts.ip; targetDevice = t.ts.deviceIds[0] ?? null;
      roomId = t.ts.roomId ?? s.roomId;
      kind = 'user'; key = targetUserId ? `u:${targetUserId}` : `u:n:${t.user.nick.toLowerCase()}`;
      snapshot = { text: null, attachments: [], senderAccountId: targetUserId, senderNick: t.user.nick, roomId, roomName: roomId ? rooms.get(roomId)?.name ?? null : null, ts: null };
      context = roomId ? repo.recentMessages(roomId, MODQ.contextSize, true).map((m) => ({ ts: m.ts, from: m.nick, text: m.burn_ttl != null ? '[burn message]' : m.text })) : [];
    }
    const reporterUserId = s.account?.id ?? null;
    const dup = modq.findDuplicate({ reporterUserId, reporterIp: ip, reporterNick: s.user.nick, key });
    if (dup) {
      modq.updateDuplicate(dup.id, category, note, notify);
      return ack({ ok: true, reportId: dup.id, updated: true });
    }
    if (!reportUserRl.take(reporterUserId != null ? `u:${reporterUserId}` : `g:${ip}:${s.user.nick.toLowerCase()}`) || !ipReport.take(ip))
      return ack({ ok: false, error: 'You have sent a lot of reports. Please wait.' });
    const reportId = modq.insertReport({
      reporterUserId, reporterNick: s.user.nick, reporterIp: ip,
      targetUserId, targetNick, targetIp, targetDevice, roomId, messageId, messageText,
      kind, key, category, note, snapshot, privateKind, context, notify,
    });
    if (snapshot && files.length) {
      // Keep copies of attachments so a later delete cannot erase the evidence.
      const att = snapshot.attachments.map((a) => ({ ...a }));
      for (const f of files) att[f.i].evidence = modq.keepEvidence(reportId, f.src, f.name);
      modq.setSnapshot(reportId, { ...snapshot, attachments: att });
    }
    ack({ ok: true, reportId });
    const row = modq.reportById(reportId);
    if (row) afterNewReport(row);
  });

  // ---- moderation queue: room view (room owner / room mods; site staff see everything) ----
  const roomQueueCtx = (): { error: string; status: number } | { s: Session; room: Room } => {
    const s = session();
    if (!s.user || !s.roomId) return { error: 'Not in a room', status: 400 };
    const room = rooms.get(s.roomId);
    if (!room) return { error: 'Not in a room', status: 400 };
    if (!canRoomManage(s, room)) return { error: 'Only the room owner or a room moderator can see reports', status: 403 };
    return { s, room };
  };
  socket.on('modq:counts', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !isStaff(s)) return ack({ ok: false, error: 'Moderators only', status: 403 });
    ack({ ok: true, counts: modq.counts() });
  });
  socket.on('modq:room:list', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomQueueCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const bucket = modq.isBucket(p?.status) ? p.status : 'open';
    const sort = p?.sort === 'oldest' || p?.sort === 'newest' ? p.sort : 'count';
    const scope = { roomId: c.room.id };
    ack({ ok: true, items: modq.listItems(bucket, sort, modqView(isStaff(c.s)), scope), counts: modq.counts(scope) });
  });
  socket.on('modq:room:claim', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomQueueCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const r = queueClaim({ label: actorLabel(c.s), accountId: c.s.account?.id ?? null }, Number(p?.reportId), !!p?.release, false, c.room.id);
    ack(r.ok ? { ok: true } : r);
  });
  socket.on('modq:room:act', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomQueueCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const r = queueAct({ label: actorLabel(c.s), accountId: c.s.account?.id ?? null, role: roleOf(c.s), nick: c.s.user!.nick, site: false, room: c.room }, Number(p?.reportId), p);
    ack(r.ok ? { ok: true, resolution: r.resolution } : r);
  });


  // ---- room lock / slow-mode / purge ----
  socket.on('room:lock', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId)!;
    if (!isStaff(s) && !isOwner(s, room)) return ack({ ok: false, error: 'Only the room owner or a moderator can lock the room' });
    room.locked = !!p?.locked;
    repo.setRoomLocked(room.id, room.locked);
    repo.logAction(actorLabel(s), s.account?.id ?? null, room.locked ? 'room-lock' : 'room-unlock', null, room.id);
    io.to(`room:${room.id}`).emit('room:settings', { locked: room.locked, slowModeSec: room.slowModeSec });
    systemMsg(room, room.locked ? `${s.user.nick} locked the room` : `${s.user.nick} unlocked the room`);
    ack({ ok: true });
  });
  socket.on('room:password', async (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    try {
      const s = session();
      if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
      if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
      const room = rooms.get(s.roomId)!;
      if (!isStaff(s) && !isOwner(s, room)) return ack({ ok: false, error: 'Only the room owner or a moderator can set the password' });
      const pw = roomPasswordInput(p?.password);
      if ('error' in pw) return ack({ ok: false, error: pw.error });
      const hash = pw.password ? await hashSecret(pw.password) : null;
      room.passwordHash = hash;
      pingRoomFriends(room);
      repo.setRoomPassword(room.id, hash);
      repo.logAction(actorLabel(s), s.account?.id ?? null, hash ? 'room-password' : 'room-password-clear', null, room.id, hash ? 'set' : 'cleared');
      io.to(`room:${room.id}`).emit('room:access', { passwordRequired: !!hash });
      systemMsg(room, hash ? `${s.user.nick} set a room password` : `${s.user.nick} removed the room password`);
      broadcastRooms();
      ack({ ok: true });
    } catch (err) {
      console.error('[room:password]', (err as Error).message);
      ack({ ok: false, error: 'Could not update the room password' });
    }
  });
  const ownerHere = () => {
    const s = session();
    if (!s.user || !s.roomId) return { error: 'Not in a room' as const };
    const room = rooms.get(s.roomId)!;
    if (room.isPrivate) return { error: 'Bots cannot join a private call' as const };
    if (!isOwner(s, room)) return { error: 'Only the room creator can manage bots' as const };
    return { s, room };
  };
  socket.on('room:bots', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const here = ownerHere();
    if ('error' in here) return ack({ ok: false, error: here.error });
    ack({ ok: true, bots: repo.botsAllowed(here.room.id) });
  });
  socket.on('room:bot-allow', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const here = ownerHere();
    if ('error' in here) return ack({ ok: false, error: here.error });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    const bot = name ? repo.botByName(name) : undefined;
    if (!bot || !bot.token_hash) return ack({ ok: false, error: 'No bot with that name' });
    repo.allowBot(here.room.id, bot.id);
    repo.logAction(actorLabel(here.s), here.s.account?.id ?? null, 'bot-allow', bot.name, here.room.id);
    ack({ ok: true, bot: { id: bot.id, name: bot.name } });
  });
  socket.on('room:bot-remove', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const here = ownerHere();
    if ('error' in here) return ack({ ok: false, error: here.error });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const botId = Number(p?.botId);
    if (!Number.isInteger(botId) || botId <= 0) return ack({ ok: false, error: 'No such bot' });
    const known = repo.botsAllowed(here.room.id).some((b) => b.id === botId);
    repo.removeBotAllow(here.room.id, botId);
    removeBot(botId, here.room);
    if (known) repo.logAction(actorLabel(here.s), here.s.account?.id ?? null, 'bot-remove', String(botId), here.room.id);
    ack({ ok: true });
  });
  socket.on('room:slowmode', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId)!;
    if (!isStaff(s) && !isOwner(s, room)) return ack({ ok: false, error: 'Only the room owner or a moderator can set slow mode' });
    const sec = Math.max(0, Math.min(300, Math.round(Number(p?.seconds) || 0)));
    room.slowModeSec = sec;
    repo.setRoomSlowMode(room.id, sec);
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'slow-mode', null, room.id, `${sec}s`);
    io.to(`room:${room.id}`).emit('room:settings', { locked: room.locked, slowModeSec: room.slowModeSec });
    systemMsg(room, sec ? `${s.user.nick} set slow mode to ${sec}s` : `${s.user.nick} turned off slow mode`);
    ack({ ok: true });
  });
  socket.on('room:purge', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user || !s.roomId) return ack({ ok: false, error: 'Not in a room' });
    const room = rooms.get(s.roomId)!;
    if (!isStaff(s) && !isOwner(s, room)) return ack({ ok: false, error: 'Only the room owner or a moderator can purge chat' });
    const minutes = Math.max(1, Math.min(24 * 60, Math.round(Number(p?.minutes) || 60)));
    const since = Date.now() - minutes * 60_000;
    const purged = repo.purgeRoomMessages(room.id, since);
    deleteVoiceForMessages(purged);
    deleteImagesForMessages(purged);
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'purge', null, room.id, `${purged.length} msgs / last ${minutes}m`);
    for (const id of purged) io.to(`room:${room.id}`).emit('chat:deleted', { id });
    systemMsg(room, `${s.user.nick} purged recent chat (${purged.length} messages)`);
    ack({ ok: true });
  });

  // ---- friends ----
  // ---- smarter lobby (accounts only; every answer is about the asking account) ----
  socket.on('lobby:friends', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: true, friends: [] });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    ack({ ok: true, friends: friendsOnlineFor(s.account.id) });
  });
  socket.on('lobby:recent', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: true, rooms: [] });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    ack({ ok: true, rooms: recentRoomsFor(s) });
  });
  socket.on('lobby:recent:remove', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in with an account' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    lobby.removeRecent(s.account.id, String(p?.roomId ?? '').slice(0, 64));
    ack({ ok: true });
  });
  socket.on('presence:get', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in with an account' });
    ack({ ok: true, showRoom: lobby.showRoom(s.account.id) });
  });
  socket.on('presence:set', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in with an account' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    lobby.setShowRoom(s.account.id, p?.showRoom !== false);
    friendRoomPing(s.account.id);
    ack({ ok: true, showRoom: lobby.showRoom(s.account.id) });
  });
  socket.on('blocks:get', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: true, usernames: [] });
    ack({ ok: true, usernames: lobby.blockedUsernames(s.account.id) });
  });
  socket.on('blocks:set', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in with an account' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const names = Array.isArray(p?.usernames) ? p.usernames.filter((n: unknown): n is string => typeof n === 'string').slice(0, LOBBY.blocksMax) : [];
    const ids: number[] = [];
    for (const n of names) { const u = repo.userByName(n.slice(0, 40)); if (u) ids.push(u.id); }
    const before = new Set(lobby.blockedIds(s.account.id));
    const after = lobby.setBlocks(s.account.id, ids);
    // whoever was added or removed sees the change in their friends row right away
    const changed = new Set([...after.filter((id) => !before.has(id)), ...[...before].filter((id) => !after.includes(id))]);
    const friends = new Set(acceptedFriendIds(s.account.id));
    for (const id of changed) if (friends.has(id) && accountSockets.has(id)) emitToAccount(id, 'lobby:friend', { userId: s.account.id, entry: friendOnlineFor(id, s.account.id) });
    ack({ ok: true, usernames: lobby.blockedUsernames(s.account.id) });
  });
  socket.on('friends:list', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in with an account' });
    const rows = repo.listFriendships(s.account.id);
    const other = (r: repo.FriendRow) => (r.user_id === s.account!.id ? r.peer_id : r.user_id);
    ack({
      ok: true,
      friends: rows.filter((r) => r.status === 'accepted').map((r) => friendEntryFor(s.account!.id, other(r), 'accepted')),
      pendingIn: rows.filter((r) => r.status === 'pending' && r.requested_by !== s.account!.id).map((r) => friendEntryFor(s.account!.id, other(r), 'pending')),
      pendingOut: rows.filter((r) => r.status === 'pending' && r.requested_by === s.account!.id).map((r) => friendEntryFor(s.account!.id, other(r), 'pending')),
    });
  });
  socket.on('friends:request', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in with an account' });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const name = typeof p?.username === 'string' ? p.username.trim() : '';
    const peer = repo.userByName(name);
    if (!peer) return ack({ ok: false, error: 'No such user' });
    if (peer.id === s.account.id) return ack({ ok: false, error: 'Cannot friend yourself' });
    try {
      const row = repo.requestFriend(s.account.id, peer.id);
      const entry = friendEntryFor(s.account.id, peer.id, 'pending');
      emitToAccount(peer.id, 'friend:update', { type: 'request', entry: friendEntryFor(peer.id, s.account.id, 'pending') });
      ack({ ok: true, friend: entry });
    } catch (e) { ack({ ok: false, error: (e as Error).message }); }
  });
  socket.on('friends:respond', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in with an account' });
    const peerId = Number(p?.userId);
    if (!Number.isFinite(peerId)) return ack({ ok: false, error: 'Bad user' });
    try {
      const row = repo.respondFriend(s.account.id, peerId, !!p?.accept);
      if (!row) return ack({ ok: false, error: 'No pending request' });
      if (p?.accept) {
        setStat(s.account.id, 'friends', repo.friendCount(s.account.id));
        setStat(peerId, 'friends', repo.friendCount(peerId));
        emitToAccount(peerId, 'friend:update', { type: 'accepted', entry: friendEntryFor(peerId, s.account.id, 'accepted') });
      } else {
        emitToAccount(peerId, 'friend:update', { type: 'declined', entry: friendEntryFor(peerId, s.account.id, 'pending') });
      }
      ack({ ok: true });
    } catch (e) { ack({ ok: false, error: (e as Error).message }); }
  });
  socket.on('friends:remove', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in with an account' });
    const peerId = Number(p?.userId);
    if (!repo.removeFriend(s.account.id, peerId)) return ack({ ok: false, error: 'Not friends' });
    setStat(s.account.id, 'friends', repo.friendCount(s.account.id));
    setStat(peerId, 'friends', repo.friendCount(peerId));
    emitToAccount(peerId, 'friend:update', { type: 'removed', entry: friendEntryFor(peerId, s.account.id, 'accepted') });
    ack({ ok: true });
  });

  // ---- 1:1 call (private room) ----
  socket.on('call:invite', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account || !s.user) return ack({ ok: false, error: 'Sign in with an account' });
    const fresh = repo.accountById(s.account.id);
    if (fresh) s.account = fresh;
    const gate = roomEntryError(s.account);
    if (gate) return ack({ ok: false, error: gate });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited' });
    const peerId = Number(p?.userId);
    if (!repo.areFriends(s.account.id, peerId)) return ack({ ok: false, error: 'You can only call friends' });
    const peerSock = accountSockets.get(peerId);
    if (!peerSock) return ack({ ok: false, error: 'Friend is offline' });
    const id = `call-${s.account.id}-${peerId}-${randomUUID().slice(0, 6)}`;
    const name = `Call ${s.user.nick}`;
    const row = {
      id, name, topic: 'Private call', owner_user_id: s.account.id, owner_nick: s.user.nick,
      permanent: 0, persistent: 0, locked: 0, slow_mode_sec: 0, is_private: 1,
    };
    repo.insertRoom(row);
    const room = loadRoom({ ...row, created_at: Date.now() } as repo.RoomRow);
    room.callPeers = [s.account.id, peerId].sort((a, b) => a - b) as [number, number];
    emitToAccount(peerId, 'call:incoming', { from: friendEntryFor(peerId, s.account.id, 'accepted'), roomId: room.id });
    // caller joins immediately
    if (s.roomId) leaveRoom(socket);
    socket.leave('lobby');
    socket.join(`room:${room.id}`);
    room.members.add(socket.id);
    s.roomId = room.id;
    const state = roomState(room, s);
    ack({ ok: true, roomId: room.id, room: state });
  });
  socket.on('call:respond', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account || !s.user) return ack({ ok: false, error: 'Sign in with an account' });
    const room = rooms.get(String(p?.roomId ?? ''));
    if (!room || !room.isPrivate || !room.callPeers || !room.callPeers.includes(s.account.id))
      return ack({ ok: false, error: 'Call not found' });
    if (p?.accept) {
      const fresh = repo.accountById(s.account.id);
      if (fresh) s.account = fresh;
      const gate = roomEntryError(s.account);
      if (gate) return ack({ ok: false, error: gate });
    }
    if (!p?.accept) {
      for (const id of [...room.members]) {
        const sock = io.sockets.sockets.get(id);
        if (sock) { sock.emit('call:ended', { roomId: room.id, reason: 'declined' }); leaveRoom(sock, 'left'); }
      }
      dropRoom(room);
      return ack({ ok: true });
    }
    if (s.roomId) leaveRoom(socket);
    socket.leave('lobby');
    socket.join(`room:${room.id}`);
    room.members.add(socket.id);
    s.roomId = room.id;
    socket.to(`room:${room.id}`).emit('user:joined', s.user);
    const state = roomState(room, s);
    ack({ ok: true, room: state });
  });

  socket.on('disconnect', () => {
    // In a room: keep the seat for RECONNECT_GRACE_MS. Anywhere else: drop immediately.
    parkSession(socket.id);
    const n = (connsPerIp.get(ip) ?? 1) - 1;
    if (n <= 0) connsPerIp.delete(ip); else connsPerIp.set(ip, n);
  });

  // ================= batch 2 =================
  /** In a room right now, as a person (not a bot). */
  const roomCtx = (): { error: string; status?: number } | { s: Session; room: Room } => {
    const s = session();
    if (socket.id.startsWith('bot:')) return { error: 'Bots cannot do that', status: 403 };
    if (!s.user || !s.roomId) return { error: 'Not in a room' };
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(socket.id)) return { error: 'Not in a room' };
    return { s, room };
  };

  // ---- message search (registered members of the room; burn/deleted never included) ----
  const searchRl = new RateLimiter(20, 60_000);
  socket.on('chat:search', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (!c.s.account || !c.s.user?.registered) return ack({ ok: false, error: 'Sign in to search chat history.', status: 401 });
    if (!searchRl.take()) return ack({ ok: false, error: 'Too many searches. Wait a moment.', status: 429 });
    const tokens = repo2.searchTokens(String(p?.q ?? ''));
    const filter = searchFilterOf(p);
    const hasFilter = !!(filter.from || filter.after != null || filter.before != null);
    if ((!tokens.length && !hasFilter) || (tokens.length && tokens.join('').length < 2)) return ack({ ok: false, error: 'Type at least 2 letters to search.', status: 400 });
    const offset = Math.max(0, Math.min(1000, Math.floor(Number(p?.offset) || 0)));
    const PAGE = 20;
    const { rows, hasMore } = repo2.searchRoomMessages(c.room.id, tokens, offset, PAGE, filter);
    const key = repo.userKey(identOf(c.s));
    const rx = repo.reactionsFor(rows.map((m) => m.id), key);
    const hits: SearchHit[] = rows.map((m) => ({ message: chatFromRow(m, rx.get(m.id), 0, c.s), ...(m.parent_id ? { threadId: m.parent_id } : {}) }));
    ack({ ok: true, hits, hasMore, offset: offset + rows.length });
  });
  socket.on('modq:botlog', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user) return ack({ ok: false, error: 'Not allowed', status: 403 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down', status: 429 });
    if (p?.scope === 'site') {
      if (!isStaff(s)) return ack({ ok: false, error: 'Not allowed', status: 403 });
      return ack({ ok: true, actions: repo4.botActions(null) });
    }
    const room = s.roomId ? rooms.get(s.roomId) : undefined;
    if (!room || !canReview(s, room.id)) return ack({ ok: false, error: 'Not allowed', status: 403 });
    ack({ ok: true, actions: repo4.botActions(room.id) });
  });
  socket.on('notify:get', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (!c.s.account) return ack({ ok: false, error: 'Sign in to change notifications.', status: 401 });
    ack({ ok: true, level: repo4.notifyLevel(c.s.account.id, c.room.id), quiet: repo4.quietHours(c.s.account.id) });
  });
  socket.on('notify:set', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (!c.s.account) return ack({ ok: false, error: 'Sign in to change notifications.', status: 401 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down', status: 429 });
    if (!isNotifyLevel(p?.level)) return ack({ ok: false, error: 'Unknown setting', status: 400 });
    repo4.setNotifyLevel(c.s.account.id, c.room.id, p.level);
    ack({ ok: true, level: p.level });
  });
  socket.on('notify:quiet', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in to change notifications.', status: 401 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down', status: 429 });
    if (p == null) { repo4.setQuietHours(s.account.id, null); return ack({ ok: true, quiet: null }); }
    const mins = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1440 ? (v as number) : null);
    const start = mins(p.start), end = mins(p.end), tz = validTz(p.tz);
    if (start == null || end == null || !tz) return ack({ ok: false, error: 'Pick a start and end time', status: 400 });
    repo4.setQuietHours(s.account.id, { start, end, tz });
    ack({ ok: true, quiet: start === end ? null : { start, end, tz } });
  });
  socket.on('room:filters:get', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (!canRoomManage(c.s, c.room)) return ack({ ok: false, error: 'Only the room owner or a room moderator can see filters', status: 403 });
    ack({ ok: true, filters: repo6.filtersFor(c.room.id), bot: modBotName() });
  });
  socket.on('room:filters:set', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    if (room.isPrivate) return ack({ ok: false, error: 'Private calls have no filters', status: 400 });
    if (!canRoomManage(s, room)) return ack({ ok: false, error: 'Only the room owner or a room moderator can change filters', status: 403 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const w = cleanWords(p?.words);
    if ('error' in w) return ack({ ok: false, error: w.error, status: 400 });
    const d = cleanDomains(p?.allow);
    if ('error' in d) return ack({ ok: false, error: d.error, status: 400 });
    if (!isLinkMode(p?.links)) return ack({ ok: false, error: 'Links: off, block or allowlist', status: 400 });
    repo6.setFilters(room.id, w.words, p.links, d.domains, s.user!.nick);
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'room-filters', null, room.id, `${w.words.length} words, links ${p.links}${d.domains.length ? ` (${d.domains.length} allowed)` : ''}`);
    ack({ ok: true, filters: repo6.filtersFor(room.id) });
  });
  const unreadRl = new RateLimiter(20, 10_000);
  socket.on('unread:get', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: true, rooms: {}, mentions: 0 });
    if (!unreadRl.take()) return ack({ ok: false, error: 'Slow down', status: 429 });
    const out: Record<string, { n: number; mention: boolean }> = {};
    const ident = identOf(s);
    for (const r of repo5.readRows(s.account.id)) {
      const room = rooms.get(r.room_id);
      if (!room || room.callPeers || r.room_id === s.roomId) continue;
      if (room.isPrivate && !room.members.has(socket.id)) continue;
      if (repo.activeRoomBan(room.id, ident)) continue;
      const u = lobby.unreadSince(room.id, r.read_ts, s.account.id, s.account.username);
      if (u.unread > 0) out[room.id] = { n: u.unread, mention: u.mentions > 0 };
    }
    ack({ ok: true, rooms: out, mentions: repo5.unreadMentionCount(s.account.id) });
  });
  socket.on('room:read', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    const roomId = String(p?.roomId ?? '');
    if (!s.account || !roomId || s.roomId !== roomId || !rooms.has(roomId)) return ack({ ok: false, error: 'Not in that room' });
    if (!unreadRl.take()) return ack({ ok: false, error: 'Slow down', status: 429 });
    const t = Date.now();
    const ts = typeof p?.ts === 'number' && Number.isFinite(p.ts) && p.ts > 0 ? Math.min(p.ts, t) : t;
    repo5.markRead(s.account.id, roomId, ts);
    repo5.readMentionsInRoom(s.account.id, roomId, ts);
    ack({ ok: true });
  });
  socket.on('mentions:list', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in to see mentions', status: 401 });
    if (!unreadRl.take()) return ack({ ok: false, error: 'Slow down', status: 429 });
    const items = repo5.listMentions(s.account.id).filter((r) => r.text != null && !r.deleted).map(mentionItemOf);
    ack({ ok: true, items, unread: repo5.unreadMentionCount(s.account.id) });
  });
  socket.on('mentions:read', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account) return ack({ ok: false, error: 'Sign in to see mentions', status: 401 });
    if (!unreadRl.take()) return ack({ ok: false, error: 'Slow down', status: 429 });
    const ids = p?.ids === 'all' ? 'all' : Array.isArray(p?.ids) ? p.ids.filter((x): x is number => Number.isInteger(x)) : [];
    repo5.setMentionRead(s.account.id, ids, p?.read !== false);
    ack({ ok: true, unread: repo5.unreadMentionCount(s.account.id) });
  });
  socket.on('whisper:search', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (!searchRl.take()) return ack({ ok: false, error: 'Too many searches. Wait a moment.', status: 429 });
    const tokens = repo2.searchTokens(String(p?.q ?? '')).map((t) => t.toLowerCase());
    const filter = searchFilterOf(p);
    if (!tokens.length && !filter.from && filter.after == null && filter.before == null) return ack({ ok: false, error: 'Type at least 2 letters to search.', status: 400 });
    const hits: WhisperMessage[] = [];
    for (const e of [...whisperLog.values()].reverse()) {
      // only whispers you were part of, in the room you are in
      if (e.roomId !== c.room.id || !e.members.has(socket.id)) continue;
      const m = e.m;
      if (filter.from && m.from.toLowerCase() !== filter.from.toLowerCase()) continue;
      if (filter.after != null && m.ts < filter.after) continue;
      if (filter.before != null && m.ts >= filter.before) continue;
      const text = m.text.toLowerCase();
      if (!tokens.every((t) => text.includes(t))) continue;
      hits.push(m);
      if (hits.length >= 50) break;
    }
    // saved lines from earlier sessions (this account was a member), so search works after reconnects and restarts
    if (hits.length < 50 && c.s.account) {
      const seen = new Set(hits.map((h) => h.id));
      const meId = c.s.account.id;
      for (const r of repo5.whispersFor(meId, c.room.id, filter.after != null ? filter.after - 1 : null, filter.before ?? null)) {
        if (seen.has(r.id)) continue;
        if (filter.from && r.from_nick.toLowerCase() !== filter.from.toLowerCase()) continue;
        const text = r.text.toLowerCase();
        if (!tokens.every((t) => text.includes(t))) continue;
        hits.push({ id: r.id, whisperId: r.whisper_id, ts: r.ts, fromId: r.from_user_id === meId ? socket.id : `acct:${r.from_user_id ?? 0}`, from: r.from_nick, text: r.text });
        if (hits.length >= 50) break;
      }
      hits.sort((a, b) => b.ts - a.ts);
    }
    ack({ ok: true, hits });
  });
  socket.on('chat:context', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down', status: 429 });
    const m = repo.messageById(String(p?.messageId ?? ''));
    if (!m || m.deleted || m.room_id !== c.room.id || m.burn_ttl != null) return ack({ ok: false, error: 'Message not found', status: 404 });
    const topId = m.parent_id ?? m.id;
    const anchor = repo.messageAnchor(c.room.id, topId);
    if (!anchor) return ack({ ok: false, error: 'Message not found', status: 404 });
    const rows = repo2.messageContext(c.room.id, anchor, 25, 25);
    const key = repo.userKey(identOf(c.s));
    const rx = repo.reactionsFor(rows.map((r) => r.id), key);
    const counts = repo.replyCounts(rows.map((r) => r.id));
    ack({ ok: true, messages: rows.map((r) => chatFromRow(r, rx.get(r.id), counts.get(r.id) ?? 0, c.s)), anchorId: topId, ...(m.parent_id ? { threadId: m.parent_id } : {}) });
  });

  // ---- bookmarks (private per account) ----
  socket.on('bookmark:toggle', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account || !s.user?.registered || socket.id.startsWith('bot:')) return ack({ ok: false, error: 'Sign in to save messages.', status: 401 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down', status: 429 });
    const m = repo.messageById(String(p?.messageId ?? ''));
    // only lines in the room you are in (you can see them), never burn messages
    if (!m || m.deleted || m.room_id !== s.roomId || m.burn_ttl != null) return ack({ ok: false, error: 'Message not found', status: 404 });
    const on = typeof p?.on === 'boolean' ? p.on : !repo2.isBookmarked(s.account.id, m.id);
    repo2.setBookmark(s.account.id, m.id, m.room_id, on);
    ack({ ok: true, bookmarked: on });
  });
  socket.on('bookmark:list', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.account || !s.user?.registered) return ack({ ok: false, error: 'Sign in to see saved messages.', status: 401 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down', status: 429 });
    const rows = repo2.listBookmarks(s.account.id);
    const bookmarks = rows.map((r) => ({ message: chatFromRow(r, [], 0, s), roomId: r.room_id, roomName: r.room_name, savedAt: r.saved_at }));
    ack({ ok: true, bookmarks, ids: rows.map((r) => r.id) });
  });

  // ---- scheduled events (owner, room mods, site staff manage; registered users RSVP) ----
  const eventRl = new RateLimiter(20, 10 * 60_000);
  const eventCtx = (needManage: boolean): { error: string; status?: number } | { s: Session; room: Room } => {
    const c = roomCtx();
    if ('error' in c) return c;
    if (needManage && !canRoomManage(c.s, c.room)) return { error: 'Only the room owner or a moderator can manage events', status: 403 };
    return c;
  };
  socket.on('events:list', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = eventCtx(false);
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    ack({ ok: true, events: eventInfos(repo2.roomEvents(c.room.id), c.s.account?.id ?? null), canManage: canRoomManage(c.s, c.room) });
  });
  const eventWrite = (p: unknown, existing: repo2.EventRow | null, ack: (r: any) => void) => {
    const c = eventCtx(true);
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (existing && existing.room_id !== c.room.id) return ack({ ok: false, error: 'Event not found', status: 404 });
    if (!eventRl.take()) return ack({ ok: false, error: 'Too many event changes. Try again in a few minutes.', status: 429 });
    const v = validateEvent(p, Date.now());
    if (!v.ok) return ack({ ok: false, error: v.error, status: 400 });
    if (hasFilteredWord(v.value.title)) return ack({ ok: false, error: 'Please pick another title.', status: 400 });
    const upcoming = repo2.upcomingEventCount(c.room.id);
    if ((!existing || existing.starts_at <= Date.now()) && upcoming >= EVENT_MAX_UPCOMING) return ack({ ok: false, error: `A room can have at most ${EVENT_MAX_UPCOMING} upcoming events.`, status: 409 });
    let id: string;
    if (existing) {
      id = existing.id;
      repo2.updateEvent(id, { title: v.value.title, description: maskWords(v.value.description), starts_at: v.value.startsAt, duration_min: v.value.durationMin });
    } else {
      id = randomUUID();
      repo2.insertEvent({ id, room_id: c.room.id, title: v.value.title, description: maskWords(v.value.description), starts_at: v.value.startsAt, duration_min: v.value.durationMin, created_by_user: c.s.account?.id ?? null, created_by_nick: c.s.user!.nick });
    }
    repo.logAction(actorLabel(c.s), c.s.account?.id ?? null, existing ? 'event-edit' : 'event-create', null, c.room.id, v.value.title);
    ack({ ok: true, event: eventInfos([repo2.eventById(id)!], c.s.account?.id ?? null)[0] });
    eventsChanged(c.room.id);
    eventTick();
  };
  socket.on('events:create', (p, ackRaw) => eventWrite(p, null, safeAck(ackRaw)));
  socket.on('events:update', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const row = repo2.eventById(String(p?.id ?? ''));
    if (!row) return ack({ ok: false, error: 'Event not found', status: 404 });
    eventWrite(p, row, ack);
  });
  socket.on('events:cancel', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = eventCtx(true);
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const row = repo2.eventById(String(p?.id ?? ''));
    if (!row || row.room_id !== c.room.id) return ack({ ok: false, error: 'Event not found', status: 404 });
    if (!eventRl.take()) return ack({ ok: false, error: 'Too many event changes. Try again in a few minutes.', status: 429 });
    repo2.deleteEvent(row.id);
    repo.logAction(actorLabel(c.s), c.s.account?.id ?? null, 'event-cancel', null, c.room.id, row.title);
    ack({ ok: true });
    eventsChanged(c.room.id);
  });
  socket.on('events:rsvp', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = eventCtx(false);
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (!c.s.account || !c.s.user?.registered) return ack({ ok: false, error: 'Create a free account (or sign in) to RSVP.', status: 401 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const row = repo2.eventById(String(p?.id ?? ''));
    if (!row || row.room_id !== c.room.id) return ack({ ok: false, error: 'Event not found', status: 404 });
    const status = p?.status ?? null;
    if (status !== null && !isRsvp(status)) return ack({ ok: false, error: 'RSVP must be going, maybe or not going', status: 400 });
    repo2.setRsvp(row.id, c.s.account.id, status);
    ack({ ok: true, event: eventInfos([row], c.s.account.id)[0] });
    io.to(`room:${c.room.id}`).emit('events:changed', { roomId: c.room.id });
  });

  // ---- room roles ----
  socket.on('room:mod', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    if (room.isPrivate) return ack({ ok: false, error: 'Private calls have no room moderators', status: 400 });
    if (!isOwner(s, room) && !isStaff(s)) return ack({ ok: false, error: 'Only the room owner can appoint moderators', status: 403 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const accountId = Math.floor(Number(p?.accountId));
    const target = Number.isFinite(accountId) ? repo.accountById(accountId) : null;
    if (!target) return ack({ ok: false, error: 'Only registered users can be room moderators', status: 404 });
    if (room.ownerUserId === target.id) return ack({ ok: false, error: 'The owner already has every room power', status: 400 });
    const on = !!p?.on;
    if (on && !room.mods.has(target.id) && room.mods.size >= repo2.ROOM_MODS_MAX) return ack({ ok: false, error: `A room can have at most ${repo2.ROOM_MODS_MAX} moderators`, status: 409 });
    repo2.setRoomMod(room.id, target.id, on, actorLabel(s));
    if (on) room.mods.add(target.id); else room.mods.delete(target.id);
    repo.logAction(actorLabel(s), s.account?.id ?? null, on ? 'room-mod-add' : 'room-mod-remove', target.username, room.id);
    const mods = roomModsOf(room);
    io.to(`room:${room.id}`).emit('room:mods', { mods });
    systemMsg(room, on ? `${target.username} is now a room moderator` : `${target.username} is no longer a room moderator`);
    ack({ ok: true, mods });
  });
  socket.on('room:mute', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    if (!canRoomManage(s, room)) return ack({ ok: false, error: 'Only the room owner or a moderator can mute here', status: 403 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const t = target(p?.userId);
    if (!t || !room.members.has(t.sock.id)) return ack({ ok: false, error: 'User not in room', status: 404 });
    if (!canModerate(s, t.ts, room, true)) return ack({ ok: false, error: 'You cannot do that to this user', status: 403 });
    const minutes = Math.round(Number(p?.minutes));
    if (!(minutes >= 1 && minutes <= 10080)) return ack({ ok: false, error: 'Mute for 1 minute to 7 days', status: 400 });
    const until = repo2.addRoomMute(room.id, identOf(t.ts), actorLabel(s), minutes);
    t.sock.emit('room:muted', { by: s.user!.nick, until, roomId: room.id });
    systemMsg(room, `${t.user.nick} was muted in this room for ${minutes} min by ${s.user!.nick}`);
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'room-mute', t.user.nick, room.id, `${minutes} min`);
    ack({ ok: true });
  });

  // ---- link previews: the sender can remove theirs ----
  socket.on('chat:preview-remove', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const m = repo.messageById(String(p?.messageId ?? ''));
    if (!m || m.deleted || m.room_id !== c.room.id) return ack({ ok: false, error: 'Message not found', status: 404 });
    if (!isMessageAuthor(c.s, m) && !canRoomManage(c.s, c.room)) return ack({ ok: false, error: 'Only the sender can remove the preview', status: 403 });
    repo2.removePreview(m.id);
    io.to(`room:${c.room.id}`).emit('chat:preview', { messageId: m.id, preview: null });
    ack({ ok: true });
  });

  // ---- polls ----
  const pollRl = new RateLimiter(8, 10 * 60_000);
  socket.on('poll:create', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    if (limited(chatRl, ipChat)) return ack({ ok: false, error: 'Slow down', status: 429 });
    const muted = repo.activeMuteUntil(identOf(s)) ?? (isStaff(s) ? null : repo2.activeRoomMuteUntil(room.id, identOf(s)));
    if (muted) return ack({ ok: false, error: 'You are muted.', status: 403 });
    const v = validatePoll(p);
    if (!v.ok) return ack({ ok: false, error: v.error, status: 400 });
    if (hasFilteredWord(v.value.question) || v.value.options.some(hasFilteredWord)) return ack({ ok: false, error: 'Please reword the poll.', status: 400 });
    // batch C: a poll can live in a thread (reply to a top-level line)
    let parentId: string | null = null;
    const rawParent = (p as { parentId?: unknown })?.parentId;
    if (rawParent) {
      const parent = repo.messageById(String(rawParent));
      if (!parent || parent.deleted || parent.room_id !== room.id || parent.parent_id || parent.burn_ttl != null) return ack({ ok: false, error: 'Thread not found', status: 404 });
      parentId = parent.id;
    }
    if (!pollRl.take()) return ack({ ok: false, error: 'Too many polls. Try again in a few minutes.', status: 429 });
    const stored = postPoll(room, {
      fromId: socket.id, nick: s.user!.nick, role: s.user!.role, userId: s.account?.id ?? null, profile: profileOf(s.account),
      key: pollVoterKeys(s)[0] ?? repo.userKey(identOf(s)), ip: s.ip, device: s.deviceIds[0] ?? null,
    }, v.value.question, v.value.options, v.value.durationMin ?? null, parentId);
    room.lastChatAt.set(socket.id, Date.now());
    ack({ ok: true, poll: pollInfo(stored, s) });
  });
  socket.on('poll:vote', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Slow down', status: 429 });
    const row = repo2.pollById(String(p?.pollId ?? ''));
    if (!row || row.room_id !== c.room.id) return ack({ ok: false, error: 'Poll not found', status: 404 });
    const msgRow = repo.messageById(row.message_id);
    if (!msgRow || msgRow.deleted) return ack({ ok: false, error: 'Poll not found', status: 404 });
    if (row.closed_at != null || (row.closes_at != null && row.closes_at <= Date.now())) return ack({ ok: false, error: 'This poll is closed', status: 409 });
    let n = 0;
    try { n = (JSON.parse(row.options) as string[]).length; } catch { /* none */ }
    const option = Number(p?.option);
    if (!Number.isInteger(option) || option < 0 || option >= n) return ack({ ok: false, error: 'Pick one of the options', status: 400 });
    const key = pollVoterKeys(c.s)[0];
    if (!key) return ack({ ok: false, error: 'Voting needs an account or a device id', status: 401 });
    repo2.castPollVote(row.id, key, option);
    io.to(`room:${c.room.id}`).emit('poll:update', { poll: pollInfo(row) });
    ack({ ok: true, poll: pollInfo(row, c.s) });
  });
  socket.on('poll:close', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const row = repo2.pollById(String(p?.pollId ?? ''));
    if (!row || row.room_id !== c.room.id) return ack({ ok: false, error: 'Poll not found', status: 404 });
    const creator = pollVoterKeys(c.s).includes(row.created_by_key) || (c.s.account != null && row.created_by_user === c.s.account.id);
    if (!creator && !canRoomManage(c.s, c.room)) return ack({ ok: false, error: 'Only the poll creator or a moderator can close it', status: 403 });
    if (row.closed_at != null) return ack({ ok: false, error: 'This poll is already closed', status: 409 });
    const fresh = closePollNow(row.id, c.s.user!.nick)!;
    ack({ ok: true, poll: pollInfo(fresh, c.s) });
  });

  // ================= batch 3 =================
  // ---- 1. category + tags (owner / site staff) ----
  /** batch C: browse page. Only open rooms: never private calls or password rooms. */
  socket.on('rooms:discover', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const s = session();
    if (!s.user) return ack({ ok: false, error: 'Sign in first' });
    if (!discoverRl.take(s.ip)) return ack({ ok: false, error: 'Slow down' });
    const sort = isDiscoverSort(p?.sort) ? p!.sort! : 'trending';
    const cat = typeof p?.category === 'string' && p.category ? p.category : null;
    const tag = typeof p?.tag === 'string' && p.tag ? p.tag.toLowerCase().slice(0, 24) : null;
    const needle = typeof p?.q === 'string' ? p.q.trim().toLowerCase().slice(0, 40) : '';
    const members = repo7.roomMemberCounts();
    const trend = repo7.roomMessageTrend();
    const created = new Map(repo.allRooms().map((r) => [r.id, r.created_at]));
    const open = [...rooms.values()].filter((r) => !r.isPrivate && !r.passwordHash && !r.callPeers && (r.persistent || r.members.size > 0));
    const all: DiscoverRoom[] = open.map((r) => {
      const sm = summary(r);
      const t = trend.get(r.id) ?? { day: 0, prev: 0 };
      return {
        id: r.id, name: r.name, topic: r.topic, category: r.category, tags: r.tags, users: sm.users, members: members.get(r.id) ?? 0,
        messages24h: t.day, trending: trendingScore(sm.users, t.day, t.prev), ...(r.voice ? { voice: true } : {}),
        ...(sm.thumbUrl ? { thumbUrl: sm.thumbUrl } : {}), ...(sm.iconUrl ? { iconUrl: sm.iconUrl } : {}), createdAt: created.get(r.id) ?? 0,
      };
    });
    const categories = new Map<string, number>(); const tags = new Map<string, number>();
    for (const r of all) { if (r.category) categories.set(r.category, (categories.get(r.category) ?? 0) + 1); for (const t of r.tags) tags.set(t, (tags.get(t) ?? 0) + 1); }
    let list = all.filter((r) => (!cat || r.category === cat) && (!tag || r.tags.includes(tag)) && (!needle || r.name.toLowerCase().includes(needle) || r.topic.toLowerCase().includes(needle) || r.tags.some((t) => t.includes(needle))));
    const by: Record<string, (a: DiscoverRoom, b: DiscoverRoom) => number> = {
      trending: (a, b) => b.trending - a.trending || b.users - a.users,
      members: (a, b) => b.members - a.members || b.users - a.users,
      active: (a, b) => b.users - a.users || b.messages24h - a.messages24h,
      new: (a, b) => b.createdAt - a.createdAt,
    };
    list = list.sort((a, b) => by[sort](a, b) || a.name.localeCompare(b.name)).slice(0, 60);
    ack({
      ok: true, rooms: list, sort,
      trending: [...all].sort(by.trending).filter((r) => r.trending > 0).slice(0, 5),
      categories: [...categories].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      tags: [...tags].map(([t, count]) => ({ tag: t, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 30),
    });
  });
  const capTimes: number[] = [];
  socket.on('caption:send', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error });
    const { s, room } = c;
    if (!room.voice) return ack({ ok: false, error: 'Live captions are for voice rooms' });
    const now = Date.now();
    while (capTimes.length && now - capTimes[0] > 1000) capTimes.shift();
    if (capTimes.length >= 8) return ack({ ok: false, error: 'Slow down' });
    capTimes.push(now);
    const text = typeof p?.text === 'string' ? p.text.replace(/\s+/g, ' ').trim().slice(-300) : '';
    if (!text) return ack({ ok: true });
    socket.to(`room:${room.id}`).emit('caption', { roomId: room.id, id: socket.id, nick: s.user!.nick, text, final: !!p?.final, ts: now });
    ack({ ok: true });
  });
  socket.on('rec:start', (_p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    if (!s.account || room.ownerUserId !== s.account.id) return ack({ ok: false, error: 'Only the room owner can record', status: 403 });
    if (!room.voice || room.isPrivate) return ack({ ok: false, error: 'Recording is for voice rooms', status: 400 });
    if (recs.activeRec(room.id)) return ack({ ok: false, error: 'Already recording', status: 409 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const r = recs.startRec(room.id, s.account.id, s.user!.nick);
    const rec = recStateOf(room.id)!;
    repo.logAction(actorLabel(s), s.account.id, 'recording-start', null, room.id, r.id);
    io.to(`room:${room.id}`).emit('rec:state', { roomId: room.id, rec });
    systemMsg(room, `🔴 ${s.user!.nick} started recording this room (leave if you don't want to be recorded)`);
    ack({ ok: true, rec, maxBytes: recs.REC_MAX_BYTES });
  });
  socket.on('rec:stop', (_p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    const r = recs.activeRec(room.id);
    if (!r) return ack({ ok: true });
    if (!isStaff(s) && s.account?.id !== room.ownerUserId) return ack({ ok: false, error: 'Only the room owner can stop it', status: 403 });
    recs.endRec(r.id, 'done', 'stop');
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'recording-stop', null, room.id, r.id);
    recEnded(room.id, s.user!.nick, 'stop');
    ack({ ok: true });
  });
  socket.on('room:voice', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    if (room.isPrivate) return ack({ ok: false, error: 'Private calls cannot be voice rooms', status: 400 });
    if (!isStaff(s) && !isOwner(s, room)) return ack({ ok: false, error: 'Only the room owner can change this', status: 403 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const on = !!p?.on;
    if (on !== room.voice) {
      room.voice = on;
      repo.setRoomVoice(room.id, on);
      if (!on && !room.stage.on) room.stage.hands.clear();
      { const r = recs.activeRec(room.id); if (!on && r) { recs.endRec(r.id, 'done', 'voiceoff'); recEnded(room.id, r.started_nick, 'voiceoff'); } }
      repo.logAction(actorLabel(s), s.account?.id ?? null, on ? 'voice-on' : 'voice-off', null, room.id, null);
      systemMsg(room, on ? `${s.user!.nick} made this a voice room: audio only, raise your hand to take the floor` : `${s.user!.nick} turned off voice-room mode`);
      if (on) {
        // cameras and screen shares stop; mics stay on
        for (const id of room.members) {
          const m = sessions.get(id);
          if (m?.user && (m.user.cam || m.user.screen)) {
            m.user = { ...m.user, cam: false, screen: false };
            io.to(`room:${room.id}`).emit('user:updated', m.user);
            io.to(id).emit('media:force', { cam: false, screen: false });
          }
        }
      }
      io.to(`room:${room.id}`).emit('room:voice', { on });
      emitStage(room);
      broadcastRooms();
    }
    ack({ ok: true, on });
  });
  socket.on('room:meta', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    if (room.isPrivate) return ack({ ok: false, error: 'Private calls have no category', status: 400 });
    if (!isStaff(s) && !isOwner(s, room)) return ack({ ok: false, error: 'Only the room owner can change the category and tags', status: 403 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const meta = roomMetaInput(p?.category, p?.tags);
    if ('error' in meta) return ack({ ok: false, error: meta.error, status: 400 });
    room.category = meta.category;
    room.tags = meta.tags;
    repo3.setRoomMeta(room.id, meta.category, meta.tags);
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'room-meta', null, room.id, `${meta.category ?? '-'} ${meta.tags.join(',')}`);
    io.to(`room:${room.id}`).emit('room:meta', { category: meta.category, tags: meta.tags });
    broadcastRooms();
    ack({ ok: true, category: meta.category, tags: meta.tags });
  });

  // ---- 3a. announcement banner (owner / staff / room mods) ----
  socket.on('room:theme:set', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    if (room.isPrivate) return ack({ ok: false, error: 'Private calls have no theme', status: 400 });
    if (!isStaff(s) && !isOwner(s, room)) return ack({ ok: false, error: 'Only the room owner can change the theme', status: 403 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const patch: Partial<repo4.RoomTheme> = {};
    if (p && 'accent' in p) {
      if (p.accent == null || p.accent === '') patch.accent = null;
      else if (typeof p.accent !== 'string' || !THEME_ACCENT_RE.test(p.accent)) return ack({ ok: false, error: 'Pick a color like #39ff14', status: 400 });
      else if (!accentReadable(p.accent)) return ack({ ok: false, error: 'That color is too dark or too light to read', status: 400 });
      else patch.accent = p.accent.toLowerCase();
    }
    if (p && 'welcome' in p) {
      const raw = typeof p.welcome === 'string' ? p.welcome : '';
      if (raw.trim().length > THEME_WELCOME_MAX) return ack({ ok: false, error: `Max ${THEME_WELCOME_MAX} characters`, status: 400 });
      const text = maskWords(cleanText(raw, THEME_WELCOME_MAX));
      patch.welcome = text || null;
    }
    repo4.setRoomTheme(room.id, patch);
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'room-theme', null, room.id, JSON.stringify(patch).slice(0, 160));
    const theme = themeOf(room);
    io.to(`room:${room.id}`).emit('room:theme', { theme });
    ack({ ok: true, theme });
  });
  socket.on('announce:set', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    if (!canRoomManage(s, room)) return ack({ ok: false, error: 'Only the room owner or a moderator can set the announcement', status: 403 });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const raw = typeof p?.text === 'string' ? p.text : '';
    if (raw.trim().length > ANNOUNCE_MAX) return ack({ ok: false, error: `Max ${ANNOUNCE_MAX} characters`, status: 400 });
    const text = maskWords(cleanText(raw, ANNOUNCE_MAX));
    room.announcement = text ? { text, at: Date.now(), by: s.user!.nick } : null;
    repo3.setAnnouncement(room.id, text || null, s.user!.nick);
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'announcement', null, room.id, text ? text.slice(0, 120) : '(cleared)');
    io.to(`room:${room.id}`).emit('room:announcement', { announcement: room.announcement });
    ack({ ok: true, announcement: room.announcement });
  });

  // ---- 3b. scheduled messages ----
  const scheduleRl = new RateLimiter(20, 10 * 60_000);
  const scheduleGate = () => {
    const c = roomCtx();
    if ('error' in c) return c;
    if (!canRoomManage(c.s, c.room)) return { error: 'Only the room owner or a moderator can schedule messages', status: 403 };
    if (c.room.isPrivate) return { error: 'Private calls cannot schedule messages', status: 400 };
    return c;
  };
  socket.on('schedule:list', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = scheduleGate();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    ack({ ok: true, schedules: repo3.schedulesForRoom(c.room.id).map(scheduleInfo) });
  });
  socket.on('schedule:create', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = scheduleGate();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    const raw = typeof p?.text === 'string' ? p.text : '';
    if (raw.trim().length > SCHEDULE_TEXT_MAX) return ack({ ok: false, error: `Max ${SCHEDULE_TEXT_MAX} characters`, status: 400 });
    const isPoll = p?.kind === 'poll';
    let pollSpec: string | null = null;
    if (isPoll) {
      const v = validatePoll({ question: raw, options: (p as { poll?: { options?: unknown } }).poll?.options, durationMin: (p as { poll?: { durationMin?: unknown } }).poll?.durationMin ?? null });
      if (!v.ok) return ack({ ok: false, error: v.error, status: 400 });
      if (hasFilteredWord(v.value.question) || v.value.options.some(hasFilteredWord)) return ack({ ok: false, error: 'Please reword the poll.', status: 400 });
      pollSpec = JSON.stringify({ options: v.value.options.map(maskWords), durationMin: v.value.durationMin ?? null });
    }
    const text = maskWords(cleanText(raw, SCHEDULE_TEXT_MAX));
    if (!text) return ack({ ok: false, error: 'Write the message first', status: 400 });
    if (!isScheduleRepeat(p?.repeat)) return ack({ ok: false, error: 'Repeat must be once, daily or weekly', status: 400 });
    const at = Number(p?.at);
    const now = Date.now();
    if (!Number.isFinite(at) || at <= now) return ack({ ok: false, error: 'Pick a time in the future', status: 400 });
    if (at > now + SCHEDULE_MAX_AHEAD_MS) return ack({ ok: false, error: 'Pick a time within a year', status: 400 });
    if (repo3.scheduleCount(room.id) >= SCHEDULES_PER_ROOM) return ack({ ok: false, error: `A room can have at most ${SCHEDULES_PER_ROOM} scheduled messages`, status: 409 });
    if (!scheduleRl.take()) return ack({ ok: false, error: 'Too many scheduled messages. Try again later.', status: 429 });
    const tz = isValidTimeZone(p?.tz) ? p!.tz! : null;
    const row = {
      kind: p?.kind === 'banner' ? 'banner' : isPoll ? 'poll' : 'message', poll: pollSpec,
      id: randomUUID(), room_id: room.id, text, repeat: p!.repeat as 'once' | 'daily' | 'weekly', next_at: Math.round(at), tz,
      created_by_user: s.account?.id ?? null, created_by_nick: s.user!.nick, created_at: now,
    };
    repo3.insertSchedule(row);
    repo.logAction(actorLabel(s), s.account?.id ?? null, 'schedule-add', null, room.id, `${row.repeat} ${new Date(row.next_at).toISOString()}`);
    emitSchedules(room);
    ack({ ok: true, schedule: scheduleInfo({ ...row, last_posted_at: null }) });
  });
  socket.on('schedule:delete', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = scheduleGate();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (limited(actRl, ipAct)) return ack({ ok: false, error: 'Rate limited', status: 429 });
    const row = repo3.scheduleById(String(p?.id ?? ''));
    if (!row || row.room_id !== c.room.id) return ack({ ok: false, error: 'Scheduled message not found', status: 404 });
    repo3.deleteSchedule(row.id);
    repo.logAction(actorLabel(c.s), c.s.account?.id ?? null, 'schedule-remove', null, c.room.id, row.text.slice(0, 80));
    emitSchedules(c.room);
    ack({ ok: true });
  });

  // ---- 2. radio now playing ----
  const radioRl = new RateLimiter(20, 60_000);
  socket.on('radio:listen', async (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    if (!radioRl.take()) return ack({ ok: false, error: 'Slow down', status: 429 });
    const on = !!p?.on;
    if (on) { radioOn.add(socket.id); socket.join('radio'); } else { radioOn.delete(socket.id); socket.leave('radio'); }
    syncRadioPolling();
    const s = session();
    const room = s.roomId ? rooms.get(s.roomId) : undefined;
    if (room && room.members.has(socket.id)) radioRoomPing(room);
    ack({ ok: true, np: on ? await getNowPlaying() : null });
  });
  socket.on('radio:get', async (ackRaw) => {
    const ack = safeAck(ackRaw);
    if (!radioRl.take()) return ack({ ok: false, error: 'Slow down', status: 429 });
    ack({ ok: true, np: await getNowPlaying() });
  });
  socket.on('disconnect', () => {
    if (!radioOn.delete(socket.id)) return;
    syncRadioPolling();
    const s = sessions.get(socket.id);
    const room = s?.roomId ? rooms.get(s.roomId) : undefined;
    if (room) radioRoomPing(room);
  });

  // ---- 4. clip recorder (client-only recording; the server only announces it) ----
  const clipRl = new RateLimiter(3, 30_000);
  socket.on('clip:saved', (p, ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    const { s, room } = c;
    const targetId = String(p?.userId ?? '');
    const t = targetId === socket.id ? s : room.members.has(targetId) ? sessions.get(targetId) : undefined;
    if (!t?.user) return ack({ ok: false, error: 'That stream is not in this room', status: 404 });
    if (!t.user.cam && !t.user.screen) return ack({ ok: false, error: 'That person is not streaming', status: 409 });
    if (!clipRl.take()) return ack({ ok: false, error: 'Slow down', status: 429 });
    systemMsg(room, t === s ? `${s.user!.nick} clipped their own stream` : `${s.user!.nick} clipped ${t.user.nick}'s stream`);
    ack({ ok: true });
  });

  // ---- 5. room stats (owner / staff / room mods) ----
  const statsRl = new RateLimiter(20, 60_000);
  socket.on('stats:analytics', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (!canRoomManage(c.s, c.room)) return ack({ ok: false, error: 'Only the room owner or a moderator can see analytics', status: 403 });
    if (c.room.isPrivate) return ack({ ok: false, error: 'Private calls have no stats', status: 400 });
    if (!statsRl.take()) return ack({ ok: false, error: 'Slow down', status: 429 });
    statsSample();
    ack({ ok: true, analytics: repo8.roomAnalytics(c.room.id), serverNow: Date.now() });
  });
  socket.on('stats:get', (ackRaw) => {
    const ack = safeAck(ackRaw);
    const c = roomCtx();
    if ('error' in c) return ack({ ok: false, error: c.error, status: c.status });
    if (!canRoomManage(c.s, c.room)) return ack({ ok: false, error: 'Only the room owner or a moderator can see stats', status: 403 });
    if (c.room.isPrivate) return ack({ ok: false, error: 'Private calls have no stats', status: 400 });
    if (!statsRl.take()) return ack({ ok: false, error: 'Slow down', status: 429 });
    const now = Date.now();
    statsSample();
    ack({
      ok: true,
      stats: {
        hours: repo3.statsHours(c.room.id, (repo3.dayOf(now) - 29) * 24),
        d7: repo3.statsWindow(c.room.id, 7, now), d30: repo3.statsWindow(c.room.id, 30, now), serverNow: now,
      },
    });
  });

  if (crashTestHooks) {
    // Test-only (CAMCHAT_TEST_CRASH_HOOKS=1): prove a failing handler cannot crash the process.
    (socket as unknown as { on: (ev: string, fn: (...a: unknown[]) => unknown) => void }).on('test:throw', (p: unknown, ack: unknown) => {
      const mode = (p as { mode?: unknown } | null)?.mode;
      if (mode === 'async') return Promise.reject(new Error('test:throw async failure'));
      if (mode === 'timer') { setTimeout(guardTimer('test:throw timer', () => { throw new Error('test:throw timer failure'); }), 10); safeAck(ack)({ ok: true }); return; }
      throw new Error('test:throw sync failure');
    });
  }
}

// ---------- maintenance ----------
function runPrune() {
  try {
    const r = repo.prune();
    try { repo.pruneEdits(); } catch (err) { console.error('[prune] edit history failed', (err as Error).message); }
    try { const n = repo5.pruneWhispers(); if (n) console.log(`[prune] removed ${n} old whisper line(s)`); } catch (err) { console.error('[prune] whispers', (err as Error).message); }
    if (r.messages || r.sessions) console.log(`[prune] removed ${r.messages} old messages, ${r.sessions} expired sessions`);
  } catch (err) { console.error('[prune] failed', err); }
  const t = Date.now();
  for (const [k, until] of camBlocks) if (until < t) camBlocks.delete(k);
  try {
    const n = sweepVoiceNotes();
    if (n) console.log(`[prune] removed ${n} orphaned voice note(s)`);
    const imgs = sweepChatImages();
    if (imgs) console.log(`[prune] removed ${imgs} orphaned chat image(s)`);
    const thumbs = sweepRoomThumbs(new Set([...[...rooms.values()].map((r) => r.thumbId), ...repo4.allBannerIds()].filter((x): x is string => !!x)));
    if (thumbs) console.log(`[prune] removed ${thumbs} orphaned room thumbnail(s)`);
    try { const n = invites.prune(); if (n) console.log(`[prune] removed ${n} dead invite link(s)`); } catch (err) { console.error('[prune] invites', (err as Error).message); }
    const icons = sweepRoomIcons(new Set([...rooms.values()].map((r) => r.iconId).filter((x): x is string => !!x)));
    if (icons) console.log(`[prune] removed ${icons} orphaned room icon(s)`);
  } catch (err) { console.error('[prune] voice/image sweep failed', err); }
  try {
    repo2.prune2();
    const ev = repo2.pruneEvents(Date.now() - EVENT_KEEP_PAST_MS);
    if (ev) console.log(`[prune] removed ${ev} past event(s)`);
  } catch (err) { console.error('[prune] batch-2 sweep failed', err); }
  try {
    repo3.pruneStats();
    const em = sweepEmoteFiles(repo3.allEmoteIds());
    if (em) console.log(`[prune] removed ${em} orphaned emote file(s)`);
  } catch (err) { console.error('[prune] batch-3 sweep failed', err); }
}
guardTimer('prune', runPrune)();
setInterval(guardTimer('prune', runPrune), 10 * 60_000).unref();
setInterval(guardTimer('lobby activity', activityTick), ACTIVITY_TICK_MS).unref();
guardTimer('burn sweep', sweepBurns)();
setInterval(guardTimer('air badge flush', () => { for (const [sid, s] of sessions) if (s.airSince != null) airTrack(sid, s); }), Math.max(200, Number(process.env.BADGE_AIR_FLUSH_MS) || 60_000)).unref();
setInterval(guardTimer('burn sweep', sweepBurns), Math.min(30_000, Math.max(250, Math.floor(BURN_HARD / 4)))).unref();
guardTimer('event tick', eventTick)();
setInterval(guardTimer('event tick', eventTick), EVENT_TICK).unref();
guardTimer('poll sweep', sweepPolls)();
initBackups();
setInterval(guardTimer('poll sweep', sweepPolls), 10 * 60_000).unref();
guardTimer('schedule tick', scheduleTick)();
setInterval(guardTimer('schedule tick', scheduleTick), SCHEDULE_TICK).unref();
setInterval(guardTimer('stats sample', statsSample), STATS_SAMPLE_MS).unref();


restoreBotJoins();
httpServer.listen(PORT, HOST as string, () => {
  console.log(`${BRAND_NAME} listening on http://${HOST ?? 'localhost'}:${PORT} (${isProd ? 'production' : 'development'}), data in ${DATA_DIR}`);
  if (!TURN_URLS.length) console.log('No TURN_URLS set - using STUN only (some NATs will fail to connect).');
  else console.log(`TURN: ${TURN_SECRET ? 'time-limited credentials (use-auth-secret)' : 'static credentials'} for ${TURN_URLS.join(', ')}`);
});

function shutdown() {
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
