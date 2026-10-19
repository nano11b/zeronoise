import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, storedDeviceId } from '../api';
import { WEBHOOK, WEBHOOK_EVENTS, WEBHOOK_EVENT_LABEL, type WebhookEvent, type WebhookInfo, type WebhookLogEntry } from '../../shared/webhooks';

type Toast = (msg: string, kind?: 'error' | 'info') => void;
const when = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : 'never');

/** Room settings: incoming and outgoing webhooks (owner, staff, or a custom role with "Manage webhooks"). */
export function WebhooksPanel({ roomId, toast }: { roomId: string; toast: Toast }) {
  const base = `/api/rooms/${encodeURIComponent(roomId)}/webhooks`;
  const [list, setList] = useState<WebhookInfo[] | null>(null);
  const [kind, setKind] = useState<'incoming' | 'outgoing'>('incoming');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>(['message']);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<{ id: string; label: string; value: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const r = await api<{ webhooks: WebhookInfo[] }>(base); setList(r.webhooks); } catch (e) { toast((e as Error).message, 'error'); }
  }, [base, toast]);
  useEffect(() => { void load(); }, [load]);
  const live = (list ?? []).length;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return toast('Give the webhook a name', 'error');
    setBusy(true);
    try {
      const r = await api<{ webhook: WebhookInfo; url?: string; secret?: string }>(base, kind === 'incoming' ? { kind, name } : { kind, name, url, events });
      setReveal(r.url ? { id: r.webhook.id, label: 'Webhook URL', value: r.url } : { id: r.webhook.id, label: 'Signing secret', value: r.secret! });
      setName(''); setUrl('');
      await load();
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="wh-panel" data-webhooks={live}>
      <p className="muted small">Incoming webhooks let tools such as game servers, GitHub or CI post here (Discord-style URL). Outgoing webhooks send signed events to your HTTPS server. {live}/{WEBHOOK.maxPerRoom}</p>
      {reveal && <SecretBox reveal={reveal} onClose={() => setReveal(null)} toast={toast} />}
      {list === null ? <p className="muted small">Loading…</p> : list.length === 0 ? <p className="muted small" data-empty="webhooks">No webhooks yet.</p> : (
        <ul className="wh-list">
          {list.map((h) => <HookRow key={h.id} h={h} base={base} open={open === h.id} onToggle={() => setOpen(open === h.id ? null : h.id)} reload={load} onReveal={setReveal} toast={toast} />)}
        </ul>
      )}
      {live < WEBHOOK.maxPerRoom ? (
        <form className="stack manage-form wh-create" onSubmit={create} data-form="webhook">
          <div className="seg" role="radiogroup" aria-label="Webhook type">
            {(['incoming', 'outgoing'] as const).map((k) => (
              <label key={k} className={kind === k ? 'on' : ''}><input type="radio" name="wh-kind" checked={kind === k} onChange={() => setKind(k)} data-kind={k} />{k === 'incoming' ? 'Incoming (post into this room)' : 'Outgoing (send events out)'}</label>
            ))}
          </div>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={WEBHOOK.nameMax} placeholder="Name, e.g. Server status" aria-label="Webhook name" data-field="wh-name" />
          {kind === 'outgoing' && (
            <>
              <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" placeholder="https://example.com/zeronoise-hook" aria-label="Target URL" data-field="wh-url" />
              <EventPicker value={events} onChange={setEvents} />
            </>
          )}
          <button className="btn small-btn" disabled={busy} data-action="wh-create">Create webhook</button>
        </form>
      ) : <p className="muted small">This room has {WEBHOOK.maxPerRoom} webhooks (the maximum).</p>}
      <p className="muted small"><a href="/docs/bots#webhooks" target="_blank" rel="noreferrer">Webhook docs</a>: payloads, signature checks (Node, Lua for FiveM) and curl examples.</p>
    </div>
  );
}

function EventPicker({ value, onChange }: { value: WebhookEvent[]; onChange: (v: WebhookEvent[]) => void }) {
  return (
    <fieldset className="wh-events"><legend className="small">Events</legend>
      {WEBHOOK_EVENTS.map((ev) => (
        <label key={ev}><input type="checkbox" checked={value.includes(ev)} data-event={ev} onChange={(e) => onChange(e.target.checked ? [...value, ev] : value.filter((x) => x !== ev))} /> {WEBHOOK_EVENT_LABEL[ev]}</label>
      ))}
    </fieldset>
  );
}

function SecretBox({ reveal, onClose, toast }: { reveal: { label: string; value: string }; onClose: () => void; toast: Toast }) {
  const copy = async () => { try { await navigator.clipboard.writeText(reveal.value); toast('Copied'); } catch { toast('Select the text and copy it', 'error'); } };
  return (
    <div className="wh-secret" role="alert" data-testid="wh-secret">
      <strong>{reveal.label}</strong> <span className="muted small">shown once: copy it now. Anyone with it can {reveal.label === 'Webhook URL' ? 'post here' : 'forge deliveries'}.</span>
      <div className="wh-secret-row"><input readOnly value={reveal.value} onFocus={(e) => e.target.select()} aria-label={reveal.label} data-field="wh-secret" />
        <button type="button" className="btn small-btn" onClick={() => void copy()} data-action="wh-copy">Copy</button>
        <button type="button" className="btn ghost small-btn" onClick={onClose} data-action="wh-hide">Done</button></div>
    </div>
  );
}

function HookRow({ h, base, open, onToggle, reload, onReveal, toast }: { h: WebhookInfo; base: string; open: boolean; onToggle: () => void; reload: () => Promise<void>; onReveal: (r: { id: string; label: string; value: string }) => void; toast: Toast }) {
  const [log, setLog] = useState<WebhookLogEntry[] | null>(null);
  const [edit, setEdit] = useState({ name: h.name, url: h.url ?? '', events: h.events ?? [] });
  const [confirm, setConfirm] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const one = `${base}/${h.id}`;
  const loadLog = useCallback(async () => { try { setLog((await api<{ log: WebhookLogEntry[] }>(`${one}/log`)).log); } catch { /* */ } }, [one]);
  useEffect(() => { if (open) void loadLog(); }, [open, loadLog]);
  const act = async (fn: () => Promise<unknown>, done?: string) => { try { await fn(); if (done) toast(done); await reload(); if (open) await loadLog(); } catch (e) { toast((e as Error).message, 'error'); } };
  const avatar = async (f: File) => {
    const fd = new FormData(); fd.append('avatar', f);
    const headers: Record<string, string> = { 'X-CSRF': '1' }; const dev = storedDeviceId(); if (dev) headers['X-Device-Id'] = dev;
    await act(async () => { const r = await fetch(`${one}/avatar`, { method: 'POST', headers, credentials: 'same-origin', body: fd }); const d = await r.json().catch(() => ({})); if (!r.ok || d.ok === false) throw new Error(d.error || 'Upload failed'); }, 'Avatar updated');
  };
  return (
    <li className={`wh-row${h.enabled ? '' : ' off'}`} data-webhook={h.name} data-kind={h.kind}>
      <div className="wh-head">
        {h.avatarUrl ? <img src={h.avatarUrl} alt="" width={28} height={28} className="wh-av" /> : <span className="wh-av ph" aria-hidden>🔗</span>}
        <button type="button" className="link-btn wh-name" onClick={onToggle} aria-expanded={open} data-action="wh-open">{h.name}</button>
        <span className="tag">{h.kind}</span>
        {!h.enabled && <span className="tag warn" title={h.disabledReason ?? ''}>off</span>}
        <label className="wh-switch"><input type="checkbox" checked={h.enabled} onChange={(e) => void act(() => api(one, { enabled: e.target.checked }, 'PATCH'))} data-action="wh-enable" aria-label={`${h.name} on`} /> on</label>
      </div>
      <div className="muted small wh-meta">{h.kind === 'incoming' ? <code>{h.urlHint}</code> : <code className="wh-url">{h.url}</code>} · last used {when(h.lastUsedAt)}{h.disabledReason ? ` · ${h.disabledReason}` : ''}</div>
      {open && (
        <div className="wh-body">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void act(() => api(one, h.kind === 'outgoing' ? edit : { name: edit.name }, 'PATCH'), 'Saved'); }}>
            <input value={edit.name} maxLength={WEBHOOK.nameMax} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="Name" data-field="wh-edit-name" />
            {h.kind === 'outgoing' && <><input value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} aria-label="Target URL" /><EventPicker value={edit.events} onChange={(v) => setEdit({ ...edit, events: v })} /></>}
            <div className="wh-actions">
              <button className="btn small-btn" data-action="wh-save">Save</button>
              {h.kind === 'incoming' && <><input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; if (f) void avatar(f); }} /><button type="button" className="btn ghost small-btn" onClick={() => fileRef.current?.click()} data-action="wh-avatar">Avatar…</button></>}
              <button type="button" className="btn ghost small-btn" data-action="wh-test" onClick={() => void act(() => api(`${one}/test`, {}), h.kind === 'incoming' ? 'Test message posted' : 'Test delivery queued')}>Test</button>
              <button type="button" className="btn ghost small-btn" data-action="wh-regenerate" onClick={() => void act(async () => { const r = await api<{ url?: string; secret?: string }>(`${one}/regenerate`, {}); onReveal(r.url ? { id: h.id, label: 'Webhook URL', value: r.url } : { id: h.id, label: 'Signing secret', value: r.secret! }); }, 'The old one no longer works')}>{h.kind === 'incoming' ? 'New URL' : 'New secret'}</button>
              {confirm
                ? <><button type="button" className="btn danger-btn small-btn" data-action="wh-delete-confirm" onClick={() => void act(() => api(one, undefined, 'DELETE'), 'Webhook deleted')}>Delete for good</button><button type="button" className="btn ghost small-btn" onClick={() => setConfirm(false)}>Keep</button></>
                : <button type="button" className="btn ghost small-btn danger-text" data-action="wh-delete" onClick={() => setConfirm(true)}>Delete…</button>}
            </div>
          </form>
          <div className="wh-log" data-testid="wh-log">
            <div className="small"><strong>Recent {h.kind === 'incoming' ? 'requests' : 'deliveries'}</strong> <button type="button" className="link-btn small" onClick={() => void loadLog()}>refresh</button></div>
            {!log?.length ? <p className="muted small">Nothing yet.</p> : (
              <table className="wh-log-table"><tbody>
                {log.slice(0, WEBHOOK.logKeep).map((l) => (
                  <tr key={l.id} className={l.ok ? 'ok' : 'bad'}>
                    <td>{new Date(l.ts).toLocaleTimeString()}</td><td>{l.event ?? ''}</td>
                    <td>{l.status ?? '-'}{l.attempt > 1 ? ` (try ${l.attempt})` : ''}</td>
                    <td className="wh-log-sum" title={l.error ?? l.summary ?? ''}>{l.error ?? l.summary ?? ''}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
