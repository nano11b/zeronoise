/**
 * batch W: socket handlers for private conversations. Registered per socket from index.ts with its helpers.
 * Every handler checks: signed-in account, participant of the conversation, blocks, and rate limits.
 */
import { randomUUID } from 'node:crypto';
import * as dm from './dm';
import * as repo from './repo';
import * as lobby from './lobby';
import * as roles from './roles';
import * as modq from './modq';
import { DM, DM_POLICIES, disappearLabel, type DmConvo, type DmMessage, type DmPolicy } from '../shared/dm';
import { isReportCategory, MODQ } from '../shared/modq';

export interface DmDeps {
  account: () => repo.Account | null;
  nick: () => string;
  ip: () => string;
  isStaff: (userId: number) => boolean;
  online: (userId: number) => boolean;
  emitTo: (userId: number, ev: string, payload: unknown) => void;
  limitedAct: () => boolean;
  limitedChat: () => boolean;
  prepareText: (raw: unknown) => { error: string } | { text: string };
  push: (userId: number, title: string, body: string, tag: string) => void;
  reportOk: (key: string) => boolean;
  afterReport: (id: number) => void;
}
type Ack = (r: unknown) => void;
const safe = (a: unknown): Ack => (typeof a === 'function' ? (a as Ack) : () => {});
const fail = (ack: Ack, error: string, status?: number) => ack({ ok: false, error, ...(status ? { status } : {}) });

/** Last time each (user, convo) typing ping went out. */
const typingAt = new Map<string, number>();
const receipts = (uid: number) => roles.whisperReceipts(uid);

export function systemLine(convoId: string, text: string, disappearSec = 0): dm.MsgRow {
  const ts = Date.now();
  const row: dm.MsgRow = { id: randomUUID(), convo_id: convoId, ts, from_user_id: null, text, kind: 'system', reply_to: null, edited_at: null, deleted_at: null, file_id: null, voice_id: null, voice_ms: null, expires_at: disappearSec ? ts + disappearSec * 1000 : null };
  dm.insertMessage(row);
  return row;
}

/** Turn stored rows into what one viewer sees (reactions with names, reply previews, file/voice links). */
export function viewMessages(rows: dm.MsgRow[], viewerId: number, hideFrom: Set<number> = new Set()): DmMessage[] {
  const visible = rows.filter((r) => r.from_user_id == null || !hideFrom.has(r.from_user_id));
  const ids = visible.map((r) => r.id);
  const rx = dm.reactionsFor(ids);
  const replyIds = [...new Set(visible.map((r) => r.reply_to).filter((x): x is string => !!x))];
  const replies = new Map(replyIds.map((id) => [id, dm.msgById(id)]));
  const userIds = new Set<number>();
  for (const r of visible) if (r.from_user_id != null) userIds.add(r.from_user_id);
  for (const a of rx.values()) for (const x of a) userIds.add(x.user_id);
  for (const r of replies.values()) if (r?.from_user_id != null) userIds.add(r.from_user_id);
  const users = repo.usersByIds([...userIds]);
  const name = (id: number | null) => (id == null ? '' : users.get(id)?.username ?? 'deleted');
  return visible.map((r) => {
    const f = r.file_id ? dm.fileById(r.file_id) : undefined;
    const rep = r.reply_to ? replies.get(r.reply_to) : undefined;
    const agg = new Map<string, { count: number; mine: boolean; users: string[] }>();
    for (const x of rx.get(r.id) ?? []) {
      const e = agg.get(x.emoji) ?? { count: 0, mine: false, users: [] };
      e.count++; if (x.user_id === viewerId) e.mine = true; e.users.push(name(x.user_id)); agg.set(x.emoji, e);
    }
    return {
      id: r.id, convoId: r.convo_id, ts: r.ts, fromId: r.from_user_id, from: name(r.from_user_id), text: r.text, kind: r.kind,
      ...(rep ? { replyTo: { id: rep.id, from: name(rep.from_user_id), text: rep.deleted_at ? '' : rep.text.slice(0, 140) } } : {}),
      ...(r.edited_at ? { editedAt: r.edited_at } : {}), ...(r.deleted_at ? { deleted: true } : {}),
      ...(f ? { file: dm.fileInfo(f) } : {}),
      ...(r.voice_id ? { voice: { url: `/api/voice/${r.voice_id}`, durationMs: r.voice_ms ?? 0 } } : {}),
      ...(agg.size ? { reactions: [...agg].map(([emoji, e]) => ({ emoji, ...e })) } : {}),
      ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
    };
  });
}

export function convoView(c: dm.ConvoRow, me: dm.MemberRow, viewerId: number, online: (id: number) => boolean): DmConvo {
  const rows = dm.membersOf(c.id);
  const mine = receipts(viewerId);
  const members = dm.memberView(rows, c, online, false).map((m, i) => (mine && receipts(m.userId) && rows[i].state === 'active' ? { ...m, readTs: rows[i].read_ts } : m));
  const hide = new Set(lobby.blockedIds(viewerId));
  const last = dm.lastLine(c.id, me.joined_at);
  const lastShown = last && (last.from_user_id == null || !hide.has(last.from_user_id)) ? last : undefined;
  return {
    id: c.id, kind: c.kind, name: c.name, createdBy: c.created_by, members, lastTs: c.last_ts,
    lastText: lastShown ? (lastShown.deleted_at ? 'Message deleted' : lastShown.kind === 'file' ? `📎 ${lastShown.text || 'File'}` : lastShown.kind === 'voice' ? '🎤 Voice note' : lastShown.text.slice(0, 120)) : null,
    unread: dm.unreadCount(c.id, viewerId, me.read_ts, me.joined_at), pinned: !!me.pinned, archived: !!me.archived, state: me.state,
    ...(rows.some((r) => r.state === 'request' && r.left_at == null && r.user_id !== viewerId) ? { pendingFor: rows.filter((r) => r.state === 'request' && r.left_at == null).map((r) => r.user_id) } : {}),
    disappearSec: c.disappear_sec,
  };
}

/** May `from` start a whisper with `to`? Returns the member state for `to`, or an error. (batch W9) */
export function reachState(from: number, to: number, isStaff: (id: number) => boolean): { state: dm.MemberRow['state'] } | { error: string } {
  if (from === to) return { error: 'That is you' };
  const t = repo.accountById(to);
  if (!t) return { error: 'User not found' };
  if (lobby.blockedEitherWay(from, to)) return { error: `You can't whisper ${t.username}` };
  // staff can always reach people (moderation), and anyone can always reach staff (asking for help)
  if (isStaff(from) || isStaff(to)) return { state: 'active' };
  if (repo.areFriends(from, to)) return { state: 'active' };
  const policy = dm.policyOf(to);
  if (policy === 'everyone') return { state: 'active' };
  if (policy === 'friends') return { error: `${t.username} only takes whispers from friends` };
  return { state: 'request' };
}

export function registerDm(socket: { on: (ev: string, fn: (...a: any[]) => void) => void; id: string }, d: DmDeps) {
  const me = () => d.account();
  /** The conversation, when the caller is a current participant. */
  const ctx = (raw: unknown, ack: Ack, opts: { act?: boolean } = {}) => {
    const a = me();
    if (!a) { fail(ack, 'Sign in with an account to use whispers', 401); return null; }
    const c = dm.convoById(String(raw ?? ''));
    const mr = c ? dm.memberRow(c.id, a.id) : undefined;
    if (!c || !mr || mr.left_at != null) { fail(ack, 'Conversation not found', 404); return null; }
    if (opts.act && d.limitedAct()) { fail(ack, 'Slow down', 429); return null; }
    return { a, c, mr };
  };
  const tellMembers = (convoId: string, ev: string, payload: unknown, except?: number) => {
    for (const uid of dm.activeMemberIds(convoId)) if (uid !== except) d.emitTo(uid, ev, payload);
  };
  /** Each participant gets their own view (unread counts, receipts, blocks differ). */
  const tellConvo = (convoId: string) => {
    const c = dm.convoById(convoId);
    if (!c) return;
    for (const uid of dm.activeMemberIds(convoId)) {
      const mr = dm.memberRow(convoId, uid);
      if (mr && mr.state !== 'declined') d.emitTo(uid, 'dm:convo', convoView(c, mr, uid, d.online));
    }
  };
  const deliver = (row: dm.MsgRow) => {
    for (const uid of dm.activeMemberIds(row.convo_id)) {
      const mr = dm.memberRow(row.convo_id, uid);
      if (!mr || mr.state === 'declined') continue;
      const hide = new Set(lobby.blockedIds(uid));
      const [v] = viewMessages([row], uid, hide);
      if (v) d.emitTo(uid, 'dm:message', v);
    }
    tellConvo(row.convo_id);
  };
  const expiryFor = (c: dm.ConvoRow, ts: number) => (c.disappear_sec ? ts + c.disappear_sec * 1000 : null);
  /** Requests / blocks gate every new line in a 1:1 (a group checks members when they are added). */
  const sendGate = (c: dm.ConvoRow, a: repo.Account): string | null => {
    const others = dm.membersOf(c.id).filter((m) => m.user_id !== a.id && m.left_at == null);
    if (c.kind === 'direct') {
      const o = others[0];
      if (!o) return 'They left this conversation';
      if (lobby.blockedEitherWay(a.id, o.user_id)) return "You can't whisper this person";
      if (o.state === 'declined') return 'They declined your whisper request';
    }
    const mine = dm.memberRow(c.id, a.id);
    if (mine?.state === 'request') return 'Accept the request to reply';
    return null;
  };

  socket.on('dm:list', (_p: unknown, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const a = me();
    if (!a) return fail(ack, 'Sign in with an account to use whispers', 401);
    const convos = dm.convosFor(a.id).map(({ c, me: mr }) => convoView(c, mr, a.id, d.online));
    ack({ ok: true, convos, policy: dm.policyOf(a.id), typing: dm.typingOn(a.id), receipts: receipts(a.id) });
  });

  socket.on('dm:open', (p: { convoId?: string; before?: number }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack);
    if (!x) return;
    const before = Number.isFinite(Number(p?.before)) ? Number(p!.before) : null;
    const rows = dm.pageOf(x.c.id, x.mr.joined_at, before);
    const hide = new Set(lobby.blockedIds(x.a.id));
    ack({ ok: true, convo: convoView(x.c, x.mr, x.a.id, d.online), messages: viewMessages(rows, x.a.id, hide), more: rows.length >= DM.pageSize });
  });

  socket.on('dm:start', (p: { userIds?: unknown; usernames?: unknown; name?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const a = me();
    if (!a) return fail(ack, 'Sign in with an account to use whispers', 401);
    if (d.limitedAct()) return fail(ack, 'Slow down', 429);
    const ids = new Set<number>();
    if (Array.isArray(p?.userIds)) for (const v of p.userIds) { const n = Math.floor(Number(v)); if (n > 0) ids.add(n); }
    if (Array.isArray(p?.usernames)) for (const v of p.usernames) { const u = repo.userByName(String(v)); if (u) ids.add(u.id); else return fail(ack, `No account called ${String(v).slice(0, 30)}`); }
    ids.delete(a.id);
    const others = [...ids];
    if (!others.length) return fail(ack, 'Pick someone to whisper');
    if (others.length + 1 > DM.groupMax) return fail(ack, `Groups can have up to ${DM.groupMax} people`);
    const states = new Map<number, dm.MemberRow['state']>();
    for (const uid of others) {
      const r = reachState(a.id, uid, d.isStaff);
      if ('error' in r) return fail(ack, r.error);
      states.set(uid, r.state);
    }
    if (others.length === 1) {
      const existing = dm.directBetween(a.id, others[0]);
      if (existing) {
        // reopen (they may have left or declined earlier)
        const mine = dm.memberRow(existing.id, a.id);
        if (mine?.left_at != null) dm.addMember(existing.id, a.id, 'active');
        const theirs = dm.memberRow(existing.id, others[0]);
        if (theirs?.left_at != null || theirs?.state === 'declined') dm.addMember(existing.id, others[0], states.get(others[0])!);
        const mr = dm.memberRow(existing.id, a.id)!;
        return ack({ ok: true, convo: convoView(dm.convoById(existing.id)!, mr, a.id, d.online) });
      }
      const c = dm.createConvo('direct', a.id, others, null, (u) => states.get(u)!);
      tellConvo(c.id);
      return ack({ ok: true, convo: convoView(c, dm.memberRow(c.id, a.id)!, a.id, d.online) });
    }
    if (others.length + 1 < DM.groupMin) return fail(ack, `Groups need at least ${DM.groupMin} people`);
    const name = String(p?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, DM.nameMax);
    if (!name) return fail(ack, 'Give the group a name');
    const c = dm.createConvo('group', a.id, others, name, (u) => states.get(u)!);
    systemLine(c.id, `${a.username} created the group "${name}"`);
    tellConvo(c.id);
    ack({ ok: true, convo: convoView(c, dm.memberRow(c.id, a.id)!, a.id, d.online) });
  });

  socket.on('dm:send', (p: { convoId?: string; text?: unknown; replyTo?: unknown; fileId?: unknown; voiceId?: unknown; durationMs?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack);
    if (!x) return;
    if (d.limitedChat()) return fail(ack, 'Slow down', 429);
    const gate = sendGate(x.c, x.a);
    if (gate) return fail(ack, gate, 403);
    let text = '';
    let kind: DmMessage['kind'] = 'text';
    let fileId: string | null = null, voiceId: string | null = null, voiceMs: number | null = null;
    if (p?.fileId) {
      const f = dm.fileById(String(p.fileId));
      if (!f || f.convo_id !== x.c.id || f.uploader_id !== x.a.id || f.message_id) return fail(ack, 'File not found');
      kind = 'file'; fileId = f.id; text = f.name;
      if (typeof p.text === 'string' && p.text.trim()) { const t = d.prepareText(p.text); if ('error' in t) return fail(ack, t.error); text = t.text; }
    } else if (p?.voiceId) {
      const v = repo.voiceNoteById(String(p.voiceId));
      if (!v || v.room_id !== `dm:${x.c.id}` || v.uploader_user_id !== x.a.id || v.message_id) return fail(ack, 'Voice note not found');
      kind = 'voice'; voiceId = v.id; voiceMs = Math.max(0, Math.min(120_000, Math.floor(Number(p.durationMs) || 0))); text = '';
    } else {
      const t = d.prepareText(p?.text);
      if ('error' in t) return fail(ack, t.error);
      text = t.text;
    }
    let replyTo: string | null = null;
    if (p?.replyTo) {
      const r = dm.msgById(String(p.replyTo));
      if (!r || r.convo_id !== x.c.id || r.ts < x.mr.joined_at) return fail(ack, 'Reply target not found');
      replyTo = r.id;
    }
    const ts = Date.now();
    const row: dm.MsgRow = { id: randomUUID(), convo_id: x.c.id, ts, from_user_id: x.a.id, text, kind, reply_to: replyTo, edited_at: null, deleted_at: null, file_id: fileId, voice_id: voiceId, voice_ms: voiceMs, expires_at: expiryFor(x.c, ts) };
    dm.insertMessage(row);
    if (fileId && !dm.claimFile(fileId, row.id)) { dm.deleteMessage(row.id); return fail(ack, 'File already sent'); }
    if (voiceId && !repo.claimVoiceNote(voiceId, row.id)) { dm.deleteMessage(row.id); return fail(ack, 'Voice note already sent'); }
    dm.markRead(x.c.id, x.a.id, ts);
    typingAt.delete(`${x.a.id}:${x.c.id}`);
    deliver(row);
    const [mine] = viewMessages([row], x.a.id);
    ack({ ok: true, message: mine });
    for (const m of dm.membersOf(x.c.id)) {
      if (m.user_id === x.a.id || m.left_at != null || m.state !== 'active' || lobby.blockedEitherWay(m.user_id, x.a.id)) continue;
      d.push(m.user_id, x.c.kind === 'group' ? `${x.a.username} in ${x.c.name}` : `Whisper from ${x.a.username}`, 'New message', `dm-${x.c.id}`);
    }
  });

  socket.on('dm:edit', (p: { messageId?: string; text?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const m = dm.msgById(String(p?.messageId ?? ''));
    const x = ctx(m?.convo_id, ack, { act: true });
    if (!x || !m) return;
    if (m.from_user_id !== x.a.id || m.deleted_at || m.kind === 'system' || m.kind === 'voice') return fail(ack, 'You can only edit your own messages', 403);
    const t = d.prepareText(p?.text);
    if ('error' in t) return fail(ack, t.error);
    dm.editMessage(m.id, t.text);
    const row = dm.msgById(m.id)!;
    for (const uid of dm.activeMemberIds(m.convo_id)) { const [v] = viewMessages([row], uid, new Set(lobby.blockedIds(uid))); if (v) d.emitTo(uid, 'dm:update', v); }
    ack({ ok: true });
  });

  socket.on('dm:delete', (p: { messageId?: string }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const m = dm.msgById(String(p?.messageId ?? ''));
    const x = ctx(m?.convo_id, ack, { act: true });
    if (!x || !m) return;
    if (m.from_user_id !== x.a.id || m.deleted_at) return fail(ack, 'You can only delete your own messages', 403);
    dm.deleteMessage(m.id);
    const row = dm.msgById(m.id)!;
    for (const uid of dm.activeMemberIds(m.convo_id)) { const [v] = viewMessages([row], uid); if (v) d.emitTo(uid, 'dm:update', v); }
    tellConvo(m.convo_id);
    ack({ ok: true });
  });

  socket.on('dm:react', (p: { messageId?: string; emoji?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const m = dm.msgById(String(p?.messageId ?? ''));
    const x = ctx(m?.convo_id, ack, { act: true });
    if (!x || !m) return;
    const emoji = String(p?.emoji ?? '');
    if (!emoji || emoji.length > 16 || /[\s<>]/.test(emoji)) return fail(ack, 'Pick an emoji');
    if (m.deleted_at || m.kind === 'system' || m.ts < x.mr.joined_at) return fail(ack, 'Message not found');
    if (x.mr.state !== 'active') return fail(ack, 'Accept the request first');
    if (!dm.toggleReaction(m.id, x.a.id, emoji)) return fail(ack, 'Too many different reactions');
    const row = dm.msgById(m.id)!;
    for (const uid of dm.activeMemberIds(m.convo_id)) { const [v] = viewMessages([row], uid, new Set(lobby.blockedIds(uid))); if (v) d.emitTo(uid, 'dm:update', v); }
    ack({ ok: true });
  });

  socket.on('dm:read', (p: { convoId?: string; ts?: unknown }) => {
    const a = me();
    if (!a) return;
    const c = dm.convoById(String(p?.convoId ?? ''));
    const mr = c ? dm.memberRow(c.id, a.id) : undefined;
    if (!c || !mr || mr.left_at != null) return;
    const ts = Math.min(Date.now(), Math.floor(Number(p?.ts) || Date.now()));
    if (ts <= mr.read_ts) return;
    dm.markRead(c.id, a.id, ts);
    d.emitTo(a.id, 'dm:convo', convoView(c, dm.memberRow(c.id, a.id)!, a.id, d.online));
    // receipts are mutual (batch G5 setting): only readers with receipts on are shown, only to members with them on
    if (mr.state !== 'active' || !receipts(a.id)) return;
    for (const uid of dm.activeMemberIds(c.id)) if (uid !== a.id && receipts(uid)) d.emitTo(uid, 'dm:read', { convoId: c.id, userId: a.id, ts });
  });

  // ---- W6: typing indicator (throttled, mutual off switch) ----
  socket.on('dm:typing', (p: { convoId?: string }) => {
    const a = me();
    if (!a) return;
    const c = dm.convoById(String(p?.convoId ?? ''));
    const mr = c ? dm.memberRow(c.id, a.id) : undefined;
    if (!c || !mr || mr.left_at != null || mr.state !== 'active' || !dm.typingOn(a.id)) return;
    const k = `${a.id}:${c.id}`;
    const t = Date.now();
    if ((typingAt.get(k) ?? 0) > t - DM.typingThrottleMs) return;
    typingAt.set(k, t);
    if (typingAt.size > 5000) for (const [kk, v] of typingAt) if (v < t - 60_000) typingAt.delete(kk);
    for (const m of dm.membersOf(c.id)) {
      if (m.user_id === a.id || m.left_at != null || m.state !== 'active' || !dm.typingOn(m.user_id) || lobby.blockedEitherWay(a.id, m.user_id)) continue;
      d.emitTo(m.user_id, 'dm:typing', { convoId: c.id, userId: a.id, username: a.username });
    }
  });

  socket.on('dm:settings', (p: { policy?: unknown; typing?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const a = me();
    if (!a) return fail(ack, 'Sign in first', 401);
    if (p?.policy !== undefined || p?.typing !== undefined) {
      if (d.limitedAct()) return fail(ack, 'Slow down', 429);
      if (p.policy !== undefined) { if (!DM_POLICIES.includes(p.policy as DmPolicy)) return fail(ack, 'Unknown setting'); dm.setPolicy(a.id, p.policy as DmPolicy); }
      if (typeof p.typing === 'boolean') dm.setTyping(a.id, p.typing);
    }
    ack({ ok: true, policy: dm.policyOf(a.id), typing: dm.typingOn(a.id), receipts: receipts(a.id) });
  });

  // ---- W1: groups (creator manages members; anyone can leave) ----
  socket.on('dm:group:add', (p: { convoId?: string; username?: unknown; userId?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack, { act: true });
    if (!x) return;
    if (x.c.kind !== 'group') return fail(ack, 'Only groups can add people');
    if (x.c.created_by !== x.a.id) return fail(ack, 'Only the group creator can add people', 403);
    const u = p?.userId != null ? repo.accountById(Math.floor(Number(p.userId))) : (() => { const r = repo.userByName(String(p?.username ?? '')); return r ? repo.accountById(r.id) : null; })();
    if (!u) return fail(ack, 'User not found');
    if (dm.isParticipant(x.c.id, u.id)) return fail(ack, `${u.username} is already here`);
    if (dm.activeMemberIds(x.c.id).length >= DM.groupMax) return fail(ack, `Groups can have up to ${DM.groupMax} people`);
    const r = reachState(x.a.id, u.id, d.isStaff);
    if ('error' in r) return fail(ack, r.error);
    for (const other of dm.activeMemberIds(x.c.id)) if (lobby.blockedEitherWay(other, u.id)) return fail(ack, `${u.username} can't be added to this group`);
    dm.addMember(x.c.id, u.id, r.state);
    systemLine(x.c.id, `${x.a.username} added ${u.username}`, x.c.disappear_sec);
    tellConvo(x.c.id);
    ack({ ok: true });
  });
  socket.on('dm:group:remove', (p: { convoId?: string; userId?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack, { act: true });
    if (!x) return;
    if (x.c.kind !== 'group' || x.c.created_by !== x.a.id) return fail(ack, 'Only the group creator can remove people', 403);
    const uid = Math.floor(Number(p?.userId));
    if (uid === x.a.id || !dm.isParticipant(x.c.id, uid)) return fail(ack, 'Not in this group');
    dm.markLeft(x.c.id, uid);
    const u = repo.accountById(uid);
    systemLine(x.c.id, `${x.a.username} removed ${u?.username ?? 'someone'}`, x.c.disappear_sec);
    d.emitTo(uid, 'dm:removed', { convoId: x.c.id });
    tellConvo(x.c.id);
    ack({ ok: true });
  });
  socket.on('dm:leave', (p: { convoId?: string }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack, { act: true });
    if (!x) return;
    dm.markLeft(x.c.id, x.a.id);
    if (x.c.kind === 'group') {
      systemLine(x.c.id, `${x.a.username} left`, x.c.disappear_sec);
      // the group keeps going; if the creator leaves, the longest-standing member takes over
      if (x.c.created_by === x.a.id) {
        const next = dm.membersOf(x.c.id).find((m) => m.left_at == null && m.state === 'active');
        if (next) { dm.setCreator(x.c.id, next.user_id); systemLine(x.c.id, `${repo.accountById(next.user_id)?.username ?? 'Someone'} now manages the group`, x.c.disappear_sec); }
      }
    }
    tellConvo(x.c.id);
    d.emitTo(x.a.id, 'dm:removed', { convoId: x.c.id });
    ack({ ok: true });
  });
  socket.on('dm:group:rename', (p: { convoId?: string; name?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack, { act: true });
    if (!x) return;
    if (x.c.kind !== 'group' || x.c.created_by !== x.a.id) return fail(ack, 'Only the group creator can rename it', 403);
    const name = String(p?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, DM.nameMax);
    if (!name) return fail(ack, 'Give the group a name');
    dm.setName(x.c.id, name);
    systemLine(x.c.id, `${x.a.username} renamed the group to "${name}"`, x.c.disappear_sec);
    tellConvo(x.c.id);
    ack({ ok: true });
  });

  socket.on('dm:search', (p: { q?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const a = me();
    if (!a) return fail(ack, 'Sign in first', 401);
    if (d.limitedAct()) return fail(ack, 'Slow down', 429);
    const text = String(p?.q ?? '').trim().slice(0, 100);
    if (text.length < 2) return ack({ ok: true, results: [] });
    const rows = dm.search(a.id, text);
    const hide = new Set(lobby.blockedIds(a.id));
    const names = new Map<string, string>();
    for (const r of rows) if (!names.has(r.convo_id)) { const c = dm.convoById(r.convo_id); const mr = c && dm.memberRow(c.id, a.id); if (c && mr) { const v = convoView(c, mr, a.id, d.online); names.set(c.id, v.name ?? v.members.filter((m) => m.userId !== a.id).map((m) => m.username).join(', ')); } }
    ack({ ok: true, results: viewMessages(rows, a.id, hide).map((m) => ({ ...m, convoName: names.get(m.convoId) ?? '' })) });
  });

  // ---- W7: disappearing messages (either party, visible notice) ----
  socket.on('dm:disappear', (p: { convoId?: string; sec?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack, { act: true });
    if (!x) return;
    if (x.mr.state !== 'active') return fail(ack, 'Accept the request first');
    const sec = Number(p?.sec);
    if (!(DM.disappearOptions as readonly number[]).includes(sec)) return fail(ack, 'Pick off, 1 hour, 1 day or 7 days');
    if (sec === x.c.disappear_sec) return ack({ ok: true });
    dm.setDisappear(x.c.id, sec);
    const row = systemLine(x.c.id, sec ? `${x.a.username} turned on disappearing messages: new messages vanish after ${disappearLabel(sec).toLowerCase()}` : `${x.a.username} turned off disappearing messages`);
    deliver(row);
    ack({ ok: true });
  });

  // ---- W8: pin / archive (per person) ----
  socket.on('dm:pin', (p: { convoId?: string; on?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack, { act: true });
    if (!x) return;
    dm.setPinned(x.c.id, x.a.id, !!p?.on);
    d.emitTo(x.a.id, 'dm:convo', convoView(x.c, dm.memberRow(x.c.id, x.a.id)!, x.a.id, d.online));
    ack({ ok: true });
  });
  socket.on('dm:archive', (p: { convoId?: string; on?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack, { act: true });
    if (!x) return;
    dm.setArchived(x.c.id, x.a.id, !!p?.on);
    d.emitTo(x.a.id, 'dm:convo', convoView(x.c, dm.memberRow(x.c.id, x.a.id)!, x.a.id, d.online));
    ack({ ok: true });
  });

  // ---- W9: message requests ----
  socket.on('dm:request', (p: { convoId?: string; action?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack, { act: true });
    if (!x) return;
    if (x.mr.state !== 'request') return fail(ack, 'No request waiting');
    const action = String(p?.action ?? '');
    if (action === 'accept') {
      dm.setState(x.c.id, x.a.id, 'active');
      if (x.c.kind === 'group') systemLine(x.c.id, `${x.a.username} joined`, x.c.disappear_sec);
      tellConvo(x.c.id);
      return ack({ ok: true, convo: convoView(x.c, dm.memberRow(x.c.id, x.a.id)!, x.a.id, d.online) });
    }
    if (action === 'decline' || action === 'block') {
      dm.setState(x.c.id, x.a.id, 'declined');
      if (x.c.kind === 'group') dm.markLeft(x.c.id, x.a.id);
      if (action === 'block') {
        const starter = x.c.kind === 'direct' ? dm.membersOf(x.c.id).find((m) => m.user_id !== x.a.id)?.user_id : x.c.created_by;
        if (starter && !d.isStaff(starter)) lobby.addBlock(x.a.id, starter);
      }
      tellConvo(x.c.id);
      d.emitTo(x.a.id, 'dm:removed', { convoId: x.c.id });
      return ack({ ok: true });
    }
    fail(ack, 'Accept, decline or block');
  });

  // ---- W10: block and report from a whisper ----
  socket.on('dm:block', (p: { userId?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const a = me();
    if (!a) return fail(ack, 'Sign in first', 401);
    if (d.limitedAct()) return fail(ack, 'Slow down', 429);
    const uid = Math.floor(Number(p?.userId));
    const u = repo.accountById(uid);
    if (!u || uid === a.id) return fail(ack, 'User not found');
    if (d.isStaff(uid)) return fail(ack, "Staff can't be blocked; report instead if something is wrong");
    lobby.addBlock(a.id, uid);
    const direct = dm.directBetween(a.id, uid);
    if (direct) tellConvo(direct.id);
    ack({ ok: true, username: u.username });
  });
  socket.on('dm:report', (p: { convoId?: string; messageId?: unknown; category?: unknown; note?: unknown; consent?: unknown }, ackRaw: unknown) => {
    const ack = safe(ackRaw);
    const x = ctx(p?.convoId, ack, { act: true });
    if (!x) return;
    if (p?.consent !== true) return fail(ack, 'Confirm that the recent messages will be sent to the moderators');
    if (!isReportCategory(p?.category)) return fail(ack, 'Pick a reason');
    const note = String(p?.note ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MODQ.noteMax) || null;
    const target = p?.messageId ? dm.msgById(String(p.messageId)) : undefined;
    if (p?.messageId && (!target || target.convo_id !== x.c.id || target.ts < x.mr.joined_at)) return fail(ack, 'Message not found');
    if (target && target.from_user_id === x.a.id) return fail(ack, 'You cannot report your own message');
    const others = dm.membersOf(x.c.id).filter((m) => m.user_id !== x.a.id);
    const targetUserId = target?.from_user_id ?? (x.c.kind === 'direct' ? others[0]?.user_id ?? null : null);
    const targetUser = targetUserId != null ? repo.accountById(targetUserId) : null;
    // the excerpt: only what the reporter could see, newest DM.excerptLines lines up to (and around) the reported one
    const upTo = target ? target.ts + 1 : Date.now() + 1;
    const rows = dm.pageOf(x.c.id, x.mr.joined_at, upTo, DM.excerptLines);
    const names = repo.usersByIds([...new Set(rows.map((r) => r.from_user_id).filter((v): v is number => v != null))]);
    const context = rows.map((r) => ({ ts: r.ts, from: r.from_user_id == null ? '(notice)' : names.get(r.from_user_id)?.username ?? 'deleted',
      text: r.deleted_at ? '[deleted]' : r.kind === 'file' ? `[file: ${dm.fileById(r.file_id ?? '')?.name ?? r.text}] ${r.text}` : r.kind === 'voice' ? '[voice note]' : r.text,
      ...(target && r.id === target.id ? { target: true } : {}) }));
    const key = target ? `dm:${target.id}` : `dmc:${x.c.id}`;
    if (!d.reportOk(`u:${x.a.id}`)) return fail(ack, 'You have sent a lot of reports. Please wait.');
    const dup = modq.findDuplicate({ reporterUserId: x.a.id, reporterIp: d.ip(), reporterNick: x.a.username, key });
    if (dup) { modq.updateDuplicate(dup.id, p.category, note, false); return ack({ ok: true, reportId: dup.id, updated: true }); }
    const reportId = modq.insertReport({
      reporterUserId: x.a.id, reporterNick: x.a.username, reporterIp: d.ip(),
      targetUserId, targetNick: targetUser?.username ?? null, targetIp: null, targetDevice: null,
      roomId: null, messageId: null, messageText: target ? target.text : null,
      kind: 'whisper', key, category: p.category, note,
      snapshot: { text: target?.text ?? null, attachments: [], senderAccountId: targetUserId, senderNick: targetUser?.username ?? null, roomId: null, roomName: x.c.kind === 'group' ? `Group whisper: ${x.c.name}` : 'Private whisper', ts: target?.ts ?? null, private: 'whisper' },
      privateKind: 'whisper', context, notify: false,
    });
    ack({ ok: true, reportId, lines: context.length });
    d.afterReport(reportId);
  });
}

/** Tell members about removed lines (disappearing / retention). */
export function announceGone(by: Map<string, string[]>, emitTo: (uid: number, ev: string, p: unknown) => void) {
  for (const [convoId, ids] of by) for (const uid of dm.activeMemberIds(convoId)) emitTo(uid, 'dm:gone', { convoId, ids });
}
