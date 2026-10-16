import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useTileFit } from '../useTileFit';
import { APP_NAME, LIMITS } from '../../shared/config';
import type { ChatMessage, RoomState, RoomSummary, SignalData, UserInfo, WatchState, WhisperInfo, WhisperMessage } from '../../shared/types';
import { WHISPER_MAX_MEMBERS } from '../../shared/whisper';
import { Mesh, unlockAudio } from '../rtc';
import { applyAudioOutputToDocument, audioConstraints, loadStoredDevices } from '../mediaDevices';
import { LocalSpeakingMonitor, RemoteSpeakingMonitor } from '../speaking';
import { call, getIceServers, socket } from '../socket';
import { fmtTime, unreadBadge } from '../util';
import { readRoomLocally } from '../mentions';
import { storedDeviceId } from '../api';
import { BAN_DURATIONS, Dialog, DialogSpec } from './Dialog';
import { NotifyDialog } from './NotifyDialog';
import { RoomThemeHeader, RoomThemeSettings } from './RoomTheme';
import type { RoomThemeInfo } from '../../shared/theme';
import type { PmTarget } from './PmDock';
import { SiteBar } from './SiteBar';
import { RoleTag } from './RoleTag';
import { WhisperStrip, whisperLabel, type WhisperConv } from './WhisperStrip';
import { ReportDialog, type ReportTarget } from './ReportDialog';
import { setRoomCounts, useRoomCounts } from '../modq';
import { VoiceNoteButton, VoicePlayer } from './VoiceNote';
import { BurnBody, BurnToggle, BURN_DEFAULT_TTL } from './Burn';
import { BadgeCard, BadgeIcons, badgeLabel } from './Badges';
import { fxShowEnabled, fxSoundEnabled, playFxSound, prefersReducedMotion, runFx, stopFx } from '../fx';
import { fxById, fxSlashCommand, isFxId, type FxId } from '../../shared/fx';
import type { BurnTtl } from '../../shared/burn';
import { ChatText } from './ChatText';
import { EmojiPicker } from './EmojiPicker';
import { GifPicker } from './GifPicker';
import { REACTION_EMOJIS } from '../../shared/reactions';
import { NameStylePicker } from './NameStylePicker';
import { RadioPlayer } from './RadioPlayer';
import { GamesButton, GamesSlot } from './GamesSlot';
import { Icon, IconAction, type IconName } from '../icons';
import { clampDockGhost, DEFAULT_PEOPLE_SPLIT, DEFAULT_SPLIT, dockWide, loadDock, loadPeopleSplit, loadSplit, loadUnwatch, saveDock, savePeopleSplit, saveSplit, saveUnwatch, splitFits, type DockItem } from '../docks';
import { loadSoundVolume, playSoundClip } from '../soundboard';
import type { SoundClip } from './SoundsPanel';
import type { Account } from '../App';
import { NickLabel, UserAvatar } from './UserAvatar';
import { VideoTile } from './VideoTile';
import { decideShareAudio } from '../../shared/shareAudio';
import type { BookmarkEntry, LinkPreviewInfo, PollInfo, RoomEventInfo, RoomModInfo, SearchHit } from '../../shared/types';
import { EVENT_SOON_MS, eventEnd } from '../../shared/events';
import { parsePollCommand } from '../../shared/polls';
import { EventBanner } from './EventBanner';
import { PollCard, PollDialog } from './PollCard';
import { LinkPreviewCard } from './LinkPreviewCard';
import { RoomThumbEditor } from './RoomThumb';
import { RoomIconMini } from './RoomIcon';
import { RoomIconEditor } from './RoomIconEditor';
import type { RoomAnnouncement, RoomEmote, RoomScheduleInfo } from '../../shared/types';
import { EmoteContext, emoteMap } from '../emotes';
import { refreshRadio, useRadio } from '../radioState';
import { NowPlayingCard } from './NowPlaying';
import { AnnouncementBanner } from './AnnouncementBanner';
import { CategoryTag, TagList } from './RoomMeta';
import { Lazy, lazyNamed } from '../lazy';
import { useEscape, useModal } from '../a11y';
import { captureConstraints, isVideoQuality, type ShareMode, type VideoQuality, type ViewPref } from '../../shared/videoQuality';
import { loadQuality, loadShareMode, saveQuality, saveShareMode, storedQuality } from '../vqPrefs';
import { api } from '../api';
import { STAGE_CAP_CHOICES, STAGE_OFF, type StageState } from '../../shared/stage';
import { loadBg, loadNoise, rawTrack, saveBg, saveNoise, trackProcessors, type BgPref, type NoisePref } from '../bgPrefs';

// Panels most visits never open load on demand. The whiteboard is always mounted, so start its fetch now.
const loadBoard = () => import('./Whiteboard');
void loadBoard().catch(() => {});
const Whiteboard = lazyNamed(loadBoard, 'Whiteboard');
const WatchPanel = lazyNamed(() => import('./WatchPanel'), 'WatchPanel');
const FxPanel = lazyNamed(() => import('./FxPanel'), 'FxPanel');
const AvSettings = lazyNamed(() => import('./AvSettings'), 'AvSettings');
const loadInvites = () => import('./InvitePanel');
const InvitePanel = lazyNamed(loadInvites, 'InvitePanel');
const SoundsPanel = lazyNamed(() => import('./SoundsPanel'), 'SoundsPanel');
const SearchPanel = lazyNamed(() => import('./SearchPanel'), 'SearchPanel');
const SavedPanel = lazyNamed(() => import('./SearchPanel'), 'SavedPanel');
const ProfileCard = lazyNamed(() => import('./ProfileCard'), 'ProfileCard');
const loadManage = () => import('./RoomManage');
const ModQueue = lazyNamed(() => import('./ModQueue'), 'ModQueue');
const RoomMetaEditor = lazyNamed(loadManage, 'RoomMetaEditor');
const AnnouncementEditor = lazyNamed(loadManage, 'AnnouncementEditor');
const SchedulePanel = lazyNamed(loadManage, 'SchedulePanel');
const EmoteManager = lazyNamed(loadManage, 'EmoteManager');
const StatsPanel = lazyNamed(loadManage, 'StatsPanel');
const FiltersPanel = lazyNamed(loadManage, 'FiltersPanel');
const EventsPanel = lazyNamed(() => import('./EventsPanel'), 'EventsPanel');
const panelFallback = <p className="muted small" aria-busy="true">Loading…</p>;

/** Display audio is program sound: no echo cancellation, noise suppression, or AGC. */
const SHARE_AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function mediaPeerIds(list: UserInfo[], selfId: string): string[] {
  return list.filter((u) => u.id !== selfId && !u.id.startsWith('bot:')).map((u) => u.id);
}

function playMentionPing() {
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  try {
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    const stopAt = ctx.currentTime + 0.12;
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    osc.stop(stopAt);
    osc.onended = () => { void ctx.close(); };
  } catch { /* tab blocked autoplay */ }
}

interface Props {
  me: UserInfo;
  initial: RoomState;
  onLeave: () => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
  ignored: Set<string>;
  toggleIgnore: (nick: string) => void;
  openPm: (t: PmTarget) => void;
  gifs?: boolean;
  /** Remember the secret locally so a reconnect can rejoin. Never display it. */
  onPasswordChange?: (password: string) => void;
  /** Registered account, when the composer should offer name color and effect. */
  account?: Account | null;
  onAccount?: (a: Account) => void;
  onGames: () => void;
  unread?: { n: number; mention: boolean };
  /** unread counts for other rooms (room rail badges) */
  unreadMap?: Record<string, { n: number; mention: boolean }>;
  onJoined: (r: RoomState, password?: string) => void;
  signOut: () => void;
  openAdmin: () => void;
  wantAccount: (m: 'signin' | 'register') => void;
}

const rank = { guest: 0, user: 1, moderator: 2, admin: 3 } as const;


function MoreItem({
  icon, label, title, className = '', ...rest
}: { icon: IconName; label: string; title: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" role="menuitem" {...rest} className={`more-item${className ? ` ${className}` : ''}`} title={title} aria-label={title}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayLabel(ts: number) {
  const d = new Date(ts);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Slow mode picker in the room settings (owner / site staff). */
function SlowModeRow({ seconds, canSet, toast }: { seconds: number; canSet: boolean; toast: (t: string, tone?: 'error' | 'info') => void }) {
  const opts = [0, 5, 10, 30, 60, 120, 300];
  return (
    <label className="muted small slow-row">Slow mode{' '}
      <select value={opts.includes(seconds) ? seconds : 0} disabled={!canSet} data-field="slow-mode"
        onChange={(e) => { const v = Number(e.target.value); call((ack) => socket.emit('room:slowmode', { seconds: v }, ack)).catch((err: Error) => toast(err.message, 'error')); }}>
        {opts.map((o) => <option key={o} value={o}>{o === 0 ? 'Off' : o < 60 ? `${o} seconds` : `${o / 60} minute${o === 60 ? '' : 's'}`}</option>)}
      </select>
      {!canSet && <span> (owner only)</span>}
    </label>
  );
}

export function Room({ me, initial, onLeave, toast, ignored, toggleIgnore, openPm, gifs, onPasswordChange, account, onAccount, onGames, unread, unreadMap, onJoined, signOut, openAdmin, wantAccount }: Props) {
  const [users, setUsers] = useState<UserInfo[]>(initial.users);
  const [messages, setMessages] = useState<ChatMessage[]>(initial.history);
  // "New messages" divider: first line from someone else after this account's read marker (set when the room opened)
  const [firstUnreadId] = useState<string | null>(() => {
    const since = initial.lastReadTs;
    if (since == null) return null;
    const m = initial.history.find((x) => x.kind === 'chat' && !x.parentId && x.ts > since && x.fromId !== me.id && !(me.accountId != null && x.accountId === me.accountId));
    return m?.id ?? null;
  });
  // move the server read marker forward while this room is in view
  useEffect(() => {
    if (!me.accountId) return;
    let t: number | undefined;
    const mark = () => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(t);
      t = window.setTimeout(() => { socket.emit('room:read', { roomId: initial.id }); readRoomLocally(initial.id); }, 600);
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => { window.clearTimeout(t); window.removeEventListener('focus', mark); document.removeEventListener('visibilitychange', mark); };
  }, [initial.id, me.accountId, messages.length]);
  const [topic, setTopic] = useState(initial.topic);
  const [thumbUrl, setThumbUrl] = useState<string | null>(initial.thumbUrl ?? null);
  const [iconUrl, setIconUrl] = useState<string | null>(initial.iconUrl ?? null);
  const [category, setCategory] = useState<string | null>(initial.category ?? null);
  const [tags, setTags] = useState<string[]>(initial.tags ?? []);
  const [announcement, setAnnouncement] = useState<RoomAnnouncement | null>(initial.announcement ?? null);
  const [theme, setTheme] = useState<RoomThemeInfo | null>(initial.theme ?? null);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const welcomeKey = `zn.welcomeHidden.${initial.id}`;
  const [welcomeHidden, setWelcomeHidden] = useState<string | null>(() => { try { return localStorage.getItem(welcomeKey); } catch { return null; } });
  const [emotes, setEmotes] = useState<RoomEmote[]>(initial.emotes ?? []);
  const emoteByName = useMemo(() => new Map(emotes.map((e) => [e.name, e])), [emotes]);
  const [reactPick, setReactPick] = useState<string | null>(null);
  useEffect(() => {
    if (!reactPick) return;
    const off = () => setReactPick(null);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') off(); };
    document.addEventListener('click', off);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', off); document.removeEventListener('keydown', esc); };
  }, [reactPick]);
  const emoteLookup = useMemo(() => emoteMap(emotes), [emotes]);
  const [schedules, setSchedules] = useState<RoomScheduleInfo[]>([]);
  const [radioHere, setRadioHere] = useState(initial.radioHere ?? 0);
  const radio = useRadio();
  const [editingTopic, setEditingTopic] = useState<string | null>(null);
  const [streams, setStreams] = useState<Record<string, MediaStream | null>>({});
  /** remote screen-share audio, separate from the cam/mic stream */
  const [shareAudio, setShareAudio] = useState<Record<string, MediaStream | null>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [cam, setCam] = useState(false);
  const [mic, setMic] = useState(false);
  const [screen, setScreen] = useState(false);
  const [mutedIds, setMutedIds] = useState<Set<string>>(new Set());
  const [bigId, setBigId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [blockFor, setBlockFor] = useState<string | null>(null);
  const [whispers, setWhispers] = useState<Record<string, WhisperConv>>({});
  const [openWhisper, setOpenWhisper] = useState<string | null>(null);
  const openWhisperRef = useRef<string | null>(null);
  openWhisperRef.current = openWhisper;
  const ignoredRef = useRef(ignored);
  ignoredRef.current = ignored;
  useEffect(() => {
    const onUpdate = ({ whisper }: { whisper: WhisperInfo }) =>
      setWhispers((cur) => ({ ...cur, [whisper.id]: { info: whisper, messages: cur[whisper.id]?.messages ?? [], unread: cur[whisper.id]?.unread ?? 0 } }));
    const onMessage = (m: WhisperMessage) => setWhispers((cur) => {
      const c = cur[m.whisperId];
      if (!c) return cur;
      const hidden = m.fromId !== socket.id && ignoredRef.current.has(m.from.toLowerCase());
      const unread = openWhisperRef.current === m.whisperId || m.fromId === socket.id || hidden ? c.unread : c.unread + 1;
      return { ...cur, [m.whisperId]: { ...c, messages: [...c.messages, m].slice(-200), unread } };
    });
    const onEnded = ({ whisperId, reason }: { whisperId: string; reason: 'ended' | 'left' }) => {
      setWhispers((cur) => { const n = { ...cur }; delete n[whisperId]; return n; });
      setOpenWhisper((o) => (o === whisperId ? null : o));
      if (reason === 'ended') toast('Whisper ended - everyone else left', 'info');
    };
    socket.on('whisper:update', onUpdate);
    socket.on('whisper:message', onMessage);
    socket.on('whisper:ended', onEnded);
    return () => { socket.off('whisper:update', onUpdate); socket.off('whisper:message', onMessage); socket.off('whisper:ended', onEnded); };
  }, [toast]);
  useEffect(() => {
    if (openWhisper) setWhispers((cur) => (cur[openWhisper]?.unread ? { ...cur, [openWhisper]: { ...cur[openWhisper], unread: 0 } } : cur));
  }, [openWhisper, whispers]);
  const [boardOpen, setBoardOpen] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [peopleSide, setPeopleSide] = useState<'left' | 'right'>(() => {
    try { return localStorage.getItem(`${APP_NAME.toLowerCase()}.peopleSide`) === 'left' ? 'left' : 'right'; } catch { return 'right'; }
  });
  const togglePeopleSide = () => setPeopleSide((side) => {
    const next = side === 'left' ? 'right' : 'left';
    try { localStorage.setItem(`${APP_NAME.toLowerCase()}.peopleSide`, next); } catch { /* ignore */ }
    return next;
  });
  const [docks, setDocks] = useState(loadDock);
  const [wide, setWide] = useState(dockWide);
  const [dragOver, setDragOver] = useState<'stage' | 'rail' | null>(null);
  const [ghost, setGhost] = useState<{ item: DockItem; x: number; y: number } | null>(null);
  const [unwatched, setUnwatched] = useState(() => loadUnwatch(initial.id));
  useEffect(() => {
    const sync = () => setWide(dockWide());
    const wideQ = window.matchMedia('(min-width: 861px)');
    const shortQ = window.matchMedia('(max-width: 900px) and (max-height: 500px)');
    wideQ.addEventListener('change', sync);
    shortQ.addEventListener('change', sync);
    sync();
    return () => { wideQ.removeEventListener('change', sync); shortQ.removeEventListener('change', sync); };
  }, []);
  const [avOpen, setAvOpen] = useState(false);
  // ---- video quality ----
  const [vq, setVq] = useState<VideoQuality>(loadQuality);
  const vqRef = useRef(vq);
  vqRef.current = vq;
  // background effect + mic processing (this browser); the heavy code loads only when turned on
  const [bgPref, setBgPref] = useState<BgPref>(() => loadBg());
  const bgRef = useRef(bgPref);
  bgRef.current = bgPref;
  const [bgNote, setBgNote] = useState<string | null>(null);
  const [noisePref, setNoisePref] = useState<NoisePref>(() => loadNoise());
  const noiseRef = useRef(noisePref);
  noiseRef.current = noisePref;
  const [shareMode, setShareMode] = useState<ShareMode>(loadShareMode);
  /** own-tile note while Auto has stepped down */
  const [vqNotice, setVqNotice] = useState<string | null>(null);
  /** per-viewer receive preferences, by lowercased nick (this tab only) */
  const [viewPrefs, setViewPrefs] = useState<Record<string, ViewPref>>({});
  const [selfSpeaking, setSelfSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState<Record<string, boolean>>({});
  const [locked, setLocked] = useState(!!initial.locked);
  const [slowModeSec, setSlowModeSec] = useState(initial.slowModeSec || 0);
  const [passwordRequired, setPasswordRequired] = useState(!!initial.passwordRequired);
  const [pwOpen, setPwOpen] = useState(false);
  const [pwDraft, setPwDraft] = useState('');
  const [botsOpen, setBotsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [roomList, setRoomList] = useState<RoomSummary[]>([]);
  const [sideTab, setSideTab] = useState<'rooms' | 'info' | 'search' | 'saved' | 'events' | 'stats'>('rooms');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [stripCollapsed, setStripCollapsed] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [joinAsk, setJoinAsk] = useState<RoomSummary | null>(null);
  const [joinDraft, setJoinDraft] = useState('');
  const [fxOpen, setFxOpen] = useState(false);
  const [soundsOpen, setSoundsOpen] = useState(false);
  const [sounds, setSounds] = useState<SoundClip[]>(initial.sounds ?? []);
  useEffect(() => {
    const onList = (p: { sounds: SoundClip[] }) => setSounds(p.sounds);
    const onPlayed = (p: { id: string; name: string; by: string }) => {
      toast(`${p.by} played ${p.name}`);
      void playSoundClip(initial.id, p.id, loadSoundVolume()).catch(() => {});
    };
    socket.on('room:sounds', onList);
    socket.on('sound:played', onPlayed);
    return () => {
      socket.off('room:sounds', onList);
      socket.off('sound:played', onPlayed);
    };
  }, [initial.id, toast]);
  // ---- watch party ----
  const [watch, setWatch] = useState<WatchState | null>(initial.watch ?? null);
  const [watchLocked, setWatchLocked] = useState(!!initial.watchLocked);
  const [watchSkew, setWatchSkew] = useState(() => (initial.serverNow ? initial.serverNow - Date.now() : 0));
  const [watchOpen, setWatchOpen] = useState(!!initial.watch);
  useEffect(() => {
    const onWatch = (p: { watch: WatchState | null; locked: boolean; action: string; by: string; serverNow: number }) => {
      setWatchSkew(p.serverNow - Date.now());
      setWatch(p.watch);
      setWatchLocked(p.locked);
      if (p.action === 'load' && p.watch) {
        setWatchOpen(true);
        toast(`${p.by} started a video`);
      } else if (p.action === 'clear') toast(`${p.by} stopped the video`);
      else if (p.action === 'lock') toast(p.locked ? 'Only the creator and mods control playback' : 'Anyone can control playback');
    };
    socket.on('watch:state', onWatch);
    return () => { socket.off('watch:state', onWatch); };
  }, [toast]);
  useEffect(() => {
    const onRooms = (r: RoomSummary[]) => setRoomList(r);
    socket.on('rooms', onRooms);
    call<{ rooms: RoomSummary[] }>((ack) => socket.emit('rooms:list', ack)).then((r) => setRoomList(r.rooms)).catch(() => {});
    return () => { socket.off('rooms', onRooms); };
  }, []);
  const moreRef = useRef<HTMLDivElement>(null);
  const [botName, setBotName] = useState('');
  const [allowedBots, setAllowedBots] = useState<{ id: number; name: string }[]>([]);
  const [pins, setPins] = useState(() => initial.pins.filter((m): m is Extract<ChatMessage, { kind: 'chat' }> => m.kind === 'chat'));
  const [typers, setTypers] = useState<{ id: string; nick: string }[]>([]);
  const [thread, setThread] = useState<{ parent: Extract<ChatMessage, { kind: 'chat' }>; messages: ChatMessage[] } | null>(null);
  const [threadText, setThreadText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pingMuted, setPingMuted] = useState(() => { try { return localStorage.getItem(`${APP_NAME.toLowerCase()}.pingMute`) === '1'; } catch { return false; } });
  const usersRef = useRef(users);
  usersRef.current = users;
  const camRef = useRef({ cam, mic, screen });
  camRef.current = { cam, mic, screen };
  const meshP = useRef<Promise<Mesh> | null>(null);
  /** StrictMode runs effect cleanup then setup again; don't destroy the mesh in between. */
  const meshUsers = useRef(0);
  const camBeforeScreen = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(loadSplit);
  const [splitOn, setSplitOn] = useState(splitFits);
  const [peopleW, setPeopleW] = useState(loadPeopleSplit);

  const stick = useRef(true);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const typingOn = useRef(false);
  const typingStop = useRef<number | null>(null);
  const pingMutedRef = useRef(pingMuted);
  pingMutedRef.current = pingMuted;
  const meRef = useRef(me);
  meRef.current = me;
  const localSpeakRef = useRef<LocalSpeakingMonitor | null>(null);
  const remoteSpeakRef = useRef<RemoteSpeakingMonitor | null>(null);

  useEffect(() => {
    const local = new LocalSpeakingMonitor((speaking) => setSelfSpeaking(speaking));
    localSpeakRef.current = local;
    return () => { local.stop(); localSpeakRef.current = null; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mesh = await meshP.current;
      if (!mesh || cancelled) return;
      const remote = new RemoteSpeakingMonitor(() => mesh.peerConnections(), setRemoteSpeaking, (t) => mesh.isShareAudioTrack(t));
      remoteSpeakRef.current = remote;
      remote.start(250);
    })();
    return () => {
      cancelled = true;
      remoteSpeakRef.current?.stop();
      remoteSpeakRef.current = null;
    };
  }, []);

  const isOwner = initial.isOwner;
  const isStaff = me.role === 'admin' || me.role === 'moderator';
  const canManageRoom = isOwner || isStaff;
  // ---- batch 2: room mods, events, bookmarks, polls, link previews, profiles ----
  const [mods, setMods] = useState<RoomModInfo[]>(initial.mods ?? []);
  const modIds = useMemo(() => new Set(mods.map((m) => m.accountId)), [mods]);
  const isRoomMod = me.accountId != null && modIds.has(me.accountId);
  /** owner, site staff, or an appointed room mod: kick / room-ban / mute here, pin, delete lines, manage events */
  const canRoomManage = canManageRoom || isRoomMod;
  const [modsCanInvite, setModsCanInvite] = useState(!!initial.modsCanInvite);
  /** owner / staff, or a room mod when the owner allows it; never in private calls */
  const canInvite = !initial.isPrivate && (canManageRoom || (isRoomMod && modsCanInvite));
  // ---- stage mode ----
  const [stage, setStage] = useState<StageState>(() => initial.stage ?? STAGE_OFF);
  const stageOn = stage.on && !initial.isPrivate;
  const amSpeaker = !stageOn || canRoomManage || stage.speakers.includes(me.id);
  const handOf = (id: string) => stage.hands.find((h) => h.id === id);
  const myHand = !!handOf(me.id);
  const stageIsManager = (u: UserInfo) => initial.ownerNick === u.nick || u.role === 'admin' || u.role === 'moderator' || (u.accountId != null && modIds.has(u.accountId));
  const stageInvited = (u: UserInfo) => stage.speakers.includes(u.id) && !stageIsManager(u);
  const stageAct = (ev: 'stage:hand' | 'stage:invite' | 'stage:down', payload: { up: boolean } | { userId: string }) =>
    act((ack) => (socket.emit as (e: string, p: unknown, a: unknown) => void)(ev, payload, ack));
  const stageInvite = (userId: string) => stageAct('stage:invite', { userId });
  const stageDown = (userId: string) => stageAct('stage:down', { userId });
  const stageHand = (up: boolean) => stageAct('stage:hand', { up });
  const setStageMode = (p: { on?: boolean; cap?: number }) => act((ack) => socket.emit('stage:set', p, ack));
  useEffect(() => {
    const onStage = (p: StageState) => setStage(p);
    socket.on('stage:state', onStage);
    return () => { socket.off('stage:state', onStage); };
  }, []);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const roomReports = useRoomCounts(initial.id);
  useEffect(() => {
    if (!canRoomManage || initial.isPrivate) return;
    socket.emit('modq:room:list', { status: 'open' }, (r) => { if (r.ok) setRoomCounts(initial.id, r.counts); });
  }, [canRoomManage, initial.id, initial.isPrivate]);
  useEffect(() => {
    if (!canRoomManage || initial.isPrivate) { setSchedules([]); return; }
    void call<{ schedules: RoomScheduleInfo[] }>((ack) => socket.emit('schedule:list', ack)).then((r) => setSchedules(r.schedules)).catch(() => {});
  }, [canRoomManage, initial.isPrivate]);
  useEffect(() => { if (radioHere > 0 && !radio.np) refreshRadio(); }, [radioHere, radio.np]);
  const [events, setEvents] = useState<RoomEventInfo[]>([]);
  const [canManageEvents, setCanManageEvents] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const [bookmarkIds, setBookmarkIds] = useState<ReadonlySet<string>>(() => new Set());
  const [savedVersion, setSavedVersion] = useState(0);
  const [pollDraft, setPollDraft] = useState<{ question: string; options: string[] } | null>(null);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [jumpHit, setJumpHit] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => call<{ events: RoomEventInfo[]; canManage: boolean }>((ack) => socket.emit('events:list', ack))
      .then((r) => { if (alive) { setEvents(r.events); setCanManageEvents(r.canManage); } }).catch(() => {});
    void load();
    const onChanged = (p: { roomId: string }) => { if (p.roomId === initial.id) void load(); };
    socket.on('events:changed', onChanged);
    const t = window.setInterval(() => setClockTick((n) => n + 1), 60_000);
    return () => { alive = false; socket.off('events:changed', onChanged); window.clearInterval(t); };
  }, [initial.id, isRoomMod]);
  const nextEvent = useMemo(() => {
    const now = Date.now();
    return events.find((e) => eventEnd(e) > now && e.startsAt - now <= EVENT_SOON_MS) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, clockTick]);
  useEffect(() => {
    if (!me.registered) return;
    let alive = true;
    call<{ bookmarks: BookmarkEntry[]; ids: string[] }>((ack) => socket.emit('bookmark:list', ack))
      .then((r) => { if (alive) setBookmarkIds(new Set(r.ids)); }).catch(() => {});
    return () => { alive = false; };
  }, [me.registered, savedVersion]);
  useEffect(() => {
    type ChatLine = Extract<ChatMessage, { kind: 'chat' }>;
    const patch = (fn: (m: ChatLine) => ChatLine) => {
      const apply = <T extends ChatMessage>(m: T): T => (m.kind === 'chat' ? fn(m) as T : m);
      setMessages((prev) => prev.map(apply));
      setPins((prev) => prev.map(apply));
      setThread((cur) => cur ? { parent: apply(cur.parent), messages: cur.messages.map(apply) } : cur);
    };
    const onMods = (p: { mods: RoomModInfo[] }) => setMods(p.mods);
    const onRoomMuted = (p: { by: string; until: number }) => toast(`${p.by} muted you in this room for ${Math.ceil((p.until - Date.now()) / 60_000)} min`, 'error');
    const onPreview = (p: { messageId: string; preview: LinkPreviewInfo | null }) => patch((m) => {
      if (m.id !== p.messageId || m.burn) return m;
      if (!p.preview) { const { preview: _drop, ...rest } = m; return rest; }
      return { ...m, preview: p.preview };
    });
    const onPoll = (p: { poll: PollInfo }) => patch((m) => (m.poll?.id === p.poll.id ? { ...m, poll: { ...p.poll, myVote: p.poll.myVote ?? m.poll.myVote } } : m));
    socket.on('room:mods', onMods);
    socket.on('room:muted', onRoomMuted);
    socket.on('chat:preview', onPreview);
    socket.on('poll:update', onPoll);
    return () => {
      socket.off('room:mods', onMods);
      socket.off('room:muted', onRoomMuted);
      socket.off('chat:preview', onPreview);
      socket.off('poll:update', onPoll);
    };
  }, [toast]);
  const applyAvDevices = async (r: import('./AvSettings').AvApplyResult) => {
    const mesh = await meshP.current!;
    if (r.videoTrack) r = { ...r, videoTrack: await prepareVideo(r.videoTrack) };
    if (r.audioTrack) r = { ...r, audioTrack: await prepareAudio(r.audioTrack) };
    const others = mediaPeerIds(usersRef.current, me.id);
    if (r.videoTrack !== undefined) {
      await mesh.setTrack('video', r.videoTrack, others);
      setCam(!!r.videoTrack);
    }
    if (r.audioTrack !== undefined) {
      await mesh.setTrack('audio', r.audioTrack, others);
      setMic(!!r.audioTrack);
      localSpeakRef.current?.setTrack(r.audioTrack);
    }
    setLocalStream(mesh.hasLocalTracks ? new MediaStream(mesh.local.getTracks()) : null);
    // Speaker sink (already saved in AvSettings); ensure every tile uses it.
    await applyAudioOutputToDocument();
  };

  const guestCamLocked = !me.registered && initial.camAllowedAt === -1;

  // Adopt the account's saved preset on a browser that never chose one.
  useEffect(() => {
    const saved = account?.videoQuality;
    if (isVideoQuality(saved) && !storedQuality()) { saveQuality(saved); setVq(saved); }
  }, [account?.videoQuality]);
  /** Settings: applies at once (track constraints + sender parameters, no renegotiation). */
  const changeQuality = (q: VideoQuality) => {
    saveQuality(q);
    setVq(q);
    if (account) void api('/api/me/video-quality', { videoQuality: q }, 'PATCH').catch(() => {});
    void meshP.current?.then((mesh) => {
      const t = mesh.videoTrack && rawTrack(mesh.videoTrack);
      if (!t || camRef.current.screen) return;
      const { deviceId: _d, ...c } = captureConstraints(q);
      // the scale-down factor depends on the capture height, so re-derive the encodings afterwards
      t.applyConstraints(c).catch(() => {}).finally(() => { void mesh.refreshEncodings(); });
    });
  };
  const changeShareMode = (m: ShareMode) => { saveShareMode(m); setShareMode(m); };
  /** Too slow for the background effect: switch it off (saved), with a note in A/V settings. */
  const bgSlow = useRef<(why: string) => void>(() => {});
  bgSlow.current = (why: string) => {
    if (bgRef.current.mode === 'off') return;
    const next = { ...bgRef.current, mode: 'off' as const };
    saveBg(next);
    setBgPref(next);
    const note = why === 'busy' ? 'Background turned off: your device is busy.' : 'Background turned off: this device could not keep up.';
    setBgNote(note);
    toast(note, 'error');
  };
  /** Camera track as sent: the raw one, or a background-processed canvas track. */
  async function prepareVideo(raw: MediaStreamTrack): Promise<MediaStreamTrack> {
    const p = bgRef.current;
    if (p.mode === 'off') return raw;
    try {
      const { startBackground } = await import('../bg/background');
      return await startBackground(raw, p, { onSlow: (why) => bgSlow.current(why) });
    } catch (e) {
      console.warn('background effect failed', e);
      toast('Background effect is not available on this device.', 'error');
      return raw;
    }
  }
  async function prepareAudio(raw: MediaStreamTrack): Promise<MediaStreamTrack> {
    if (!noiseRef.current.strong) return raw;
    try {
      const { startRnnoise } = await import('../noise');
      return await startRnnoise(raw);
    } catch (e) {
      console.warn('rnnoise failed', e);
      toast('Stronger noise suppression is not available here; using the browser\'s.', 'error');
      return raw;
    }
  }
  const changeBg = (p: BgPref) => { saveBg(p); setBgPref(p); setBgNote(null); };
  const changeNoise = (p: NoisePref) => {
    saveNoise(p);
    setNoisePref(p);
    noiseRef.current = p;
    if (camRef.current.mic) void setMediaRef.current?.('audio', true); // re-open the mic with the new processing
  };
  // live camera: turn the effect on / off / change it without renegotiating (replaceTrack)
  useEffect(() => {
    if (!cam || screen) return;
    let gone = false;
    void meshP.current?.then(async (mesh) => {
      const cur = mesh.videoTrack;
      if (!cur || gone) return;
      const proc = trackProcessors.get(cur);
      const others = mediaPeerIds(usersRef.current, me.id);
      if (bgPref.mode === 'off') {
        if (!proc) return;
        proc.dispose(true);
        await mesh.setTrack('video', proc.raw, others, { keepStopped: true });
      } else if (proc?.update) {
        await proc.update(bgPref);
        return;
      } else {
        const next = await prepareVideo(cur);
        if (next === cur || gone || mesh.videoTrack !== cur) { if (next !== cur && mesh.videoTrack !== cur) trackProcessors.get(next)?.dispose(true); return; }
        await mesh.setTrack('video', next, others, { keepStopped: true });
      }
      setLocalStream(mesh.hasLocalTracks ? new MediaStream(mesh.local.getTracks()) : null);
    });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgPref, cam, screen]);
  // the Auto quality controller saw a busy encoder: drop the effect first
  useEffect(() => {
    if (!vqNotice || !/busy/i.test(vqNotice)) return;
    void meshP.current?.then((mesh) => { if (mesh.videoTrack && trackProcessors.get(mesh.videoTrack)?.update) bgSlow.current('busy'); });
  }, [vqNotice]);
  useEffect(() => { void meshP.current?.then((mesh) => mesh.setShareMode(shareMode)); }, [shareMode]);
  // Camera send level: a fixed preset, or the Auto controller (lazy chunk) while the camera is live.
  useEffect(() => {
    if (!cam || screen) { setVqNotice(null); return; }
    let ctl: { stop(): void } | null = null;
    let gone = false;
    void meshP.current?.then(async (mesh) => {
      if (vq !== 'auto') { setVqNotice(null); await mesh.setVideoLevel(vq); return; }
      await mesh.setVideoLevel(null);
      const { AutoQuality } = await import('../vqAuto');
      if (gone) return;
      const a = new AutoQuality(
        () => [...mesh.peerConnections()].map(([, pc]) => pc),
        (level, notice) => { void mesh.setVideoLevel(level); setVqNotice(notice); },
      );
      a.start();
      ctl = a;
    });
    return () => { gone = true; ctl?.stop(); };
  }, [cam, screen, vq]);
  // Tell each sender what this viewer wants (mesh: each viewer has its own encoder on the sender's side).
  useEffect(() => {
    void meshP.current?.then((mesh) => {
      for (const u of users) {
        if (u.id === me.id) continue;
        mesh.setReceivePref(u.id, viewPrefs[u.nick.toLowerCase()] ?? 'full');
      }
    });
  }, [viewPrefs, users, me.id]);

  // ---- mesh lifecycle ----
  if (!meshP.current) {
    meshP.current = getIceServers().then(
      (ice) => new Mesh(
        socket, socket.id!, ice,
        (id, s) => setStreams((prev) => ({ ...prev, [id]: s })),
        (id, s) => setShareAudio((prev) => ({ ...prev, [id]: s })),
      ),
    );
  }
  useEffect(() => {
    meshUsers.current += 1;
    const created = meshP.current!;
    return () => {
      meshUsers.current -= 1;
      created.then((m) => { if (meshUsers.current === 0) m.destroy(); });
    };
  }, []);
  useEffect(() => {
    const id = me.id;
    meshP.current?.then((m) => m.adoptId(id));
  }, [me.id]);

  useEffect(() => {
    applyAudioOutputToDocument().catch(() => {});
  }, []);

  // ---- socket events ----
  useEffect(() => {
    const onMsg = (m: ChatMessage) => {
      if (m.kind === 'chat' && m.parentId) {
        const parentId = m.parentId;
        const count = m.replyCount;
        setMessages((prev) => prev.map((x) => (x.kind === 'chat' && x.id === parentId ? { ...x, replyCount: count ?? (x.replyCount ?? 0) + 1 } : x)));
        setThread((cur) => {
          if (!cur || cur.parent.id !== parentId) return cur;
          const messages = cur.messages.some((x) => x.id === m.id) ? cur.messages : [...cur.messages, m];
          return { ...cur, parent: { ...cur.parent, replyCount: count ?? messages.length }, messages };
        });
      } else {
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev.slice(-199), m]));
      }
      const viewer = meRef.current;
      if (m.kind === 'chat' && viewer.accountId && m.mentions?.includes(viewer.accountId) && m.fromId !== socket.id && !pingMutedRef.current)
        playMentionPing();
    };
    const applyEdit = (m: ChatMessage, p: { id: string; text: string; editedAt: number; mentions?: number[] }): ChatMessage =>
      m.kind === 'chat' && m.id === p.id ? { ...m, text: p.text, editedAt: p.editedAt, mentions: p.mentions } : m;
    const onEdited = (p: { id: string; text: string; editedAt: number; mentions?: number[] }) => {
      setMessages((prev) => prev.map((m) => applyEdit(m, p)));
      setPins((prev) => prev.map((m) => applyEdit(m, p) as Extract<ChatMessage, { kind: 'chat' }>));
      setThread((cur) => cur ? { parent: applyEdit(cur.parent, p) as Extract<ChatMessage, { kind: 'chat' }>, messages: cur.messages.map((m) => applyEdit(m, p)) } : cur);
    };
    // Auto-safety: hidden pending review (reviewers keep the text), or shown again with the line restored.
    const onHidden = (p: { id: string; hidden: boolean; message?: ChatMessage }) => {
      setMessages((prev) => prev.map((m) => {
        if (m.kind !== 'chat' || m.id !== p.id) return m;
        if (!p.hidden && p.message && p.message.kind === 'chat') return { ...m, ...p.message, reactions: m.reactions, hidden: false };
        return { ...m, hidden: p.hidden };
      }));
    };
    socket.on('chat:hidden', onHidden);
    const onDeleted = ({ id }: { id: string }) => {
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setPins((prev) => prev.filter((m) => m.id !== id));
      setThread((cur) => {
        if (!cur) return cur;
        if (cur.parent.id === id) return null;
        return { ...cur, messages: cur.messages.filter((m) => m.id !== id) };
      });
      setEditingId((cur) => (cur === id ? null : cur));
      setBookmarkIds((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
    };
    const onReplies = ({ messageId, replyCount }: { messageId: string; replyCount: number }) => {
      setMessages((prev) => prev.map((m) => (m.kind === 'chat' && m.id === messageId ? { ...m, replyCount } : m)));
      setThread((cur) => cur && cur.parent.id === messageId ? { ...cur, parent: { ...cur.parent, replyCount } } : cur);
    };
    const onTyping = ({ id, nick, typing }: { id: string; nick: string; typing: boolean }) => {
      if (id === socket.id) return;
      setTypers((prev) => {
        const next = prev.filter((x) => x.id !== id);
        return typing ? [...next, { id, nick }] : next;
      });
    };
    const onPins = ({ pins: next }: { pins: ChatMessage[] }) => {
      setPins(next.filter((m): m is Extract<ChatMessage, { kind: 'chat' }> => m.kind === 'chat'));
    };
    const onReactions = ({ messageId, reactions }: { messageId: string; reactions: { emoji: string; count: number }[] }) => {
      setMessages((prev) => prev.map((m) => {
        if (m.kind !== 'chat' || m.id !== messageId) return m;
        const mine = new Set((m.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji));
        return { ...m, reactions: reactions.map((r) => ({ ...r, mine: mine.has(r.emoji) })) };
      }));
    };
    const onTopic = ({ topic: t }: { topic: string }) => setTopic(t);
    const onJoined = (u: UserInfo) => {
      setUsers((prev) => [...prev.filter((x) => x.id !== u.id), u]);
      meshP.current!.then((m) => { if (m.hasLocalTracks && !u.id.startsWith('bot:')) m.ensurePeer(u.id); });
    };
    const onLeft = ({ id }: { id: string }) => {
      setUsers((prev) => prev.filter((x) => x.id !== id));
      setTypers((prev) => prev.filter((x) => x.id !== id));
      meshP.current!.then((m) => m.removePeer(id));
      setBigId((b) => (b === id ? null : b));
    };
    const moveKey = <T,>(prev: Record<string, T>, from: string, to: string): Record<string, T> => {
      if (!(from in prev) || from === to) return prev;
      const next = { ...prev, [to]: prev[from] };
      delete next[from];
      return next;
    };
    const onMoved = ({ from, to, user }: { from: string; to: string; user: UserInfo }) => {
      setUsers((prev) => prev.map((u) => (u.id === from ? user : u)));
      setTypers((prev) => prev.map((t) => (t.id === from ? { ...t, id: to } : t)));
      setBigId((b) => (b === from ? to : b));
      setMutedIds((prev) => {
        if (!prev.has(from)) return prev;
        const n = new Set(prev);
        n.delete(from);
        n.add(to);
        return n;
      });
      setStreams((prev) => moveKey(prev, from, to));
      setShareAudio((prev) => moveKey(prev, from, to));
      meshP.current!.then((m) => {
        if (from === meRef.current.id) m.adoptId(to);
        else m.renamePeer(from, to);
      });
    };
    const applyProfile = <T extends { kind?: string; accountId?: number; chatColor?: string | null; chatEffect?: string | null; hasAvatar?: boolean }>(m: T, u: UserInfo): T =>
      m.kind === 'chat' && u.accountId != null && m.accountId === u.accountId
        ? { ...m, chatColor: u.chatColor, chatEffect: u.chatEffect, hasAvatar: u.hasAvatar }
        : m;
    const onUpdated = (u: UserInfo) => {
      setUsers((prev) => prev.map((x) => (x.id === u.id ? u : x)));
      setMessages((prev) => prev.map((m) => applyProfile(m, u)));
      setPins((prev) => prev.map((m) => applyProfile(m, u)));
      setThread((cur) => cur ? { parent: applyProfile(cur.parent, u), messages: cur.messages.map((m) => applyProfile(m, u)) } : cur);
    };
    const onSignal = ({ from, data }: { from: string; data: SignalData }) => meshP.current!.then((m) => m.handleSignal(from, data));
    const onCamOff = async ({ by, until }: { by: string; until: number }) => {
      // Moderator cut the video broadcast: stop camera and any held screen-share track.
      const mesh = await meshP.current!;
      await mesh.releaseVideo();
      camBeforeScreen.current = false;
      camRef.current = { ...camRef.current, cam: false, screen: false };
      setCam(false);
      setScreen(false);
      setLocalStream(mesh.hasLocalTracks ? new MediaStream(mesh.local.getTracks()) : null);
      toast(`${by} turned your camera off (${Math.ceil((until - Date.now()) / 60_000)} min)`, 'error');
    };
    const onDemoted = async ({ by }: { by: string }) => {
      // stage mode: back to the audience. Stop every track and the send transceivers.
      const mesh = await meshP.current!;
      await mesh.stopSending();
      camBeforeScreen.current = false;
      camRef.current = { cam: false, mic: false, screen: false };
      setCam(false);
      setMic(false);
      setScreen(false);
      localSpeakRef.current?.setTrack(null);
      setLocalStream(null);
      toast(by === me.nick ? 'You left the stage.' : `${by} moved you to the audience. Raise your hand to ask to speak.`);
    };
    socket.on('stage:demoted', onDemoted);
    const onMuted = ({ by, until }: { by: string; until: number }) =>
      toast(`${by} muted you in chat for ${Math.ceil((until - Date.now()) / 60_000)} min`, 'error');
    socket.on('chat:message', onMsg);
    socket.on('chat:edited', onEdited);
    socket.on('chat:reactions', onReactions);
    socket.on('chat:deleted', onDeleted);
    socket.on('chat:replies', onReplies);
    socket.on('chat:typing', onTyping);
    socket.on('chat:pins', onPins);
    socket.on('room:topic', onTopic);
    const onThumb = ({ thumbUrl: t }: { thumbUrl: string | null }) => setThumbUrl(t);
    socket.on('room:thumb', onThumb);
    const onIcon = ({ iconUrl: u }: { iconUrl: string | null }) => setIconUrl(u);
    socket.on('room:icon', onIcon);
    const onInviteSettings = ({ modsCanInvite: on }: { modsCanInvite: boolean }) => setModsCanInvite(on);
    socket.on('room:inviteSettings', onInviteSettings);
    const onMeta = (p: { category: string | null; tags: string[] }) => { setCategory(p.category); setTags(p.tags); };
    const onAnn = (p: { announcement: RoomAnnouncement | null }) => setAnnouncement(p.announcement);
    const onTheme = (p: { theme: RoomThemeInfo }) => setTheme(p.theme);
    socket.on('room:theme', onTheme);
    const onSched = (p: { schedules: RoomScheduleInfo[] }) => setSchedules(p.schedules);
    const onEmotes = (p: { emotes: RoomEmote[] }) => setEmotes(p.emotes);
    const onRadioRoom = (p: { listening: number }) => setRadioHere(p.listening);
    socket.on('room:meta', onMeta);
    socket.on('room:announcement', onAnn);
    socket.on('room:schedules', onSched);
    socket.on('room:emotes', onEmotes);
    socket.on('radio:room', onRadioRoom);
    socket.on('user:joined', onJoined);
    socket.on('user:left', onLeft);
    socket.on('user:moved', onMoved);
    socket.on('user:updated', onUpdated);
    socket.on('rtc:signal', onSignal);
    socket.on('mod:camoff', onCamOff);
    socket.on('mod:muted', onMuted);
    const onBurned = ({ id }: { id: string }) => {
      const wipe = <T extends ChatMessage>(m: T): T => (m.kind === 'chat' && m.id === id && m.burn ? { ...m, text: '', burn: { ...m.burn, burned: true } } : m);
      setMessages((prev) => prev.map(wipe));
      setThread((cur) => cur ? { ...cur, messages: cur.messages.map(wipe) } : cur);
    };
    socket.on('chat:burned', onBurned);
    const onBadgeToast = ({ nick, id }: { nick: string; id: string }) => { if (!ignoredRef.current.has(nick.toLowerCase())) toast(`${nick} earned ${badgeLabel(id)}`); };
    socket.on('badge:toast', onBadgeToast);
    const onFx = ({ id, by }: { id: string; by: string }) => {
      if (!isFxId(id)) return;
      if (by !== me.nick && ignoredRef.current.has(by.toLowerCase())) return; // blocked sender: no toast, no effect
      const f = fxById(id)!;
      toast(`${by} ⇒ ${f.emoji}`);
      if (!fxShowEnabled() || prefersReducedMotion()) return;
      runFx(id);
      if (fxSoundEnabled()) void playFxSound(id);
    };
    socket.on('fx:played', onFx);
    const onSettings = (p: { locked: boolean; slowModeSec: number }) => { setLocked(p.locked); setSlowModeSec(p.slowModeSec); };
    const onAccess = (p: { passwordRequired: boolean }) => setPasswordRequired(p.passwordRequired);
    socket.on('room:settings', onSettings);
    socket.on('room:access', onAccess);
    return () => {
      socket.off('chat:burned', onBurned);
      socket.off('badge:toast', onBadgeToast);
      socket.off('fx:played', onFx);
      stopFx();
      socket.off('chat:message', onMsg);
      socket.off('chat:edited', onEdited);
      socket.off('chat:reactions', onReactions);
      socket.off('chat:deleted', onDeleted);
      socket.off('chat:hidden', onHidden);
      socket.off('chat:replies', onReplies);
      socket.off('chat:typing', onTyping);
      socket.off('chat:pins', onPins);
      socket.off('room:topic', onTopic);
      socket.off('room:thumb', onThumb);
      socket.off('room:icon', onIcon);
      socket.off('room:inviteSettings', onInviteSettings);
      socket.off('room:meta', onMeta); socket.off('room:announcement', onAnn); socket.off('room:theme', onTheme); socket.off('room:schedules', onSched);
      socket.off('room:emotes', onEmotes); socket.off('radio:room', onRadioRoom);
      socket.off('user:joined', onJoined);
      socket.off('user:left', onLeft);
      socket.off('user:moved', onMoved);
      socket.off('user:updated', onUpdated);
      socket.off('rtc:signal', onSignal);
      socket.off('mod:camoff', onCamOff);
      socket.off('stage:demoted', onDemoted);
      socket.off('mod:muted', onMuted);
      socket.off('room:settings', onSettings);
      socket.off('room:access', onAccess);
    };
  }, [toast]);

  useEffect(() => {
    if (!typers.length) return;
    const timer = window.setTimeout(() => setTypers([]), 4000);
    return () => window.clearTimeout(timer);
  }, [typers]);

  // ---- chat autoscroll (only if user is at the bottom) ----
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ---- media toggles ----
  const setMedia = useCallback(async (kind: 'video' | 'audio', on: boolean) => {
    setMediaBusy(true);
    const mesh = await meshP.current!;
    const nextCam = kind === 'video' ? on : camRef.current.cam;
    const nextMic = kind === 'audio' ? on : camRef.current.mic;
    // Mic toggles must not drop an active screen share. Starting the camera still replaces it.
    const keepScreen = camRef.current.screen && kind !== 'video';
    const mediaState = { cam: nextCam && !keepScreen, mic: nextMic, screen: keepScreen };
    let track: MediaStreamTrack | null = null;
    try {
      // ask the server first so a refused cam never opens the device
      unlockAudio();
      if (on) await call((ack) => socket.emit('media:state', mediaState, ack));
      if (on) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera/mic need HTTPS (or localhost) and a modern browser.');
        try {
          const stored = loadStoredDevices();
          const s = await navigator.mediaDevices.getUserMedia(
            kind === 'video'
              ? { video: captureConstraints(vqRef.current, stored.videoinput) }
              : { audio: audioConstraints(stored.audioinput) },
          );
          track = s.getTracks()[0];
          track = kind === 'video' ? await prepareVideo(track) : await prepareAudio(track);
        } catch (err) {
          socket.emit('media:state', { cam: camRef.current.cam && !camRef.current.screen, mic: camRef.current.mic, screen: camRef.current.screen }, () => {});
          throw err;
        }
      } else {
        await call((ack) => socket.emit('media:state', mediaState, ack));
      }
      const others = mediaPeerIds(usersRef.current, me.id);
      await mesh.setTrack(kind, track, others);
      kind === 'video' ? setCam(on) : setMic(on);
      setLocalStream(mesh.hasLocalTracks ? new MediaStream(mesh.local.getTracks()) : null);
      if (kind === 'audio') localSpeakRef.current?.setTrack(on ? track : null);
      else localSpeakRef.current?.setTrack(mesh.audioTrack);
    } catch (e) {
      track?.stop();
      const err = e as Error;
      toast(err.name === 'NotAllowedError' ? 'Permission denied - allow camera/mic in your browser.' : err.message, 'error');
    } finally { setMediaBusy(false); }
  }, [me.id, toast]);
  const setMediaRef = useRef(setMedia);
  setMediaRef.current = setMedia;

  const toggleScreen = useCallback(async () => {
    setMediaBusy(true);
    const mesh = await meshP.current!;
    const sharing = camRef.current.screen;
    try {
      unlockAudio();
      if (sharing) {
        const restore = camBeforeScreen.current;
        await call((ack) => socket.emit('media:state', { cam: restore, mic: camRef.current.mic, screen: false }, ack));
        await mesh.setScreenShare(null, mediaPeerIds(usersRef.current, me.id), restore);
        camBeforeScreen.current = false;
        const hasCam = !!mesh.videoTrack;
        camRef.current = { cam: hasCam, mic: camRef.current.mic, screen: false };
        setScreen(false);
        setCam(hasCam);
        setLocalStream(mesh.hasLocalTracks ? new MediaStream(mesh.local.getTracks()) : null);
      } else {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen share is not supported in this browser.');
        const hadCam = camRef.current.cam;
        await call((ack) => socket.emit('media:state', { cam: false, mic: camRef.current.mic, screen: true }, ack));
        let stream: MediaStream;
        try {
          // Prefer tab audio (audio:true / processing off). Do not set systemAudio:'include'
          // — that nudges entire-screen "Share system audio", which is every sound on the PC.
          // A cancel must not open a second picker; only a rejected audio request falls back.
          const attempts: DisplayMediaStreamOptions[] = [
            { video: true, audio: { ...SHARE_AUDIO_CONSTRAINTS } },
            { video: true, audio: true },
            { video: true, audio: false },
          ];
          let got: MediaStream | null = null;
          let lastErr: unknown = null;
          for (const opts of attempts) {
            try { got = await navigator.mediaDevices.getDisplayMedia(opts); break; } catch (err) {
              const name = (err as DOMException).name;
              if (name === 'NotAllowedError' || name === 'AbortError') throw err;
              lastErr = err;
            }
          }
          if (!got) throw lastErr ?? new Error('Screen share failed.');
          stream = got;
        } catch (err) {
          socket.emit('media:state', { cam: hadCam, mic: camRef.current.mic, screen: false }, () => {});
          throw err;
        }
        const track = stream.getVideoTracks()[0];
        const surface =
          (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface
          || (stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { displaySurface?: string } | undefined)?.displaySurface
          || null;
        // Strip entire-screen system audio (every sound on the PC). Keep Chrome tab audio only.
        let displayAudio: MediaStreamTrack | null = stream.getAudioTracks()[0] ?? null;
        const decision = decideShareAudio(surface, !!displayAudio);
        if (displayAudio && !decision.keepAudio) {
          for (const a of stream.getAudioTracks()) {
            stream.removeTrack(a);
            a.stop();
          }
          displayAudio = null;
        }
        if (displayAudio) {
          displayAudio.contentHint = 'music';
          // Some Chrome builds ignore the processing flags in getDisplayMedia; enforce them on the track.
          displayAudio.applyConstraints({ ...SHARE_AUDIO_CONSTRAINTS }).catch(() => {});
        }
        if (decision.notice) toast(decision.notice, 'info');
        // Read the ref, not the closure's `screen` — the browser "stop sharing" event
        // fires the listener from the start attempt, whose state value is still false.
        camBeforeScreen.current = hadCam;
        camRef.current = { cam: false, mic: camRef.current.mic, screen: true };
        track.addEventListener('ended', () => { if (camRef.current.screen) void toggleScreen(); });
        const others = mediaPeerIds(usersRef.current, me.id);
        await mesh.setScreenShare(track, others, false);
        // Own sender. Never replaceTrack on the microphone.
        await mesh.setShareAudio(displayAudio, others);
        setScreen(true);
        setCam(false);
        setLocalStream(mesh.hasLocalTracks ? new MediaStream(mesh.local.getTracks()) : null);
      }
    } catch (e) {
      const err = e as Error;
      toast(err.name === 'NotAllowedError' ? 'Screen share permission denied.' : err.message, 'error');
    } finally { setMediaBusy(false); }
  }, [me.id, toast]);

  // ---- chat ----
  const reactTo = async (messageId: string, emoji: string) => {
    try {
      const r = await call<{ reactions: { emoji: string; count: number; mine: boolean }[] }>((ack) => socket.emit('chat:react', { messageId, emoji }, ack));
      setMessages((prev) => prev.map((m) => (m.kind === 'chat' && m.id === messageId ? { ...m, reactions: r.reactions } : m)));
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const uploadImage = async (file: File | null) => {
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('image', file);
      const headers: Record<string, string> = { 'X-CSRF': '1' };
      const dev = storedDeviceId();
      if (dev) headers['X-Device-Id'] = dev;
      const res = await fetch(`/api/rooms/${encodeURIComponent(initial.id)}/images`, { method: 'POST', headers, credentials: 'same-origin', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || 'Upload failed');
      const md = `![image](${data.url})`;
      setText((cur) => (cur && !cur.endsWith(' ') && !cur.endsWith('\n') ? cur + ' ' : cur) + md);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const [burnOn, setBurnOn] = useState(false);
  const [burnTtl, setBurnTtl] = useState<BurnTtl>(BURN_DEFAULT_TTL);
  const [threadBurnOn, setThreadBurnOn] = useState(false);
  const [threadBurnTtl, setThreadBurnTtl] = useState<BurnTtl>(BURN_DEFAULT_TTL);
  /** burn messages whose countdown ran out for me */
  const [burnedLocal, setBurnedLocal] = useState<ReadonlySet<string>>(() => new Set());
  const onLocalBurn = useCallback((id: string) => setBurnedLocal((prev) => (prev.has(id) ? prev : new Set(prev).add(id))), []);

  const noteTyping = (on: boolean) => {
    if (on) {
      if (!typingOn.current) {
        typingOn.current = true;
        socket.emit('chat:typing', { typing: true });
      }
      if (typingStop.current) window.clearTimeout(typingStop.current);
      typingStop.current = window.setTimeout(() => noteTyping(false), 3000);
    } else if (typingOn.current) {
      typingOn.current = false;
      if (typingStop.current) window.clearTimeout(typingStop.current);
      socket.emit('chat:typing', { typing: false });
    }
  };
  useEffect(() => () => { if (typingOn.current) socket.emit('chat:typing', { typing: false }); }, []);

  const playFx = async (id: FxId) => {
    try { await call((ack) => socket.emit('fx:play', { id }, ack)); return true; }
    catch (err) { toast((err as Error).message, 'error'); return false; }
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    const pollCmd = editingId ? null : parsePollCommand(t);
    if (pollCmd) {
      if (pollCmd.question && pollCmd.options.length >= 2) {
        try { await call((ack) => socket.emit('poll:create', { question: pollCmd.question, options: pollCmd.options }, ack)); setText(''); noteTyping(false); }
        catch (err) { toast((err as Error).message, 'error'); }
      } else { setPollDraft(pollCmd); setText(''); noteTyping(false); }
      return;
    }
    const fx = editingId ? null : fxSlashCommand(t);
    if (fx) { if (await playFx(fx)) { setText(''); noteTyping(false); } return; }
    try {
      if (editingId) await call((ack) => socket.emit('chat:edit', { messageId: editingId, text: t }, ack));
      else await call((ack) => socket.emit('chat:send', burnOn ? { text: t, burnTtl } : { text: t }, ack));
      if (!editingId) setBurnOn(false);
      setText('');
      setEditingId(null);
      noteTyping(false);
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  const sendThread = async (e: FormEvent) => {
    e.preventDefault();
    const body = threadText.trim();
    if (!body || !thread) return;
    try {
      await call((ack) => socket.emit('chat:send', threadBurnOn ? { text: body, parentId: thread.parent.id, burnTtl: threadBurnTtl } : { text: body, parentId: thread.parent.id }, ack));
      setThreadBurnOn(false);
      setThreadText('');
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  const openThread = async (m: Extract<ChatMessage, { kind: 'chat' }>) => {
    const parent = m.parentId ? null : m;
    if (!parent) return;
    try {
      const r = await call<{ messages: ChatMessage[] }>((ack) => socket.emit('chat:thread', { messageId: parent.id }, ack));
      setThread({ parent, messages: r.messages });
      setThreadText('');
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  const mineMsg = (m: Extract<ChatMessage, { kind: 'chat' }>) =>
    (m.accountId != null && m.accountId === me.accountId) || m.fromId === me.id || (m.accountId == null && m.from === me.nick);

  const act = async (fn: (ack: (r: any) => void) => void, okMsg?: string) => {
    setMenuFor(null);
    try { await call(fn); if (okMsg) toast(okMsg); } catch (e) { toast((e as Error).message, 'error'); }
  };
  /** for dialogs: throw so the dialog shows the error */
  const actStrict = (fn: (ack: (r: any) => void) => void) => call(fn).then(() => undefined);

  const kick = (u: UserInfo) => act((ack) => socket.emit('room:kick', { userId: u.id }, ack));
  const roomBan = (u: UserInfo) => { setMenuFor(null); setDialog({
    title: `Ban ${u.nick} from #${initial.name}`, confirm: 'Ban from room', danger: true,
    durations: [{ label: '1 hour', minutes: 60 }, { label: '1 day', minutes: 1440 }, { label: 'Until lifted', minutes: null }],
    reason: { label: 'Reason (optional)', max: LIMITS.banReasonMax },
    onSubmit: ({ reason, minutes }) => actStrict((ack) => socket.emit('room:ban', { userId: u.id, minutes, reason }, ack)),
  }); };
  const siteBan = (u: UserInfo) => { setMenuFor(null); setDialog({
    title: `Site ban ${u.nick}`, description: `Bans ${u.registered ? 'the account, ' : ''}IP address and device from the whole site.`, confirm: 'Ban', danger: true,
    durations: BAN_DURATIONS, reason: { label: 'Reason (shown to the user)', required: true, max: LIMITS.banReasonMax },
    onSubmit: ({ reason, minutes }) => actStrict((ack) => socket.emit('mod:ban', { userId: u.id, minutes, reason }, ack)),
  }); };
  const mute = (u: UserInfo) => { setMenuFor(null); setDialog({
    title: `Mute ${u.nick} in chat`, confirm: 'Mute',
    durations: LIMITS.mutePresetsMin.map((m) => ({ label: `${m} minutes`, minutes: m })),
    onSubmit: ({ minutes }) => actStrict((ack) => socket.emit('mod:mute', { userId: u.id, minutes: minutes ?? 5 }, ack)),
  }); };
  const camOff = (u: UserInfo) => act((ack) => socket.emit('mod:camoff', { userId: u.id, minutes: 5 }, ack));
  const reportUser = (u: UserInfo) => { setMenuFor(null); setReportTarget({ kind: 'user', userId: u.id, nick: u.nick }); };
  const reportMsg = (m: Extract<ChatMessage, { kind: 'chat' }>) => setReportTarget({ kind: 'message', messageId: m.id, from: m.from, preview: m.burn ? 'Burn message: moderators will see its content in your report.' : m.text });
  const deleteMsg = (m: ChatMessage) => act((ack) => socket.emit('mod:delete', { messageId: m.id }, ack));
  const deleteOwn = (m: ChatMessage) => act((ack) => socket.emit('chat:delete', { messageId: m.id }, ack));
  /** own text message, not burn / voice / hidden, within the edit window (re-checked every minute by clockTick) */
  const canEditMsg = (m: Extract<ChatMessage, { kind: 'chat' }>) => mineMsg(m) && !m.voice && !m.burn && !m.hidden && !m.poll && Date.now() - m.ts < LIMITS.editWindowMs;
  const [historyFor, setHistoryFor] = useState<{ id: string; from: string; versions: { text: string; at: number }[]; current: { text: string; at: number } } | null>(null);
  const openHistory = async (m: Extract<ChatMessage, { kind: 'chat' }>) => {
    try {
      const r = await call<{ versions: { text: string; at: number }[]; current: { text: string; at: number } }>((ack) => socket.emit('chat:history', { messageId: m.id }, ack));
      setHistoryFor({ id: m.id, from: m.from, versions: r.versions, current: r.current });
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const editedMark = (m: Extract<ChatMessage, { kind: 'chat' }>) => (canRoomManage && !m.burn
    ? <button type="button" className="edited edited-btn" title="See edit history" onClick={(e) => { e.stopPropagation(); void openHistory(m); }} data-action="edit-history">(edited)</button>
    : <span className="edited">(edited)</span>);
  const pinsKey = `camchat.pinsCollapsed.${initial.id}`;
  const [pinsCollapsed, setPinsCollapsed] = useState(() => { try { return localStorage.getItem(pinsKey) === '1'; } catch { return false; } });
  const togglePinsCollapsed = () => setPinsCollapsed((v) => { const n = !v; try { localStorage.setItem(pinsKey, n ? '1' : '0'); } catch { /* private mode */ } return n; });
  const startEdit = (m: Extract<ChatMessage, { kind: 'chat' }>) => { setEditingId(m.id); setText(m.text); chatInputRef.current?.focus(); };
  const togglePin = (m: Extract<ChatMessage, { kind: 'chat' }>) => act((ack) => socket.emit('chat:pin', { messageId: m.id, pinned: !pins.some((p) => p.id === m.id) }, ack));
  const saveTopic = async (e: FormEvent) => {
    e.preventDefault();
    try { await call((ack) => socket.emit('room:topic', { topic: editingTopic ?? '' }, ack)); setEditingTopic(null); }
    catch (err) { toast((err as Error).message, 'error'); }
  };
  const deleteRoom = () => setDialog({
    title: `Delete #${initial.name}?`, description: 'Everyone in the room is sent back to the lobby and the chat history is removed.', confirm: 'Delete room', danger: true,
    onSubmit: () => actStrict((ack) => socket.emit('room:delete', ack)),
  });

  const roomMute = (u: UserInfo) => { setMenuFor(null); setDialog({
    title: `Mute ${u.nick} in #${initial.name}`, description: 'They can still watch and listen, but cannot chat in this room.', confirm: 'Mute',
    durations: LIMITS.mutePresetsMin.map((m) => ({ label: `${m} minutes`, minutes: m })),
    onSubmit: ({ minutes }) => actStrict((ack) => socket.emit('room:mute', { userId: u.id, minutes: minutes ?? 5 }, ack)),
  }); };
  const setRoomMod = (u: UserInfo, on: boolean) => {
    if (u.accountId == null) return;
    const accountId = u.accountId;
    void act((ack) => socket.emit('room:mod', { accountId, on }, ack), on ? `${u.nick} is now a room mod` : `${u.nick} is no longer a room mod`);
  };
  const toggleBookmark = async (m: Extract<ChatMessage, { kind: 'chat' }>) => {
    const on = !bookmarkIds.has(m.id);
    try {
      const r = await call<{ bookmarked: boolean }>((ack) => socket.emit('bookmark:toggle', { messageId: m.id, on }, ack));
      setBookmarkIds((prev) => { const n = new Set(prev); if (r.bookmarked) n.add(m.id); else n.delete(m.id); return n; });
      setSavedVersion((v) => v + 1);
      toast(r.bookmarked ? 'Saved to bookmarks' : 'Bookmark removed');
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  /** my own vote result (carries myVote; room broadcasts do not) */
  const applyMyPoll = (poll: PollInfo) => {
    const apply = <T extends ChatMessage>(m: T): T => (m.kind === 'chat' && m.poll?.id === poll.id ? { ...m, poll } : m);
    setMessages((prev) => prev.map(apply));
    setThread((cur) => cur ? { parent: apply(cur.parent), messages: cur.messages.map(apply) } : cur);
  };
  const removePreview = (m: ChatMessage) => { void call((ack) => socket.emit('chat:preview-remove', { messageId: m.id }, ack)).catch((e) => toast((e as Error).message, 'error')); };
  const openSide = (tab: 'rooms' | 'info' | 'search' | 'saved' | 'events' | 'stats') => {
    setSideTab(tab);
    setPanelCollapsed(false);
    if (!dockWide()) { setPanelOpen(true); setRailOpen(false); }
  };
  /** Jump to a message: scroll if loaded, else load the context around it (and open its thread for replies). */
  const jumpToMessage = async (id: string) => {
    const flash = (target: string) => {
      setJumpHit(target);
      window.setTimeout(() => setJumpHit((cur) => (cur === target ? null : cur)), 2600);
    };
    if (!dockWide()) setPanelOpen(false);
    const here = logRef.current?.querySelector(`[data-msg="${CSS.escape(id)}"]`);
    if (here) { stick.current = false; here.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(id); return; }
    try {
      const r = await call<{ messages: ChatMessage[]; anchorId: string; threadId?: string }>((ack) => socket.emit('chat:context', { messageId: id }, ack));
      stick.current = false;
      setMessages((prev) => {
        const byId = new Map<string, ChatMessage>();
        for (const m of [...r.messages, ...prev]) if (!byId.has(m.id)) byId.set(m.id, m);
        return [...byId.values()].sort((a, b) => a.ts - b.ts);
      });
      if (r.threadId) {
        const parent = r.messages.find((m): m is Extract<ChatMessage, { kind: 'chat' }> => m.kind === 'chat' && m.id === r.threadId);
        if (parent) void openThread(parent);
      }
      window.setTimeout(() => {
        const el = logRef.current?.querySelector(`[data-msg="${CSS.escape(r.anchorId)}"]`);
        el?.scrollIntoView({ block: 'center' });
        flash(r.threadId ? id : r.anchorId);
      }, 60);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const onSearchJump = (h: SearchHit) => { void jumpToMessage(h.message.id); };
  const onSavedJump = (b: BookmarkEntry) => {
    if (b.roomId === initial.id) { void jumpToMessage(b.message.id); return; }
    const r = roomList.find((x) => x.id === b.roomId);
    if (r) void switchRoom(r); else toast(`#${b.roomName} is not open right now`, 'error');
  };
  const openProfile = (nick: string) => { setMenuFor(null); setBlockFor(null); setProfileFor(nick); };
  const [tileAspects, setTileAspects] = useState<Record<string, { ar: number; audioOnly: boolean }>>({});
  const onTileLayout = useCallback((id: string, info: { ar: number; audioOnly: boolean }) => {
    setTileAspects((prev) => {
      const cur = prev[id];
      if (cur && cur.audioOnly === info.audioOnly && Math.abs(cur.ar - info.ar) < 0.001) return prev;
      return { ...prev, [id]: info };
    });
  }, []);
  const isIgnored = (nick: string) => ignored.has(nick.toLowerCase());
  const canWhisper = (u: { id: string; nick: string }) => u.id !== me.id && !u.id.startsWith('bot:') && !isIgnored(u.nick);
  const startWhisper = (u: { id: string; nick: string }) => {
    if (!canWhisper(u)) { toast(isIgnored(u.nick) ? 'Unblock them first' : 'You cannot whisper to them', 'error'); return; }
    const existing = Object.values(whispers).find((c) => c.info.members.length === 2 && c.info.members.some((m) => m.id === u.id));
    if (existing) { setOpenWhisper(existing.info.id); return; }
    socket.emit('whisper:start', { userIds: [u.id] }, (r) => {
      if (!r.ok) { toast(r.error, 'error'); return; }
      setWhispers((cur) => ({ ...cur, [r.whisper.id]: { info: r.whisper, messages: cur[r.whisper.id]?.messages ?? [], unread: 0 } }));
      setOpenWhisper(r.whisper.id);
    });
  };
  const addToWhisper = (whisperId: string, u: { id: string; nick: string }) => {
    if (!canWhisper(u)) { toast('You cannot add them', 'error'); return; }
    socket.emit('whisper:add', { whisperId, userId: u.id }, (r) => {
      if (!r.ok) toast(r.error, 'error');
      else setOpenWhisper(whisperId);
    });
  };
  const whisperTargets = (u: { id: string }) => Object.values(whispers).filter((c) => c.info.members.length < WHISPER_MAX_MEMBERS && !c.info.members.some((m) => m.id === u.id));
  const listedSelf = users.find((u) => u.id === me.id);
  const selfUser = { ...(listedSelf ?? me), cam, mic, screen };
  const broadcasters = useMemo(
    () => users.filter((u) => !u.modBot && !u.away && (u.cam || u.mic || u.screen) && !isIgnored(u.nick)).sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [users, ignored, me.id],
  );
  useEffect(() => {
    const ids = new Set(broadcasters.map((u) => u.id));
    setTileAspects((prev) => {
      const extra = Object.keys(prev).filter((id) => !ids.has(id));
      if (extra.length === 0) return prev;
      const next = { ...prev };
      for (const id of extra) delete next[id];
      return next;
    });
  }, [broadcasters]);
  const fitTilesInput = broadcasters.map((u) => {
    const known = tileAspects[u.id];
    const broadcasting = !!(u.cam || u.screen || (u.id === me.id && (cam || screen)));
    return {
      id: u.id,
      ar: known?.ar ?? 4 / 3,
      audioOnly: known ? known.audioOnly : !broadcasting,
      big: bigId === u.id,
    };
  });
  const { ref: tilesRef, fit: tileFit } = useTileFit(fitTilesInput);
  const tileBox = (id: string) => tileFit.sizes.find((s) => s.id === id);
  const visibleMsgs = messages.filter((m) => (m.kind === 'system' || !isIgnored(m.from)) && !(m.kind === 'chat' && m.parentId));
  const modBot = users.find((u) => u.modBot) ?? null;
  const people = users.filter((u) => !u.modBot);
  const sortedUsers = [...people].sort((a, b) => Number(b.cam || b.mic) - Number(a.cam || a.mic) || a.nick.localeCompare(b.nick));
  const canActOn = (u: UserInfo) => u.id !== me.id && (isStaff ? rank[me.role] > rank[u.role] : isOwner ? rank[u.role] < 2
    : isRoomMod && rank[u.role] < 2 && u.nick !== initial.ownerNick && !(u.accountId != null && modIds.has(u.accountId)));


  const toggleWatch = (nick: string) => {
    setUnwatched((prev) => {
      const next = new Set(prev);
      const key = nick.toLowerCase();
      if (next.has(key)) next.delete(key); else next.add(key);
      saveUnwatch(initial.id, next);
      return next;
    });
  };
  const onGripDown = (item: DockItem, e: ReactPointerEvent) => {
    if (!dockWide() || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const p = clampDockGhost(ev.clientX - 8, ev.clientY - 28);
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const slot = hit?.closest('[data-dock-slot]')?.getAttribute('data-dock-slot');
      setGhost({ item, x: p.x, y: p.y });
      setDragOver(slot === 'stage' || slot === 'rail' ? slot : null);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const slot = hit?.closest('[data-dock-slot]')?.getAttribute('data-dock-slot');
      setGhost(null);
      setDragOver(null);
      if (slot !== 'stage' && slot !== 'rail') return;
      setDocks((cur) => {
        const nextStage: DockItem = slot === 'stage' ? item : (item === 'cams' ? 'people' : 'cams');
        if (nextStage === cur.stage) return cur;
        const next = { stage: nextStage };
        saveDock(next);
        return next;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    move(e.nativeEvent);
  };
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px) and (max-height: 520px)');
    const apply = () => setSplitOn(!mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  useEffect(() => {
    if (!splitOn) return;
    const clamp = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const inner = stage.getBoundingClientRect().height - 12;
      if (inner < 300) return;
      const min = Math.max(0.18, 120 / inner);
      const max = Math.min(0.82, 1 - 180 / inner);
      if (min >= max) return;
      setSplit((cur) => Math.min(max, Math.max(min, cur)));
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [splitOn]);
  const splitDrag = useRef(false);
  const onSplitDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    // A click after mouseup has no button held. Do not start another drag from it.
    if (splitDrag.current || e.button !== 0 || e.buttons === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const stage = stageRef.current;
    const handle = e.currentTarget;
    if (!stage) return;
    const pointer = e.pointerId;
    splitDrag.current = true;
    let next = split;
    const move = (ev: PointerEvent) => {
      if (!splitDrag.current || ev.pointerId !== pointer) return;
      if (ev.buttons === 0) { end(); return; }
      const r = stage.getBoundingClientRect();
      const inner = r.height - 12;
      if (inner < 300) return;
      const min = Math.max(0.18, 120 / inner);
      const max = Math.min(0.82, 1 - 180 / inner);
      if (min >= max) return;
      const raw = (ev.clientY - r.top) / inner;
      next = Math.min(max, Math.max(min, raw));
      setSplit(next);
    };
    const leaveWindow = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer || ev.relatedTarget) return;
      end();
    };
    const end = () => {
      if (!splitDrag.current) return;
      splitDrag.current = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('pointerout', leaveWindow);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('blur', end);
      try { if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer); } catch { /* already released */ }
      setSplit(next);
      saveSplit(next);
    };
    try { handle.setPointerCapture(pointer); } catch { /* window listeners still end the drag */ }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('pointerout', leaveWindow);
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);
  };
  const resetSplit = () => { setSplit(DEFAULT_SPLIT); saveSplit(DEFAULT_SPLIT); };
  const peopleDrag = useRef(false);
  const onPeopleSplitDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (peopleDrag.current || e.button !== 0 || e.buttons === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const body = bodyRef.current;
    const handle = e.currentTarget;
    if (!body) return;
    const pointer = e.pointerId;
    const leftSide = peopleSide === 'left';
    peopleDrag.current = true;
    let next = peopleW;
    const move = (ev: PointerEvent) => {
      if (!peopleDrag.current || ev.pointerId !== pointer) return;
      if (ev.buttons === 0) { end(); return; }
      const r = body.getBoundingClientRect();
      const max = Math.min(560, Math.max(160, r.width - 28 - 320));
      const raw = leftSide ? ev.clientX - r.left - 14 : r.right - 14 - ev.clientX;
      next = Math.min(max, Math.max(160, raw));
      setPeopleW(next);
    };
    const leaveWindow = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer || ev.relatedTarget) return;
      end();
    };
    const end = () => {
      if (!peopleDrag.current) return;
      peopleDrag.current = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('pointerout', leaveWindow);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('blur', end);
      try { if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer); } catch { /* already released */ }
      setPeopleW(next);
      savePeopleSplit(next);
    };
    try { handle.setPointerCapture(pointer); } catch { /* window listeners still end the drag */ }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('pointerout', leaveWindow);
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);
  };
  const resetPeopleSplit = () => { setPeopleW(DEFAULT_PEOPLE_SPLIT); savePeopleSplit(DEFAULT_PEOPLE_SPLIT); };
  const watchCam = (u: UserInfo) => {
    setStripCollapsed(false);
    if (unwatched.has(u.nick.toLowerCase())) toggleWatch(u.nick);
    setBigId(u.id);
    setPeopleOpen(false);
  };
  const switchRoom = async (r: RoomSummary, password?: string) => {
    if (r.id === initial.id) return;
    if (r.passwordRequired && password === undefined) {
      setJoinAsk(r);
      setJoinDraft('');
      setSideTab('rooms');
      setPanelCollapsed(false);
      if (!wide) setPanelOpen(true);
      return;
    }
    try {
      const res = await call<{ room: RoomState }>((ack) => socket.emit('room:join', password ? { roomId: r.id, password } : { roomId: r.id }, ack));
      onJoined(res.room, password);
      setJoinAsk(null);
      setJoinDraft('');
      setRailOpen(false);
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  const peopleNeedle = peopleQuery.trim().toLowerCase();
  const shownUsers = peopleNeedle ? sortedUsers.filter((u) => u.nick.toLowerCase().includes(peopleNeedle)) : sortedUsers;
  const shownMod = modBot && (!peopleNeedle || modBot.nick.toLowerCase().includes(peopleNeedle)) ? modBot : null;
  const stageItem: DockItem = wide ? docks.stage : 'cams';
  const railItem: DockItem = stageItem === 'cams' ? 'people' : 'cams';
  const cameraDock = (
          <div className="video-area">
            <button type="button" className="btn ghost dock-grip cams-grip" title="Move cameras" aria-label="Move cameras" onPointerDown={(e) => onGripDown('cams', e)}><Icon name="grip" /></button>
          <section ref={tilesRef} className={`tiles n${Math.min(broadcasters.length, 9)} ${bigId ? 'has-big' : ''} ${tileFit.scroll ? 'can-scroll' : ''} ${tileFit.row ? 'row-scroll' : ''}`} data-tile-scroll={tileFit.scroll ? '1' : '0'}>
            {broadcasters.length === 0 && (
              <div className="empty-stage">
                <p>No one is on cam yet.</p>
                <p className="muted small">
                  {guestCamLocked ? <>Register a free account to go live. You can still chat, watch and use your mic.</>
                    : <>Hit <strong>Start cam</strong> to go live - up to {LIMITS.maxBroadcastersPerRoom} people can broadcast at once.</>}
                </p>
              </div>
            )}
            {broadcasters.map((u) => {
              const isSelf = u.id === me.id;
              return (
                <VideoTile
                  key={u.nick}
                  user={isSelf ? selfUser : u}
                  stream={isSelf ? localStream : streams[u.id] ?? null}
                  shareAudio={isSelf || !u.screen ? null : shareAudio[u.id] ?? null}
                  isSelf={isSelf}
                  muted={mutedIds.has(u.id)}
                  big={bigId === u.id}
                  speaking={isSelf ? (mic && selfSpeaking) : !!(u.mic && remoteSpeaking[u.id])}
                  onClick={() => setBigId((b) => (b === u.id ? null : u.id))}
                  onToggleMute={() => setMutedIds((prev) => { const n = new Set(prev); n.has(u.id) ? n.delete(u.id) : n.add(u.id); return n; })}
                  unwatched={!isSelf && unwatched.has(u.nick.toLowerCase())}
                  onToggleWatch={() => toggleWatch(u.nick)}
                  viewPref={isSelf ? undefined : viewPrefs[u.nick.toLowerCase()] ?? 'full'}
                  onViewPref={isSelf ? undefined : (p) => setViewPrefs((prev) => { const n = { ...prev }; const k = u.nick.toLowerCase(); if (p === 'full') delete n[k]; else n[k] = p; return n; })}
                  notice={isSelf ? vqNotice : null}
                  onDockGrip={wide ? (e) => onGripDown('cams', e) : undefined}
                  box={tileBox(u.id)}
                  onLayout={(info) => onTileLayout(u.id, info)}
                  onClipSaved={(sec) => {
                    toast(`Saved a ${sec}s clip (download)`);
                    void call((ack) => socket.emit('clip:saved', { userId: u.id }, ack)).catch(() => {});
                  }}
                  onClipError={(msg) => toast(msg, 'error')}
                />
              );
            })}
          </section>
          {watchOpen && (
            <Lazy fallback={panelFallback} inline><WatchPanel
              watch={watch}
              skewMs={watchSkew}
              canControl={!watchLocked || isOwner || isStaff}
              locked={watchLocked}
              isCreator={isOwner}
              onClose={() => setWatchOpen(false)}
              toast={toast}
            /></Lazy>
          )}
          <Lazy fallback={null} inline><Whiteboard open={boardOpen} canClear={canManageRoom} initial={initial.board ?? []} /></Lazy>
          </div>

  );
  // Escape closes the innermost open thing and focus goes back to the control that opened it.
  // The chat log announces new lines politely, but not the history burst on join.
  const [logLive, setLogLive] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setLogLive(true), 1500); return () => window.clearTimeout(t); }, []);
  const byAction = (a: string) => () => document.querySelector<HTMLElement>(`.room [data-action="${a}"]`);
  useEscape(boardOpen, () => setBoardOpen(false), byAction('more'));
  useEscape(watchOpen, () => setWatchOpen(false), byAction('more'));
  useEscape(railOpen, () => setRailOpen(false), byAction('open-rail'));
  useEscape(panelOpen, () => setPanelOpen(false), byAction('collapse-panel'));
  useEscape(!!thread, () => setThread(null));
  useEscape(peopleOpen, () => setPeopleOpen(false), byAction('more'));
  useEscape(moreOpen, () => setMoreOpen(false), byAction('more'));
  useEscape(plusOpen, () => setPlusOpen(false), byAction('composer-plus'));
  useEscape(!!menuFor, () => setMenuFor(null));
  useEscape(!!blockFor, () => setBlockFor(null));
  const botsRef = useRef<HTMLFormElement>(null);
  const pwRef = useRef<HTMLFormElement>(null);
  useModal(botsRef, () => setBotsOpen(false), botsOpen);
  useModal(pwRef, () => setPwOpen(false), pwOpen);
  const videoLive = cam || screen || broadcasters.some((u) => u.id !== me.id && !u.away && !!(u.cam || u.screen));
  const stripOpen = boardOpen || watchOpen || (videoLive && !stripCollapsed);
  const audienceLabel = 'Stage mode: only speakers can use camera and mic. Raise your hand to ask.';
  const mediaControls = (
    <div className={`people-media${wide ? '' : ' is-bar'}${stageOn ? ' is-stage' : ''}`} onClick={(e) => e.stopPropagation()} role="toolbar" aria-label="Camera, microphone, and screen share">
      {wide && <p className="people-media-kicker">{stageOn ? (amSpeaker ? 'On stage' : 'In the audience') : 'Camera and mic'}</p>}
      <div className="people-media-row">
        {!amSpeaker && (
          <div className={`people-media-cell stage-hand-cell${myHand ? ' is-on' : ''}`}>
            <button type="button" className={`btn icon-act toggle stage-hand-btn${myHand ? ' on' : ''}`} aria-pressed={myHand} title={myHand ? 'Lower your hand' : 'Raise your hand to ask to speak'} aria-label={myHand ? 'Lower hand' : 'Raise hand'} onClick={() => stageHand(!myHand)} data-action="stage-hand"><span aria-hidden="true">✋</span></button>
            <span className="people-media-name" aria-hidden="true">{myHand ? 'Hand up' : 'Raise hand'}</span>
          </div>
        )}
        {stageOn && amSpeaker && stage.speakers.includes(me.id) && !canRoomManage && (
          <div className="people-media-cell stage-leave-cell">
            <button type="button" className="btn ghost icon-act stage-leave-btn" title="Leave the stage (back to the audience)" aria-label="Leave stage" onClick={() => stageDown(me.id)} data-action="stage-leave"><span aria-hidden="true">⬇</span></button>
            <span className="people-media-name" aria-hidden="true">Leave stage</span>
          </div>
        )}
        <div className={`people-media-cell${cam ? ' is-on' : ''}`}>
          <IconAction label={!amSpeaker ? audienceLabel : guestCamLocked ? 'Register a free account to go on cam' : screen ? 'Stop screen share first' : cam ? 'Cam on' : 'Start cam'} icon="cam" className={`toggle ${cam ? 'on' : ''} ${guestCamLocked || !amSpeaker ? 'locked' : ''}`} disabled={mediaBusy || screen || !amSpeaker} onClick={() => setMedia('video', !cam)} aria-pressed={cam} data-action="cam" />
          <span className="people-media-name" aria-hidden="true">{cam ? 'Cam on' : 'Cam'}</span>
        </div>
        <div className={`people-media-cell${mic ? ' is-on' : ''}`}>
          <IconAction label={!amSpeaker ? audienceLabel : mic ? 'Mic on' : 'Start mic'} icon="mic" className={`toggle ${mic ? 'on' : ''} ${selfSpeaking ? 'speaking' : ''} ${!amSpeaker ? 'locked' : ''}`} disabled={mediaBusy || !amSpeaker} onClick={() => setMedia('audio', !mic)} aria-pressed={mic} data-action="mic" />
          <span className="people-media-name" aria-hidden="true">{selfSpeaking && mic ? 'Mic live' : mic ? 'Mic on' : 'Mic'}</span>
        </div>
        <div className={`people-media-cell${screen ? ' is-on' : ''}`}>
          <IconAction label={!amSpeaker ? audienceLabel : guestCamLocked ? 'Register to share your screen' : screen ? 'Stop sharing' : 'Share screen. For sound, share a Chrome tab and tick Share tab audio.'} icon="screen" className={`toggle ${screen ? 'on' : ''} ${guestCamLocked || !amSpeaker ? 'locked' : ''}`} disabled={mediaBusy || guestCamLocked || !amSpeaker} onClick={() => void toggleScreen()} aria-pressed={screen} data-action="screen" />
          <span className="people-media-name" aria-hidden="true">{screen ? 'Sharing' : 'Share'}</span>
        </div>
        <div className="people-media-cell">
          <IconAction label="Audio & video settings" icon="settings" className="ghost" disabled={mediaBusy} onClick={() => setAvOpen(true)} data-action="av-settings" />
          <span className="people-media-name" aria-hidden="true">Devices</span>
        </div>
      </div>
    </div>
  );
  const stageSpeakers = stageOn ? shownUsers.filter((u) => stage.speakers.includes(u.id)) : [];
  const stageAudience = stageOn ? shownUsers.filter((u) => !stage.speakers.includes(u.id)) : [];
  const handQueue = stageOn && canRoomManage && stage.hands.length > 0 && (
    <div className="stage-hands" data-testid="stage-hands" onClick={(e) => e.stopPropagation()}>
      <p className="stage-hands-title">✋ Raised hands <span className="muted small">{stage.hands.length}</span></p>
      <ul>
        {stage.hands.map((h) => (
          <li key={h.id}>
            <span className="stage-hands-nick">{h.nick}</span>
            <button type="button" className="btn primary small-btn" onClick={() => stageInvite(h.id)} data-action="stage-approve" disabled={stage.speakers.length >= stage.cap} title={stage.speakers.length >= stage.cap ? `Stage is full (${stage.cap}). Move someone down first.` : 'Let them use camera and mic'}>Bring up</button>
            <button type="button" className="btn ghost small-btn" onClick={() => stageDown(h.id)} data-action="stage-lower">Lower</button>
          </li>
        ))}
      </ul>
    </div>
  );
  const renderUser = (u: UserInfo) => (
              <li key={u.id} className={`user ${isIgnored(u.nick) ? 'ignored' : ''}`}>
                <button className="user-row" onClick={(e) => { e.stopPropagation(); if (u.id !== me.id) setMenuFor(menuFor === u.id ? null : u.id); }} data-nick={u.nick}>
                  <UserAvatar nick={u.nick} accountId={u.accountId} chatColor={u.chatColor} hasAvatar={u.hasAvatar} size={28} />
                  <span className="user-id">
                    <NickLabel nick={u.nick} chatColor={u.chatColor} chatEffect={u.chatEffect} className="nick" />
                    <span className="user-badges">
                      {!u.id.startsWith('bot:') && <BadgeIcons ids={u.badges} />}
                      {initial.ownerNick === u.nick && <span className="tag owner" title="Room owner">owner</span>}
                      {u.accountId != null && modIds.has(u.accountId) && initial.ownerNick !== u.nick && <span className="tag room-mod" title="Room moderator" data-room-mod="1">mod</span>}
                      {u.id.startsWith('bot:') && <span className="tag" title="Chat bot">BOT</span>}
                      <RoleTag role={u.role} />
                      {u.id === me.id && <span className="muted small">you</span>}
                      {u.screen && <span className="tag cam" title="Sharing screen">screen</span>}
                      {u.mic && <span className="tag mic" title="On mic">mic</span>}
                      {stageOn && handOf(u.id) && <span className="stage-hand-tag" title="Hand raised" data-hand="1" aria-label="Hand raised">✋</span>}
                    </span>
                  </span>
                </button>
                  {(u.cam || u.screen) && (
                    <button
                      type="button"
                      className="cam-jump"
                      title="Watch cam"
                      aria-label={`Watch ${u.nick}`}
                      data-action="watch-cam"
                      onClick={(e) => { e.stopPropagation(); watchCam(u); }}
                    >
                      <Icon name="cam" />
                      <span className="tag cam">cam</span>
                    </button>
                  )}
                {menuFor === u.id && (
                  <div className="menu" onClick={(e) => e.stopPropagation()}>
                    {!u.id.startsWith('bot:') && <BadgeCard ids={u.badges} />}
                    {u.registered && u.accountId != null && !u.id.startsWith('bot:') && <button data-action="view-profile" onClick={() => openProfile(u.nick)}>View profile</button>}
                    {!u.id.startsWith('whip:') && !u.id.startsWith('bot:') && <button onClick={() => { openPm({ id: u.id, nick: u.nick }); setMenuFor(null); }}>Private message</button>}
                    {canWhisper(u) && <button data-action="whisper" onClick={() => { startWhisper(u); setMenuFor(null); setPeopleOpen(false); }}>🤫 Whisper</button>}
                    {canWhisper(u) && whisperTargets(u).map((c) => (
                      <button key={c.info.id} data-action="whisper-add" onClick={() => { addToWhisper(c.info.id, u); setMenuFor(null); setPeopleOpen(false); }}>🤫 Add to {whisperLabel(c.info, me.id)}</button>
                    ))}
                    {(u.cam || u.mic || u.screen) && <button onClick={() => { setBigId(u.id); setMenuFor(null); }}>Watch</button>}
                    {stageOn && canRoomManage && !u.id.startsWith('bot:') && !u.id.startsWith('whip:') && (
                      stage.speakers.includes(u.id)
                        ? (stageInvited(u) && <button data-action="stage-down" onClick={() => { stageDown(u.id); setMenuFor(null); }}>Move to audience</button>)
                        : <button data-action="stage-invite" onClick={() => { stageInvite(u.id); setMenuFor(null); }}>Bring up to speak</button>
                    )}
                    <button data-action="block" onClick={() => { toggleIgnore(u.nick); setMenuFor(null); }}>{isIgnored(u.nick) ? 'Unblock' : 'Block'}</button>
                    <button onClick={() => reportUser(u)} data-action="report-user">Report…</button>
                    {canActOn(u) && !u.id.startsWith('bot:') && !u.id.startsWith('whip:') && (
                      <>
                        <div className="menu-sep">Moderation</div>
                        {isStaff && u.cam && <button onClick={() => camOff(u)} data-action="camoff">Turn cam off</button>}
                        {isStaff && <button onClick={() => mute(u)} data-action="mute">Mute in chat…</button>}
                        {!initial.isPrivate && <button onClick={() => roomMute(u)} data-action="room-mute">Mute in this room…</button>}
                        {(isOwner || isStaff) && !initial.isPrivate && u.registered && u.accountId != null && initial.ownerNick !== u.nick && (
                          <button onClick={() => setRoomMod(u, !modIds.has(u.accountId!))} data-action="room-mod">{modIds.has(u.accountId) ? 'Remove room mod' : 'Make room mod'}</button>
                        )}
                        <button className="danger" onClick={() => kick(u)} data-action="kick">Kick from room</button>
                        <button className="danger" onClick={() => roomBan(u)} data-action="room-ban">Ban from room…</button>
                        {isStaff && <button className="danger" onClick={() => siteBan(u)} data-action="site-ban">Site ban…</button>}
                      </>
                    )}
                  </div>
                )}
              </li>
  );
  const peopleDock = (
        <div className="users panel" onClick={(e) => e.stopPropagation()}>
          <div className="users-head">
            <h3 data-online={people.length}>{people.length} Online</h3>
            <button type="button" className="btn ghost small-btn people-toggle" onClick={() => setPeopleOpen(false)} data-action="people-close">Close</button>
          </div>
          <input className="people-search" value={peopleQuery} onChange={(e) => setPeopleQuery(e.target.value)} placeholder="Search" aria-label="Search people" />
          <div className="users-scroll">
          {handQueue}
          <ul>
            {shownMod && (
              <li key={shownMod.id} className="user modbot" data-modbot="1">
                <div className="user-row modbot" title="Automated moderator" data-nick={shownMod.nick} onClick={(e) => e.stopPropagation()}>
                  <UserAvatar nick={shownMod.nick} accountId={shownMod.accountId} chatColor={shownMod.chatColor} hasAvatar={shownMod.hasAvatar} size={28} />
                  <NickLabel nick={shownMod.nick} chatColor={shownMod.chatColor} chatEffect={shownMod.chatEffect} className="nick" />
                  <span className="tag role-modbot" title="Automated moderator">mod bot</span>
                </div>
              </li>
            )}
            {stageOn ? (
              <>
                <li className="people-section" data-section="speakers">Speakers <span className="muted small">{stage.speakers.length}/{stage.cap}</span></li>
                {stageSpeakers.map(renderUser)}
                <li className="people-section" data-section="audience">Audience <span className="muted small">{stageAudience.length}</span></li>
                {stageAudience.length === 0 && <li className="people-empty muted small">No one in the audience</li>}
                {stageAudience.map(renderUser)}
              </>
            ) : shownUsers.map(renderUser)}
          </ul>
          <p className="muted small hint">Click a name to message, block or report{canRoomManage ? ', or moderate' : ''}.</p>
          </div>
          {wide && mediaControls}
        </div>
  );


  return (
    <EmoteContext.Provider value={emoteLookup}>
    <div className={`room shell${peopleOpen ? ' people-open' : ''}${railOpen ? ' rail-open' : ''}${panelOpen ? ' panel-open' : ''}${panelCollapsed ? ' panel-collapsed' : ''}`} data-accent={theme?.accent ? '1' : undefined} style={theme?.accent ? ({ ['--room-accent' as string]: theme.accent } as CSSProperties) : undefined} onClick={() => { if (menuFor) setMenuFor(null); if (blockFor) setBlockFor(null); if (peopleOpen) setPeopleOpen(false); if (moreOpen) setMoreOpen(false); if (plusOpen) setPlusOpen(false); if (railOpen) setRailOpen(false); if (panelOpen) setPanelOpen(false); }}>
      <SiteBar me={me} account={account} onAccount={onAccount} toast={toast} signOut={signOut} openAdmin={openAdmin} wantAccount={wantAccount} onAudioVideo={() => setAvOpen(true)}
        onFriends={account ? () => { try { sessionStorage.setItem('zn.lobbyOpen', 'friends'); } catch { /* ignore */ } onLeave(); } : undefined}
        onStartRoom={() => { try { sessionStorage.setItem('zn.lobbyOpen', 'create'); } catch { /* ignore */ } onLeave(); }}>
        <IconAction label="Rooms" icon="home" className="ghost" data-action="nav-rooms" onClick={onLeave} />
        <RadioPlayer />
        <IconAction label="Room list" icon="rail" className="ghost drawer-toggle" data-action="open-rail" onClick={() => { setRailOpen((v) => !v); setPanelOpen(false); }} />
      </SiteBar>
      <div ref={bodyRef} className="room-body">
        <nav className="icon-rail" aria-label="Rooms" onClick={(e) => e.stopPropagation()} {...(!wide && !railOpen ? { inert: '' } : {})}>
          <button type="button" className="rail-btn home" title="Rooms" aria-label="Rooms" data-action="rail-home" onClick={onLeave}><Icon name="home" /></button>
          {roomList.map((r) => { const icon = r.id === initial.id ? iconUrl : r.iconUrl; return (
            <button
              key={r.id}
              type="button"
              className={`rail-btn${r.id === initial.id ? ' on' : ''}${icon ? ' has-icon' : ''}`}
              title={`${r.name} · ${r.users} online`}
              aria-label={(unreadMap?.[r.id]?.n ?? 0) > 0 && r.id !== initial.id ? `${r.name}, ${unreadMap![r.id].n} unread${unreadMap![r.id].mention ? ', mentioned' : ''}` : r.name}
              aria-current={r.id === initial.id ? 'true' : undefined}
              data-rail-room={r.id}
              onClick={() => { void switchRoom(r); }}
            >
              {icon ? <img className="rail-icon" src={icon} alt={r.name} width={46} height={46} decoding="async" data-rail-icon={r.id} /> : (r.name || '?').slice(0, 1).toUpperCase()}
              {r.id !== initial.id && (unreadMap?.[r.id]?.n ?? 0) > 0 && <span className={`rail-badge${unreadMap![r.id].mention ? ' mention' : ''}`} data-rail-unread={r.id} aria-hidden="true">{unreadMap![r.id].mention ? '@' : unreadBadge(unreadMap![r.id].n)}</span>}
            </button>
          ); })}
        </nav>
        <div className="people-backdrop" onClick={(e) => { e.stopPropagation(); setPeopleOpen(false); }} aria-hidden={!peopleOpen} />
        {(railOpen || panelOpen) && <div className="drawer-backdrop" onClick={(e) => { e.stopPropagation(); setRailOpen(false); setPanelOpen(false); }} />}
        {peopleDock}
        <main ref={stageRef} className="stage center-col">
        <section
          className={`media-strip dock-slot${stripOpen ? ' is-open' : ' is-collapsed'}`}
          data-media-strip={stripOpen ? 'open' : 'collapsed'}
          data-streaming={videoLive ? '1' : '0'}
          aria-label="Cameras"
          {...(!stripOpen ? { inert: '' } : {})}
        >
          {cameraDock}
        </section>
        <GamesSlot />
        <div className="chat-stage">
        <div className="chat-head">
          {iconUrl
            ? <img className="room-head-thumb room-head-icon" src={iconUrl} alt="" width={40} height={40} data-room-head-icon="1" />
            : thumbUrl
            ? <img className="room-head-thumb" src={thumbUrl} alt="" width={40} height={40} data-room-head-thumb="1" />
            : <UserAvatar nick={initial.name} size={40} />}
          <div className="room-title">
          <span className="room-name">#{initial.name}{locked ? ' 🔒' : ''}{passwordRequired ? ' · password' : ''}{slowModeSec ? ` · slow ${slowModeSec}s` : ''}{initial.isPrivate ? ' · private' : ''}{(unread?.n ?? 0) > 0 && <span className={`badge${unread?.mention ? ' mention' : ''}`} data-unread="room">{unreadBadge(unread!.n)}</span>}</span>
          {editingTopic !== null ? (
            <form onSubmit={saveTopic} className="topic-form">
              <input autoFocus value={editingTopic} maxLength={LIMITS.roomTopicMax} onChange={(e) => setEditingTopic(e.target.value)} aria-label="Room topic" />
              <button className="btn primary small-btn">Save</button>
              <button type="button" className="btn ghost small-btn" onClick={() => setEditingTopic(null)}>Cancel</button>
            </form>
          ) : (
            <span className="muted small topic" data-testid="topic">
              {topic}
              {canManageRoom && <button className="icon-btn" title="Edit topic" aria-label="Edit topic" onClick={() => setEditingTopic(topic)}>✎</button>}
            </span>
          )}
        </div>
        <div className="controls">
          <div className="more-wrap" ref={moreRef} onClick={(e) => e.stopPropagation()}>
            <IconAction label="More" icon="more" className={`ghost${moreOpen ? ' on' : ''}`} aria-expanded={moreOpen} aria-haspopup="menu" data-action="more" onClick={() => setMoreOpen((v) => !v)} />
            {moreOpen && (
              <div className="more-menu" role="menu" aria-label="More">
                <GamesButton onOpen={() => { setMoreOpen(false); onGames(); }} />
                {me.registered && !initial.isPrivate && <MoreItem icon="bell" label="Notifications" title="Notifications" data-action="notify" onClick={() => { setMoreOpen(false); setNotifyOpen(true); }} />}
                <MoreItem icon="board" label="Board" title="Board" className={boardOpen ? 'on' : ''} aria-pressed={boardOpen} data-action="board" onClick={() => { setMoreOpen(false); setBoardOpen((v) => !v); }} />
                <MoreItem icon="sounds" label="Sounds" title="Sounds" data-action="sounds" onClick={() => { setMoreOpen(false); setSoundsOpen(true); }} />
                <MoreItem icon="fx" label="Effects" title="Full-screen effects" data-action="effects" onClick={() => { setMoreOpen(false); setFxOpen(true); }} />
                <MoreItem icon="watch" label="Watch" title="Watch together (YouTube or Twitch)" className={watchOpen ? 'on' : ''} aria-pressed={watchOpen} data-action="watch" onClick={() => { setMoreOpen(false); setWatchOpen((v) => !v); }} />
                {canInvite && (
                  <MoreItem icon="link" label="Copy invite link" title="Copy invite link" data-action="copy-invite" onClick={() => { setMoreOpen(false); void loadInvites().then((m) => m.copyDefaultInvite(initial.id, toast)); }} />
                )}
                {canManageRoom && (
                  <MoreItem icon="key" label={passwordRequired ? 'Password on' : 'Password'} title={passwordRequired ? 'Password on' : 'Room password'} className={passwordRequired ? 'on' : ''} data-action="room-password" onClick={() => { setMoreOpen(false); setPwDraft(''); setPwOpen(true); }} />
                )}
                {canManageRoom && !initial.isPrivate && (
                  <MoreItem icon="image" label="Thumbnail" title="Room thumbnail" className={thumbUrl ? 'on' : ''} data-action="room-thumb" onClick={() => { setMoreOpen(false); openSide('info'); }} />
                )}
                {isOwner && !initial.isPrivate && (
                  <MoreItem icon="bot" label="Bots" title="Bots" data-action="room-bots" onClick={async () => {
                    setMoreOpen(false);
                    setBotsOpen(true);
                    try {
                      const r = await call<{ bots: { id: number; name: string }[] }>((ack) => socket.emit('room:bots', ack));
                      setAllowedBots(r.bots);
                    } catch (err) { toast((err as Error).message, 'error'); }
                  }} />
                )}
                {canManageRoom && (
                  <MoreItem icon={locked ? 'lock' : 'unlock'} label={locked ? 'Locked' : 'Lock'} title={locked ? 'Locked' : 'Lock room'} className={locked ? 'on' : ''} data-action="lock" onClick={() => { setMoreOpen(false); act((ack) => socket.emit('room:lock', { locked: !locked }, ack)); }} />
                )}
                {canManageRoom && (
                  <MoreItem icon="slow" label={slowModeSec ? `Slow ${slowModeSec}s` : 'Slow off'} title={slowModeSec ? `Slow ${slowModeSec}s` : 'Slow off'} data-action="slowmode" onClick={() => {
                    setMoreOpen(false);
                    const opts = LIMITS.slowModePresetsSec;
                    const i = opts.indexOf(slowModeSec as typeof opts[number]);
                    const next = opts[(i + 1) % opts.length] ?? 0;
                    act((ack) => socket.emit('room:slowmode', { seconds: next }, ack));
                  }} />
                )}
                {canManageRoom && (
                  <MoreItem icon="purge" label="Purge" title="Purge" data-action="purge" onClick={() => {
                    setMoreOpen(false);
                    setDialog({
                      title: 'Purge recent chat?', description: 'Soft-deletes messages from the last hour in this room for everyone.', confirm: 'Purge', danger: true,
                      onSubmit: () => actStrict((ack) => socket.emit('room:purge', { minutes: 60 }, ack)),
                    });
                  }} />
                )}
                {canManageRoom && !initial.permanent && (
                  <MoreItem icon="trash" label="Delete" title="Delete" data-action="delete-room" onClick={() => { setMoreOpen(false); deleteRoom(); }} />
                )}
                <MoreItem icon="people" label={`People (${people.length})`} title={`People (${people.length})`} aria-expanded={peopleOpen} data-action="people" onClick={(e) => { e.stopPropagation(); setMoreOpen(false); setPeopleOpen((o) => !o); }} />
                <MoreItem icon="leave" label="Leave" title="Leave room" data-action="leave" onClick={() => { setMoreOpen(false); onLeave(); }} />
              </div>
            )}
          </div>
          <span className="count-pill" title="People in this room">{people.length}</span>
          <IconAction label={stripOpen ? 'Hide cameras' : 'Show cameras'} icon={stripOpen ? 'eyeOff' : 'eye'} className={`ghost${stripOpen ? ' on' : ''}`} aria-expanded={stripOpen} data-action="toggle-strip" onClick={(e) => { e.stopPropagation(); setStripCollapsed((v) => !v); }} />
          <IconAction label={wide && panelCollapsed ? 'Show side panel' : 'Hide side panel'} icon="panel" className="ghost" data-action="collapse-panel" onClick={() => { if (!wide) { setPanelOpen((v) => !v); setRailOpen(false); return; } setPanelCollapsed((v) => !v); }} />
        </div>
        </div>

          <section className="chat">
            <WhisperStrip convs={whispers} open={openWhisper} setOpen={setOpenWhisper} selfId={me.id} isIgnored={isIgnored} toast={toast} onReport={(m) => setReportTarget({ kind: 'whisper', messageId: m.id, from: m.from, preview: m.text })} />
            <RoomThemeHeader theme={theme && theme.welcome && welcomeHidden === theme.welcome ? { ...theme, welcome: null } : theme} onDismiss={() => { if (theme?.welcome) { setWelcomeHidden(theme.welcome); try { localStorage.setItem(welcomeKey, theme.welcome); } catch { /* private mode */ } } }} />
            <AnnouncementBanner key={announcement?.at ?? 0} roomId={initial.id} ann={announcement} />
            {nextEvent && <EventBanner ev={nextEvent} onOpen={() => openSide('events')} />}
            {radio.np && (radioHere > 0 || radio.playing) && <div className="np-room"><NowPlayingCard np={radio.np} here={radioHere} compact /></div>}
            {pins.length > 0 && (
              <div className={`pin-list${pinsCollapsed ? ' is-collapsed' : ''}`} data-pins={pins.length}>
                <button type="button" className="pin-bar-head" aria-expanded={!pinsCollapsed} onClick={() => togglePinsCollapsed()} data-action="pins-toggle">
                  <span aria-hidden="true">📌</span> <span>Pinned <span className="muted small">{pins.length}</span></span>
                  {pinsCollapsed && pins[0] && <span className="pin-bar-peek muted small">{pins[0].from}: {pins[0].text.replace(/\s+/g, ' ').slice(0, 60)}</span>}
                  <span className="pin-bar-caret" aria-hidden="true">{pinsCollapsed ? '▾' : '▴'}</span>
                </button>
                {!pinsCollapsed && pins.filter((pin) => !isIgnored(pin.from)).map((pin) => (
                  <div key={pin.id} className="pin-row">
                    <button type="button" className="pin" data-pin={pin.id} onClick={() => { void jumpToMessage(pin.id); }} title="Jump to message">
                      <b>{pin.from}</b>: {pin.text.replace(/\s+/g, ' ').slice(0, 120)}{pin.parentId ? <span className="muted small"> · in a thread</span> : null}
                    </button>
                    {canRoomManage && <button type="button" className="icon-btn pin-unpin" title="Unpin" aria-label={`Unpin message from ${pin.from}`} onClick={() => togglePin(pin)} data-action="unpin">✕</button>}
                  </div>
                ))}
              </div>
            )}
            <div className="chat-log" ref={logRef} role="log" aria-label={`Chat in #${initial.name}`} aria-live={logLive ? 'polite' : 'off'} aria-relevant="additions" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
              {visibleMsgs.map((m, i) => {
                const prev = visibleMsgs[i - 1];
                const sep = !prev || dayKey(prev.ts) !== dayKey(m.ts);
                const line = m.kind === 'system' ? (
                  <div key={m.id} className="msg system"><span className="ts">{fmtTime(m.ts)}</span> {m.text}</div>
                ) : m.announce ? (
                  <div key={m.id} className="msg announce-line" data-msg={m.id} data-announce="1">
                    <span className="ann-ic" aria-hidden>📢</span>
                    <div className="msg-body">
                      <span className="msg-meta"><b className="ann-room">#{initial.name}</b> <span className="muted">· {m.announce.by === 'Event reminder' ? 'event reminder' : `scheduled by ${m.announce.by}`}</span> <span className="ts">{fmtTime(m.ts)}</span></span>
                      <ChatText text={m.text} className="text" />
                      {canRoomManage && <span className="msg-actions"><button className="icon-btn" title="Delete message" aria-label="Delete announcement" onClick={() => (mineMsg(m) || !isStaff ? deleteOwn(m) : deleteMsg(m))} data-action="room-delete-msg">🗑</button></span>}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className={`msg line ${m.fromId === me.id || (!m.fromId && m.from === me.nick) ? 'mine' : ''} ${me.accountId && m.mentions?.includes(me.accountId) ? 'mentioned' : ''}${jumpHit === m.id ? ' jump-hit' : ''}`} data-msg={m.id}>
                    <UserAvatar nick={m.from} accountId={m.accountId} chatColor={m.chatColor} hasAvatar={m.hasAvatar} size={32} />
                    <div className="msg-body">
                    <span className="msg-meta">
                    {m.from.toLowerCase() === me.nick.toLowerCase() ? (
                      <NickLabel nick={m.from} chatColor={m.chatColor} chatEffect={m.chatEffect} className="from" />
                    ) : (
                      <span className="name-block">
                        <button type="button" className="name-btn" data-action="user-name" onClick={(e) => { e.stopPropagation(); if (m.accountId != null && !m.fromId.startsWith('bot:')) openProfile(m.from); else setBlockFor(blockFor === m.id ? null : m.id); }}>
                          <NickLabel nick={m.from} chatColor={m.chatColor} chatEffect={m.chatEffect} className="from" />
                        </button>
                        {blockFor === m.id && (
                          <span className="menu name-menu" onClick={(e) => e.stopPropagation()}>
                            <button type="button" data-action="block" onClick={() => { toggleIgnore(m.from); setBlockFor(null); }}>{isIgnored(m.from) ? 'Unblock' : 'Block'}</button>
                            {(() => { const u = users.find((x) => x.id === m.fromId); return u && canWhisper(u) ? <button type="button" data-action="whisper" onClick={() => { startWhisper(u); setBlockFor(null); }}>🤫 Whisper</button> : null; })()}
                          </span>
                        )}
                      </span>
                    )}
                    {m.role && m.role !== 'user' && m.role !== 'guest' && <> <RoleTag role={m.role} /></>}
                    {m.accountId != null && modIds.has(m.accountId) && m.from !== initial.ownerNick && <> <span className="tag room-mod" title="Room moderator">mod</span></>}
                    <span className="ts">{fmtTime(m.ts)}</span>
                    </span>
                    {m.hidden && !canRoomManage ? <span className="msg-hidden" data-hidden="1">Hidden pending review</span> : <>
                    {m.hidden && <span className="tag tag-warn msg-hidden-tag" data-hidden="1" title="Auto-hidden after several reports; others see a collapsed line">Hidden pending review</span>}
                    {m.burn ? <BurnBody id={m.id} text={m.text} burn={m.burn} onLocalBurn={onLocalBurn} toast={toast} /> : m.voice ? <VoicePlayer voice={m.voice} /> : m.poll ? <PollCard poll={m.poll} canClose={mineMsg(m) || canRoomManage} toast={toast} onPoll={applyMyPoll} /> : <ChatText text={m.text} className="text" />}
                    </>}
                    {m.editedAt ? editedMark(m) : null}
                    {m.preview && account?.linkPreviews !== false && !m.burn && !(m.hidden && !canRoomManage) && <LinkPreviewCard messageId={m.id} preview={m.preview} canRemove={mineMsg(m)} onRemove={() => removePreview(m)} />}
                    {!m.burn && (m.replyCount ?? 0) > 0 && (
                      <button type="button" className="icon-btn reply-count" data-action="open-thread" onClick={() => openThread(m)}>{m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}</button>
                    )}
                    {!m.burn && !(m.hidden && !canRoomManage) && <span className="reactions">
                      {REACTION_EMOJIS.map((emoji) => {
                        const hit = m.reactions?.find((r) => r.emoji === emoji);
                        return (
                          <button key={emoji} type="button" className={`react ${hit?.mine ? 'mine' : ''} ${hit ? 'on' : ''}`} onClick={() => reactTo(m.id, emoji)} data-action="react" title="React">
                            {emoji}{hit ? <span className="react-n">{hit.count}</span> : null}
                          </button>
                        );
                      })}
                      {(m.reactions ?? []).filter((r) => r.emoji.startsWith(':')).map((r) => {
                        const em = emoteByName.get(r.emoji.slice(1, -1));
                        if (!em) return null;
                        return (
                          <button key={r.emoji} type="button" className={`react custom on ${r.mine ? 'mine' : ''}`} onClick={() => reactTo(m.id, r.emoji)} data-action="react" data-react-custom={em.name} title={r.emoji}>
                            <img src={em.url} alt={r.emoji} width={18} height={18} loading="lazy" /><span className="react-n">{r.count}</span>
                          </button>
                        );
                      })}
                      {emotes.length > 0 && (
                        <span className="react-more-wrap">
                          <button type="button" className="react react-more" data-action="react-more" aria-label="React with a room emoji" aria-expanded={reactPick === m.id} title="Room emoji" onClick={(e) => { e.stopPropagation(); setReactPick((v) => (v === m.id ? null : m.id)); }}>＋</button>
                          {reactPick === m.id && (
                            <span className="react-pick" role="menu" aria-label="Room emoji" data-testid="react-pick" onClick={(e) => e.stopPropagation()}>
                              {emotes.slice(0, 50).map((em) => (
                                <button key={em.id} type="button" role="menuitem" className="react-pick-item" title={`:${em.name}:`} data-react-pick={em.name} onClick={() => { setReactPick(null); reactTo(m.id, `:${em.name}:`); }}>
                                  <img src={em.url} alt={`:${em.name}:`} width={24} height={24} loading="lazy" />
                                </button>
                              ))}
                            </span>
                          )}
                        </span>
                      )}
                    </span>}
                    <span className="msg-actions">
                      {!m.burn && <button className="icon-btn" title="Reply in thread" aria-label="Reply in thread" onClick={() => openThread(m)} data-action="reply-thread">↩</button>}
                      {canEditMsg(m) && <button className="icon-btn" title="Edit message (for 10 minutes after sending)" aria-label="Edit message" onClick={() => startEdit(m)} data-action="edit-msg">✎</button>}
                      {mineMsg(m) && <button className="icon-btn" title="Delete message" aria-label="Delete your message" onClick={() => deleteOwn(m)} data-action="delete-own">🗑</button>}
                      {m.from !== me.nick && !(m.burn && (m.burn.burned || burnedLocal.has(m.id))) && <button className="icon-btn" title="Report message" aria-label="Report message" onClick={() => reportMsg(m)} data-action="report-msg">⚑</button>}
                      {isStaff && !mineMsg(m) && <button className="icon-btn" title="Delete message" aria-label="Delete message" onClick={() => deleteMsg(m)} data-action="delete-msg">🗑</button>}
                      {!isStaff && canRoomManage && !mineMsg(m) && m.role !== 'admin' && m.role !== 'moderator' && (isOwner || m.from !== initial.ownerNick) && <button className="icon-btn" title="Delete message" aria-label="Delete message" onClick={() => deleteOwn(m)} data-action="room-delete-msg">🗑</button>}
                      {me.registered && !m.burn && <button className={`icon-btn${bookmarkIds.has(m.id) ? ' on' : ''}`} title={bookmarkIds.has(m.id) ? 'Remove bookmark' : 'Bookmark'} aria-label={bookmarkIds.has(m.id) ? 'Remove bookmark' : 'Bookmark message'} aria-pressed={bookmarkIds.has(m.id)} onClick={() => void toggleBookmark(m)} data-action="bookmark">{bookmarkIds.has(m.id) ? '★' : '☆'}</button>}
                      {canRoomManage && !m.burn && <button className="icon-btn" title={pins.some((pin) => pin.id === m.id) ? 'Unpin' : 'Pin'} aria-label={pins.some((pin) => pin.id === m.id) ? 'Unpin message' : 'Pin message'} onClick={() => togglePin(m)} data-action="pin-msg">{pins.some((pin) => pin.id === m.id) ? 'Unpin' : 'Pin'}</button>}
                    </span>
                    </div>
                  </div>
                );
                return (
                  <div key={sep ? `d-${m.id}` : m.id} className="msg-wrap">
                    {sep && <div className="day-sep" role="separator">{dayLabel(m.ts)}</div>}
                    {m.id === firstUnreadId && <div className="new-divider" role="separator" data-testid="new-messages-divider">New messages</div>}
                    {line}
                  </div>
                );
              })}
            </div>
            {typers.filter((tp) => !isIgnored(tp.nick)).length > 0 && (
              <div className="typing-line" data-typing="1">{typers.filter((tp) => !isIgnored(tp.nick)).map((tp) => tp.nick).join(', ')} {typers.filter((tp) => !isIgnored(tp.nick)).length === 1 ? 'is' : 'are'} typing…</div>
            )}
            {editingId && (
              <div className="editing-banner">Editing your message <button type="button" className="btn ghost small-btn" onClick={() => { setEditingId(null); setText(''); }}>Cancel</button></div>
            )}
            <form className="chat-form" onSubmit={send}>
              <div className="composer-plus" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="btn ghost icon-act" title="More message tools" aria-label="More message tools" aria-expanded={plusOpen} data-action="composer-plus" onClick={() => setPlusOpen((v) => !v)}><Icon name="plus" /></button>
                {plusOpen && (
                  <div className="plus-menu" role="menu" aria-label="Message tools">
                    <label className="plus-item" title="Upload image">
                      Upload image
                      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => { uploadImage(e.target.files?.[0] ?? null); e.target.value = ''; setPlusOpen(false); }} />
                    </label>
                    {!editingId && (
                      <div className={`plus-item burn-plus${burnOn ? ' on' : ''}`}>
                        <span>Burn after reading</span>
                        <BurnToggle armed={burnOn} ttl={burnTtl} onArmed={setBurnOn} onTtl={setBurnTtl} />
                      </div>
                    )}
                    {!editingId && <button type="button" className="plus-item" data-action="new-poll" onClick={() => { setPlusOpen(false); setPollDraft({ question: '', options: [] }); }}>📊 Poll</button>}
                    {account && onAccount && <NameStylePicker account={account} onAccount={onAccount} toast={toast} />}
                    <button type="button" className={`plus-item${pingMuted ? ' on' : ''}`} data-action="ping-mute" onClick={() => setPingMuted((v) => { const next = !v; try { localStorage.setItem(`${APP_NAME.toLowerCase()}.pingMute`, next ? '1' : '0'); } catch { /* ignore */ } return next; })}>{pingMuted ? 'Unmute mention sounds' : 'Mute mention sounds'}</button>
                  </div>
                )}
              </div>
              <input ref={chatInputRef} className={burnOn && !editingId ? 'burn-armed' : undefined} value={text} onChange={(e) => { setText(e.target.value); if (!editingId) noteTyping(!!e.target.value.trim()); }} onBlur={() => noteTyping(false)} maxLength={LIMITS.messageMax} placeholder={editingId ? 'Edit message' : burnOn ? `🔥 Burn message (${burnTtl}s after viewing)` : `Message #${initial.name}`} aria-label="Chat message" />
              {text.length > LIMITS.messageMax - 80 && <span className="counter">{LIMITS.messageMax - text.length}</span>}
              <div className="composer-tools">
                <GifPicker enabled={!!gifs} value={text} onChange={setText} inputRef={chatInputRef} />
                <EmojiPicker value={text} onChange={setText} inputRef={chatInputRef} emotes={emotes} />
                {!editingId && burnOn && <button type="button" className="btn ghost burn-btn on" data-action="burn-disarm" title={`Burn on: next message disappears ${burnTtl}s after viewing. Click to turn off.`} aria-label="Turn off burn after reading" onClick={() => setBurnOn(false)}>🔥</button>}
                {!editingId && !burnOn && <VoiceNoteButton roomId={initial.id} toast={toast} />}
              </div>
              <button className="btn primary">{editingId ? 'Save' : 'Send'}</button>
            </form>
            {thread && (
              <div className="thread-panel" role="dialog" aria-label="Thread">
                <div className="thread-head">
                  <strong>Thread</strong>
                  <span className="muted small thread-count">{thread.messages.length} {thread.messages.length === 1 ? 'reply' : 'replies'}</span>
                  <button type="button" className="btn ghost small-btn" onClick={() => setThread(null)} data-action="close-thread">Close</button>
                </div>
                <blockquote className="thread-quote" data-testid="thread-quote">
                  <span className="thread-quote-from">{thread.parent.from} <span className="ts">{fmtTime(thread.parent.ts)}</span></span>
                  <span className="thread-quote-text">{thread.parent.burn ? '🔥 Burn message' : thread.parent.voice ? '🎤 Voice note' : thread.parent.text.replace(/\s+/g, ' ').slice(0, 280)}</span>
                  <button type="button" className="btn ghost small-btn thread-jump" onClick={() => { const id = thread.parent.id; setThread(null); void jumpToMessage(id); }} data-action="thread-jump">Jump to message</button>
                </blockquote>
                <div className="chat-log" role="log" aria-label="Thread replies" aria-live="polite" aria-relevant="additions">
                  {thread.messages.filter((m): m is Extract<ChatMessage, { kind: 'chat' }> => m.kind === 'chat' && !isIgnored(m.from)).map((m) => (
                    <div key={m.id} className={`msg${jumpHit === m.id ? ' jump-hit' : ''}`} data-msg={m.id}>
                      <span className="ts">{fmtTime(m.ts)}</span>{' '}
                      {m.from.toLowerCase() === me.nick.toLowerCase() ? (
                        <NickLabel nick={m.from} chatColor={m.chatColor} chatEffect={m.chatEffect} className="from" />
                      ) : (
                        <span className="name-block">
                          <button type="button" className="name-btn" data-action="user-name" onClick={(e) => { e.stopPropagation(); if (m.accountId != null && !m.fromId.startsWith('bot:')) openProfile(m.from); else setBlockFor(blockFor === `t:${m.id}` ? null : `t:${m.id}`); }}>
                            <NickLabel nick={m.from} chatColor={m.chatColor} chatEffect={m.chatEffect} className="from" />
                          </button>
                          {blockFor === `t:${m.id}` && (
                            <span className="menu name-menu" onClick={(e) => e.stopPropagation()}>
                              <button type="button" data-action="block" onClick={() => { toggleIgnore(m.from); setBlockFor(null); }}>{isIgnored(m.from) ? 'Unblock' : 'Block'}</button>
                              {(() => { const u = users.find((x) => x.id === m.fromId); return u && canWhisper(u) ? <button type="button" data-action="whisper" onClick={() => { startWhisper(u); setBlockFor(null); }}>🤫 Whisper</button> : null; })()}
                            </span>
                          )}
                        </span>
                      )}{' '}
                      {m.burn ? <BurnBody id={m.id} text={m.text} burn={m.burn} onLocalBurn={onLocalBurn} toast={toast} /> : m.voice ? <VoicePlayer voice={m.voice} /> : <ChatText text={m.text} className="text" />}
                      {m.kind === 'chat' && m.editedAt ? editedMark(m) : null}
                      {m.preview && !m.burn && <LinkPreviewCard messageId={m.id} preview={m.preview} canRemove={mineMsg(m)} onRemove={() => removePreview(m)} />}
                    </div>
                  ))}
                  {thread.messages.length === 0 && <div className="msg system">No replies yet.</div>}
                </div>
                <form className="chat-form" onSubmit={sendThread}>
                  <input className={threadBurnOn ? 'burn-armed' : undefined} value={threadText} onChange={(e) => setThreadText(e.target.value)} maxLength={LIMITS.messageMax} placeholder={threadBurnOn ? `🔥 Burn reply (${threadBurnTtl}s after viewing)` : 'Reply in thread'} aria-label="Thread reply" />
                  <BurnToggle armed={threadBurnOn} ttl={threadBurnTtl} onArmed={setThreadBurnOn} onTtl={setThreadBurnTtl} />
                  {!threadBurnOn && <VoiceNoteButton roomId={initial.id} parentId={thread.parent.id} toast={toast} />}
                  <button className="btn primary">Reply</button>
                </form>
              </div>
            )}
          </section>
        </div>
        </main>
        <aside className="side-panel" hidden={wide && panelCollapsed} {...(!wide && !panelOpen ? { inert: '' } : {})} onClick={(e) => e.stopPropagation()} aria-label="Side panel">
          <div className="side-tabs" role="tablist" aria-label="Side panel">
            <button type="button" className={sideTab === 'rooms' ? 'on' : ''} role="tab" aria-selected={sideTab === 'rooms'} data-action="tab-rooms" onClick={() => setSideTab('rooms')} title="Rooms" aria-label="Rooms"><Icon name="home" /></button>
            <button type="button" className={sideTab === 'info' ? 'on' : ''} role="tab" aria-selected={sideTab === 'info'} data-action="tab-info" onClick={() => setSideTab('info')} title="Room info" aria-label="Room info"><Icon name="board" /></button>
            {!initial.isPrivate && <button type="button" className={`${sideTab === 'events' ? 'on' : ''}${nextEvent ? ' has-dot' : ''}`} role="tab" aria-selected={sideTab === 'events'} data-action="tab-events" onClick={() => setSideTab('events')} title="Events" aria-label="Events"><Icon name="calendar" /></button>}
            {me.registered && <button type="button" className={sideTab === 'search' ? 'on' : ''} role="tab" aria-selected={sideTab === 'search'} data-action="tab-search" onClick={() => setSideTab('search')} title="Search messages" aria-label="Search messages"><Icon name="search" /></button>}
            {me.registered && <button type="button" className={sideTab === 'saved' ? 'on' : ''} role="tab" aria-selected={sideTab === 'saved'} data-action="tab-saved" onClick={() => setSideTab('saved')} title="Bookmarks" aria-label="Bookmarks"><Icon name="bookmark" /></button>}
            {canRoomManage && !initial.isPrivate && <button type="button" className={sideTab === 'stats' ? 'on' : ''} role="tab" aria-selected={sideTab === 'stats'} data-action="tab-stats" onClick={() => setSideTab('stats')} title="Room stats" aria-label="Room stats"><Icon name="stats" /></button>}
          </div>
          {sideTab === 'rooms' && (
            <div className="side-body">
              <h3>Rooms</h3>
              <ul className="side-rooms">
                {roomList.map((r) => (
                  <li key={r.id}>
                    <button type="button" className={r.id === initial.id ? 'on' : ''} data-room={r.id} onClick={() => { void switchRoom(r); }}>
                      <span className="room-name"><RoomIconMini url={r.id === initial.id ? iconUrl : r.iconUrl} />#{r.name}</span>
                      <span className="muted small">{r.users} {r.users === 1 ? 'person' : 'people'}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {joinAsk && (
                <form className="side-join" onSubmit={(e) => { e.preventDefault(); void switchRoom(joinAsk, joinDraft); }}>
                  <p className="muted small">#{joinAsk.name} needs a password.</p>
                  <input type="password" value={joinDraft} onChange={(e) => setJoinDraft(e.target.value)} aria-label="Room password" autoComplete="off" />
                  <button className="btn primary small-btn" type="submit">Join</button>
                </form>
              )}
            </div>
          )}
          {sideTab === 'events' && <Lazy fallback={panelFallback} inline><EventsPanel events={events} canManage={canManageEvents || canRoomManage} registered={me.registered} roomName={initial.name} toast={toast} /></Lazy>}
          {sideTab === 'search' && <Lazy fallback={panelFallback} inline><SearchPanel registered={me.registered} roomName={initial.name} people={users.filter((u) => !u.id.startsWith("bot:")).map((u) => u.nick)} onJump={onSearchJump} /></Lazy>}
          {sideTab === 'saved' && <Lazy fallback={panelFallback} inline><SavedPanel version={savedVersion} currentRoomId={initial.id} onJump={onSavedJump} onRemove={(id) => {
            void call((ack) => socket.emit('bookmark:toggle', { messageId: id, on: false }, ack)).catch(() => {});
            setBookmarkIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
          }} /></Lazy>}
          {sideTab === 'stats' && canRoomManage && !initial.isPrivate && <Lazy fallback={panelFallback} inline><StatsPanel roomName={initial.name} toast={toast} /></Lazy>}
          {sideTab === 'info' && (
            <div className="side-body">
              {!initial.isPrivate && (isOwner || isStaff) && <RoomThemeSettings key={`${theme?.accent}|${theme?.welcome}`} roomId={initial.id} theme={theme} toast={toast} />}
              {!initial.isPrivate && <RoomThumbEditor roomId={initial.id} thumbUrl={thumbUrl} canEdit={canManageRoom} onChange={setThumbUrl} toast={toast} />}
              {!initial.isPrivate && (canRoomManage || stageOn) && (
                <section className="stage-settings" data-testid="stage-settings">
                  <h4>Stage mode</h4>
                  {canManageRoom ? (
                    <label className="check-row"><input type="checkbox" checked={stageOn} onChange={(e) => setStageMode({ on: e.target.checked })} data-action="stage-toggle" /> <span>Only speakers can use camera and mic</span></label>
                  ) : <p className="small">{stageOn ? 'On: only speakers can use camera and mic.' : 'Off.'}</p>}
                  <label className="field stage-cap">
                    <span>Speakers at once</span>
                    <select value={stage.cap} onChange={(e) => setStageMode({ cap: Number(e.target.value) })} disabled={!canManageRoom} data-action="stage-cap">
                      {STAGE_CAP_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  <p className="muted small" data-testid="stage-cost">
                    Video here is peer to peer: every speaker sends a separate stream to each viewer, so {stage.cap} speakers × {Math.max(1, people.length - 1)} viewers ≈ {stage.cap * Math.max(1, people.length - 1)} streams. Fewer speakers keep it smooth on phones and slow connections.
                  </p>
                  {stageOn && <p className="small">{stageSpeakers.length} speaking · {stage.hands.length} hand{stage.hands.length === 1 ? '' : 's'} up</p>}
                </section>
              )}
              {!initial.isPrivate && <RoomIconEditor roomId={initial.id} roomName={initial.name} iconUrl={iconUrl} canEdit={canManageRoom} onChange={setIconUrl} toast={toast} />}
              {canInvite && <Lazy fallback={null} inline><InvitePanel roomId={initial.id} canSkipPassword={canManageRoom} passwordRequired={passwordRequired} modsCanInvite={modsCanInvite} toast={toast} /></Lazy>}
              <h3>#{initial.name}</h3>
              <p className="muted">{topic || 'No topic yet.'}</p>
              {(category || tags.length > 0) && <p className="room-meta-line" data-room-meta="1"><CategoryTag category={category} /> <TagList tags={tags} /></p>}
              <ul className="side-facts">
                <li>{people.length} {people.length === 1 ? 'person' : 'people'} here</li>
                {initial.ownerNick && <li>Owner {initial.ownerNick}</li>}
                {mods.length > 0 && <li data-room-mods={mods.length}>Room mods: {mods.map((m) => m.username).join(', ')}</li>}
                <li>{locked ? 'Locked' : 'Open'}</li>
                <li>{passwordRequired ? 'Password required' : 'No password'}</li>
                <li>{slowModeSec ? `Slow mode ${slowModeSec}s` : 'Slow mode off'}</li>
                {initial.isPrivate && <li>Private call</li>}
              </ul>
              {!initial.isPrivate && canManageRoom && (
                <details className="manage-sec" data-section="room-meta">
                  <summary>Category and tags</summary>
                  <Lazy fallback={panelFallback} inline><RoomMetaEditor category={category} tags={tags} toast={toast} /></Lazy>
                </details>
              )}
              {!initial.isPrivate && canRoomManage && (
                <>
                  <details className="manage-sec" data-section="announcement">
                    <summary>Announcement banner{announcement ? ' · on' : ''}</summary>
                    <Lazy fallback={panelFallback} inline><AnnouncementEditor ann={announcement} toast={toast} /></Lazy>
                  </details>
                  <details className="manage-sec" data-section="filters">
                    <summary>Slow mode, word and link filters{slowModeSec ? ` · slow ${slowModeSec}s` : ''}</summary>
                    <SlowModeRow seconds={slowModeSec} canSet={isStaff || isOwner} toast={toast} />
                    <Lazy fallback={panelFallback} inline><FiltersPanel toast={toast} /></Lazy>
                  </details>
                  <details className="manage-sec" data-section="schedules">
                    <summary>Scheduled announcements{schedules.length ? ` · ${schedules.length}` : ''}</summary>
                    <Lazy fallback={panelFallback} inline><SchedulePanel schedules={schedules} toast={toast} /></Lazy>
                  </details>
                </>
              )}
              {!initial.isPrivate && canRoomManage && (
                <details className="manage-sec" data-section="reports" open={roomReports.open + roomReports.review > 0 ? true : undefined}>
                  <summary>Reports{roomReports.open + roomReports.review > 0 ? ` · ${roomReports.open + roomReports.review}` : ''}</summary>
                  <p className="muted small">Reports about messages in this room. Reporters stay anonymous to room moderators.</p>
                  <Lazy fallback={panelFallback} inline><ModQueue mode="room" roomId={initial.id} toast={toast} /></Lazy>
                </details>
              )}
              {!initial.isPrivate && canManageRoom && (
                <details className="manage-sec" data-section="emotes">
                  <summary>Room emotes{emotes.length ? ` · ${emotes.length}` : ''}</summary>
                  <Lazy fallback={panelFallback} inline><EmoteManager roomId={initial.id} emotes={emotes} toast={toast} /></Lazy>
                </details>
              )}
              {!initial.isPrivate && !isOwner && (
                <p className="room-report"><button type="button" className="link-btn" data-action="report-room" onClick={() => setReportTarget({ kind: 'room', roomId: initial.id, name: initial.name })}>Report this room…</button></p>
              )}
              {!initial.isPrivate && !canManageRoom && emotes.length > 0 && (
                <p className="emote-strip" data-emote-strip={emotes.length}>{emotes.slice(0, 24).map((e) => <img key={e.id} src={e.url} alt={`:${e.name}:`} title={`:${e.name}:`} width={28} height={28} loading="lazy" />)}</p>
              )}
            </div>
          )}
        </aside>
      </div>
      {!wide && mediaControls}
      {ghost && <div className="dock-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden>{ghost.item === 'cams' ? 'Cameras' : 'People'}</div>}
      {historyFor && <EditHistory h={historyFor} onClose={() => setHistoryFor(null)} />}
      {avOpen && <Lazy fallback={null} inline><AvSettings open={avOpen} onClose={() => setAvOpen(false)} onApply={applyAvDevices} camOn={cam && !screen} micOn={mic} blocked={ignored} onUnblock={toggleIgnore} quality={vq} onQuality={changeQuality} shareMode={shareMode} onShareMode={changeShareMode} bg={bgPref} onBg={changeBg} bgNote={bgNote} noise={noisePref} onNoise={changeNoise} /></Lazy>}
      {dialog && <Dialog spec={dialog} onClose={() => setDialog(null)} />}
      {notifyOpen && <NotifyDialog roomName={initial.name} onClose={() => setNotifyOpen(false)} />}
      {reportTarget && <ReportDialog target={reportTarget} onClose={() => setReportTarget(null)} toast={toast} registered={me.registered} />}
      {pollDraft && <PollDialog initial={pollDraft} onClose={() => setPollDraft(null)} toast={toast} />}
      {profileFor && (() => {
        const u = users.find((x) => x.nick.toLowerCase() === profileFor.toLowerCase());
        return (
          <Lazy fallback={null} inline><ProfileCard
            nick={profileFor}
            onClose={() => setProfileFor(null)}
            toast={toast}
            isIgnored={isIgnored(profileFor)}
            toggleIgnore={() => toggleIgnore(profileFor)}
            openPm={openPm}
            onWhisper={u && canWhisper(u) ? () => startWhisper(u) : undefined}
            roomMod={!!u && u.accountId != null && modIds.has(u.accountId)}
            onReport={(p) => { setProfileFor(null); setReportTarget(u ? { kind: 'user', userId: u.id, accountId: p.id, nick: p.username } : { kind: 'user', accountId: p.id, nick: p.username }); }}
            onOpenRoom={(roomId) => { const r = roomList.find((x) => x.id === roomId); if (r) { setProfileFor(null); void switchRoom(r); } else toast('That room is not open right now', 'error'); }}
          /></Lazy>
        );
      })()}
      {fxOpen && <Lazy fallback={null} inline><FxPanel onClose={() => setFxOpen(false)} onPlay={(id) => { void playFx(id).then((ok) => { if (ok) setFxOpen(false); }); }} /></Lazy>}
      {soundsOpen && (
        <Lazy fallback={null} inline><SoundsPanel
          roomId={initial.id}
          clips={sounds}
          isOwner={isOwner}
          onClose={() => setSoundsOpen(false)}
          onPlay={(id) => { void call((ack) => socket.emit('sound:play', { id }, ack)).catch((e) => toast((e as Error).message, 'error')); }}
          onChange={setSounds}
          toast={toast}
        /></Lazy>
      )}
      {botsOpen && (
        <div className="modal-backdrop" onClick={() => setBotsOpen(false)}>
          <form ref={botsRef} className="modal panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Room bots" onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await call<{ bot: { id: number; name: string } }>((ack) => socket.emit('room:bot-allow', { name: botName.trim() }, ack));
              setAllowedBots((prev) => prev.some((b) => b.id === r.bot.id) ? prev : [...prev, r.bot]);
              setBotName('');
              toast(`${r.bot.name} can join this room`);
            } catch (err) { toast((err as Error).message, 'error'); }
          }}>
            <h3>Bots</h3>
            <p className="muted small">Only you, the room creator, can allow a bot. It chats under its own name. No cam, mic, screen share, or private messages.</p>
            <p className="small"><a href="/docs/bots">Bot API docs</a></p>
            <label className="whip-field">
              <span className="muted small">Allow by display name</span>
              <input value={botName} maxLength={20} onChange={(e) => setBotName(e.target.value)} aria-label="Bot name to allow" placeholder="Bot name" data-action="allow-bot-name" />
            </label>
            <ul className="bot-list">
              {allowedBots.length === 0 && <li className="muted small">No bots allowed yet.</li>}
              {allowedBots.map((b) => (
                <li key={b.id} className="bot-row">
                  <span>{b.name}</span>
                  <button type="button" className="btn small-btn ghost" data-action="remove-bot" onClick={async () => {
                    try {
                      await call((ack) => socket.emit('room:bot-remove', { botId: b.id }, ack));
                      setAllowedBots((prev) => prev.filter((x) => x.id !== b.id));
                      toast(`${b.name} removed`);
                    } catch (err) { toast((err as Error).message, 'error'); }
                  }}>Remove</button>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setBotsOpen(false)}>Close</button>
              <button className="btn primary" data-action="allow-bot" disabled={!botName.trim()}>Allow</button>
            </div>
          </form>
        </div>
      )}
      {pwOpen && (
        <div className="modal-backdrop" onClick={() => setPwOpen(false)}>
          <form ref={pwRef} className="modal panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Room password" onSubmit={async (e) => {
            e.preventDefault();
            try {
              await call((ack) => socket.emit('room:password', { password: pwDraft }, ack));
              onPasswordChange?.(pwDraft);
              setPasswordRequired(!!pwDraft.trim());
              setPwOpen(false);
              setPwDraft('');
              toast(pwDraft.trim() ? 'Room password updated' : 'Room password cleared');
            } catch (err) { toast((err as Error).message, 'error'); }
          }}>
            <h3>Room password</h3>
            <p className="muted small">{passwordRequired ? 'Enter a new password, or clear it so anyone can join.' : 'Optional. Blank leaves the room open.'}</p>
            <input type="password" autoFocus value={pwDraft} maxLength={LIMITS.passwordMax} onChange={(e) => setPwDraft(e.target.value)} aria-label="New room password" autoComplete="new-password" />
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setPwOpen(false)}>Cancel</button>
              {passwordRequired && (
                <button type="button" className="btn ghost" data-action="clear-password" onClick={async () => {
                  try {
                    await call((ack) => socket.emit('room:password', { password: '' }, ack));
                    onPasswordChange?.('');
                    setPasswordRequired(false);
                    setPwOpen(false);
                    setPwDraft('');
                    toast('Room password cleared');
                  } catch (err) { toast((err as Error).message, 'error'); }
                }}>Clear</button>
              )}
              <button className="btn primary" data-action="save-password">Save</button>
            </div>
          </form>
        </div>
      )}
    </div>
    </EmoteContext.Provider>
  );
}

function EditHistory({ h, onClose }: { h: { from: string; versions: { text: string; at: number }[]; current: { text: string; at: number } }; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose, true);
  const stamp = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={ref} className="modal panel edit-history" role="dialog" aria-modal="true" aria-label="Edit history" onClick={(e) => e.stopPropagation()} data-testid="edit-history">
        <h3>Edit history</h3>
        <p className="muted small">Message from {h.from}. Visible to the room owner, room mods and staff.</p>
        <ol className="edit-versions">
          {h.versions.map((v, i) => (
            <li key={i}><span className="ts">{i === 0 ? 'Original' : `Edit ${i}`} · {stamp(v.at)}</span><span className="edit-text">{v.text}</span></li>
          ))}
          <li className="current"><span className="ts">Now · {stamp(h.current.at)}</span><span className="edit-text">{h.current.text}</span></li>
        </ol>
        {h.versions.length === 0 && <p className="muted small">Edited before history was kept.</p>}
        <div className="modal-actions"><button type="button" className="btn primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
