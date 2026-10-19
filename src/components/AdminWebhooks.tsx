import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { WebhookInfo, WebhookLogEntry } from '../../shared/webhooks';

type Row = WebhookInfo & { roomId: string; roomName: string; log: WebhookLogEntry[] };

/** Staff: every room's webhooks, with a switch-off. */
export function AdminWebhooks({ onError, onNotice }: { onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const load = useCallback(async () => { try { setRows((await api<{ webhooks: Row[] }>('/api/admin/webhooks')).webhooks); } catch (e) { onError((e as Error).message); } }, [onError]);
  useEffect(() => { void load(); }, [load]);
  const disable = async (h: Row) => {
    const reason = window.prompt(`Turn off "${h.name}" in #${h.roomName}? Reason (shown to the room owner):`, 'Turned off by staff');
    if (reason === null) return;
    try { await api(`/api/admin/webhooks/${h.id}/disable`, { reason }); onNotice('Webhook turned off'); await load(); } catch (e) { onError((e as Error).message); }
  };
  const n = q.trim().toLowerCase();
  const shown = (rows ?? []).filter((h) => !n || `${h.name} ${h.roomName} ${h.url ?? ''}`.toLowerCase().includes(n));
  return (
    <section className="admin-webhooks" data-testid="admin-webhooks">
      <div className="row"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by room, name or URL" aria-label="Filter webhooks" /> <button className="btn ghost small-btn" onClick={() => void load()}>Refresh</button></div>
      {rows === null ? <p className="muted">Loading…</p> : shown.length === 0 ? <p className="muted">No webhooks.</p> : (
        <div className="wh-admin-wrap"><table className="table">
          <thead><tr><th>Room</th><th>Name</th><th>Type</th><th>Target / URL</th><th>Status</th><th>Recent</th><th /></tr></thead>
          <tbody>
            {shown.map((h) => (
              <tr key={h.id} data-admin-webhook={h.name}>
                <td>#{h.roomName}</td><td>{h.name}</td><td>{h.kind}</td>
                <td className="wh-url"><code>{h.kind === 'outgoing' ? h.url : h.urlHint}</code></td>
                <td>{h.enabled ? 'on' : <span title={h.disabledReason ?? ''}>off{h.disabledReason ? `: ${h.disabledReason}` : ''}</span>}</td>
                <td className="small">{h.log.map((l) => <span key={l.id} className={l.ok ? 'ok' : 'bad'} title={`${new Date(l.ts).toLocaleString()} ${l.event ?? ''} ${l.error ?? ''}`}>{l.status ?? '·'} </span>)}</td>
                <td>{h.enabled && <button className="btn danger-btn small-btn" data-action="admin-wh-disable" onClick={() => void disable(h)}>Turn off</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
