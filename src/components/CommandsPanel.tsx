import { useEffect, useState } from 'react';
import { api } from '../api';
import { BUILTIN_COMMANDS, ROOM_COMMAND_RESPONSE_MAX } from '../../shared/chatCommands';

type Cmd = { name: string; response: string; uses: number };
/** batch MC2: room settings -> Chat commands (owner / staff). */
export function CommandsPanel({ roomId, toast }: { roomId: string; toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [list, setList] = useState<Cmd[] | null>(null);
  const [max, setMax] = useState(20);
  const [name, setName] = useState('');
  const [resp, setResp] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<{ commands: Cmd[]; max: number }>(`/api/rooms/${encodeURIComponent(roomId)}/commands`).then((r) => { setList(r.commands); setMax(r.max); }).catch(() => setList([])); }, [roomId]);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ commands: Cmd[] }>(`/api/rooms/${encodeURIComponent(roomId)}/commands/${encodeURIComponent(name.trim().replace(/^\//, '').toLowerCase())}`, { response: resp }, 'PUT');
      setList(r.commands); setName(''); setResp(''); toast('Command saved');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const del = async (n: string) => {
    if (!window.confirm(`Remove /${n}?`)) return;
    try { const r = await api<{ commands: Cmd[] }>(`/api/rooms/${encodeURIComponent(roomId)}/commands/${encodeURIComponent(n)}`, undefined, 'DELETE'); setList(r.commands); toast('Command removed'); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="cmd-panel" data-panel="commands">
      <p className="small muted">Everyone can use {BUILTIN_COMMANDS.map((c) => <code key={c.name}>/{c.name}</code>).reduce<React.ReactNode[]>((a, c, i) => (i ? [...a, ' ', c] : [c]), [])}. Add up to {max} text replies of your own: typing <code>/name</code> posts the reply.</p>
      {list === null ? <p className="small muted">Loading…</p> : list.length === 0 ? <p className="small muted" data-testid="cmd-empty">No custom commands yet.</p> : (
        <ul className="cmd-list">
          {list.map((c) => (
            <li key={c.name} data-command={c.name}><code>/{c.name}</code> <span className="cmd-resp">{c.response}</span> <span className="small muted">{c.uses} uses</span>
              <button type="button" className="btn ghost small-btn" onClick={() => void del(c.name)} data-action="cmd-delete" aria-label={`Remove /${c.name}`}>Remove</button></li>
          ))}
        </ul>
      )}
      <div className="cmd-form">
        <label className="small">Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="rules" maxLength={21} data-field="cmd-name" /></label>
        <label className="small">Reply <textarea value={resp} onChange={(e) => setResp(e.target.value)} rows={2} maxLength={ROOM_COMMAND_RESPONSE_MAX} placeholder="Be kind. No spam." data-field="cmd-response" /></label>
        <button type="button" className="btn small-btn primary" disabled={busy || !name.trim() || !resp.trim() || (list?.length ?? 0) >= max && !list?.some((c) => c.name === name.trim().toLowerCase())} onClick={() => void save()} data-action="cmd-save">Save command</button>
      </div>
    </div>
  );
}

/** suggestions shown above the message box while typing "/name" */
export function CommandHints({ text, roomCommands, onPick }: { text: string; roomCommands: string[]; onPick: (cmd: string) => void }) {
  const m = /^\/([a-z0-9_-]*)$/i.exec(text);
  if (!m) return null;
  const pre = m[1].toLowerCase();
  const all = [...BUILTIN_COMMANDS.map((c) => ({ name: c.name, help: c.help })), ...roomCommands.map((n) => ({ name: n, help: 'Room command' }))].filter((c) => c.name.startsWith(pre)).slice(0, 8);
  if (!all.length) return null;
  return (
    <ul className="cmd-hints" role="listbox" aria-label="Commands" data-testid="cmd-hints">
      {all.map((c) => <li key={c.name}><button type="button" role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); onPick(`/${c.name} `); }} data-cmd={c.name}><code>/{c.name}</code> <span className="small muted">{c.help}</span></button></li>)}
    </ul>
  );
}
