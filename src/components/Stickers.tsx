import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useEscape } from '../a11y';
import { STICKER_MAX_BYTES, type StickerPack } from '../../shared/stickers';

type Toast = (t: string, tone?: 'error' | 'info') => void;
const load = (roomId: string) => api<{ packs: StickerPack[]; limits: { packs: number; perPack: number } }>(`/api/rooms/${encodeURIComponent(roomId)}/stickers`);

/** batch MC2: sticker button in the chat bar; approved stickers of this room, grouped by pack. */
export function StickerPicker({ roomId, onSend }: { roomId: string; onSend: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [packs, setPacks] = useState<StickerPack[] | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) void load(roomId).then((r) => setPacks(r.packs.map((p) => ({ ...p, stickers: p.stickers.filter((s) => s.status === 'approved') })).filter((p) => p.stickers.length))).catch(() => setPacks([])); }, [open, roomId]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEscape(open, () => setOpen(false), () => wrap.current?.querySelector<HTMLElement>('[aria-expanded]'));
  return (
    <div className="sticker-wrap" ref={wrap}>
      <button type="button" className="btn ghost icon-act" title="Stickers" aria-label="Stickers" aria-expanded={open} data-action="stickers" onClick={() => setOpen((o) => !o)}>🗒️</button>
      {open && (
        <div className="sticker-pop" role="dialog" style={wrap.current ? { position: 'fixed', bottom: Math.max(8, window.innerHeight - wrap.current.getBoundingClientRect().top + 6), ...(window.innerWidth < 800 ? { left: 12, right: 12, width: 'auto' } : { right: Math.max(12, window.innerWidth - wrap.current.getBoundingClientRect().right) }) } : undefined} aria-label="Stickers" data-testid="sticker-pop">
          {packs === null ? <p className="small muted">Loading…</p> : packs.length === 0 ? <p className="small muted">This room has no stickers yet.</p> : packs.map((p) => (
            <section key={p.id} className="sticker-pack"><div className="small muted">{p.name}</div>
              <div className="sticker-grid">{p.stickers.map((s) => <button key={s.id} type="button" className="sticker-btn" title={s.name} aria-label={`Send sticker ${s.name}`} data-sticker={s.name} onClick={() => { onSend(s.id); setOpen(false); }}><img src={s.url} alt="" loading="lazy" width={64} height={64} /></button>)}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** room settings -> Sticker packs (owner / staff) */
export function StickersPanel({ roomId, toast }: { roomId: string; toast: Toast }) {
  const [packs, setPacks] = useState<StickerPack[] | null>(null);
  const [limits, setLimits] = useState({ packs: 3, perPack: 24 });
  const [packName, setPackName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void load(roomId).then((r) => { setPacks(r.packs); setLimits(r.limits); }).catch(() => setPacks([])); }, [roomId]);
  const addPack = async () => {
    setBusy(true);
    try { const r = await api<{ packs: StickerPack[] }>(`/api/rooms/${encodeURIComponent(roomId)}/sticker-packs`, { name: packName }); setPacks(r.packs); setPackName(''); toast('Pack created'); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const removePack = async (p: StickerPack) => {
    if (!window.confirm(`Remove the pack "${p.name}" and its stickers from this room?`)) return;
    try { const r = await api<{ packs: StickerPack[] }>(`/api/rooms/${encodeURIComponent(roomId)}/sticker-packs/${p.id}`, undefined, 'DELETE'); setPacks(r.packs); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const upload = async (packId: string, file: File | null, name: string) => {
    if (!file) return;
    if (file.size > STICKER_MAX_BYTES) return toast('Image too large (max 1 MB)', 'error');
    const fd = new FormData(); fd.append('name', name); fd.append('sticker', file);
    setBusy(true);
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/sticker-packs/${packId}/stickers`, { method: 'POST', body: fd, headers: { 'X-CSRF': '1' }, credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'Upload failed');
      setPacks(j.packs); toast(j.sticker.status === 'approved' ? 'Sticker added' : 'Sticker uploaded: staff will review it before it can be used');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="stickers-panel" data-panel="stickers">
      <p className="small muted">Up to {limits.packs} packs of {limits.perPack} stickers (PNG, JPEG, WebP or GIF, max 1 MB, shown up to 256×256). New stickers are checked by staff before members can send them.</p>
      {(packs ?? []).map((p) => <PackEditor key={p.id} pack={p} busy={busy} onUpload={upload} onRemove={() => void removePack(p)} />)}
      {(packs?.length ?? 0) < limits.packs && (
        <div className="row-actions"><input value={packName} onChange={(e) => setPackName(e.target.value)} placeholder="Pack name" maxLength={32} aria-label="New pack name" data-field="pack-name" />
          <button type="button" className="btn small-btn" disabled={busy || !packName.trim()} onClick={() => void addPack()} data-action="pack-add">Create pack</button></div>
      )}
    </div>
  );
}
function PackEditor({ pack, busy, onUpload, onRemove }: { pack: StickerPack; busy: boolean; onUpload: (packId: string, f: File | null, name: string) => void; onRemove: () => void }) {
  const [name, setName] = useState('');
  return (
    <section className="sticker-pack-edit" data-pack={pack.name}>
      <div className="row-actions"><b>{pack.name}</b> <span className="small muted">{pack.stickers.length} stickers</span> <button type="button" className="btn ghost small-btn" onClick={onRemove} data-action="pack-remove">Remove pack</button></div>
      <div className="sticker-grid">{pack.stickers.map((s) => <figure key={s.id} className={`sticker-cell st-${s.status}`} data-sticker-status={s.status} title={s.note ?? ''}><img src={s.url} alt={s.name} width={56} height={56} loading="lazy" /><figcaption className="small">{s.name}<br /><span className="muted">{s.status === 'pending' ? 'waiting for review' : s.status}</span></figcaption></figure>)}</div>
      <div className="row-actions"><input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="sticker_name" maxLength={24} aria-label="Sticker name" data-field="sticker-name" />
        <label className={`btn small-btn${busy || !name ? ' disabled' : ''}`}>Upload<input type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy || !name} onChange={(e) => { onUpload(pack.id, e.target.files?.[0] ?? null, name); e.target.value = ''; setName(''); }} data-field="sticker-file" /></label></div>
    </section>
  );
}
