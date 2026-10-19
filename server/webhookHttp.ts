/** HTTP side of room webhooks: the public incoming endpoint, owner management, staff overview, avatars. */
import express, { type Express, type Request, type Response, type Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as hooks from './webhooks';
import { live } from './live';
import * as repo from './repo';
import { clientIp } from './net';
import { hasFilteredWord } from './moderation';
import { WEBHOOK, type WebhookEvent } from '../shared/webhooks';

type Fail = (res: Response, status: number, error: string) => unknown;
interface Deps { fail: Fail; reqAccount: (req: Request) => repo.Account | null | undefined; publicBase: (req: Request) => string }

/** Sliding window counter that also says when the next slot frees up. */
class Window {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private ms: number) {}
  take(key: string): number {
    const t = Date.now();
    const list = (this.hits.get(key) ?? []).filter((x) => x > t - this.ms);
    if (list.length >= this.max) { this.hits.set(key, list); return list[0] + this.ms - t; }
    list.push(t); this.hits.set(key, list);
    if (this.hits.size > 20000) for (const [k, v] of this.hits) if (!v.some((x) => x > t - this.ms)) this.hits.delete(k);
    return 0;
  }
}
const scaleRl = Math.max(1, Number(process.env.WEBHOOK_RATE_SCALE) || 1);
const perHookBurst = new Window(5 * scaleRl, 2000);
const perHookMin = new Window(30 * scaleRl, 60_000);
const perRoomMin = new Window(60 * scaleRl, 60_000);
const perIpMin = new Window(120 * scaleRl, 60_000);
const badToken = new Window(30, 60_000);

const discordErr = (res: Response, status: number, message: string, code = 0, extra: Record<string, unknown> = {}) => res.status(status).json({ message, code, ...extra });

export function registerIncoming(app: Express, d: Deps) {
  const parsers = [
    express.json({ limit: '64kb', type: ['application/json', 'text/plain', 'application/*+json'] }),
    express.urlencoded({ extended: false, limit: '64kb' }),
    multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 10, fields: 20, fieldSize: 64 * 1024 } }).any(),
  ];
  const handler = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const ip = clientIp(req);
    const variant = String(req.params.variant ?? '');
    const h = hooks.matchIncoming(String(req.params.id), String(req.params.token));
    if (!h) {
      if (badToken.take(ip) > 0) return discordErr(res, 429, 'You are being rate limited.', 0, { retry_after: 60, global: false });
      return discordErr(res, 404, 'Unknown Webhook', 10015);
    }
    const room = live.webhookRoom(h.room_id);
    if (!room || room.isPrivate) return discordErr(res, 404, 'Unknown Channel', 10003);
    if (!h.enabled) {
      hooks.logEntry(h.id, { direction: 'in', event: 'post', status: 403, ok: false, attempt: 1, durationMs: 0, error: 'Webhook is turned off', summary: null });
      return discordErr(res, 403, 'This webhook is turned off', 50001);
    }
    const waits = [perHookBurst.take(h.id), perHookMin.take(h.id), perRoomMin.take(h.room_id), perIpMin.take(ip)];
    const wait = Math.max(...waits);
    if (wait > 0) {
      const sec = Math.ceil(wait / 100) / 10;
      res.setHeader('Retry-After', String(Math.ceil(sec)));
      res.setHeader('X-RateLimit-Limit', '5'); res.setHeader('X-RateLimit-Remaining', '0'); res.setHeader('X-RateLimit-Reset-After', String(sec));
      hooks.logEntry(h.id, { direction: 'in', event: 'post', status: 429, ok: false, attempt: 1, durationMs: 0, error: `Rate limited (retry after ${sec}s)`, summary: null });
      return discordErr(res, 429, 'You are being rate limited.', 0, { retry_after: sec, global: false });
    }
    // body: JSON, form field payload_json (Discord multipart / form), or GitHub form-encoded "payload"
    let body: unknown = req.body ?? {};
    const b = body as Record<string, unknown>;
    for (const k of ['payload_json', 'payload']) {
      if (typeof b?.[k] === 'string') { try { body = JSON.parse(b[k] as string); } catch { return discordErr(res, 400, 'Invalid payload_json', 50109); } }
    }
    const files = (req as Request & { files?: unknown[] }).files;
    if (variant === 'slack') body = hooks.fromSlack(body);
    else if (variant === 'github') body = hooks.fromGithub(String(req.headers['x-github-event'] ?? 'push'), body);
    else if (variant) return discordErr(res, 404, 'Unknown Webhook', 10015);
    const p = hooks.normalizeIncoming(body);
    if ('error' in p) {
      hooks.logEntry(h.id, { direction: 'in', event: 'post', status: 400, ok: false, attempt: 1, durationMs: 0, error: p.error, summary: null });
      return discordErr(res, 400, p.error, p.code);
    }
    const name = p.username && !hasFilteredWord(p.username) ? p.username : h.name;
    let avatar = h.avatar;
    if (p.avatarUrl) avatar = (await hooks.remoteAvatar(p.avatarUrl)) ?? avatar;
    const text = p.content || p.fallback;
    const r = live.webhookPost(h.room_id, { id: h.id, name }, { text, avatar, embeds: p.embeds, fallback: !p.content });
    if (!r.ok) {
      hooks.logEntry(h.id, { direction: 'in', event: 'post', status: r.status, ok: false, attempt: 1, durationMs: 0, error: r.error, summary: null });
      return discordErr(res, r.status, r.error);
    }
    hooks.touch(h.id);
    hooks.logEntry(h.id, { direction: 'in', event: variant || 'post', status: req.query.wait === 'true' ? 200 : 204, ok: true, attempt: 1, durationMs: 0,
      error: Array.isArray(files) && files.length ? `${files.length} attachment(s) ignored (not supported)` : null, summary: `${name}: ${text.slice(0, 120)}` });
    if (req.query.wait === 'true' || req.query.wait === '1') {
      return res.json({ id: r.id, type: 0, channel_id: h.room_id, content: p.content, embeds: p.embeds, timestamp: new Date(r.ts).toISOString(),
        author: { id: h.id, username: name, bot: true, avatar: avatar ? `/api/webhook-avatars/${avatar}` : null }, webhook_id: h.id });
    }
    res.status(204).end();
  };
  const route = '/api/webhooks/:id/:token';
  app.post(route, ...parsers, handler);
  app.post(`${route}/:variant`, ...parsers, handler);
  // Discord tools sometimes GET the URL to check it exists
  app.get(route, (req, res) => {
    const h = hooks.matchIncoming(String(req.params.id), String(req.params.token));
    if (!h) return discordErr(res, 404, 'Unknown Webhook', 10015);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ id: h.id, type: 1, name: h.name, avatar: h.avatar ? `/api/webhook-avatars/${h.avatar}` : null, channel_id: h.room_id, token: String(req.params.token) });
  });
  app.get('/api/webhook-avatars/:key', (req, res) => {
    const f = hooks.avatarFile(String(req.params.key));
    if (!f || !fs.existsSync(f)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type('image/webp').sendFile(f);
  });
}

export function registerManage(app: Express, d: Deps) {
  const { fail } = d;
  const manageLimiter = new Window(60, 10 * 60_000);
  const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } }).single('avatar');
  const nameOf = (id: number) => repo.userById(id)?.username ?? null;
  const gate = (req: Request, res: Response, write = true) => {
    const a = d.reqAccount(req);
    if (!a) { fail(res, 401, 'Sign in first'); return null; }
    const roomId = String(req.params.roomId ?? '');
    const room = live.webhookRoom(roomId);
    if (!room) { fail(res, 404, 'Room not found'); return null; }
    if (room.isPrivate) { fail(res, 403, 'Private calls cannot have webhooks'); return null; }
    if (!live.webhookCanManage(roomId, a.id, a.role)) { fail(res, 403, 'Only the room owner (or a role with "Manage webhooks") can manage webhooks'); return null; }
    if (write && manageLimiter.take(`${a.id}`) > 0) { fail(res, 429, 'Too many webhook changes. Try again later.'); return null; }
    return { a, room };
  };
  const hookIn = (req: Request, res: Response, roomId: string) => {
    const h = hooks.hookById(String(req.params.id));
    if (!h || h.room_id !== roomId || h.revoked_at) { fail(res, 404, 'Webhook not found'); return null; }
    return h;
  };
  const audit = (a: repo.Account, action: string, h: { name: string }, roomId: string, details?: string) => repo.logAction(a.username, a.id, action, h.name, roomId, details ?? null);
  const fullUrl = (req: Request, id: string, token: string) => `${d.publicBase(req)}/api/webhooks/${id}/${token}`;

  app.get('/api/rooms/:roomId/webhooks', (req, res) => {
    const g = gate(req, res, false); if (!g) return;
    res.json({ ok: true, max: WEBHOOK.maxPerRoom, webhooks: hooks.hooksForRoom(g.room.id).map((h) => hooks.info(h, nameOf)) });
  });
  app.post('/api/rooms/:roomId/webhooks', (req, res) => {
    const g = gate(req, res); if (!g) return;
    if (hooks.liveCount(g.room.id) >= WEBHOOK.maxPerRoom) return fail(res, 409, `A room can have at most ${WEBHOOK.maxPerRoom} webhooks`);
    const kind = req.body?.kind === 'outgoing' ? 'outgoing' : 'incoming';
    const name = hooks.cleanName(req.body?.name) || (kind === 'incoming' ? 'Webhook' : 'Outgoing webhook');
    if (hasFilteredWord(name)) return fail(res, 400, 'Please pick another name');
    if (kind === 'incoming') {
      const { row, token } = hooks.createIncoming(g.room.id, name, g.a.id);
      audit(g.a, 'webhook-create', row, g.room.id, 'incoming');
      return res.json({ ok: true, webhook: hooks.info(row, nameOf), url: fullUrl(req, row.id, token) });
    }
    const u = hooks.cleanTargetUrl(req.body?.url);
    if ('error' in u) return fail(res, 400, u.error);
    const events = hooks.cleanEvents(req.body?.events);
    if (!events.length) return fail(res, 400, 'Pick at least one event');
    const { row, secret } = hooks.createOutgoing(g.room.id, name, u.url, events, g.a.id);
    audit(g.a, 'webhook-create', row, g.room.id, `outgoing → ${new URL(u.url).host} (${events.join(', ')})`);
    res.json({ ok: true, webhook: hooks.info(row, nameOf), secret });
  });
  app.patch('/api/rooms/:roomId/webhooks/:id', (req, res) => {
    const g = gate(req, res); if (!g) return;
    const h = hookIn(req, res, g.room.id); if (!h) return;
    const p: { name?: string; url?: string; events?: WebhookEvent[]; enabled?: boolean } = {};
    if (req.body?.name !== undefined) { const n = hooks.cleanName(req.body.name); if (!n) return fail(res, 400, 'Name cannot be empty'); if (hasFilteredWord(n)) return fail(res, 400, 'Please pick another name'); p.name = n; }
    if (h.kind === 'outgoing' && req.body?.url !== undefined) { const u = hooks.cleanTargetUrl(req.body.url); if ('error' in u) return fail(res, 400, u.error); p.url = u.url; }
    if (h.kind === 'outgoing' && req.body?.events !== undefined) { const ev = hooks.cleanEvents(req.body.events); if (!ev.length) return fail(res, 400, 'Pick at least one event'); p.events = ev; }
    if (typeof req.body?.enabled === 'boolean') p.enabled = req.body.enabled;
    hooks.update(h, p);
    const changed = Object.keys(p);
    audit(g.a, p.enabled === false ? 'webhook-disable' : p.enabled === true ? 'webhook-enable' : 'webhook-update', { name: p.name ?? h.name }, g.room.id, changed.join(', '));
    res.json({ ok: true, webhook: hooks.info(hooks.hookById(h.id)!, nameOf) });
  });
  app.post('/api/rooms/:roomId/webhooks/:id/regenerate', (req, res) => {
    const g = gate(req, res); if (!g) return;
    const h = hookIn(req, res, g.room.id); if (!h) return;
    const fresh = hooks.regenerate(h);
    audit(g.a, 'webhook-regenerate', h, g.room.id, h.kind === 'incoming' ? 'new URL token' : 'new signing secret');
    res.json({ ok: true, ...(h.kind === 'incoming' ? { url: fullUrl(req, h.id, fresh) } : { secret: fresh }) });
  });
  app.delete('/api/rooms/:roomId/webhooks/:id', (req, res) => {
    const g = gate(req, res); if (!g) return;
    const h = hookIn(req, res, g.room.id); if (!h) return;
    hooks.revoke(h.id, g.a.username);
    audit(g.a, 'webhook-revoke', h, g.room.id, h.kind);
    res.json({ ok: true });
  });
  app.post('/api/rooms/:roomId/webhooks/:id/test', (req, res) => {
    const g = gate(req, res); if (!g) return;
    const h = hookIn(req, res, g.room.id); if (!h) return;
    audit(g.a, 'webhook-test', h, g.room.id);
    if (h.kind === 'incoming') {
      if (!h.enabled) return fail(res, 409, 'Turn the webhook on first');
      const r = live.webhookPost(g.room.id, { id: h.id, name: h.name }, { text: `✅ Test message from webhook **${h.name}** (sent by ${g.a.username})`, avatar: h.avatar, embeds: [] });
      hooks.logEntry(h.id, { direction: 'in', event: 'test', status: r.ok ? 204 : r.status, ok: r.ok, attempt: 1, durationMs: 0, error: r.ok ? null : r.error, summary: `test by ${g.a.username}` });
      return r.ok ? res.json({ ok: true }) : fail(res, r.status, r.error);
    }
    const id = hooks.enqueue(h, 'test', g.room, { message: 'Test delivery', by: g.a.username }, `test by ${g.a.username}`);
    res.json({ ok: true, deliveryId: id });
  });
  app.get('/api/rooms/:roomId/webhooks/:id/log', (req, res) => {
    const g = gate(req, res, false); if (!g) return;
    const h = hookIn(req, res, g.room.id); if (!h) return;
    res.json({ ok: true, log: hooks.logFor(h.id), pending: hooks.pendingFor(h.id) });
  });
  app.post('/api/rooms/:roomId/webhooks/:id/avatar', (req, res) => {
    const g = gate(req, res); if (!g) return;
    const h = hookIn(req, res, g.room.id); if (!h) return;
    avatarUpload(req, res, async (err) => {
      if (err) return fail(res, 400, /LIMIT_FILE_SIZE|too large/i.test(String((err as Error).message)) ? 'Image too large (max 1 MB)' : 'Upload failed');
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return fail(res, 400, 'No image');
      try {
        const key = await hooks.storeAvatar(file.buffer, `h-${h.id}${randomBytes(4).toString('hex')}`);
        hooks.setAvatar(h.id, key);
        audit(g.a, 'webhook-update', h, g.room.id, 'avatar');
        res.json({ ok: true, webhook: hooks.info(hooks.hookById(h.id)!, nameOf) });
      } catch { fail(res, 400, 'Use a PNG, JPEG, WebP or GIF image'); }
    });
  });
}

/** Staff: every room's hooks, read-only details, and a kill switch. */
export function registerAdmin(admin: Router, d: Deps, actor: (req: Request) => repo.Account) {
  const nameOf = (id: number) => repo.userById(id)?.username ?? null;
  admin.get('/webhooks', (_req, res) => {
    const rows = hooks.allHooks();
    res.json({ ok: true, webhooks: rows.map((h) => ({ ...hooks.info(h, nameOf), roomId: h.room_id, roomName: live.webhookRoom(h.room_id)?.name ?? h.room_id, log: hooks.logFor(h.id, 5) })) });
  });
  admin.post('/webhooks/:id/disable', (req, res) => {
    const h = hooks.hookById(String(req.params.id));
    if (!h || h.revoked_at) return d.fail(res, 404, 'Webhook not found');
    const a = actor(req);
    const why = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
    hooks.setDisabled(h.id, `Turned off by staff${why ? `: ${why}` : ''}`);
    repo.logAction(a.username, a.id, 'webhook-disable', h.name, h.room_id, `by staff${why ? `: ${why}` : ''}`);
    res.json({ ok: true });
  });
}
