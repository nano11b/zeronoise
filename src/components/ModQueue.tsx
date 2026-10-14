import { useCallback, useEffect, useState } from 'react';
import { LIMITS } from '../../shared/config';
import {
  QUEUE_BUCKETS, REPORT_CATEGORY_LABELS, type QueueAction, type QueueBucket, type QueueCounts, type QueueItem, type QueueSort, type ReportCategory,
} from '../../shared/modq';
import { api } from '../api';
import { useRoomCounts, useStaffCounts } from '../modq';
import { call, socket } from '../socket';
import { BAN_DURATIONS, Dialog, type DialogSpec } from './Dialog';

const BUCKET_LABEL: Record<QueueBucket, string> = { open: 'Open', review: 'In review', resolved: 'Resolved', dismissed: 'Dismissed' };
const MUTE_DURATIONS = [
  { label: '10 minutes', minutes: 10 },
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 1440 },
  { label: '7 days', minutes: 10080 },
];
const ROOM_BAN_DURATIONS = [
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 1440 },
  { label: '7 days', minutes: 10080 },
  { label: 'Until lifted', minutes: null },
];
const EMPTY: QueueCounts = { open: 0, review: 0, resolved: 0, dismissed: 0 };

function ago(ts: number | null) {
  if (!ts) return '-';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const fullTime = (ts: number | null) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '');

function targetLabel(it: QueueItem) {
  const who = it.targetNick ?? 'someone';
  if (it.kind === 'message') return <>Message by <strong>{who}</strong></>;
  if (it.kind === 'whisper') return <>Whisper by <strong>{who}</strong></>;
  if (it.kind === 'room') return <>Room <strong>#{it.roomName ?? it.roomId}</strong></>;
  return <>User <strong>{who}</strong></>;
}

type Backend = {
  list: (b: QueueBucket, s: QueueSort) => Promise<{ items: QueueItem[]; counts: QueueCounts }>;
  claim: (id: number, release: boolean) => Promise<unknown>;
  act: (id: number, body: { action: QueueAction; minutes?: number | null; reason?: string; note?: string }) => Promise<unknown>;
};

/**
 * Moderation queue. mode "site": every report, site powers (staff, in the admin panel).
 * mode "room": reports about this room's messages, room powers, reporter identity hidden unless the viewer is site staff.
 */
export function ModQueue({ mode, roomId, toast }: { mode: 'site' | 'room'; roomId?: string; toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [bucket, setBucket] = useState<QueueBucket>('open');
  const [sort, setSort] = useState<QueueSort>('count');
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [counts, setCounts] = useState<QueueCounts>(EMPTY);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const staffCounts = useStaffCounts();
  const roomCounts = useRoomCounts(roomId ?? '');
  const live = mode === 'site' ? staffCounts : roomCounts;
  const site = mode === 'site';

  const backend: Backend = site ? {
    list: (b, s) => api(`/api/admin/reports?view=queue&status=${b}&sort=${s}`),
    claim: (id, release) => api(`/api/admin/reports/${id}/claim`, { release }),
    act: (id, body) => api(`/api/admin/reports/${id}/action`, body),
  } : {
    list: (b, s) => call((ack) => socket.emit('modq:room:list', { status: b, sort: s }, ack)),
    claim: (id, release) => call((ack) => socket.emit('modq:room:claim', { reportId: id, release }, ack)),
    act: (id, body) => call((ack) => socket.emit('modq:room:act', { reportId: id, ...body }, ack)),
  };
  const load = useCallback(async () => {
    try {
      const r = await backend.list(bucket, sort);
      setItems(r.items); setCounts(r.counts); setError('');
    } catch (e) { setError((e as Error).message); }
  }, [bucket, sort, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load, live.open, live.review, live.resolved, live.dismissed]);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg); await load(); } catch (e) { toast((e as Error).message, 'error'); await load(); }
  };
  const act = (it: QueueItem, action: QueueAction, extra: { minutes?: number | null; reason?: string } = {}) =>
    backend.act(it.id, { action, note: notes[it.key]?.trim() || undefined, ...extra });
  const done = (label: string) => (it: QueueItem) => { setNotes((n) => { const x = { ...n }; delete x[it.key]; return x; }); return label; };

  const mute = (it: QueueItem) => setDialog({
    title: site ? `Mute ${it.targetNick ?? 'user'}` : `Mute ${it.targetNick ?? 'user'} in this room`,
    description: `Resolves ${it.count === 1 ? 'the report' : `all ${it.count} reports`} on this item.`,
    confirm: 'Mute', durations: MUTE_DURATIONS,
    onSubmit: async ({ minutes }) => { await act(it, 'mute', { minutes }); toast(done('Muted')(it)); await load(); },
  });
  const ban = (it: QueueItem) => setDialog({
    title: site ? `Ban ${it.targetNick ?? 'user'}` : `Ban ${it.targetNick ?? 'user'} from this room`,
    description: site ? 'Bans the account, IP and device.' : 'They cannot rejoin this room until the ban ends.',
    confirm: 'Ban', danger: true, durations: site ? BAN_DURATIONS : ROOM_BAN_DURATIONS,
    reason: { label: 'Reason (shown to the user)', required: site, max: LIMITS.banReasonMax },
    onSubmit: async ({ minutes, reason }) => { await act(it, 'ban', { minutes, reason }); toast(done('Banned')(it)); await load(); },
  });
  const warn = (it: QueueItem) => setDialog({
    title: `Warn ${it.targetNick ?? 'user'}`,
    description: 'They see this as a notice from the moderators (at their next sign-in if they are away).',
    confirm: 'Send warning', reason: { label: 'Warning', required: true, max: LIMITS.banReasonMax },
    onSubmit: async ({ reason }) => { await act(it, 'warn', { reason }); toast(done('Warning sent')(it)); await load(); },
  });

  const shownCounts = { ...counts, open: Math.max(counts.open, 0) };
  return (
    <section className={`modq modq-${mode}`} data-testid={`modq-${mode}`}>
      <div className="modq-bar">
        <div className="modq-tabs" role="tablist" aria-label="Report status">
          {QUEUE_BUCKETS.map((b) => (
            <button key={b} type="button" role="tab" aria-selected={bucket === b} className={`tab ${bucket === b ? 'active' : ''}`} data-bucket={b} onClick={() => setBucket(b)}>
              {BUCKET_LABEL[b]} <span className="modq-count" data-count={b}>{shownCounts[b]}</span>
            </button>
          ))}
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as QueueSort)} aria-label="Sort reports" data-action="modq-sort">
          <option value="count">Most reports</option>
          <option value="oldest">Oldest first</option>
          <option value="newest">Newest first</option>
        </select>
      </div>
      {error && <div className="form-error">{error}</div>}
      {items && items.length === 0 && <p className="muted modq-empty">No {BUCKET_LABEL[bucket].toLowerCase()} reports.</p>}
      <div className="report-list">
        {items?.map((it) => {
          const active = it.bucket === 'open' || it.bucket === 'review';
          const firstId = it.reports[0]?.id;
          return (
            <article key={it.key} className={`panel report queue-item${it.hidden ? ' is-hidden' : ''}`} data-report={it.id} data-key={it.key} data-count={it.count}>
              <div className="report-head">
                <span className="queue-target">{targetLabel(it)}</span>
                <span className="tag queue-n" title={`${it.count} report(s) from ${it.reporters} people`}>{it.count} {it.count === 1 ? 'report' : 'reports'}</span>
                {it.roomName && it.kind !== 'room' && <span className="muted small">#{it.roomName}</span>}
                <span className="muted small" title={fullTime(it.firstAt)}>first {ago(it.firstAt)}{it.count > 1 ? ` · last ${ago(it.lastAt)}` : ''}</span>
                {it.hidden && <span className="tag tag-warn" data-hidden="1">Hidden pending review</span>}
                {it.messageGone && <span className="tag">message deleted</span>}
                {it.snapshot?.private && <span className="tag" title="Private content, kept because the reporter could see it">{it.snapshot.private === 'burn' ? 'burn message' : 'whisper'}</span>}
                {it.claimedBy && active && <span className="tag status-review" data-claimed={it.claimedBy}>{it.claimedBy} is on it</span>}
              </div>
              <p className="queue-cats">
                {(Object.entries(it.categories) as [ReportCategory, number][]).map(([c, n]) => <span key={c} className="tag cat-tag">{REPORT_CATEGORY_LABELS[c]}{n > 1 ? ` ×${n}` : ''}</span>)}
              </p>
              {it.snapshot && (it.kind === 'message' || it.kind === 'whisper') && (
                <div className="queue-snap">
                  {it.snapshot.text != null ? <p className="small"><span className="muted">Reported message{it.snapshot.editedAt ? ' (as it was when reported)' : ''}:</span> <span className="quoted" data-snapshot="1">{it.snapshot.text || '(no text)'}</span></p>
                    : <p className="muted small">Private content: visible to site staff only.</p>}
                  {it.snapshot.attachments.length > 0 && (
                    <div className="queue-att">
                      {it.snapshot.attachments.map((a, i) => (site && a.evidence && firstId
                        ? (a.kind === 'image'
                          ? <a key={i} href={`/api/admin/reports/${firstId}/evidence/${a.evidence}`} target="_blank" rel="noreferrer"><img src={`/api/admin/reports/${firstId}/evidence/${a.evidence}`} alt="Reported image" width={96} height={96} loading="lazy" /></a>
                          : <audio key={i} controls preload="none" src={`/api/admin/reports/${firstId}/evidence/${a.evidence}`} aria-label="Reported voice note" />)
                        : <span key={i} className="tag">{a.kind === 'image' ? 'image' : 'voice note'}{a.evidence ? ' (kept)' : ''}</span>))}
                    </div>
                  )}
                </div>
              )}
              {it.kind === 'room' && it.snapshot?.topic && <p className="small"><span className="muted">Topic when reported:</span> <span className="quoted">{it.snapshot.topic}</span></p>}
              {it.context.length > 0 && (
                <details>
                  <summary className="muted small">Chat context ({it.context.length} {it.context.length === 1 ? 'line' : 'lines'})</summary>
                  <div className="context">
                    {it.context.map((c, i) => (
                      <div key={i} className={`msg ${c.target ? 'flag' : ''}`}><span className="ts">{fullTime(c.ts)}</span> <strong>{c.from}</strong> {c.text}{c.deleted ? <span className="muted"> (deleted)</span> : null}</div>
                    ))}
                  </div>
                </details>
              )}
              <details className="queue-reports">
                <summary className="muted small">{it.count === 1 ? 'The report' : `All ${it.count} reports`}{site ? '' : ' (reporters stay anonymous)'}</summary>
                <ul>
                  {it.reports.map((r) => (
                    <li key={r.id} data-report-id={r.id}>
                      <span className="muted small">#{r.id} · {ago(r.updatedAt ?? r.createdAt)}</span> {REPORT_CATEGORY_LABELS[r.category]}
                      {r.reporterNick && <span className="muted small"> · by {r.reporterNick}</span>}
                      {r.note && <> · <span className="quoted">{r.note}</span></>}
                    </li>
                  ))}
                </ul>
              </details>
              {active ? (
                <>
                  <label className="field queue-note">
                    <span className="muted small">Resolution note (optional, staff only)</span>
                    <input value={notes[it.key] ?? ''} maxLength={500} onChange={(e) => setNotes((n) => ({ ...n, [it.key]: e.target.value }))} />
                  </label>
                  <div className="row-actions queue-actions">
                    {it.bucket === 'open'
                      ? <button type="button" className="btn small-btn" data-action="claim" onClick={() => run(() => backend.claim(it.id, false), 'You are on it')}>I'm on it</button>
                      : <button type="button" className="btn ghost small-btn" data-action="release" onClick={() => run(() => backend.claim(it.id, true), 'Released')}>Release</button>}
                    {it.messageId && !it.messageGone && <button type="button" className="btn danger-btn small-btn" data-action="q-delete" onClick={() => run(() => act(it, 'delete').then(() => done('')(it)), 'Message deleted')}>Delete message</button>}
                    {(it.targetUserId != null || it.targetNick) && <>
                      <button type="button" className="btn small-btn" data-action="q-mute" onClick={() => mute(it)}>{site ? 'Mute…' : 'Room mute…'}</button>
                      {it.targetOnline && <button type="button" className="btn small-btn" data-action="q-kick" onClick={() => run(() => act(it, 'kick').then(() => done('')(it)), 'Kicked')}>Kick</button>}
                      <button type="button" className="btn danger-btn small-btn" data-action="q-ban" onClick={() => ban(it)}>{site ? 'Ban…' : 'Room ban…'}</button>
                      {site && <button type="button" className="btn small-btn" data-action="q-warn" onClick={() => warn(it)}>Warn…</button>}
                    </>}
                    <button type="button" className="btn primary small-btn" data-action="q-resolve" onClick={() => run(() => act(it, 'resolve').then(() => done('')(it)), 'Resolved')}>Resolve</button>
                    <button type="button" className="btn ghost small-btn" data-action="q-dismiss" onClick={() => run(() => act(it, 'dismiss').then(() => done('')(it)), 'Dismissed')}>Dismiss</button>
                  </div>
                </>
              ) : (
                <p className="muted small queue-outcome">{it.resolution ?? it.bucket} · by {it.handledBy ?? '?'} · {ago(it.handledAt)}{it.note ? <> · <span className="quoted">{it.note}</span></> : null}</p>
              )}
            </article>
          );
        })}
      </div>
      {dialog && <Dialog spec={dialog} onClose={() => setDialog(null)} />}
    </section>
  );
}
