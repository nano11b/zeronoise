import { FormEvent, useState } from 'react';
import type { RoomRoleInfo, RoomRolePerm, UserInfo } from '../../shared/types';
import { readableOnAllThemes } from '../../shared/uiTheme';
import { call, socket } from '../socket';
const rcall = (ev: string, p: unknown) => call((ack) => (socket.emit as unknown as (e: string, p: unknown, a: (r: unknown) => void) => void)(ev, p, ack));

/** Batch G4: owner defines custom roles (name, contrast-checked colour, chosen powers) and hands them out. */
export const PERM_LABEL: Record<RoomRolePerm, string> = { messages: 'Delete messages', pin: 'Pin messages', mute: 'Mute in this room', kick: 'Kick from room', floor: 'Give / take the voice floor' };
const PERMS = Object.keys(PERM_LABEL) as RoomRolePerm[];
type Toast = (msg: string, kind?: 'error' | 'info') => void;
export interface RolesState { roles: RoomRoleInfo[]; members: Record<string, number> }

export function RolesPanel({ state, people, ownerNick, toast }: { state: RolesState; people: UserInfo[]; ownerNick: string | null; toast: Toast }) {
  const [edit, setEdit] = useState<{ id?: number; name: string; color: string; perms: RoomRolePerm[] } | null>(null);
  const [who, setWho] = useState('');
  const [roleFor, setRoleFor] = useState('');
  const colorOk = !edit?.color || readableOnAllThemes(edit.color);
  const save = async (e: FormEvent) => {
    e.preventDefault(); if (!edit) return;
    try { await rcall('roles:save', { ...(edit.id ? { id: edit.id } : {}), name: edit.name, color: edit.color || null, perms: edit.perms }); setEdit(null); toast('Role saved', 'info'); }
    catch (err) { toast((err as Error).message, 'error'); }
  };
  const members = people.filter((u) => u.registered && u.accountId != null && u.nick !== ownerNick && u.role !== 'admin' && u.role !== 'moderator' && !u.id.startsWith('bot:'));
  const assign = async (e: FormEvent) => {
    e.preventDefault();
    try { await rcall('roles:assign', { accountId: Number(who), roleId: roleFor ? Number(roleFor) : null }); toast('Role updated', 'info'); }
    catch (err) { toast((err as Error).message, 'error'); }
  };
  const holders = (id: number) => Object.entries(state.members).filter(([, r]) => r === id).length;
  return (
    <div className="roles-panel" data-testid="roles-panel">
      <p className="muted small">Roles give single powers in this room. Holders can't act on you, staff, room mods or other role holders, and can't ban or change settings.</p>
      <ul className="roles-list">
        {state.roles.map((r) => (
          <li key={r.id} data-role={r.name}>
            <span className="role-chip" style={r.color ? { color: r.color, borderColor: r.color } : undefined}>{r.name}</span>
            <span className="small muted"> {r.perms.length ? r.perms.map((p) => PERM_LABEL[p]).join(', ') : 'no powers (name colour only)'} · {holders(r.id)} member{holders(r.id) === 1 ? '' : 's'}</span>
            <span className="row">
              <button type="button" className="btn ghost small-btn" data-action="role-edit" onClick={() => setEdit({ id: r.id, name: r.name, color: r.color ?? '', perms: r.perms })}>Edit</button>
              <button type="button" className="btn ghost small-btn" data-action="role-remove" onClick={() => void rcall('roles:archive', { id: r.id }).catch((err) => toast((err as Error).message, 'error'))}>Remove</button>
            </span>
          </li>
        ))}
        {state.roles.length === 0 && <li className="muted small">No custom roles yet.</li>}
      </ul>
      {!edit && <button type="button" className="btn small-btn" data-action="role-new" onClick={() => setEdit({ name: '', color: '#7cc4ff', perms: ['pin'] })}>+ New role</button>}
      {edit && (
        <form className="role-form" onSubmit={save} data-testid="role-form">
          <label>Name <input value={edit.name} maxLength={24} onChange={(e) => setEdit({ ...edit, name: e.target.value })} data-testid="role-name" required /></label>
          <label>Name colour <input type="color" value={edit.color || '#7cc4ff'} onChange={(e) => setEdit({ ...edit, color: e.target.value })} data-testid="role-color" />
            <span className="role-chip" style={{ color: edit.color || undefined, borderColor: edit.color || undefined }}>{edit.name || 'Preview'}</span>
          </label>
          {!colorOk && <p className="form-error small" role="alert" data-testid="role-color-warn">That colour is too dark to read on the chat background. Pick a lighter one.</p>}
          <fieldset><legend className="small">Powers</legend>
            {PERMS.map((p) => (
              <label key={p} className="check"><input type="checkbox" checked={edit.perms.includes(p)} data-perm={p} onChange={(e) => setEdit({ ...edit, perms: e.target.checked ? [...edit.perms, p] : edit.perms.filter((x) => x !== p) })} /> {PERM_LABEL[p]}</label>
            ))}
          </fieldset>
          <div className="row"><button className="btn small-btn" type="submit" disabled={!colorOk} data-action="role-save">Save role</button><button type="button" className="btn ghost small-btn" onClick={() => setEdit(null)}>Cancel</button></div>
        </form>
      )}
      {state.roles.length > 0 && (
        <form className="role-assign" onSubmit={assign}>
          <label>Member <select value={who} onChange={(e) => { setWho(e.target.value); setRoleFor(String(state.members[e.target.value] ?? '')); }} data-testid="role-member" required>
            <option value="">Choose someone here…</option>
            {members.map((u) => <option key={u.accountId} value={u.accountId}>{u.nick}</option>)}
          </select></label>
          <label>Role <select value={roleFor} onChange={(e) => setRoleFor(e.target.value)} data-testid="role-pick">
            <option value="">No role</option>
            {state.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select></label>
          <button className="btn small-btn" type="submit" data-action="role-assign">Apply</button>
        </form>
      )}
    </div>
  );
}
