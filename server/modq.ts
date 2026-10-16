/**
 * Moderation queue storage. Extends the existing `reports` table (no parallel system):
 * every report row still carries reporter / target / room / message / reason / context, plus a grouping key,
 * a reason category, the reporter's note, a frozen snapshot, a claim and the resolution.
 *
 * Buckets: open = status 'open' and unclaimed; review = 'open' and claimed; resolved; dismissed.
 * Items group reports by target (same message / user / room), so five reports on one message are one item.
 */
import fs from 'node:fs';
import path from 'node:path';
import { q, tx } from './db';
import { DATA_DIR } from './env';
import {
  MODQ, isReportCategory, type QueueBucket, type QueueCounts, type QueueItem, type QueueReport, type QueueSort,
  type ReportCategory, type ReportContextLine, type ReportSnapshot, type ReportTargetKind,
} from '../shared/modq';

export const EVIDENCE_DIR = path.join(DATA_DIR, 'report-evidence');
const now = () => Date.now();

/** Grouping key; tolerates rows written before the key existed (a skewed schema skips the backfill). */
const GK = `COALESCE(target_key, CASE WHEN message_id IS NOT NULL THEN 'm:' || message_id ELSE 'x:' || id END)`;
const BUCKET: Record<QueueBucket, string> = {
  open: `status = 'open' AND claimed_by IS NULL`,
  review: `status = 'open' AND claimed_by IS NOT NULL`,
  resolved: `status = 'resolved'`,
  dismissed: `status = 'dismissed'`,
};
export const isBucket = (v: unknown): v is QueueBucket => typeof v === 'string' && v in BUCKET;

export interface ReportRowFull {
  id: number; created_at: number; status: 'open' | 'resolved' | 'dismissed';
  reporter_user_id: number | null; reporter_nick: string; reporter_ip: string | null;
  target_user_id: number | null; target_nick: string | null; target_ip: string | null; target_device: string | null;
  room_id: string | null; message_id: string | null; message_text: string | null; reason: string; context: string;
  handled_by: string | null; handled_at: number | null; note: string | null;
  target_kind: ReportTargetKind | null; target_key: string | null; category: string | null; reporter_note: string | null;
  snapshot: string | null; private_kind: string | null; claimed_by: string | null; claimed_by_id: number | null; claimed_at: number | null;
  updated_at: number | null; resolution: string | null; notify_reporter: number; reporter_notified_at: number | null;
}
export const groupKeyOf = (r: Pick<ReportRowFull, 'id' | 'target_key' | 'message_id'>) => r.target_key ?? (r.message_id ? `m:${r.message_id}` : `x:${r.id}`);

export function reportById(id: number): ReportRowFull | undefined {
  return q('SELECT * FROM reports WHERE id = ?').get(id) as ReportRowFull | undefined;
}

export interface NewReport {
  reporterUserId: number | null; reporterNick: string; reporterIp: string;
  targetUserId: number | null; targetNick: string | null; targetIp: string | null; targetDevice: string | null;
  roomId: string | null; messageId: string | null; messageText: string | null;
  kind: ReportTargetKind; key: string; category: ReportCategory; note: string | null;
  snapshot: ReportSnapshot | null; privateKind: 'burn' | 'whisper' | null; context: ReportContextLine[]; notify: boolean;
}

/** Same reporter + same target, still open, within 24 h. */
export function findDuplicate(r: Pick<NewReport, 'reporterUserId' | 'reporterIp' | 'reporterNick' | 'key'>): ReportRowFull | undefined {
  const since = now() - MODQ.dedupeMs;
  if (r.reporterUserId != null) {
    return q(`SELECT * FROM reports WHERE ${GK} = ? AND status = 'open' AND created_at >= ? AND reporter_user_id = ? ORDER BY id DESC LIMIT 1`)
      .get(r.key, since, r.reporterUserId) as ReportRowFull | undefined;
  }
  return q(`SELECT * FROM reports WHERE ${GK} = ? AND status = 'open' AND created_at >= ? AND reporter_user_id IS NULL AND reporter_ip = ? AND lower(reporter_nick) = lower(?) ORDER BY id DESC LIMIT 1`)
    .get(r.key, since, r.reporterIp, r.reporterNick) as ReportRowFull | undefined;
}

export function updateDuplicate(id: number, category: ReportCategory, note: string | null, notify: boolean) {
  q('UPDATE reports SET category = ?, reporter_note = ?, reason = ?, notify_reporter = ?, updated_at = ? WHERE id = ?')
    .run(category, note, reasonText(category, note), notify ? 1 : 0, now(), id);
}

const reasonText = (category: ReportCategory, note: string | null) => (note ? `${category}: ${note}` : category).slice(0, 600);

export function insertReport(r: NewReport): number {
  return tx(() => {
    // A new report on an item someone already claimed joins that claim.
    const claim = q(`SELECT claimed_by, claimed_by_id, claimed_at FROM reports WHERE ${GK} = ? AND status = 'open' AND claimed_by IS NOT NULL LIMIT 1`)
      .get(r.key) as { claimed_by: string; claimed_by_id: number | null; claimed_at: number } | undefined;
    const row = q(`INSERT INTO reports (created_at, reporter_user_id, reporter_nick, reporter_ip, target_user_id, target_nick, target_ip, target_device,
        room_id, message_id, message_text, reason, context, target_kind, target_key, category, reporter_note, snapshot, private_kind,
        claimed_by, claimed_by_id, claimed_at, notify_reporter)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
      now(), r.reporterUserId, r.reporterNick, r.reporterIp, r.targetUserId, r.targetNick, r.targetIp, r.targetDevice,
      r.roomId, r.messageId, r.messageText, reasonText(r.category, r.note), JSON.stringify(r.context), r.kind, r.key, r.category, r.note,
      r.snapshot ? JSON.stringify(r.snapshot) : null, r.privateKind,
      claim?.claimed_by ?? null, claim?.claimed_by_id ?? null, claim?.claimed_at ?? null, r.notify ? 1 : 0,
    ) as { id: number };
    return row.id;
  });
}

/** Distinct registered reporters on one message's open reports in the auto-hide window. */
export function recentRegisteredReporters(messageId: string): number {
  const row = q(`SELECT COUNT(DISTINCT reporter_user_id) AS n FROM reports WHERE ${GK} = ? AND status = 'open' AND reporter_user_id IS NOT NULL AND created_at >= ?`)
    .get(`m:${messageId}`, now() - MODQ.autoHideWindowMs) as { n: number };
  return row.n;
}

export interface Scope { roomId: string }
// room view: messages in the room, plus lines the room's word / link filters blocked (filed by the moderator bot)
const scopeSql = (scope?: Scope) => (scope ? ` AND room_id = ? AND (COALESCE(target_kind, CASE WHEN message_id IS NOT NULL THEN 'message' END) = 'message' OR target_key LIKE 'filter:%') AND COALESCE(private_kind, '') <> 'whisper'` : '');
const scopeArgs = (scope?: Scope) => (scope ? [scope.roomId] : []);

export function counts(scope?: Scope): QueueCounts {
  const out: QueueCounts = { open: 0, review: 0, resolved: 0, dismissed: 0 };
  for (const b of Object.keys(BUCKET) as QueueBucket[]) {
    const row = q(`SELECT COUNT(DISTINCT ${GK}) AS n FROM reports WHERE ${BUCKET[b]}${scopeSql(scope)}`).get(...scopeArgs(scope)) as { n: number };
    out[b] = row.n;
  }
  return out;
}

/** Rows of one item in one bucket (oldest first). */
export function groupRows(key: string, bucket: QueueBucket | 'active'): ReportRowFull[] {
  const cond = bucket === 'active' ? `status = 'open'` : BUCKET[bucket];
  return q(`SELECT * FROM reports WHERE ${GK} = ? AND ${cond} ORDER BY created_at, id`).all(key) as unknown as ReportRowFull[];
}

/** Item keys for a bucket, sorted. */
export function groupKeys(bucket: QueueBucket, sort: QueueSort, scope?: Scope, limit = 100): string[] {
  const order = sort === 'oldest' ? 'first_at ASC' : sort === 'newest' ? 'last_at DESC' : 'n DESC, first_at ASC';
  const rows = q(`SELECT ${GK} AS k, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(COALESCE(updated_at, created_at)) AS last_at
    FROM reports WHERE ${BUCKET[bucket]}${scopeSql(scope)} GROUP BY k ORDER BY ${order} LIMIT ${Math.max(1, Math.min(limit, 200))}`).all(...scopeArgs(scope)) as { k: string }[];
  return rows.map((r) => r.k);
}

export const bucketOf = (r: Pick<ReportRowFull, 'status' | 'claimed_by'>): QueueBucket =>
  (r.status === 'open' ? (r.claimed_by ? 'review' : 'open') : r.status);

export function parseSnapshot(raw: string | null): ReportSnapshot | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as ReportSnapshot; } catch { return null; }
}
function parseContext(raw: string | null): ReportContextLine[] {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export interface ItemView {
  /** site staff see reporter identities and whisper / burn content */
  staff: boolean;
  messageExists: (id: string) => boolean;
  hidden: (id: string) => boolean;
  roomName: (id: string) => string | null;
  targetOnline: (r: ReportRowFull) => boolean;
  targetRole: (userId: number | null) => string | null;
}

/** Build the queue item for rows of one target in one bucket. */
export function toItem(rows: ReportRowFull[], view: ItemView): QueueItem {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const kind: ReportTargetKind = (first.target_kind as ReportTargetKind | null) ?? (first.message_id ? 'message' : 'user');
  const categories: QueueItem['categories'] = {};
  const reporterKeys = new Set<string>();
  const reports: QueueReport[] = rows.map((r) => {
    const cat = isReportCategory(r.category) ? r.category : 'other';
    categories[cat] = (categories[cat] ?? 0) + 1;
    reporterKeys.add(r.reporter_user_id != null ? `u:${r.reporter_user_id}` : `g:${r.reporter_ip}:${r.reporter_nick.toLowerCase()}`);
    const base: QueueReport = { id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, category: cat, note: r.reporter_note ?? (r.category ? null : r.reason) };
    return view.staff ? { ...base, reporterNick: r.reporter_nick, reporterUserId: r.reporter_user_id } : base;
  });
  let snapshot = parseSnapshot(first.snapshot);
  if (!snapshot && (first.message_text != null || first.target_nick)) {
    snapshot = { text: first.message_text, attachments: [], senderAccountId: first.target_user_id, senderNick: first.target_nick, roomId: first.room_id, roomName: first.room_id ? view.roomName(first.room_id) : null, ts: null, private: null };
  }
  let context = parseContext(first.context);
  const privateKind = (first.private_kind as 'burn' | 'whisper' | null) ?? snapshot?.private ?? null;
  if (!view.staff && privateKind) {
    // Burn / whisper content is for site staff only.
    if (snapshot) snapshot = { ...snapshot, text: null, attachments: [] };
    context = context.map((c) => (c.target ? { ...c, text: '' } : c));
  }
  const messageId = first.message_id;
  return {
    key: groupKeyOf(first),
    id: last.id,
    kind,
    bucket: bucketOf(last),
    count: rows.length,
    reporters: reporterKeys.size,
    firstAt: first.created_at,
    lastAt: Math.max(...rows.map((r) => r.updated_at ?? r.created_at)),
    categories,
    targetNick: first.target_nick,
    targetUserId: first.target_user_id,
    targetRole: view.targetRole(first.target_user_id),
    roomId: first.room_id,
    roomName: snapshot?.roomName ?? (first.room_id ? view.roomName(first.room_id) : null),
    messageId,
    messageGone: !!messageId && !view.messageExists(messageId),
    hidden: !!messageId && view.hidden(messageId),
    snapshot: snapshot ? { ...snapshot, private: privateKind } : null,
    context,
    reports,
    claimedBy: last.claimed_by,
    claimedAt: last.claimed_at,
    handledBy: last.handled_by,
    handledAt: last.handled_at,
    resolution: last.resolution,
    note: last.note,
    targetOnline: view.targetOnline(first),
  };
}

export function listItems(bucket: QueueBucket, sort: QueueSort, view: ItemView, scope?: Scope): QueueItem[] {
  return groupKeys(bucket, sort, scope).map((k) => {
    const rows = groupRows(k, bucket).filter((r) => !scope || r.room_id === scope.roomId);
    return rows.length ? toItem(rows, view) : null;
  }).filter((x): x is QueueItem => !!x);
}

/** Claim (or release) every open report of the item. Returns the current claimant when someone else holds it. */
export function claim(key: string, by: string, byId: number | null, release: boolean, force: boolean): { ok: true } | { ok: false; heldBy: string } {
  return tx(() => {
    const rows = groupRows(key, 'active');
    if (!rows.length) return { ok: false as const, heldBy: '' };
    const held = rows.find((r) => r.claimed_by && r.claimed_by_id !== byId && r.claimed_by !== by);
    if (held && !force) return { ok: false as const, heldBy: held.claimed_by! };
    if (release) q(`UPDATE reports SET claimed_by = NULL, claimed_by_id = NULL, claimed_at = NULL WHERE ${GK} = ? AND status = 'open'`).run(key);
    else q(`UPDATE reports SET claimed_by = ?, claimed_by_id = ?, claimed_at = ? WHERE ${GK} = ? AND status = 'open'`).run(by, byId, now(), key);
    return { ok: true as const };
  });
}

/** Close every open report of the item. Returns the closed rows. */
export function closeGroup(key: string, status: 'resolved' | 'dismissed', by: string, note: string | null, resolution: string | null): ReportRowFull[] {
  return tx(() => {
    const rows = groupRows(key, 'active');
    q(`UPDATE reports SET status = ?, handled_by = ?, handled_at = ?, note = ?, resolution = ? WHERE ${GK} = ? AND status = 'open'`)
      .run(status, by, now(), note, resolution, key);
    return rows;
  });
}
export function markReporterNotified(ids: number[]) {
  for (const id of ids) q('UPDATE reports SET reporter_notified_at = ? WHERE id = ?').run(now(), id);
}
/** Open reports left on a message (after a single-report status change). */
export function openOnMessage(messageId: string): number {
  return (q(`SELECT COUNT(*) AS n FROM reports WHERE ${GK} = ? AND status = 'open'`).get(`m:${messageId}`) as { n: number }).n;
}

// ---------------- auto-hide ----------------
export function hiddenIds(): { message_id: string; room_id: string }[] {
  return q('SELECT message_id, room_id FROM hidden_messages').all() as { message_id: string; room_id: string }[];
}
export function hideMessage(messageId: string, roomId: string, reportId: number | null) {
  q('INSERT OR IGNORE INTO hidden_messages (message_id, room_id, hidden_at, report_id) VALUES (?,?,?,?)').run(messageId, roomId, now(), reportId);
}
export function unhideMessage(messageId: string): boolean {
  return q('DELETE FROM hidden_messages WHERE message_id = ?').run(messageId).changes > 0;
}

// ---------------- user notices (warnings, report outcomes) ----------------
export function addNotice(userId: number, kind: 'warn' | 'report', text: string, delivered: boolean): number {
  const row = q('INSERT INTO user_notices (user_id, created_at, kind, text, delivered_at) VALUES (?,?,?,?,?) RETURNING id')
    .get(userId, now(), kind, text, delivered ? now() : null) as { id: number };
  return row.id;
}
export function takeNotices(userId: number): { id: number; kind: 'warn' | 'report'; text: string; created_at: number }[] {
  return tx(() => {
    const rows = q('SELECT id, kind, text, created_at FROM user_notices WHERE user_id = ? AND delivered_at IS NULL ORDER BY id LIMIT 20').all(userId) as { id: number; kind: 'warn' | 'report'; text: string; created_at: number }[];
    for (const r of rows) q('UPDATE user_notices SET delivered_at = ? WHERE id = ?').run(now(), r.id);
    return rows;
  });
}

export function staffAccountIds(): number[] {
  return (q("SELECT id FROM users WHERE role IN ('admin','moderator')").all() as { id: number }[]).map((r) => r.id);
}

// ---------------- evidence files ----------------
/** Copy an attachment so deleting the message cannot erase it. Returns the stored file name. */
export function keepEvidence(reportId: number, src: string, name: string): string | null {
  try {
    if (!fs.existsSync(src)) return null;
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const safe = `${reportId}-${name.replace(/[^\w.-]/g, '')}`;
    fs.copyFileSync(src, path.join(EVIDENCE_DIR, safe));
    return safe;
  } catch { return null; }
}
export function evidencePath(reportId: number, file: string): string | null {
  if (!/^[\w.-]{1,120}$/.test(file) || !file.startsWith(`${reportId}-`)) return null;
  const p = path.join(EVIDENCE_DIR, file);
  return fs.existsSync(p) ? p : null;
}
export function setSnapshot(id: number, snap: ReportSnapshot) {
  q('UPDATE reports SET snapshot = ? WHERE id = ?').run(JSON.stringify(snap), id);
}

// ---------------- context around a message ----------------
type Msg = import('./repo').MsgRow;
/** Newest first: lines at or before ts (excluding the message itself), deleted ones included as evidence. */
export function messagesBefore(roomId: string, ts: number, id: string, n: number): Msg[] {
  return q('SELECT * FROM messages WHERE room_id = ? AND ts <= ? AND id <> ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(roomId, ts, id, n) as unknown as Msg[];
}
/** Oldest first: lines after ts. */
export function messagesAfter(roomId: string, ts: number, id: string, n: number): Msg[] {
  return q('SELECT * FROM messages WHERE room_id = ? AND ts > ? AND id <> ? ORDER BY ts ASC, rowid ASC LIMIT ?').all(roomId, ts, id, n) as unknown as Msg[];
}
