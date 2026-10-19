/** batch MC2: sticker packs (owner uploads, staff review, members send approved ones). */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import multer from 'multer';
import type { Request, Response, Router, Express } from 'express';
import { DATA_DIR } from './env';
import { q } from './db';
import { live } from './live';
import * as repo from './repo';
import { hasFilteredWord } from './moderation';
import { STICKER_ID_RE, STICKER_MAX_BYTES, STICKER_NAME_RE, STICKER_PACKS_PER_ROOM, STICKER_PACK_NAME_MAX, STICKER_SIZE, STICKERS_PER_PACK, type StickerInfo, type StickerPack, type StickerStatus } from '../shared/stickers';

const DIR = path.join(DATA_DIR, 'room-stickers');
fs.mkdirSync(DIR, { recursive: true, mode: 0o750 });
const fileOf = (id: string) => (STICKER_ID_RE.test(id) ? path.join(DIR, `${id}.webp`) : null);
const newId = () => randomBytes(16).toString('hex');
interface Row { id: string; pack_id: string; room_id: string; name: string; animated: number; status: StickerStatus; created_by: number | null; created_at: number; review_note: string | null }
const info = (r: Row): StickerInfo => ({ id: r.id, packId: r.pack_id, name: r.name, url: `/api/stickers/${r.id}.webp`, animated: !!r.animated, status: r.status, note: r.review_note });
export const stickerById = (id: string) => q('SELECT * FROM room_stickers WHERE id = ?').get(id) as Row | undefined;
/** packs for a room; members only see approved stickers, managers see everything */
export function packsFor(roomId: string, all: boolean): StickerPack[] {
  const packs = q('SELECT id, name FROM room_sticker_packs WHERE room_id = ? ORDER BY created_at').all(roomId) as { id: string; name: string }[];
  const rows = q(`SELECT * FROM room_stickers WHERE room_id = ? ${all ? '' : "AND status = 'approved'"} ORDER BY created_at`).all(roomId) as unknown as Row[];
  return packs.map((p) => ({ id: p.id, name: p.name, stickers: rows.filter((r) => r.pack_id === p.id).map(info) })).filter((p) => all || p.stickers.length);
}
/** the sticker a member may send in this room, or null */
export function sendable(roomId: string, id: unknown): Row | null {
  if (typeof id !== 'string' || !STICKER_ID_RE.test(id)) return null;
  const r = stickerById(id);
  return r && r.room_id === roomId && r.status === 'approved' ? r : null;
}

async function processSticker(buf: Buffer): Promise<{ webp: Buffer; animated: boolean }> {
  if (buf.length > STICKER_MAX_BYTES) throw new Error('Image too large (max 1 MB)');
  if (buf.length < 24) throw new Error('Not a valid image');
  try {
    const probe = await sharp(buf, { failOn: 'error', animated: true, limitInputPixels: 40_000_000 }).metadata();
    if (!probe.format || !['jpeg', 'png', 'webp', 'gif'].includes(probe.format)) throw new Error('Use PNG, JPEG, WebP or GIF');
    const pages = probe.pages ?? 1;
    const animated = pages > 1 && pages <= 200 && (probe.format === 'gif' || probe.format === 'webp');
    const img = sharp(buf, { failOn: 'error', animated, limitInputPixels: 40_000_000 });
    const webp = await (animated ? img : img.rotate()).resize(STICKER_SIZE, STICKER_SIZE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer();
    return { webp, animated };
  } catch (e) {
    if (e instanceof Error && /too large|Use PNG|Not a valid/.test(e.message)) throw e;
    throw new Error('Could not read image');
  }
}

type Fail = (res: Response, status: number, error: string) => unknown;
interface Deps { fail: Fail; reqAccount: (req: Request) => repo.Account | null | undefined }
const isStaffRole = (r: string) => r === 'admin' || r === 'moderator';

export function registerStickers(app: Express, d: Deps) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: STICKER_MAX_BYTES, files: 1, fields: 4, fieldSize: 200 },
    fileFilter: (_req, file, cb) => (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Use PNG, JPEG, WebP or GIF'))) }).single('sticker');
  const gate = (req: Request, res: Response) => {
    const a = d.reqAccount(req);
    if (!a) { d.fail(res, 401, 'Sign in first'); return null; }
    const roomId = String(req.params.id);
    if (!live.roomCanManage(roomId, a.id, a.role)) { d.fail(res, 403, 'Only the room owner (or site staff) can manage stickers'); return null; }
    return { a, roomId };
  };
  app.get('/api/rooms/:id/stickers', (req, res) => {
    const roomId = String(req.params.id);
    if (!live.roomVisible(roomId)) return d.fail(res, 404, 'Room not found');
    const a = d.reqAccount(req);
    const all = !!a && live.roomCanManage(roomId, a.id, a.role);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, packs: packsFor(roomId, all), limits: { packs: STICKER_PACKS_PER_ROOM, perPack: STICKERS_PER_PACK, maxBytes: STICKER_MAX_BYTES } });
  });
  app.post('/api/rooms/:id/sticker-packs', (req, res) => {
    const g = gate(req, res); if (!g) return;
    const name = String((req.body as { name?: unknown })?.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim();
    if (!name || name.length > STICKER_PACK_NAME_MAX) return d.fail(res, 400, `Pack names are 1-${STICKER_PACK_NAME_MAX} characters`);
    if (hasFilteredWord(name)) return d.fail(res, 400, 'Please pick another name');
    const n = (q('SELECT COUNT(*) AS n FROM room_sticker_packs WHERE room_id = ?').get(g.roomId) as { n: number }).n;
    if (n >= STICKER_PACKS_PER_ROOM) return d.fail(res, 409, `A room can have at most ${STICKER_PACKS_PER_ROOM} sticker packs`);
    const id = newId();
    q('INSERT INTO room_sticker_packs (id, room_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, g.roomId, name, g.a.id, Date.now());
    repo.logAction(g.a.username, g.a.id, 'sticker-pack-add', name, g.roomId);
    res.json({ ok: true, packs: packsFor(g.roomId, true) });
  });
  app.delete('/api/rooms/:id/sticker-packs/:pack', (req, res) => {
    const g = gate(req, res); if (!g) return;
    const pack = q('SELECT id, name FROM room_sticker_packs WHERE id = ? AND room_id = ?').get(String(req.params.pack), g.roomId) as { id: string; name: string } | undefined;
    if (!pack) return d.fail(res, 404, 'Pack not found');
    // stickers leave the room; the image files are kept on disk (nothing is deleted by this action)
    q("UPDATE room_stickers SET status = 'rejected', review_note = 'pack removed' WHERE pack_id = ?").run(pack.id);
    q('UPDATE room_stickers SET room_id = room_id || \':removed\' WHERE pack_id = ?').run(pack.id);
    q('DELETE FROM room_sticker_packs WHERE id = ?').run(pack.id);
    repo.logAction(g.a.username, g.a.id, 'sticker-pack-remove', pack.name, g.roomId);
    res.json({ ok: true, packs: packsFor(g.roomId, true) });
  });
  app.post('/api/rooms/:id/sticker-packs/:pack/stickers', (req, res) => {
    const g = gate(req, res); if (!g) return;
    upload(req, res, async (err) => {
      if (err) { const m = err instanceof Error ? err.message : 'Upload failed'; return d.fail(res, 400, /too large|LIMIT_FILE_SIZE/i.test(m) ? 'Image too large (max 1 MB)' : m.startsWith('Use ') ? m : 'Upload failed'); }
      const pack = q('SELECT id FROM room_sticker_packs WHERE id = ? AND room_id = ?').get(String(req.params.pack), g.roomId) as { id: string } | undefined;
      if (!pack) return d.fail(res, 404, 'Pack not found');
      const name = String((req.body as { name?: unknown })?.name ?? '').trim().toLowerCase();
      if (!STICKER_NAME_RE.test(name)) return d.fail(res, 400, 'Sticker names are 2-24 characters: a-z, 0-9 and _');
      if (hasFilteredWord(name.replace(/_/g, ' '))) return d.fail(res, 400, 'Please pick another name');
      const n = (q("SELECT COUNT(*) AS n FROM room_stickers WHERE pack_id = ? AND status != 'rejected'").get(pack.id) as { n: number }).n;
      if (n >= STICKERS_PER_PACK) return d.fail(res, 409, `A pack can have at most ${STICKERS_PER_PACK} stickers`);
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return d.fail(res, 400, 'Choose an image file');
      try {
        const { webp, animated } = await processSticker(file.buffer);
        const id = newId();
        fs.writeFileSync(fileOf(id)!, webp, { mode: 0o640 });
        const staff = isStaffRole(g.a.role);
        q('INSERT INTO room_stickers (id, pack_id, room_id, name, animated, status, created_by, created_at, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, pack.id, g.roomId, name, animated ? 1 : 0, staff ? 'approved' : 'pending', g.a.id, Date.now(), staff ? g.a.id : null, staff ? Date.now() : null);
        repo.logAction(g.a.username, g.a.id, 'sticker-add', name, g.roomId);
        res.json({ ok: true, sticker: info(stickerById(id)!), packs: packsFor(g.roomId, true) });
      } catch (e) { return d.fail(res, 400, (e as Error).message || 'Could not process image'); }
    });
  });
  /** approved stickers are public (unguessable ids); pending/rejected ones only for the room's managers */
  app.get('/api/stickers/:id.webp', (req, res) => {
    const id = String(req.params.id);
    const r = STICKER_ID_RE.test(id) ? stickerById(id) : undefined;
    const p = r ? fileOf(id) : null;
    if (!r || !p || !fs.existsSync(p)) return res.status(404).end();
    if (r.status !== 'approved') {
      const a = d.reqAccount(req);
      if (!a || !(isStaffRole(a.role) || live.roomCanManage(r.room_id, a.id, a.role))) return res.status(404).end();
      res.setHeader('Cache-Control', 'private, no-store');
    } else res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.sendFile(p);
  });
}

export function registerStickerAdmin(admin: Router, actor: (req: Request) => repo.Account) {
  admin.get('/stickers', (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(String(req.query.status)) ? String(req.query.status) : 'pending';
    const rows = q('SELECT s.*, p.name AS pack_name FROM room_stickers s LEFT JOIN room_sticker_packs p ON p.id = s.pack_id WHERE s.status = ? ORDER BY s.created_at DESC LIMIT 200').all(status) as unknown as (Row & { pack_name: string | null })[];
    res.json({ ok: true, stickers: rows.map((r) => ({ ...info(r), roomId: r.room_id, roomName: live.webhookRoom(r.room_id)?.name ?? r.room_id, pack: r.pack_name, by: r.created_by != null ? repo.userById(r.created_by)?.username ?? null : null, createdAt: r.created_at })) });
  });
  admin.post('/stickers/:id/review', (req, res) => {
    const a = actor(req);
    const r = stickerById(String(req.params.id));
    if (!r) return res.status(404).json({ ok: false, error: 'Sticker not found' });
    const ok = (req.body as { approve?: unknown })?.approve === true;
    const note = String((req.body as { note?: unknown })?.note ?? '').slice(0, 200) || null;
    q('UPDATE room_stickers SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?').run(ok ? 'approved' : 'rejected', a.id, Date.now(), note, r.id);
    repo.logAction(a.username, a.id, ok ? 'sticker-approve' : 'sticker-reject', r.name, r.room_id, note);
    res.json({ ok: true, status: ok ? 'approved' : 'rejected' });
  });
}
