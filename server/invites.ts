/**
 * Room invite links. A code is 12 random base62 characters (~71 bits). One use per account: `uses` counts
 * distinct accounts (room_invite_uses), so the same person opening the link again costs nothing.
 */
import { randomBytes } from 'crypto';
import { q, tx } from './db';
import { INVITE_CODE_LEN, INVITE_CODE_RE, type InviteInfo, type InviteStatus } from '../shared/invites';

const now = () => Date.now();
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface InviteRow {
  code: string; room_id: string; created_by: number | null; created_by_name: string; created_at: number;
  expires_at: number | null; max_uses: number | null; uses: number; skip_password: number; is_default: number;
  revoked_at: number | null; revoked_by: string | null;
}

/** Unbiased base62 (rejection sampling). */
export function newCode(len = INVITE_CODE_LEN): string {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b >= 248) continue; // 248 = 62 * 4
      out += ALPHABET[b % 62];
      if (out.length === len) break;
    }
  }
  return out;
}

export function statusOf(r: InviteRow | undefined, at = now()): InviteStatus {
  if (!r) return 'notfound';
  if (r.revoked_at) return 'revoked';
  if (r.expires_at != null && r.expires_at <= at) return 'expired';
  if (r.max_uses != null && r.uses >= r.max_uses) return 'used';
  return 'ok';
}

export function toInfo(r: InviteRow): InviteInfo {
  return {
    code: r.code, roomId: r.room_id, createdBy: r.created_by_name, createdAt: r.created_at, expiresAt: r.expires_at,
    maxUses: r.max_uses, uses: r.uses, skipPassword: !!r.skip_password, isDefault: !!r.is_default, revokedAt: r.revoked_at,
    status: statusOf(r),
  };
}

export function byCode(code: string): InviteRow | undefined {
  if (!INVITE_CODE_RE.test(code)) return undefined;
  return q('SELECT * FROM room_invites WHERE code = ?').get(code) as unknown as InviteRow | undefined;
}

export function create(o: { roomId: string; byId: number; byName: string; expiresAt: number | null; maxUses: number | null; skipPassword: boolean; isDefault?: boolean }): InviteRow {
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    try {
      q(`INSERT INTO room_invites (code, room_id, created_by, created_by_name, created_at, expires_at, max_uses, uses, skip_password, is_default)
         VALUES (?,?,?,?,?,?,?,0,?,?)`).run(code, o.roomId, o.byId, o.byName, now(), o.expiresAt, o.maxUses, o.skipPassword ? 1 : 0, o.isDefault ? 1 : 0);
      return byCode(code)!;
    } catch (e) {
      if (!/UNIQUE|PRIMARY/i.test(String((e as Error).message))) throw e;
    }
  }
  throw new Error('Could not create an invite code');
}

/** Newest first; revoked ones and links dead for over a day are left out. */
export function listForRoom(roomId: string): InviteRow[] {
  const cut = now() - 24 * 60 * 60_000;
  return q(`SELECT * FROM room_invites WHERE room_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY created_at DESC LIMIT 100`).all(roomId, cut) as unknown as InviteRow[];
}

export function activeCount(roomId: string): number {
  return (q(`SELECT COUNT(*) AS n FROM room_invites WHERE room_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
             AND (max_uses IS NULL OR uses < max_uses)`).get(roomId, now()) as { n: number }).n;
}

/** The caller's reusable "Copy invite link" default for this room, if still good. */
export function activeDefault(roomId: string, userId: number): InviteRow | undefined {
  const rows = q('SELECT * FROM room_invites WHERE room_id = ? AND created_by = ? AND is_default = 1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 5')
    .all(roomId, userId) as unknown as InviteRow[];
  return rows.find((r) => statusOf(r) === 'ok');
}

export function revoke(code: string, by: string): boolean {
  return Number(q('UPDATE room_invites SET revoked_at = ?, revoked_by = ? WHERE code = ? AND revoked_at IS NULL').run(now(), by, code).changes) > 0;
}

export function hasUsed(code: string, userId: number): boolean {
  return !!q('SELECT 1 FROM room_invite_uses WHERE code = ? AND user_id = ?').get(code, userId);
}

/**
 * Count one use for this account (no-op when it already used the link). Returns the outcome; a full link
 * still lets an account that already used it back in.
 */
export function redeem(code: string, userId: number): { ok: true; first: boolean; row: InviteRow } | { ok: false; status: InviteStatus } {
  return tx(() => {
    const r = byCode(code);
    const st = statusOf(r);
    if (!r || st === 'notfound' || st === 'revoked' || st === 'expired') return { ok: false as const, status: st };
    if (hasUsed(code, userId)) return { ok: true as const, first: false, row: r };
    if (st === 'used') return { ok: false as const, status: st };
    q('INSERT INTO room_invite_uses (code, user_id, used_at) VALUES (?,?,?)').run(code, userId, now());
    q('UPDATE room_invites SET uses = uses + 1 WHERE code = ?').run(code);
    return { ok: true as const, first: true, row: byCode(code)! };
  });
}

/** room:join may skip the password only for an account that redeemed a live link that allows it. */
export function bypassesPassword(code: string, roomId: string, userId: number): boolean {
  const r = byCode(code);
  if (!r || r.room_id !== roomId || !r.skip_password) return false;
  const st = statusOf(r);
  if (st === 'revoked' || st === 'expired' || st === 'notfound') return false;
  return hasUsed(code, userId);
}

export function modsCanInvite(roomId: string): boolean {
  const r = q('SELECT mods_can_invite FROM rooms WHERE id = ?').get(roomId) as { mods_can_invite: number | null } | undefined;
  return !!r?.mods_can_invite;
}
export function setModsCanInvite(roomId: string, on: boolean) {
  q('UPDATE rooms SET mods_can_invite = ? WHERE id = ?').run(on ? 1 : 0, roomId);
}

export function forgetRoom(roomId: string) {
  tx(() => {
    q('DELETE FROM room_invite_uses WHERE code IN (SELECT code FROM room_invites WHERE room_id = ?)').run(roomId);
    q('DELETE FROM room_invites WHERE room_id = ?').run(roomId);
  });
}

/** Drop links dead (revoked / expired) for 30+ days. */
export function prune(): number {
  const cut = now() - 30 * 24 * 60 * 60_000;
  return tx(() => {
    q(`DELETE FROM room_invite_uses WHERE code IN (SELECT code FROM room_invites WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?))`).run(cut, cut);
    return Number(q('DELETE FROM room_invites WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?)').run(cut, cut).changes);
  });
}
