import { BanAppeal } from './components/BanAppeal';
import { TwoFactorGate } from './components/TwoFactor';
import { badgeLabel, clientTimeZone } from './components/Badges';
import { isUiTheme } from '../shared/uiTheme';
import { applyUiTheme, currentUiTheme } from './uiTheme';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, EventReminder, MeResponse, PrivateMessage, Role, RoomState, UserInfo } from '../shared/types';
import { BRAND_NAME } from '../shared/config';
import { api, fetchMe } from './api';
import { setMentionUnread } from './mentions';
import { call, reconnect, socket } from './socket';
import { Login } from './components/Login';
import { ConfirmEmail, VerifyFromLink } from './components/ConfirmEmail';
import { Lobby } from './components/Lobby';
import type { PmTarget } from './components/PmDock';
import { unlockAudio } from './audioUnlock';
import { resumeSoundboard } from './soundboard';
import { bindCountdown, checkBuild, onBeforeHardReload } from './refresh';
import { clearReturn, peekReturn, rememberReturn } from './returnRoom';
import { clearAppBadge, onOpenRoom, setAppBadge, takeRoomParam } from './pwa';
import { setRoomCounts, setStaffCounts } from './modq';
import type { QueueCounts } from '../shared/modq';
import { loadIgnored, saveIgnored } from './util';
import { Lazy, lazyNamed } from './lazy';
import { clearPendingInvite, peekPendingInvite, savePendingInvite } from './invite';
import { INVITE_PATH_RE } from '../shared/inviteCode';

// Heavy or rarely used screens load on demand. The room preloads once you are signed in.
const loadRoom = () => import('./components/Room');
const Room = lazyNamed(loadRoom, 'Room');
const AdminPanel = lazyNamed(() => import('./components/AdminPanel'), 'AdminPanel');
const Browse = lazyNamed(() => import('./components/Browse'), 'Browse');
const PmDock = lazyNamed(() => import('./components/PmDock'), 'PmDock');
const loadGames = () => import('./components/GamesPanel');
const GamesDock = lazyNamed(loadGames, 'GamesDock');
const ResetPassword = lazyNamed(() => import('./components/ResetPassword'), 'ResetPassword');
const InvitePage = lazyNamed(() => import('./components/InvitePage'), 'InvitePage');
const screenFallback = <main className="login" aria-busy="true"><section className="login-card"><p className="muted">Loading…</p></section></main>;
const roomFallback = <div className="room-loading" aria-busy="true" aria-label="Loading room" />;

export interface Toast { id: number; text: string; tone?: 'error' | 'info' }
export type Account = NonNullable<MeResponse['account']>;

export default function App() {
  const [boot, setBoot] = useState<MeResponse | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  // The account's saved interface theme wins over this browser's (null = never picked: keep the local choice).
  useEffect(() => {
    const t = account?.uiTheme;
    if (isUiTheme(t) && t !== currentUiTheme()) applyUiTheme(t);
  }, [account?.id, account?.uiTheme]);
  const [me, setMe] = useState<UserInfo | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  /** Bumped on socket reconnect so Room remounts (fresh mesh + history). Same room id would otherwise keep stale peers. */
  const [roomEpoch, setRoomEpoch] = useState(0);
  const [connected, setConnected] = useState(false);
  // Only show "Connecting…" when it takes a while: a normal load connects in well under a second,
  // and flashing the banner pushed the whole page down and back up (layout shift).
  const [slowConnect, setSlowConnect] = useState(false);
  useEffect(() => {
    if (connected) { setSlowConnect(false); return; }
    const t = window.setTimeout(() => setSlowConnect(true), 1200);
    return () => window.clearTimeout(t);
  }, [connected]);
  /** Server stayed down long enough to be an upgrade, not a network blip. */
  const [restarting, setRestarting] = useState(false);
  const [restartSec, setRestartSec] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ignored, setIgnored] = useState<Set<string>>(loadIgnored);
  const [pms, setPms] = useState<Record<string, { nick: string; messages: PrivateMessage[]; unread: number }>>({});
  const [pmOpen, setPmOpen] = useState<string | null>(null);
  /** Unread room messages for rooms this client is not looking at. Client only. */
  const [roomUnread, setRoomUnread] = useState<Record<string, { n: number; mention: boolean }>>({});
  const [loginMode, setLoginMode] = useState<'signin' | 'register'>('signin');
  const [emailNagHidden, setEmailNagHidden] = useState(() => { try { return sessionStorage.getItem('camchat.emailNag') === '1'; } catch { return false; } });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [path, setPath] = useState(location.pathname);
  const [inviteTick, setInviteTick] = useState(0);
  const [inviteAskPw, setInviteAskPw] = useState<{ id: string; name: string; n: number } | null>(null);
  const inviteBusy = useRef(false);
  const [gamesOpen, setGamesOpen] = useState(false);
  const session = useRef<{ nick: string | null; roomId: string | null; account: Account | null; roomPassword: string | null; roomInvite?: string | null }>({ nick: null, roomId: null, account: null, roomPassword: null });
  const wasConnected = useRef(false);
  /** This tab was in a room when the socket dropped, so the next login should keep the peer connections. */
  const resumeMedia = useRef(false);
  const restartingRef = useRef(false);
  const restartTimer = useRef<number | null>(null);
  /** Ban / session end must not start the update countdown. */
  const suppressReload = useRef(false);
  const returnApplied = useRef(false);
  const pendingPmNick = useRef<string | null>(null);
  const pmOpenRef = useRef<string | null>(null);
  const pmsRef = useRef(pms);
  pmOpenRef.current = pmOpen;
  pmsRef.current = pms;

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info', ms = 4500) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  const toggleIgnore = useCallback((nick: string) => {
    setIgnored((prev) => {
      const k = nick.toLowerCase();
      if (me && k === me.nick.toLowerCase()) return prev;
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      saveIgnored(next);
      return next;
    });
  }, [me]);

  // The block list lives in this browser; signed-in accounts keep a server copy so friends-online respects it
  // both ways and on other devices. On sign-in the two lists are merged, then every change is sent.
  const ignoredRef = useRef(ignored);
  ignoredRef.current = ignored;
  const blocksSynced = useRef(false);
  useEffect(() => {
    if (!me || !account) { blocksSynced.current = false; return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await call<{ usernames: string[] }>((ack) => socket.emit('blocks:get', ack));
        if (cancelled) return;
        const merged = new Set(ignoredRef.current);
        for (const n of r.usernames) if (n.toLowerCase() !== me.nick.toLowerCase()) merged.add(n.toLowerCase());
        if (merged.size !== ignoredRef.current.size) { setIgnored(merged); saveIgnored(merged); }
        blocksSynced.current = true;
        await call((ack) => socket.emit('blocks:set', { usernames: [...merged] }, ack));
      } catch { /* offline: the next sign-in syncs */ }
    })();
    return () => { cancelled = true; };
  }, [me?.id, account?.id]);
  useEffect(() => {
    if (!blocksSynced.current || !account) return;
    socket.emit('blocks:set', { usernames: [...ignored] }, () => {});
  }, [ignored]);

  // batch W: blocking from a whisper adds the person to this browser's list too, so blocks:set keeps them.
  useEffect(() => {
    const on = (e: Event) => {
      const k = String((e as CustomEvent<string>).detail ?? '').toLowerCase();
      if (!k) return;
      setIgnored((prev) => { if (prev.has(k)) return prev; const next = new Set(prev); next.add(k); saveIgnored(next); return next; });
    };
    window.addEventListener('zn:block', on);
    return () => window.removeEventListener('zn:block', on);
  }, []);
  useEffect(() => {
    if (!account) return;
    const q = new URLSearchParams(location.search);
    if (!q.has('whispers')) return;
    const who = q.get('whispers');
    const t = window.setTimeout(() => window.dispatchEvent(new CustomEvent('zn:open-whispers', { detail: who && who !== '1' ? who : undefined })), 300);
    return () => window.clearTimeout(t);
  }, [account?.id]);

  // Once signed in, fetch the room and games code in the background so joining stays instant.
  const signedIn = !!me;
  useEffect(() => {
    if (!signedIn) return;
    const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const go = () => { void loadRoom().catch(() => {}); void loadGames().catch(() => {}); };
    if (idle) idle(go, { timeout: 3000 }); else window.setTimeout(go, 1200);
  }, [signedIn]);

  useEffect(() => {
    if (!room) return;
    setRoomUnread((prev) => {
      if (!prev[room.id]) return prev;
      const next = { ...prev };
      delete next[room.id];
      return next;
    });
  }, [room?.id]);
  useEffect(() => {
    const base = room ? `${room.name} · ${BRAND_NAME}` : BRAND_NAME;
    const n = Object.values(roomUnread).reduce((sum, r) => sum + r.n, 0);
    document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${base}` : base;
  }, [room, roomUnread]);
  // Moderation queue: staff badge counts + a toast per new report; warnings and report outcomes for everyone.
  const staffRole = me?.role === 'admin' || me?.role === 'moderator';
  useEffect(() => {
    if (!staffRole) { setStaffCounts({ open: 0, review: 0, resolved: 0, dismissed: 0 }); return; }
    const onCounts = (p: { counts: QueueCounts; fresh?: boolean }) => {
      setStaffCounts(p.counts);
      if (p.fresh) toast(`New report · ${p.counts.open} open`);
    };
    const refresh = () => { socket.emit('modq:counts', (r) => { if (r.ok) setStaffCounts(r.counts); }); };
    socket.on('modq:counts', onCounts);
    socket.on('connect', refresh);
    refresh();
    return () => { socket.off('modq:counts', onCounts); socket.off('connect', refresh); };
  }, [staffRole, me?.id, toast]);
  useEffect(() => {
    const onNotice = (p: { kind: 'warn' | 'report'; text: string }) => toast(p.text, p.kind === 'warn' ? 'error' : 'info', p.kind === 'warn' ? 15_000 : 6000);
    const onRoomCounts = (p: { roomId: string; counts: QueueCounts; fresh?: boolean }) => {
      setRoomCounts(p.roomId, p.counts);
      if (p.fresh && !staffRole) toast('New report about a message in this room');
    };
    socket.on('user:notice', onNotice);
    socket.on('modq:room-counts', onRoomCounts);
    return () => { socket.off('user:notice', onNotice); socket.off('modq:room-counts', onRoomCounts); };
  }, [toast, staffRole]);
  // Installed app: unread rooms + PMs on the icon (where supported), cleared while the app is in front.
  useEffect(() => {
    const n = Object.values(roomUnread).reduce((sum, r) => sum + r.n, 0)
      + Object.values(pms).reduce((sum, c) => sum + c.unread, 0);
    setAppBadge(n);
  }, [roomUnread, pms]);
  useEffect(() => {
    const clear = () => { if (document.visibilityState === 'visible') clearAppBadge(); };
    window.addEventListener('focus', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('focus', clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);
  useEffect(() => {
    const once = () => {
      unlockAudio();
      resumeSoundboard();
      window.removeEventListener('pointerdown', once);
      window.removeEventListener('keydown', once);
    };
    window.addEventListener('pointerdown', once);
    window.addEventListener('keydown', once);
    return () => {
      window.removeEventListener('pointerdown', once);
      window.removeEventListener('keydown', once);
    };
  }, []);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (p: string) => { history.pushState(null, '', p); setPath(p); };

  const linkedRoom = useRef<string | null>(null);
  const applyReturn = () => {
    if (returnApplied.current) return;
    returnApplied.current = true;
    // A notification link (/?room=<id>) opened this window: signed-in accounts go straight to that room.
    if (linkedRoom.current && session.current.account) session.current.roomId = linkedRoom.current;
    const ret = peekReturn();
    if (!ret) return;
    if (!session.current.roomId) session.current.roomId = ret.roomId;
    if (!session.current.account && !session.current.nick && ret.nick) session.current.nick = ret.nick;
    pendingPmNick.current = ret.pmNick;
  };

  // boot: session probe + device id, then open the socket
  useEffect(() => {
    linkedRoom.current ??= takeRoomParam();
    // the email confirmation link carries an invite being followed (/verify-email?token=…&invite=<code>)
    { const inv = new URLSearchParams(location.search).get('invite'); if (inv && location.pathname === '/verify-email') savePendingInvite(inv); }
    const err = new URLSearchParams(location.search).get('authError');
    if (err) { toast(err, 'error'); history.replaceState(null, '', location.pathname); }
    onBeforeHardReload(() => {
      const id = pmOpenRef.current;
      const pmNick = id ? pmsRef.current[id]?.nick ?? null : null;
      rememberReturn({
        roomId: session.current.roomId,
        nick: session.current.account ? null : session.current.nick,
        pmNick,
      });
    });
    fetchMe().then((m) => {
      setBoot(m);
      if (m.twoFactorPending) return; // code step first; no socket until then
      setAccount(m.account);
      session.current.account = m.account;
      applyReturn();
      socket.auth = { deviceId: m.deviceId };
      socket.connect();
    }).catch(() => {
      setBoot({ account: null, deviceId: '', google: false, discord: false, tiktok: false, gifs: false, guestCamAfterMinutes: -1, captchaMode: 'builtin', captchaSiteKey: null, emailVerifyRequired: false, mailConfigured: false });
      applyReturn();
      socket.connect();
    });
  }, [toast]);

  useEffect(() => {
    bindCountdown((seconds) => {
      restartingRef.current = true;
      setRestarting(true);
      setRestartSec(seconds);
    });
  }, []);

  useEffect(() => {
    const tick = () => { void checkBuild(); };
    tick();
    const id = window.setInterval(tick, 20_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const openRememberedPm = (users: UserInfo[]) => {
      const want = pendingPmNick.current;
      if (!want) return;
      const u = users.find((x) => x.nick.toLowerCase() === want.toLowerCase() && x.id !== socket.id && !x.id.startsWith('bot:'));
      if (!u) return;
      pendingPmNick.current = null;
      setPms((prev) => ({ ...prev, [u.id]: prev[u.id] ? { ...prev[u.id], nick: u.nick, unread: 0 } : { nick: u.nick, messages: [], unread: 0 } }));
      setPmOpen(u.id);
    };
    const onConnect = async () => {
      if (restartTimer.current != null) {
        window.clearTimeout(restartTimer.current);
        restartTimer.current = null;
      }
      // Countdown owns the reload. Do not navigate just because the socket returned.
      if (restartingRef.current) return;
      suppressReload.current = false;
      void checkBuild();
      wasConnected.current = true;
      setConnected(true);
      setBlocked(null);
      // accounts log in automatically after a network blip; a guest nick is not a session
      const { account: acct } = session.current;
      if (!acct) return;
      const wantResume = resumeMedia.current && !!session.current.roomId;
      resumeMedia.current = false;
      try {
        // A busy moment (rate limit, slow answer) is not a reason to strand the account on "Signing in…":
        // retry a few times with a growing pause before giving up.
        let r: { user: UserInfo } | null = null;
        for (let attempt = 0; ; attempt++) {
          try {
            r = await call<{ user: UserInfo }>((ack) => socket.emit('login', { resume: wantResume && attempt === 0, tz: clientTimeZone() }, ack));
            break;
          } catch (err) {
            const msg = (err as Error).message || '';
            if (attempt >= 5 || !socket.connected || !/rate limit|did not respond|slow down/i.test(msg)) throw err;
            await new Promise((res) => window.setTimeout(res, 700 * (attempt + 1)));
            if (!socket.connected || session.current.account?.id !== acct.id) return;
          }
        }
        session.current.nick = r.user.nick;
        setMe(r.user);
      } catch (e) {
        session.current = { ...session.current, nick: null, roomId: null, roomPassword: null };
        pendingPmNick.current = null;
        clearReturn();
        setMe(null); setRoom(null);
        toast((e as Error).message, 'error');
        return;
      }
      const roomId = session.current.roomId;
      if (!roomId) return;
      try {
        // Password stays in this document only. After an update reload it is gone.
        const password = session.current.roomPassword || undefined;
        const invite = session.current.roomInvite || undefined;
        const j = await call<{ room: RoomState; resumed?: boolean }>((ack) => socket.emit('room:join', { roomId, ...(password ? { password } : {}), ...(invite ? { invite } : {}) }, ack));
        // A resumed blip keeps the mounted room and its peer connections. A real join rebuilds them.
        if (!j.resumed) setRoomEpoch((n) => n + 1);
        setRoomUnread((prev) => {
          if (!prev[j.room.id]) return prev;
          const next = { ...prev };
          delete next[j.room.id];
          return next;
        });
        setRoom(j.room);
        openRememberedPm(j.room.users);
        clearReturn();
      } catch (e) {
        // Room gone, locked, or needs a password we no longer have: lobby.
        session.current.roomId = null;
        session.current.roomPassword = null;
        pendingPmNick.current = null;
        clearReturn();
        setRoom(null);
        toast((e as Error).message, 'error');
      }
    };
    const onDisconnect = (reason?: string) => {
      setConnected(false);
      // Sign-in, sign-out, and ban use a client disconnect or session:ended. Do not reload for those.
      if (suppressReload.current) return;
      if (reason === 'io client disconnect') return;
      if (!wasConnected.current) return;
      // A blip is not an upgrade. checkBuild reloads only when the server build id actually changes.
      resumeMedia.current = !!session.current.roomId;
      if (restartTimer.current != null) window.clearTimeout(restartTimer.current);
      // 'io server disconnect' does not auto-reconnect. Transport drops do, but calling connect is safe.
      const delay = reason === 'io server disconnect' ? 400 : 200;
      restartTimer.current = window.setTimeout(() => {
        restartTimer.current = null;
        if (!socket.connected) socket.connect();
      }, delay);
    };
    const onConnectError = (e: Error) => {
      if (e.message.startsWith('banned: ')) { suppressReload.current = true; clearReturn(); setBlocked(e.message.slice(8)); socket.disconnect(); }
      else if (/Too many/.test(e.message)) toast(e.message, 'error');
    };
    const onEnded = (p: { reason: string }) => {
      suppressReload.current = true;
      pendingPmNick.current = null;
      clearReturn();
      session.current = { ...session.current, nick: null, roomId: null, roomPassword: null };
      setMe(null); setRoom(null); setBlocked(p.reason);
    };
    const onUserJoined = (u: UserInfo) => { openRememberedPm([u]); };
    const onRate = (p: { message: string }) => toast(p.message, 'error');
    const onKicked = (p: { by: string; reason?: string }) => {
      session.current.roomId = null;
      session.current.roomPassword = null;
      pendingPmNick.current = null;
      clearReturn();
      setRoom(null);
      toast(`You were removed from the room by ${p.by}${p.reason ? `: ${p.reason}` : ''}`, 'error');
    };
    const onRoomDeleted = () => { session.current.roomId = null; session.current.roomPassword = null; pendingPmNick.current = null; clearReturn(); setRoom(null); toast('This room was deleted', 'error'); };
    const onCallEnded = (p: { roomId: string; reason: string }) => {
      if (session.current.roomId !== p.roomId) return;
      session.current.roomId = null;
      session.current.roomPassword = null;
      pendingPmNick.current = null;
      clearReturn();
      setRoom(null);
      toast(p.reason === 'declined' ? 'Call was declined' : 'Call ended');
    };
    const onRole = (p: { role: Role }) => {
      setAccount((a) => (a ? { ...a, role: p.role as Account['role'] } : a));
      if (session.current.account) session.current.account = { ...session.current.account, role: p.role as Account['role'] };
      setMe((m) => (m ? { ...m, role: p.role } : m));
      toast(`Your role is now ${p.role}`);
    };
    const bumpRoom = (roomId: string, mention: boolean) => {
      setRoomUnread((prev) => {
        const cur = prev[roomId] ?? { n: 0, mention: false };
        return { ...prev, [roomId]: { n: cur.n + 1, mention: cur.mention || mention } };
      });
    };
    const lookingAt = (roomId: string) => session.current.roomId === roomId
      && document.visibilityState === 'visible' && document.hasFocus();
    const onActivity = (p: { roomId: string; mentions?: number[] }) => {
      if (!p?.roomId || session.current.roomId === p.roomId) return;
      const meId = session.current.account?.id;
      bumpRoom(p.roomId, !!meId && !!p.mentions?.includes(meId));
    };
    const onChat = (m: ChatMessage) => {
      if (m.kind !== 'chat') return;
      const roomId = session.current.roomId;
      if (!roomId || m.fromId === socket.id) return;
      if (lookingAt(roomId)) return;
      const meId = session.current.account?.id;
      bumpRoom(roomId, !!meId && !!m.mentions?.includes(meId));
    };
    const clearIfLooking = () => {
      const id = session.current.roomId;
      if (!id || !lookingAt(id)) return;
      setRoomUnread((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    };
    window.addEventListener('focus', clearIfLooking);
    document.addEventListener('visibilitychange', clearIfLooking);
    socket.on('room:activity', onActivity);
    socket.on('chat:message', onChat);
    socket.on('connect', onConnect);
    socket.on('user:joined', onUserJoined);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('session:ended', onEnded);
    const onBadge = ({ id }: { id: string }) => toast(`🏅 New badge: ${badgeLabel(id).replace(/^\S+\s/, '')}`);
    socket.on('badge:earned', onBadge);
    const onReminder = (r: EventReminder) => {
      const here = session.current.roomId === r.roomId;
      const where = here ? '' : ` in #${r.roomName}`;
      toast(r.stage === 'start' ? `📅 ${r.title} is starting now${where}` : `📅 ${r.title} starts in 15 min${where}`, 'info');
    };
    socket.on('event:reminder', onReminder);
    socket.on('error:rate', onRate);
    socket.on('room:kicked', onKicked);
    socket.on('room:deleted', onRoomDeleted);
    socket.on('call:ended', onCallEnded);
    socket.on('account:role', onRole);
    return () => {
      if (restartTimer.current != null) window.clearTimeout(restartTimer.current);
      window.removeEventListener('focus', clearIfLooking);
      document.removeEventListener('visibilitychange', clearIfLooking);
      socket.off('room:activity', onActivity);
      socket.off('chat:message', onChat);
      socket.off('connect', onConnect);
      socket.off('user:joined', onUserJoined);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('badge:earned', onBadge);
      socket.off('event:reminder', onReminder);
      socket.off('session:ended', onEnded);
      socket.off('error:rate', onRate);
      socket.off('room:kicked', onKicked);
      socket.off('room:deleted', onRoomDeleted);
      socket.off('call:ended', onCallEnded);
      socket.off('account:role', onRole);
    };
  }, [toast]);

  const incomingPm = useCallback((m: PrivateMessage) => {
    if (ignored.has(m.from.toLowerCase())) return;
    setPms((prev) => {
      const conv = prev[m.fromId] ?? { nick: m.from, messages: [], unread: 0 };
      return { ...prev, [m.fromId]: { nick: m.from, messages: [...conv.messages.slice(-99), m], unread: pmOpen === m.fromId ? 0 : conv.unread + 1 } };
    });
  }, [ignored, pmOpen]);
  useEffect(() => {
    socket.on('pm', incomingPm);
    return () => { socket.off('pm', incomingPm); };
  }, [incomingPm]);

  const openPm = useCallback((t: PmTarget) => {
    setPms((prev) => ({ ...prev, [t.id]: prev[t.id] ? { ...prev[t.id], unread: 0 } : { nick: t.nick, messages: [], unread: 0 } }));
    setPmOpen(t.id);
  }, []);

  const sendPm = useCallback(async (toId: string, text: string) => {
    try {
      const r = await call<{ message: PrivateMessage }>((ack) => socket.emit('pm:send', { toId, text }, ack));
      setPms((prev) => {
        const conv = prev[toId];
        return { ...prev, [toId]: { ...conv, messages: [...(conv?.messages ?? []).slice(-99), r.message] } };
      });
      return true;
    } catch (e) { toast((e as Error).message, 'error'); return false; }
  }, [toast]);

  /** signed in / registered over HTTP: reconnect so the socket handshake carries the new session cookie */
  const onAccount = (a: Account) => {
    setAccount(a);
    session.current = { nick: null, roomId: null, account: a, roomPassword: null };
    pendingPmNick.current = null;
    clearReturn();
    setMe(null); setRoom(null); setPms({});
    reconnect();
  };
  /** profile color/avatar update without dropping the socket session */
  const patchAccount = (a: Account) => {
    setAccount(a);
    if (session.current.account) session.current.account = a;
    setMe((m) => (m && m.registered ? { ...m, accountId: a.id, chatColor: a.chatColor, chatEffect: a.chatEffect, hasAvatar: a.hasAvatar } : m));
  };
  const signOut = async () => {
    try { await api('/api/auth/logout', {}); } catch { /* ignore */ }
    setAccount(null);
    pendingPmNick.current = null;
    clearReturn();
    session.current = { nick: null, roomId: null, account: null, roomPassword: null };
    setMe(null); setRoom(null); setPms({}); setLoginMode('signin');
    reconnect();
  };
  /** guest wants an account: drop the guest nick and show the register form */
  const wantAccount = (mode: 'signin' | 'register') => {
    pendingPmNick.current = null;
    clearReturn();
    session.current = { nick: null, roomId: null, account: null, roomPassword: null };
    setMe(null); setRoom(null); setPms({}); setLoginMode(mode);
    reconnect();
  };
  const onJoined = (r: RoomState, password?: string, invite?: string) => {
    session.current.roomId = r.id;
    session.current.roomPassword = password?.trim() || null;
    session.current.roomInvite = invite || null;
    setRoomUnread((prev) => {
      if (!prev[r.id]) return prev;
      const next = { ...prev };
      delete next[r.id];
      return next;
    });
    setRoom(r);
  };
  // A notification was clicked while this window is open: the service worker asks us to open its room.
  useEffect(() => {
    onOpenRoom((roomId) => {
      if (session.current.roomId === roomId || !session.current.account) return;
      if (!socket.connected || !session.current.nick) { session.current.roomId = roomId; return; }
      call<{ room: RoomState }>((ack) => socket.emit('room:join', { roomId }, ack)).then((j) => {
        setRoomEpoch((n) => n + 1);
        onJoined(j.room);
      }, (e: Error) => toast(e.message, 'error'));
    });
    return () => onOpenRoom(null);
  });
  // Jump to a room from the mentions inbox.
  useEffect(() => {
    const on = (e: Event) => {
      const roomId = (e as CustomEvent<{ roomId: string }>).detail?.roomId;
      if (!roomId || session.current.roomId === roomId || !session.current.account) return;
      if (!socket.connected || !session.current.nick) { session.current.roomId = roomId; return; }
      call<{ room: RoomState }>((ack) => socket.emit('room:join', { roomId }, ack)).then((j) => {
        setRoomEpoch((n) => n + 1);
        onJoined(j.room);
      }, (err: Error) => toast(err.message, 'error'));
    };
    window.addEventListener('zn:open-room', on);
    return () => window.removeEventListener('zn:open-room', on);
  });
  // Server-side unread counts and the mentions badge for this account (after sign-in and every reconnect).
  const meNick = me?.nick;
  useEffect(() => {
    if (!meNick || !account) return;
    let stop = false;
    const pull = () => {
      call<{ rooms: Record<string, { n: number; mention: boolean }>; mentions: number }>((ack) => socket.emit('unread:get', ack)).then((r) => {
        if (stop) return;
        setMentionUnread(r.mentions);
        setRoomUnread((prev) => {
          const next = { ...prev };
          for (const [id, v] of Object.entries(r.rooms)) {
            if (id === session.current.roomId) continue;
            const cur = next[id];
            next[id] = { n: Math.max(cur?.n ?? 0, v.n), mention: (cur?.mention ?? false) || v.mention };
          }
          return next;
        });
      }, () => {});
    };
    pull();
    // the socket logs in a moment after it reconnects; ask once that has happened
    let t: number | undefined;
    const later = () => { window.clearTimeout(t); t = window.setTimeout(pull, 1500); };
    socket.on('connect', later);
    return () => { stop = true; window.clearTimeout(t); socket.off('connect', later); };
  }, [meNick, account?.id]);
  const onRoomPassword = (password: string) => { session.current.roomPassword = password.trim() || null; };
  const onLeave = () => { socket.emit('room:leave'); session.current.roomId = null; session.current.roomPassword = null; pendingPmNick.current = null; clearReturn(); setRoom(null); };

  const adminRoute = path.startsWith('/admin');
  const inviteCode = INVITE_PATH_RE.exec(path)?.[1] ?? null;
  const [gamesEver, setGamesEver] = useState(false);
  const openGames = () => { setGamesEver(true); setGamesOpen(true); };
  // The dock listens for trivia in a room even while closed, so it mounts there too.
  const gamesUsed = gamesEver || gamesOpen || !!(me && room);
  const query = new URLSearchParams(location.search);
  const resetToken = path === '/reset' ? (query.get('token') || '') : '';
  const verifyToken = path === '/verify-email' ? (query.get('token') || '') : '';
  const mustConfirm = !!account && account.role !== 'admin' && (!account.email || (!!boot?.emailVerifyRequired && !account.emailVerified));
  // An invite being followed (from /i/<code>, through sign-in / sign-up / email confirmation): redeem it and join.
  useEffect(() => {
    if (!me || !account || mustConfirm || inviteBusy.current || adminRoute || inviteCode) return;
    const code = peekPendingInvite();
    if (!code) return;
    inviteBusy.current = true;
    void import('./inviteFlow').then((m) => m.followInvite(code, {
      currentRoom: () => session.current.roomId,
      leave: onLeave,
      askPassword: (r) => setInviteAskPw({ ...r, n: Date.now() }),
      joined: (r) => { setRoomEpoch((n) => n + 1); onJoined(r, undefined, code); },
      toast,
    })).finally(() => { inviteBusy.current = false; });
  }, [me, account, mustConfirm, inviteTick, path]); // eslint-disable-line react-hooks/exhaustive-deps
  const showEmailNag = !!account && !!me && !mustConfirm && !account.emailVerified && !emailNagHidden && !adminRoute;

  if (restarting) {
    return (
      <main className="login">
        <section className="login-card">
          <h1 className="brand-title"><img className="lockup" src="/logo-lockup.png" alt="zeronoise" width={512} height={359} /></h1>
          <p data-testid="restart-notice">Chat will restart for an update.</p>
          <p className="muted" data-testid="restart-countdown">{restartSec != null && restartSec > 0 ? `Restarting in ${restartSec}.` : 'Restarting now.'}</p>
        </section>
      </main>
    );
  }

  if (resetToken) {
    return <Lazy fallback={screenFallback}><ResetPassword token={resetToken} onDone={(a) => { onAccount(a); navigate('/'); }} /></Lazy>;
  }
  if (verifyToken) {
    return <VerifyFromLink token={verifyToken} onDone={(a) => { onAccount(a); navigate('/'); }} />;
  }

  if (inviteCode) {
    return (
      <Lazy fallback={screenFallback}>
        <InvitePage code={inviteCode} signedIn={boot ? !!account : null}
          onJoin={() => { savePendingInvite(inviteCode); setInviteTick((n) => n + 1); navigate('/'); }}
          onAuth={(mode) => { savePendingInvite(inviteCode); setLoginMode(mode); navigate('/'); }}
          onHome={() => { clearPendingInvite(); navigate('/'); }} />
      </Lazy>
    );
  }

  if (boot?.twoFactorPending) return <TwoFactorGate />;

  if (blocked && !adminRoute) {
    return (
      <main className="login">
        <section className="login-card">
          <h1 className="brand-title"><img className="lockup" src="/logo-lockup.png" alt="zeronoise" width={512} height={359} /></h1>
          <p className="form-error" data-testid="blocked">{blocked}</p>
          <BanAppeal />
          <button className="btn ghost" onClick={() => { setBlocked(null); session.current = { ...session.current, nick: null, roomId: null }; reconnect(); }}>Try again</button>
        </section>
      </main>
    );
  }

  return (
    <div className={`app${gamesOpen ? ' games-open' : ''}`}>
      {boot && !connected && slowConnect && !adminRoute && !mustConfirm && <div className="banner" role="status">Connecting…</div>}
      {showEmailNag && (
        <div className="banner" data-testid="email-nag">
          Confirm {account!.email || 'your email'} when you can. Password reset uses that address.
          <button type="button" className="link-btn" onClick={() => setConfirmOpen(true)}>Confirm</button>
          <button type="button" className="link-btn" onClick={() => { try { sessionStorage.setItem('camchat.emailNag', '1'); } catch { /* ignore */ } setEmailNagHidden(true); }}>Dismiss</button>
        </div>
      )}
      <div className="app-main">
      {adminRoute ? (
        <Lazy fallback={screenFallback}><AdminPanel account={account} onBack={() => navigate('/')} onGames={openGames} /></Lazy>
      ) : (mustConfirm || confirmOpen) && account ? (
        <ConfirmEmail account={account} blocked={mustConfirm} onAccount={(a) => { onAccount(a); if (a.emailVerified) setConfirmOpen(false); }} onSignOut={signOut} onClose={() => setConfirmOpen(false)} />
      ) : !me ? (
        account ? (
          <main className="login"><section className="login-card"><p className="muted">Signing in as {account.username}…</p>
            <button className="btn ghost" onClick={signOut}>Sign out</button></section></main>
        ) : (
          <>
          {peekPendingInvite() && <div className="banner invite-banner" role="status" data-testid="invite-banner">You have a room invite. {loginMode === 'register' ? 'Create an account' : 'Sign in'} to join.</div>}
          <Login onAccount={onAccount} mode={loginMode} setMode={setLoginMode} google={!!boot?.google} discord={!!boot?.discord} tiktok={!!boot?.tiktok} />
          </>
        )
      ) : room ? (
        <Lazy fallback={roomFallback}><Room key={`${room.id}:${roomEpoch}`} me={me} initial={room} onLeave={onLeave} toast={toast} ignored={ignored} toggleIgnore={toggleIgnore} openPm={openPm} gifs={!!boot?.gifs} onPasswordChange={onRoomPassword} account={account} onAccount={patchAccount} onGames={openGames} unread={roomUnread[room.id]} unreadMap={roomUnread} onJoined={onJoined} signOut={signOut} openAdmin={() => navigate('/admin')} wantAccount={wantAccount} /></Lazy>
      ) : path === '/browse' ? (
        <Lazy fallback={screenFallback}><Browse onJoined={(r) => { navigate('/'); onJoined(r); }} onBack={() => navigate('/')} toast={toast} /></Lazy>
      ) : (
        <Lobby me={me} account={account} onJoined={onJoined} toast={toast} signOut={signOut} wantAccount={wantAccount} openAdmin={() => navigate('/admin')} onAccount={patchAccount} onGames={openGames} roomUnread={roomUnread} openPm={openPm} ignored={ignored} toggleIgnore={toggleIgnore} askRoom={inviteAskPw} />
      )}
      {me && Object.keys(pms).length > 0 && (
        <Lazy><PmDock
          convs={pms}
          open={pmOpen}
          setOpen={(id) => { setPmOpen(id); if (id) setPms((p) => (p[id] ? { ...p, [id]: { ...p[id], unread: 0 } } : p)); }}
          close={(id) => { setPms((p) => { const n = { ...p }; delete n[id]; return n; }); if (pmOpen === id) setPmOpen(null); }}
          send={sendPm}
          ignored={ignored}
          gifs={!!boot?.gifs}
        /></Lazy>
      )}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone ?? ''}`}>{t.text}</div>)}
      </div>
      </div>
      {gamesUsed && <Lazy><GamesDock open={gamesOpen} onClose={() => setGamesOpen(false)} toast={toast} trivia={{ roomId: me && room ? room.id : null, canStop: !!room && (room.isOwner || room.canModerate) }} /></Lazy>}
    </div>
  );
}
