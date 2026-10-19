import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { StickerInfo } from '../../shared/stickers';

type Row = StickerInfo & { roomId: string; roomName: string; pack: string | null; by: string | null; createdAt: number };
/** Staff: review stickers before members can send them. */
export function AdminStickers({ onError, onNotice }: { onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [rows, setRows] = useState<Row[] | null>(null);
  const load = useCallback(async () => { try { setRows((await api<{ stickers: Row[] }>(`/api/admin/stickers?status=${status}`)).stickers); } catch (e) { onError((e as Error).message); } }, [status, onError]);
  useEffect(() => { void load(); }, [load]);
  const review = async (r: Row, approve: boolean) => {
    const note = approve ? '' : window.prompt(`Reject "${r.name}"? Note for the room owner:`, 'Not suitable');
    if (note === null) return;
    try { await api(`/api/admin/stickers/${r.id}/review`, { approve, note }); onNotice(approve ? 'Sticker approved' : 'Sticker rejected'); await load(); } catch (e) { onError((e as Error).message); }
  };
  return (
    <section className="admin-stickers" data-testid="admin-stickers">
      <div className="row-actions" role="tablist">{(['pending', 'approved', 'rejected'] as const).map((s) => <button key={s} type="button" role="tab" aria-selected={status === s} className={`btn small-btn ${status === s ? 'primary' : 'ghost'}`} onClick={() => setStatus(s)} data-action={`stickers-${s}`}>{s[0].toUpperCase() + s.slice(1)}</button>)}</div>
      {rows === null ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted" data-testid="admin-stickers-empty">Nothing here.</p> : (
        <div className="admin-sticker-grid">
          {rows.map((r) => (
            <figure key={r.id} className="admin-sticker" data-admin-sticker={r.name}>
              <img src={r.url} alt={r.name} width={96} height={96} loading="lazy" />
              <figcaption className="small"><b>{r.name}</b> · {r.pack}<br />#{r.roomName} · by {r.by ?? '?'}<br /><span className="muted">{new Date(r.createdAt).toLocaleString()}</span></figcaption>
              {status === 'pending' && <div className="row-actions"><button type="button" className="btn small-btn primary" onClick={() => void review(r, true)} data-action="sticker-approve">Approve</button><button type="button" className="btn small-btn danger-btn" onClick={() => void review(r, false)} data-action="sticker-reject">Reject</button></div>}
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
