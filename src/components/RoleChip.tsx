import type { RoomRoleInfo } from '../../shared/types';
/** Batch G4: small coloured tag after a nick for custom room roles. */
export function RoleChip({ role }: { role: RoomRoleInfo | null }) {
  if (!role) return null;
  return <span className="role-chip" data-role-chip={role.name} style={role.color ? { color: role.color, borderColor: role.color } : undefined}>{role.name}</span>;
}
