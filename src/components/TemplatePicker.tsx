import { useState } from 'react';
import { ROOM_TEMPLATES, TEMPLATE_KEYS, type RoomTemplateKey } from '../../shared/templates';
import { call, socket } from '../socket';
import { PERM_LABEL } from './RolesPanel';

/** Batch G3: owner applies one of five presets (accent, filters, slow mode, roles, welcome). */
export function TemplatePicker({ current, toast }: { current?: string | null; toast: (m: string, k?: 'error' | 'info') => void }) {
  const [pick, setPick] = useState<RoomTemplateKey | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    if (!pick) return;
    setBusy(true);
    try { await call((ack) => socket.emit('room:template:apply', { template: pick }, ack)); toast(`${ROOM_TEMPLATES[pick].label} template applied`, 'info'); setPick(null); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const t = pick ? ROOM_TEMPLATES[pick] : null;
  return (
    <div className="template-picker" data-testid="template-picker">
      <div className="template-grid" role="radiogroup" aria-label="Room templates">
        {TEMPLATE_KEYS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={pick === k} className={`template-card${pick === k ? ' on' : ''}`} data-template={k} onClick={() => setPick(k)} style={{ borderColor: pick === k ? ROOM_TEMPLATES[k].accent : undefined }}>
            <span className="template-icon" aria-hidden="true">{ROOM_TEMPLATES[k].icon}</span> <strong>{ROOM_TEMPLATES[k].label}</strong>{current === k && <span className="small muted"> · current</span>}
            <span className="small muted">{ROOM_TEMPLATES[k].blurb}</span>
          </button>
        ))}
      </div>
      {t && (
        <div className="template-preview" data-testid="template-preview">
          <p className="small"><span className="swatch" style={{ background: t.accent }} aria-hidden="true" /> Accent {t.accent} · Slow mode {t.slowModeSec ? `${t.slowModeSec}s` : 'off'} · Links {t.filters.links === 'allowlist' ? `only ${t.filters.allow.join(', ')}` : t.filters.links === 'block' ? 'blocked' : 'allowed'}</p>
          <p className="small">Roles: {t.roles.map((r) => <span key={r.name} className="role-chip" style={{ color: r.color, borderColor: r.color }} title={r.perms.map((p) => PERM_LABEL[p]).join(', ') || 'name colour only'}>{r.name}</span>)}</p>
          <p className="small muted">“{t.welcome}”</p>
          <p className="small muted">This replaces the accent, welcome message, filters and slow mode, and adds these roles (existing roles stay).</p>
          <button type="button" className="btn small-btn" disabled={busy} onClick={() => void apply()} data-action="template-apply">Apply {t.label}</button>
        </div>
      )}
    </div>
  );
}
