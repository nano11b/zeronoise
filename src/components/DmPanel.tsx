/**
 * batch W: the Whispers inbox — private 1:1 and group conversations for accounts.
 * Two panes on wide screens (list | conversation), one pane with a Back button on phones.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { DM, disappearLabel, type DmConvo, type DmMessage, type DmPolicy } from '../../shared/dm';
import { dmCall, dmSock, loadDm, loadOlder, markRead, openConvo, requestCount, setDmPrefs, totalUnread, useDm, blockLocally } from '../dmStore';
import { call, socket } from '../socket';
import { fmtTime } from '../util';
import { ChatText } from './ChatText';
import { UserAvatar } from './UserAvatar';
import type { RoomState } from '../../shared/types';

type Toast = (t: string, tone?: 'error' | 'info') => void;
type Tab = 'chats' | 'requests' | 'archived';

export const convoTitle = (c: DmConvo, myId: number) =>
  c.name ?? (c.members.filter((m) => m.userId !== myId && !m.left).map((m) => m.username).join(', ') || 'Just you');

export function DmPanel({ myId, toast, startWith, onJoinCall }: { myId: number; toast: Toast; startWith?: string | null; onJoinCall?: (room: RoomState) => void }) {
  const s = useDm();
  const [tab, setTab] = useState<Tab>('chats');
  const [composing, setComposing] = useState(false);
  const [settings, setSettings] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<(DmMessage & { convoName: string })[] | null>(null);
  useEffect(() => { void loadDm().catch((e) => toast((e as Error).message, 'error')); }, [toast]);
  useEffect(() => {
    if (!startWith) return;
    void dmCall<{ convo: DmConvo }>('dm:start', { usernames: [startWith] })
      .then((r) => openConvo(r.convo.id)).catch((e) => toast((e as Error).message, 'error'));
  }, [startWith, toast]);
  useEffect(() => {
    if (query.trim().length < 2) { setResults(null); return; }
    const t = window.setTimeout(() => {
      void dmCall<{ results: (DmMessage & { convoName: string })[] }>('dm:search', { q: query.trim() }).then((r) => setResults(r.results)).catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const list = useMemo(() => {
    const rows = s.convos.filter((c) => (tab === 'requests' ? c.state === 'request' : c.state === 'active' && (tab === 'archived' ? c.archived : !c.archived)));
    return [...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastTs - a.lastTs);
  }, [s.convos, tab]);
  const open = s.convos.find((c) => c.id === s.openId) ?? null;
  const reqs = requestCount(s);
  const archivedUnread = s.convos.filter((c) => c.archived && c.state === 'active').length;

  return (
    <div className={`dm-panel${open ? ' has-open' : ''}`} data-testid="dm-panel">
      <section className="dm-list" aria-label="Conversations">
        <div className="dm-list-head">
          <input type="search" className="dm-search" placeholder="Search whispers" aria-label="Search whispers" value={query} onChange={(e) => setQuery(e.target.value)} data-action="dm-search" />
          <button type="button" className="btn primary small-btn" onClick={() => { setComposing((v) => !v); setSettings(false); }} data-action="dm-new" aria-expanded={composing}>New</button>
          <button type="button" className="icon-btn" onClick={() => { setSettings((v) => !v); setComposing(false); }} aria-label="Whisper settings" title="Whisper settings" aria-expanded={settings} data-action="dm-settings">⚙</button>
        </div>
        {composing && <NewConvo toast={toast} onDone={(id) => { setComposing(false); setTab('chats'); void openConvo(id); }} />}
        {settings && <DmSettings toast={toast} />}
        {results ? (
          <ul className="dm-results" aria-label="Search results" data-testid="dm-results">
            {results.length === 0 && <li className="muted small">No matches</li>}
            {results.map((m) => (
              <li key={m.id}><button type="button" className="dm-row" onClick={() => { setQuery(''); void openConvo(m.convoId); }} data-action="dm-result">
                <span className="dm-row-main"><strong>{m.convoName}</strong><span className="muted small">{m.from}: {m.text.slice(0, 80)}</span></span>
                <span className="muted small">{fmtTime(m.ts)}</span>
              </button></li>
            ))}
          </ul>
        ) : (
          <>
            <div className="dm-tabs" role="tablist" aria-label="Conversation lists">
              <button type="button" role="tab" aria-selected={tab === 'chats'} onClick={() => setTab('chats')} data-tab="chats">Chats{totalUnread(s) > 0 && <span className="badge">{totalUnread(s)}</span>}</button>
              <button type="button" role="tab" aria-selected={tab === 'requests'} onClick={() => setTab('requests')} data-tab="requests">Requests{reqs > 0 && <span className="badge" data-testid="dm-requests-badge">{reqs}</span>}</button>
              <button type="button" role="tab" aria-selected={tab === 'archived'} onClick={() => setTab('archived')} data-tab="archived">Archived{archivedUnread > 0 && <span className="muted small"> {archivedUnread}</span>}</button>
            </div>
            <ul className="dm-rows" data-testid="dm-rows">
              {s.loaded && list.length === 0 && <li className="muted small dm-empty">{tab === 'requests' ? 'No requests. Whispers from people who are not your friends wait here.' : tab === 'archived' ? 'Nothing archived. A new message brings a chat back.' : 'No whispers yet. Press New to start one.'}</li>}
              {list.map((c) => <ConvoRow key={c.id} c={c} myId={myId} active={c.id === s.openId} typing={(s.typing[c.id] ?? []).length > 0} />)}
            </ul>
          </>
        )}
      </section>
      <section className="dm-thread" aria-label={open ? `Conversation: ${convoTitle(open, myId)}` : 'No conversation open'}>
        {open ? <Thread key={open.id} c={open} myId={myId} toast={toast} onJoinCall={onJoinCall} /> : <p className="muted dm-placeholder">Pick a conversation, or press New.</p>}
      </section>
    </div>
  );
}

function ConvoRow({ c, myId, active, typing }: { c: DmConvo; myId: number; active: boolean; typing: boolean }) {
  const other = c.kind === 'direct' ? c.members.find((m) => m.userId !== myId) : undefined;
  return (
    <li>
      <button type="button" className={`dm-row${active ? ' on' : ''}${c.unread ? ' unread' : ''}`} onClick={() => void openConvo(c.id)} data-convo={c.id} data-kind={c.kind} aria-current={active || undefined}>
        {other ? <UserAvatar nick={other.username} accountId={other.userId} chatColor={other.chatColor} hasAvatar={other.hasAvatar} size={28} /> : <span className="dm-group-ico" aria-hidden="true">👥</span>}
        <span className="dm-row-main">
          <strong className="dm-row-name">{c.pinned && <span aria-label="Pinned" title="Pinned">📌 </span>}{convoTitle(c, myId)}{other?.online && <span className="dm-online" aria-label="online" />}</strong>
          <span className="muted small dm-row-last">{typing ? 'typing…' : c.state === 'request' ? 'Wants to whisper you' : c.lastText ?? ''}</span>
        </span>
        <span className="dm-row-side">
          <span className="muted small">{fmtTime(c.lastTs)}</span>
          {c.unread > 0 && <span className="badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>}
          {c.disappearSec > 0 && <span className="muted small" title={`Disappearing: ${disappearLabel(c.disappearSec)}`} aria-label="Disappearing messages on">⏱</span>}
        </span>
      </button>
    </li>
  );
}

function NewConvo({ toast, onDone }: { toast: Toast; onDone: (id: string) => void }) {
  const [names, setNames] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const list = names.split(/[\s,]+/).map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
  const group = list.length > 1;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await dmCall<{ convo: DmConvo }>('dm:start', { usernames: list, name: group ? name : undefined });
      onDone(r.convo.id);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <form className="dm-new" onSubmit={submit} data-testid="dm-new">
      <label className="field">To (one name for a whisper, 2–{DM.groupMax - 1} for a group)
        <input value={names} onChange={(e) => setNames(e.target.value)} placeholder="username, username…" required data-field="dm-to" autoFocus />
      </label>
      {group && <label className="field">Group name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={DM.nameMax} required data-field="dm-group-name" /></label>}
      <button className="btn primary small-btn" disabled={busy || !list.length} data-action="dm-start">{group ? 'Create group' : 'Start'}</button>
    </form>
  );
}

function DmSettings({ toast }: { toast: Toast }) {
  const s = useDm();
  const save = async (p: { policy?: DmPolicy; typing?: boolean }) => {
    try { const r = await dmCall<{ policy: DmPolicy; typing: boolean }>('dm:settings', p); setDmPrefs({ policy: r.policy, typingOn: r.typing }); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const setReceipts = async (on: boolean) => {
    try { const r = await call<{ on: boolean }>((ack) => socket.emit('whisper:receipts', { on }, ack)); setDmPrefs({ receipts: r.on }); void loadDm(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <fieldset className="dm-settings" data-testid="dm-settings">
      <legend>Whisper settings</legend>
      <label className="field">Who can whisper me
        <select value={s.policy} onChange={(e) => void save({ policy: e.target.value as DmPolicy })} data-field="dm-policy">
          <option value="everyone">Everyone</option>
          <option value="requests">Friends; others go to Requests</option>
          <option value="friends">Friends only</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={s.receipts} onChange={(e) => void setReceipts(e.target.checked)} data-field="dm-receipts" /> Read receipts (off = you don't see others' either)</label>
      <label className="check"><input type="checkbox" checked={s.typingOn} onChange={(e) => void save({ typing: e.target.checked })} data-field="dm-typing" /> Typing indicator (off = you don't see others' either)</label>
      <p className="muted small">Staff can always reach you, and you can always reach staff. Moderators only see a whisper when someone reports it.</p>
    </fieldset>
  );
}

function Thread({ c, myId, toast, onJoinCall }: { c: DmConvo; myId: number; toast: Toast; onJoinCall?: (room: RoomState) => void }) {
  const s = useDm();
  const [text, setText] = useState('');
  const [manage, setManage] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const others = c.members.filter((m) => m.userId !== myId && !m.left);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [s.messages.length]);
  useEffect(() => {
    const onVis = () => { const last = dmLast(); if (document.visibilityState === 'visible' && last) markRead(c.id, last.ts); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [c.id]);
  const dmLast = () => s.messages[s.messages.length - 1];
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t) return;
    try {
      await dmCall('dm:send', { convoId: c.id, text: t });
      setText('');
    } catch (err) { toast((err as Error).message, 'error'); }
  };
  // "Seen by": under my newest message that someone has read
  const seen = useMemo(() => {
    const mine = [...s.messages].reverse().find((m) => m.fromId === myId && m.kind !== 'system');
    if (!mine) return null;
    const by = others.filter((m) => (m.readTs ?? 0) >= mine.ts).map((m) => m.username);
    return by.length ? { id: mine.id, by } : null;
  }, [s.messages, others, myId]);
  const typing = (s.typing[c.id] ?? []).filter((t) => t.until > Date.now()).map((t) => t.name);

  return (
    <div className="dm-thread-inner">
      <header className="dm-thread-head">
        <button type="button" className="icon-btn dm-back" onClick={() => void openConvo(null)} aria-label="Back to conversations" data-action="dm-back">←</button>
        <div className="dm-thread-title">
          <strong data-testid="dm-title">{convoTitle(c, myId)}</strong>
          <span className="muted small">{c.kind === 'group' ? `${c.members.filter((m) => !m.left).length} people` : others[0]?.online ? 'online' : ''}{c.disappearSec > 0 && <> · ⏱ {disappearLabel(c.disappearSec)}</>}</span>
        </div>
        <button type="button" className="icon-btn" onClick={() => setManage((v) => !v)} aria-label="Conversation options" title="Options" aria-expanded={manage} data-action="dm-manage">⋯</button>
      </header>
      {manage && <Manage c={c} myId={myId} toast={toast} onClose={() => setManage(false)} />}
      <div className="dm-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions" data-testid="dm-log">
        {s.more && <button type="button" className="linklike small" onClick={() => void loadOlder()} data-action="dm-older">Load older</button>}
        {s.messages.map((m) => (
          <Line key={m.id} m={m} mine={m.fromId === myId}>{seen?.id === m.id && <span className="dm-seen small muted" data-testid="dm-seen">Seen by {seen.by.join(', ')}</span>}</Line>
        ))}
      </div>
      {typing.length > 0 && <div className="dm-typing small muted" aria-live="polite" data-testid="dm-typing">{typing.join(', ')} {typing.length === 1 ? 'is' : 'are'} typing…</div>}
      <form className="dm-composer" onSubmit={send}>
        <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Whisper ${convoTitle(c, myId)}`} aria-label="Message"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} maxLength={2000} data-field="dm-text" />
        <button className="btn primary small-btn" disabled={!text.trim()} data-action="dm-send">Send</button>
      </form>
    </div>
  );
}

function Line({ m, mine, children }: { m: DmMessage; mine: boolean; children?: ReactNode }) {
  if (m.kind === 'system') return <div className="dm-system small muted" data-msg={m.id} data-kind="system">{m.text}</div>;
  return (
    <div className={`dm-line${mine ? ' mine' : ''}`} data-msg={m.id}>
      <div className="dm-bubble">
        {!mine && <span className="dm-from small">{m.from}</span>}
        {m.deleted ? <em className="muted">Message deleted</em> : <ChatText text={m.text} className="dm-text" />}
        <span className="dm-meta small muted">{fmtTime(m.ts)}{m.editedAt ? ' · edited' : ''}</span>
      </div>
      {children}
    </div>
  );
}

function Manage({ c, myId, toast, onClose }: { c: DmConvo; myId: number; toast: Toast; onClose: () => void }) {
  const [add, setAdd] = useState('');
  const [rename, setRename] = useState(c.name ?? '');
  const owner = c.kind === 'group' && c.createdBy === myId;
  const act = async (ev: string, p: Record<string, unknown>, ok?: string) => {
    try { await dmCall(ev, { convoId: c.id, ...p }); if (ok) toast(ok); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="dm-manage" data-testid="dm-manage">
      {c.kind === 'group' && (
        <>
          <ul className="dm-members" aria-label="Members">
            {c.members.filter((m) => !m.left).map((m) => (
              <li key={m.userId}>
                <UserAvatar nick={m.username} accountId={m.userId} chatColor={m.chatColor} hasAvatar={m.hasAvatar} size={20} /> {m.username}{m.owner && <span className="muted small"> (manages)</span>}
                {owner && m.userId !== myId && <button type="button" className="btn ghost small-btn" onClick={() => void act('dm:group:remove', { userId: m.userId }, `${m.username} removed`)} data-action="dm-remove">Remove</button>}
              </li>
            ))}
          </ul>
          {owner && (
            <>
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act('dm:group:add', { username: add.trim() }, `${add.trim()} added`).then(() => setAdd('')); }}>
                <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Add username" aria-label="Add a person" data-field="dm-add" disabled={c.members.filter((m) => !m.left).length >= DM.groupMax} />
                <button className="btn small-btn" disabled={!add.trim() || c.members.filter((m) => !m.left).length >= DM.groupMax} data-action="dm-add">Add</button>
              </form>
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act('dm:group:rename', { name: rename.trim() }, 'Renamed'); }}>
                <input value={rename} onChange={(e) => setRename(e.target.value)} maxLength={DM.nameMax} aria-label="Group name" data-field="dm-rename" />
                <button className="btn small-btn" disabled={!rename.trim()} data-action="dm-rename">Rename</button>
              </form>
            </>
          )}
        </>
      )}
      <div className="dm-manage-actions">
        <button type="button" className="btn ghost small-btn" onClick={() => { onClose(); void act('dm:leave', {}, c.kind === 'group' ? 'You left the group' : 'Conversation closed'); }} data-action="dm-leave">{c.kind === 'group' ? 'Leave group' : 'Close conversation'}</button>
      </div>
    </div>
  );
}
export { blockLocally, dmSock };
