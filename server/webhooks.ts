/**
 * Room webhooks.
 *  - incoming: POST /api/webhooks/:id/:token (Discord-style) posts a line into the room as the hook's name + avatar.
 *    Only a SHA-256 of the token is stored; the full URL is shown once (create / regenerate).
 *  - outgoing: room events are POSTed as JSON to an owner-chosen HTTPS URL, signed with HMAC-SHA256
 *    (X-ZN-Signature: sha256=hex(hmac(secret, `${timestamp}.${body}`))). Retries with backoff, auto-disable
 *    after WEBHOOK.maxFails final failures in a row, SSRF-safe fetch (public addresses only), timeouts.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { q, tx } from './db';
import { DATA_DIR } from './env';
import { checkOutboundUrl, isTestAllowed, safeFetch, FetchError } from './safeFetch';
import * as secretbox from './secretbox';
import { WEBHOOK, WEBHOOK_EVENTS, type WebhookEmbed, type WebhookEvent, type WebhookInfo, type WebhookLogEntry } from '../shared/webhooks';

export interface HookRow {
  id: string; room_id: string; kind: 'incoming' | 'outgoing'; name: string; avatar: string | null;
  token_hash: string | null; url: string | null; secret: string | null; events: string;
  enabled: number; fail_count: number; disabled_reason: string | null; created_by: number | null;
  created_at: number; updated_at: number; last_used_at: number | null; revoked_at: number | null; revoked_by: string | null;
}
const now = () => Date.now();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const AVATAR_DIR = path.join(DATA_DIR, 'webhook-avatars');

// ---------- rows ----------
export const hookById = (id: string) => q('SELECT * FROM room_webhooks WHERE id = ?').get(id) as HookRow | undefined;
export const hooksForRoom = (roomId: string, includeRevoked = false) =>
  q(`SELECT * FROM room_webhooks WHERE room_id = ? ${includeRevoked ? '' : 'AND revoked_at IS NULL'} ORDER BY created_at`).all(roomId) as unknown as HookRow[];
export const allHooks = () => q('SELECT * FROM room_webhooks WHERE revoked_at IS NULL ORDER BY room_id, created_at').all() as unknown as HookRow[];
export const liveCount = (roomId: string) => (q('SELECT COUNT(*) AS n FROM room_webhooks WHERE room_id = ? AND revoked_at IS NULL').get(roomId) as { n: number }).n;

/** A fresh incoming token (URL-safe, 48 chars). */
const newToken = () => randomBytes(36).toString('base64url');
const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;
/** Outgoing secrets are sealed with CAMCHAT_SECRET_KEY when it is set (plain otherwise, like TOTP seeds). */
const sealSecret = (id: string, secret: string) => (secretbox.secretKeySet() ? secretbox.seal(secret, `webhook:${id}`) : `plain:${secret}`);
export function secretOf(h: HookRow): string | null {
  if (!h.secret) return null;
  if (h.secret.startsWith('plain:')) return h.secret.slice(6);
  return secretbox.open(h.secret, `webhook:${h.id}`);
}

export function cleanName(raw: unknown): string {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, WEBHOOK.nameMax);
}
export function cleanEvents(raw: unknown): WebhookEvent[] {
  const arr = Array.isArray(raw) ? raw : [];
  return WEBHOOK_EVENTS.filter((e) => arr.includes(e));
}
/** Outgoing target: https only (plain http only for an exact test-allowed host), no credentials, public host. */
export function cleanTargetUrl(raw: unknown): { url: string } | { error: string } {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 500) return { error: 'Enter an https:// URL' };
  let u: URL;
  try { u = checkOutboundUrl(s); } catch (e) { return { error: e instanceof FetchError ? `URL not allowed: ${e.message}` : 'Bad URL' }; }
  if (u.protocol !== 'https:' && !isTestAllowed(u)) return { error: 'Outgoing webhooks need an https:// URL' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) && !isTestAllowed(u)) return { error: 'URL not allowed: private host' };
  return { url: u.toString() };
}

export function createIncoming(roomId: string, name: string, by: number | null): { row: HookRow; token: string } {
  const id = randomUUID().replace(/-/g, '').slice(0, 20);
  const token = newToken();
  const t = now();
  q(`INSERT INTO room_webhooks (id, room_id, kind, name, token_hash, events, enabled, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)`)
    .run(id, roomId, 'incoming', name, sha(token), '[]', by, t, t);
  return { row: hookById(id)!, token };
}
export function createOutgoing(roomId: string, name: string, url: string, events: WebhookEvent[], by: number | null): { row: HookRow; secret: string } {
  const id = randomUUID().replace(/-/g, '').slice(0, 20);
  const secret = newSecret();
  const t = now();
  q(`INSERT INTO room_webhooks (id, room_id, kind, name, url, secret, events, enabled, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)`)
    .run(id, roomId, 'outgoing', name, url, sealSecret(id, secret), JSON.stringify(events), by, t, t);
  return { row: hookById(id)!, secret };
}
/** New token (incoming) or signing secret (outgoing); the old one stops working at once. */
export function regenerate(h: HookRow): string {
  if (h.kind === 'incoming') {
    const token = newToken();
    q('UPDATE room_webhooks SET token_hash = ?, updated_at = ? WHERE id = ?').run(sha(token), now(), h.id);
    return token;
  }
  const secret = newSecret();
  q('UPDATE room_webhooks SET secret = ?, updated_at = ? WHERE id = ?').run(sealSecret(h.id, secret), now(), h.id);
  return secret;
}
export function update(h: HookRow, p: { name?: string; url?: string; events?: WebhookEvent[]; enabled?: boolean }) {
  q(`UPDATE room_webhooks SET name = ?, url = ?, events = ?, enabled = ?, fail_count = ?, disabled_reason = ?, updated_at = ? WHERE id = ?`).run(
    p.name ?? h.name, p.url ?? h.url, p.events ? JSON.stringify(p.events) : h.events,
    p.enabled === undefined ? h.enabled : p.enabled ? 1 : 0,
    p.enabled ? 0 : h.fail_count, p.enabled === undefined ? h.disabled_reason : p.enabled ? null : h.disabled_reason,
    now(), h.id);
}
export function setDisabled(id: string, reason: string) {
  q('UPDATE room_webhooks SET enabled = 0, disabled_reason = ?, updated_at = ? WHERE id = ?').run(reason, now(), id);
}
/** Soft revoke: the row and its log stay (audit), the URL / deliveries stop for good. */
export function revoke(id: string, by: string) {
  q('UPDATE room_webhooks SET revoked_at = ?, revoked_by = ?, enabled = 0, token_hash = NULL, updated_at = ? WHERE id = ?').run(now(), by, now(), id);
  queues.delete(id);
}
export function setAvatar(id: string, key: string | null) { q('UPDATE room_webhooks SET avatar = ?, updated_at = ? WHERE id = ?').run(key, now(), id); }

/** Token check for incoming calls: constant-time compare of the hashes. */
export function matchIncoming(id: string, token: string): HookRow | null {
  const h = hookById(id);
  if (!h || h.kind !== 'incoming' || h.revoked_at || !h.token_hash || !token) return null;
  const a = Buffer.from(h.token_hash, 'hex'), b = Buffer.from(sha(token), 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? h : null;
}
export const touch = (id: string) => q('UPDATE room_webhooks SET last_used_at = ? WHERE id = ?').run(now(), id);

// ---------- delivery / request log (last WEBHOOK.logKeep shown; older rows pruned past 200 per hook) ----------
export function logEntry(hookId: string, e: Omit<WebhookLogEntry, 'id' | 'ts'> & { ts?: number }) {
  const id = randomUUID();
  q('INSERT INTO webhook_deliveries (id, hook_id, ts, direction, event, status, ok, attempt, duration_ms, error, summary) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, hookId, e.ts ?? now(), e.direction, e.event, e.status, e.ok ? 1 : 0, e.attempt, e.durationMs, e.error ? e.error.slice(0, 300) : null, e.summary ? e.summary.slice(0, 200) : null);
  if (Math.random() < 0.05) q(`DELETE FROM webhook_deliveries WHERE hook_id = ? AND id NOT IN (SELECT id FROM webhook_deliveries WHERE hook_id = ? ORDER BY ts DESC LIMIT 200)`).run(hookId, hookId);
  return id;
}
export function logFor(hookId: string, limit: number = WEBHOOK.logKeep): WebhookLogEntry[] {
  return (q('SELECT * FROM webhook_deliveries WHERE hook_id = ? ORDER BY ts DESC LIMIT ?').all(hookId, limit) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), ts: Number(r.ts), direction: r.direction as 'in' | 'out', event: (r.event as string) ?? null, status: (r.status as number) ?? null,
    ok: !!r.ok, attempt: Number(r.attempt), durationMs: (r.duration_ms as number) ?? null, error: (r.error as string) ?? null, summary: (r.summary as string) ?? null,
  }));
}

export function info(h: HookRow, nameOf: (id: number) => string | null): WebhookInfo {
  return {
    id: h.id, kind: h.kind, name: h.name, avatarUrl: h.avatar ? `/api/webhook-avatars/${h.avatar}` : null,
    enabled: !!h.enabled && !h.revoked_at, disabledReason: h.disabled_reason, createdAt: h.created_at,
    createdBy: h.created_by != null ? nameOf(h.created_by) : null, lastUsedAt: h.last_used_at,
    ...(h.kind === 'outgoing' ? { url: h.url ?? '', events: cleanEvents(safeJson(h.events)), failCount: h.fail_count } : { urlHint: `/api/webhooks/${h.id}/••••••••` }),
  };
}
const safeJson = (s: string | null) => { try { return JSON.parse(s ?? 'null'); } catch { return null; } };

// ---------- incoming payloads (Discord-compatible subset) ----------
export interface IncomingPost { content: string; username: string | null; avatarUrl: string | null; embeds: WebhookEmbed[]; fallback: string }
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, n) : '');
const httpUrl = (v: unknown) => { const s = clip(v, 1000); if (!s) return undefined; try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined; } catch { return undefined; } };
/** Discord markup that has no meaning here: <@id>, <#id>, <@&id>, <:name:id>, <t:unix:style>. */
export function translateDiscord(text: string): string {
  return text
    .replace(/<a?:([A-Za-z0-9_]{2,32}):\d{5,25}>/g, ':$1:')
    .replace(/<t:(-?\d{1,13})(?::[tTdDfFR])?>/g, (_m, s) => { const d = new Date(Number(s) * 1000); return Number.isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : _m; })
    .replace(/<@!?(\d{5,25})>/g, '@user').replace(/<@&(\d{5,25})>/g, '@role').replace(/<#(\d{5,25})>/g, '#channel');
}
/** No mass pings, no real @mentions from a webhook: @everyone / @here / @name are shown, never notify. */
export const defuseMentions = (text: string) => text.replace(/@(everyone|here|channel|room|all)\b/gi, '@\u200b$1');
export function normalizeIncoming(body: unknown): IncomingPost | { error: string; code: number } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const rawContent = typeof b.content === 'string' ? b.content : typeof b.text === 'string' ? b.text : '';
  if (rawContent.length > WEBHOOK.contentMax) return { error: `Must be ${WEBHOOK.contentMax} or fewer in length.`, code: 50035 };
  const content = defuseMentions(translateDiscord(rawContent.replace(/\r\n?/g, '\n'))).trim();
  const embedsIn = Array.isArray(b.embeds) ? b.embeds : b.embed && typeof b.embed === 'object' ? [b.embed] : [];
  if (embedsIn.length > WEBHOOK.embedsMax) return { error: `At most ${WEBHOOK.embedsMax} embeds`, code: 50035 };
  const embeds: WebhookEmbed[] = [];
  let total = 0;
  for (const raw of embedsIn) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const t = (v: unknown, n: number) => defuseMentions(translateDiscord(clip(v, n)));
    const out: WebhookEmbed = {};
    const title = t(e.title, 256); if (title) out.title = title;
    const desc = t(e.description, 4096); if (desc) out.description = desc;
    const url = httpUrl(e.url); if (url) out.url = url;
    if (typeof e.color === 'number' && Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff) out.color = e.color;
    const au = e.author as Record<string, unknown> | undefined; if (au && t(au.name, 256)) out.author = { name: t(au.name, 256), ...(httpUrl(au.url) ? { url: httpUrl(au.url) } : {}) };
    const ft = e.footer as Record<string, unknown> | undefined; if (ft && t(ft.text, 2048)) out.footer = { text: t(ft.text, 2048) };
    if (Array.isArray(e.fields)) {
      const fields = e.fields.slice(0, 25).map((f) => { const ff = (f ?? {}) as Record<string, unknown>; return { name: t(ff.name, 256), value: t(ff.value, 1024), ...(ff.inline ? { inline: true } : {}) }; }).filter((f) => f.name || f.value);
      if (fields.length) out.fields = fields;
    }
    if (typeof e.timestamp === 'string' && Number.isFinite(Date.parse(e.timestamp))) out.timestamp = new Date(e.timestamp).toISOString();
    const img = httpUrl((e.image as Record<string, unknown> | undefined)?.url); if (img) out.image = img;
    const th = httpUrl((e.thumbnail as Record<string, unknown> | undefined)?.url); if (th) out.thumbnail = th;
    total += (out.title?.length ?? 0) + (out.description?.length ?? 0) + (out.author?.name.length ?? 0) + (out.footer?.text.length ?? 0) + (out.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    if (Object.keys(out).length) embeds.push(out);
  }
  if (total > WEBHOOK.embedTotalMax) return { error: `Embed text is limited to ${WEBHOOK.embedTotalMax} characters in total`, code: 50035 };
  if (!content && !embeds.length) return { error: 'Cannot send an empty message', code: 50006 };
  const fallback = content || embeds.map((e) => [e.author?.name, e.title, e.description].filter(Boolean).join(' — ')).filter(Boolean).join('\n').slice(0, WEBHOOK.contentMax) || '(embed)';
  const username = cleanName(b.username) || null;
  return { content, username, avatarUrl: httpUrl(b.avatar_url) ?? null, embeds, fallback };
}
/** Slack-style { text } and GitHub event payloads, turned into the Discord shape. */
export function fromSlack(body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  return { content: typeof b.text === 'string' ? b.text.replace(/<(https?:[^|>]+)\|([^>]+)>/g, '[$2]($1)').replace(/<(https?:[^>]+)>/g, '$1') : '', username: b.username, avatar_url: b.icon_url };
}
export function fromGithub(event: string, body: unknown): unknown {
  const b = (body ?? {}) as Record<string, any>;
  const repo = b.repository?.full_name ?? 'repository';
  const who = b.sender?.login ?? 'someone';
  const e = (title: string, url?: string, description?: string, color = 0x24292f) => ({ username: 'GitHub', embeds: [{ title: title.slice(0, 256), url, description, color, author: { name: who } }] });
  switch (event) {
    case 'ping': return e(`[${repo}] webhook connected`, b.repository?.html_url, b.zen);
    case 'push': {
      const commits = (Array.isArray(b.commits) ? b.commits : []).slice(0, 5);
      const branch = String(b.ref ?? '').replace('refs/heads/', '');
      return e(`[${repo}:${branch}] ${b.commits?.length ?? 0} new commit${b.commits?.length === 1 ? '' : 's'}`, b.compare,
        commits.map((c: any) => `[\`${String(c.id).slice(0, 7)}\`](${c.url}) ${String(c.message).split('\n')[0].slice(0, 80)} — ${c.author?.name ?? ''}`).join('\n'), 0x7289da);
    }
    case 'issues': return e(`[${repo}] Issue ${b.action}: #${b.issue?.number} ${b.issue?.title ?? ''}`, b.issue?.html_url, String(b.issue?.body ?? '').slice(0, 500), 0xeb6420);
    case 'pull_request': return e(`[${repo}] Pull request ${b.action}: #${b.pull_request?.number} ${b.pull_request?.title ?? ''}`, b.pull_request?.html_url, String(b.pull_request?.body ?? '').slice(0, 500), 0x009800);
    case 'issue_comment': return e(`[${repo}] New comment on #${b.issue?.number}: ${b.issue?.title ?? ''}`, b.comment?.html_url, String(b.comment?.body ?? '').slice(0, 500));
    case 'release': return e(`[${repo}] Release ${b.action}: ${b.release?.tag_name ?? ''}`, b.release?.html_url, String(b.release?.body ?? '').slice(0, 500));
    case 'star': case 'watch': return e(`[${repo}] New star`, b.repository?.html_url);
    default: return e(`[${repo}] ${event}${b.action ? ` ${b.action}` : ''}`, b.repository?.html_url);
  }
}

// ---------- avatars (owner upload, or a payload avatar_url fetched once through the SSRF-safe client) ----------
const failedAvatar = new Map<string, number>();
export async function storeAvatar(buf: Buffer, key: string): Promise<string> {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const out = await sharp(buf, { animated: false, limitInputPixels: 40_000_000 }).resize(128, 128, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
  fs.writeFileSync(path.join(AVATAR_DIR, `${key}.webp`), out);
  return key;
}
export async function remoteAvatar(url: string): Promise<string | null> {
  const key = `u-${sha(url).slice(0, 24)}`;
  if (fs.existsSync(path.join(AVATAR_DIR, `${key}.webp`))) return key;
  if ((failedAvatar.get(key) ?? 0) > now() - 10 * 60_000) return null;
  try {
    const r = await safeFetch(url, { timeoutMs: 3000, maxBytes: 2_000_000, failOnOversize: true, headers: { 'user-agent': 'zeronoise-webhooks/1.0', accept: 'image/*' },
      accept: (st, h) => { if (st !== 200 || !/^image\//i.test(String(h['content-type'] ?? ''))) throw new FetchError('not an image', 'type'); } });
    return await storeAvatar(r.body, key);
  } catch { failedAvatar.set(key, now()); if (failedAvatar.size > 1000) failedAvatar.clear(); return null; }
}
export const avatarFile = (key: string) => (/^[a-z]-[A-Za-z0-9_-]{6,64}$/.test(key) ? path.join(AVATAR_DIR, `${key}.webp`) : null);

// ---------- messages posted by webhooks ----------
export function recordMessage(messageId: string, hookId: string, avatar: string | null, embeds: WebhookEmbed[], fallback = false) {
  q('INSERT OR REPLACE INTO webhook_messages (message_id, hook_id, avatar, embeds) VALUES (?,?,?,?)').run(messageId, hookId, avatar, embeds.length ? JSON.stringify(fallback ? { e: embeds, f: 1 } : embeds) : null);
}
export interface WebhookLine { hookId: string; avatar: string | null; embeds?: WebhookEmbed[]; fallback?: boolean }
export function linesFor(ids: string[]): Map<string, WebhookLine> {
  const out = new Map<string, WebhookLine>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    if (!chunk.length) continue;
    const rows = q(`SELECT * FROM webhook_messages WHERE message_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { message_id: string; hook_id: string; avatar: string | null; embeds: string | null }[];
    for (const r of rows) {
      const j = r.embeds ? safeJson(r.embeds) : null;
      const embeds = Array.isArray(j) ? j : Array.isArray(j?.e) ? j.e : null;
      out.set(r.message_id, { hookId: r.hook_id, avatar: r.avatar ? `/api/webhook-avatars/${r.avatar}` : null, ...(embeds ? { embeds } : {}), ...(j?.f ? { fallback: true } : {}) });
    }
  }
  return out;
}
export const lineFor = (id: string) => linesFor([id]).get(id) ?? null;

// ---------- outgoing deliveries ----------
interface Job { id: string; hookId: string; event: WebhookEvent | 'test'; body: string; attempt: number; dueAt: number; summary: string }
const queues = new Map<string, Job[]>();
const busy = new Set<string>();
const scale = Math.max(0.0001, Number(process.env.WEBHOOK_RETRY_SCALE) || 1);
let onDisabled: (h: HookRow, reason: string) => void = () => {};
export function onAutoDisable(fn: (h: HookRow, reason: string) => void) { onDisabled = fn; }

export function sign(secret: string, ts: string, body: string) { return `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`; }

/** Queue an event for every enabled outgoing hook of the room that subscribed to it. */
export function emitEvent(room: { id: string; name: string }, event: WebhookEvent, data: Record<string, unknown>, summary = '') {
  let hooks: HookRow[];
  try { hooks = hooksForRoom(room.id).filter((h) => h.kind === 'outgoing' && h.enabled && cleanEvents(safeJson(h.events)).includes(event)); } catch { return; }
  for (const h of hooks) enqueue(h, event, room, data, summary);
}
export function enqueue(h: HookRow, event: WebhookEvent | 'test', room: { id: string; name: string }, data: Record<string, unknown>, summary = '') {
  const id = randomUUID();
  const body = JSON.stringify({ id, event, ts: now(), room: { id: room.id, name: room.name }, webhook: { id: h.id, name: h.name }, data });
  const list = queues.get(h.id) ?? [];
  if (list.length >= WEBHOOK.queueMax) {
    const dropped = list.shift()!;
    logEntry(h.id, { direction: 'out', event: dropped.event, status: null, ok: false, attempt: dropped.attempt, durationMs: null, error: 'Dropped: queue full (receiver too slow)', summary: dropped.summary });
  }
  list.push({ id, hookId: h.id, event, body, attempt: 1, dueAt: now(), summary });
  queues.set(h.id, list);
  void pump(h.id);
  return id;
}
async function pump(hookId: string) {
  if (busy.has(hookId)) return;
  busy.add(hookId);
  try {
    for (;;) {
      const list = queues.get(hookId);
      if (!list?.length) { queues.delete(hookId); return; }
      const job = list[0];
      const wait = job.dueAt - now();
      if (wait > 0) { setTimeout(() => void pump(hookId), wait).unref?.(); return; }
      const h = hookById(hookId);
      if (!h || h.revoked_at || (!h.enabled && job.event !== 'test')) { queues.delete(hookId); return; }
      const ok = await deliver(h, job);
      if (ok || job.attempt > WEBHOOK.retryDelays.length) {
        list.shift();
        if (!ok) finalFailure(h);
        else if (h.fail_count) q('UPDATE room_webhooks SET fail_count = 0 WHERE id = ?').run(h.id);
      } else {
        job.dueAt = now() + WEBHOOK.retryDelays[job.attempt - 1] * scale;
        job.attempt++;
      }
    }
  } finally { busy.delete(hookId); }
}
function finalFailure(h: HookRow) {
  const fails = h.fail_count + 1;
  q('UPDATE room_webhooks SET fail_count = ? WHERE id = ?').run(fails, h.id);
  if (fails >= WEBHOOK.maxFails && h.enabled) {
    const reason = `Turned off after ${fails} failed deliveries in a row`;
    setDisabled(h.id, reason);
    queues.delete(h.id);
    onDisabled(h, reason);
  }
}
async function deliver(h: HookRow, job: Job): Promise<boolean> {
  const secret = secretOf(h);
  const t0 = now();
  const base = { direction: 'out' as const, event: job.event, attempt: job.attempt, summary: job.summary };
  if (!secret || !h.url) { logEntry(h.id, { ...base, status: null, ok: false, durationMs: 0, error: secret ? 'No URL' : 'Signing secret unreadable (server key changed?): regenerate it' }); return false; }
  const ts = String(Math.floor(t0 / 1000));
  try {
    const r = await safeFetch(h.url, {
      method: 'POST', body: job.body, timeoutMs: WEBHOOK.timeoutMs, maxBytes: 16_384, maxRedirects: 0,
      headers: { 'content-type': 'application/json', 'user-agent': 'zeronoise-webhooks/1.0', 'x-zn-event': job.event, 'x-zn-delivery': job.id,
        'x-zn-timestamp': ts, 'x-zn-signature': sign(secret, ts, job.body), 'x-zn-webhook-id': h.id },
    });
    const ok = r.status >= 200 && r.status < 300;
    logEntry(h.id, { ...base, status: r.status, ok, durationMs: now() - t0, error: ok ? null : `HTTP ${r.status}` });
    if (ok) touch(h.id);
    return ok;
  } catch (e) {
    const msg = e instanceof FetchError ? e.message : (e as Error).message || 'Request failed';
    logEntry(h.id, { ...base, status: null, ok: false, durationMs: now() - t0, error: /timeout|timed out/i.test(msg) ? `Timed out after ${WEBHOOK.timeoutMs / 1000}s` : msg });
    return false;
  }
}
export const pendingFor = (hookId: string) => queues.get(hookId)?.length ?? 0;
export function exportCount(roomId: string) { return liveCount(roomId); }
void tx;
