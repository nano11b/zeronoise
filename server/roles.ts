/**
 * Batch G4: custom room roles. The owner (or staff) defines named roles with a contrast-checked colour and a
 * subset of moderation powers; holders get exactly those powers in that room and never more than room mods
 * (they cannot act on the owner, staff, room mods or other role holders, and cannot ban or manage roles).
 */
import { q } from './db';
import { readableOnAllThemes } from '../shared/uiTheme';

export const ROLE_PERMS = ['messages', 'pin', 'mute', 'kick', 'floor'] as const;
export type RolePerm = (typeof ROLE_PERMS)[number];
export const MAX_ROLES = 8;
export interface RoomRole { id: number; name: string; color: string | null; perms: RolePerm[] }
interface Cache { roles: Map<number, RoomRole>; members: Map<number, number> }
const cache = new Map<string, Cache>();

function load(roomId: string): Cache {
  let c = cache.get(roomId);
  if (c) return c;
  const roles = new Map<number, RoomRole>();
  for (const r of q('SELECT id, name, color, perms FROM room_roles WHERE room_id = ? AND archived_at IS NULL ORDER BY id').all(roomId) as { id: number; name: string; color: string | null; perms: string }[]) {
    let perms: RolePerm[] = [];
    try { perms = (JSON.parse(r.perms) as string[]).filter((p): p is RolePerm => (ROLE_PERMS as readonly string[]).includes(p)); } catch { /* none */ }
    roles.set(r.id, { id: r.id, name: r.name, color: r.color, perms });
  }
  const members = new Map<number, number>();
  for (const m of q('SELECT user_id, role_id FROM room_role_members WHERE room_id = ?').all(roomId) as { user_id: number; role_id: number }[]) if (roles.has(m.role_id)) members.set(m.user_id, m.role_id);
  c = { roles, members };
  cache.set(roomId, c);
  return c;
}
export const rolesOf = (roomId: string) => [...load(roomId).roles.values()];
export const membersOf = (roomId: string) => Object.fromEntries(load(roomId).members);
export function roleOf(roomId: string, userId: number | null | undefined): RoomRole | null {
  if (userId == null) return null;
  const c = load(roomId); const id = c.members.get(userId);
  return id != null ? c.roles.get(id) ?? null : null;
}
export const hasPerm = (roomId: string, userId: number | null | undefined, perm: RolePerm) => !!roleOf(roomId, userId)?.perms.includes(perm);

export function cleanRole(p: unknown): { name: string; color: string | null; perms: RolePerm[] } | string {
  const o = (p ?? {}) as { name?: unknown; color?: unknown; perms?: unknown };
  const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim().slice(0, 24) : '';
  if (name.length < 2) return 'Role names need 2–24 characters';
  if (/^(owner|admin|moderator|mod|staff)$/i.test(name)) return 'That name is reserved';
  let color: string | null = null;
  if (o.color != null && o.color !== '') {
    if (typeof o.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(o.color)) return 'Pick a colour like #4fa3ff';
    if (!readableOnAllThemes(o.color)) return 'That colour is too dark to read on the chat background (needs 4.5:1 contrast). Pick a lighter one.';
    color = o.color.toLowerCase();
  }
  const perms = Array.isArray(o.perms) ? [...new Set(o.perms.filter((x): x is RolePerm => (ROLE_PERMS as readonly string[]).includes(String(x))))] : [];
  return { name, color, perms };
}
export function saveRole(roomId: string, id: number | null, r: { name: string; color: string | null; perms: RolePerm[] }): RoomRole | string {
  const c = load(roomId);
  if ([...c.roles.values()].some((x) => x.id !== id && x.name.toLowerCase() === r.name.toLowerCase())) return 'A role with that name exists';
  if (id != null) {
    if (!c.roles.has(id)) return 'No such role';
    q('UPDATE room_roles SET name = ?, color = ?, perms = ? WHERE id = ? AND room_id = ?').run(r.name, r.color, JSON.stringify(r.perms), id, roomId);
  } else {
    if (c.roles.size >= MAX_ROLES) return `At most ${MAX_ROLES} roles per room`;
    id = Number(q('INSERT INTO room_roles (room_id, name, color, perms, created_at) VALUES (?,?,?,?,?)').run(roomId, r.name, r.color, JSON.stringify(r.perms), Date.now()).lastInsertRowid);
  }
  cache.delete(roomId);
  return load(roomId).roles.get(id)!;
}
/** Archived roles stop granting anything; rows are kept for the audit trail. */
export function archiveRole(roomId: string, id: number): boolean {
  const ok = Number(q('UPDATE room_roles SET archived_at = ? WHERE id = ? AND room_id = ? AND archived_at IS NULL').run(Date.now(), id, roomId).changes) > 0;
  cache.delete(roomId);
  return ok;
}
export function assign(roomId: string, userId: number, roleId: number | null, by: string): boolean {
  if (roleId != null && !load(roomId).roles.has(roleId)) return false;
  if (roleId == null) q('DELETE FROM room_role_members WHERE room_id = ? AND user_id = ?').run(roomId, userId);
  else q('INSERT INTO room_role_members (room_id, user_id, role_id, assigned_by, assigned_at) VALUES (?,?,?,?,?) ON CONFLICT(room_id, user_id) DO UPDATE SET role_id = excluded.role_id, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at').run(roomId, userId, roleId, by, Date.now());
  cache.delete(roomId);
  return true;
}
export const rolesPayload = (roomId: string) => ({ roles: rolesOf(roomId), members: membersOf(roomId) });
export const setRoomTemplate = (roomId: string, key: string) => q('UPDATE rooms SET template = ? WHERE id = ?').run(key, roomId);
