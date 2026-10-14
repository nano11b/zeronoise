import type { Role } from '../../shared/types';

export function RoleTag({ role }: { role: Role }) {
  if (role === 'admin') return <span className="tag role-admin" title="Site admin">admin</span>;
  if (role === 'moderator') return <span className="tag role-mod" title="Moderator">mod</span>;
  if (role === 'guest') return <span className="tag role-guest" title="Guest (not registered)">guest</span>;
  return null;
}
