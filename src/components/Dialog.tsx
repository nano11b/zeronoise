import { FormEvent, useEffect, useState, useRef } from 'react';
import { useModal } from '../a11y';

export interface DialogSpec {
  title: string;
  description?: string;
  confirm: string;
  danger?: boolean;
  /** show a reason text field */
  reason?: { label: string; required?: boolean; max: number };
  /** duration choices in minutes; null = permanent */
  durations?: { label: string; minutes: number | null }[];
  onSubmit: (v: { reason: string; minutes: number | null }) => Promise<void> | void;
}

export function Dialog({ spec, onClose }: { spec: DialogSpec; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [dur, setDur] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (spec.reason?.required && !reason.trim()) { setError('Please give a reason.'); return; }
    setBusy(true); setError('');
    try {
      await spec.onSubmit({ reason: reason.trim(), minutes: spec.durations ? spec.durations[dur].minutes : null });
      onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  const modalRef = useRef<HTMLFormElement>(null);
  useModal(modalRef, onClose);
  // Focus the reason field once the modal has noted its opener (autoFocus would run first and break focus return).
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const raf = requestAnimationFrame(() => reasonRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form ref={modalRef} className="modal panel" onClick={(e) => e.stopPropagation()} onSubmit={submit} role="dialog" aria-modal="true" aria-label={spec.title}>
        <h3>{spec.title}</h3>
        {spec.description && <p className="muted small">{spec.description}</p>}
        {spec.durations && (
          <label className="field">
            <span>Duration</span>
            <select value={dur} onChange={(e) => setDur(Number(e.target.value))} name="duration">
              {spec.durations.map((d, i) => <option key={d.label} value={i}>{d.label}</option>)}
            </select>
          </label>
        )}
        {spec.reason && (
          <label className="field">
            <span>{spec.reason.label}</span>
            <textarea ref={reasonRef} name="reason" value={reason} maxLength={spec.reason.max} rows={3} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className={`btn ${spec.danger ? 'danger-btn' : 'primary'}`} disabled={busy} data-action="dialog-confirm">{spec.confirm}</button>
        </div>
      </form>
    </div>
  );
}

export const BAN_DURATIONS = [
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 1440 },
  { label: '7 days', minutes: 10080 },
  { label: '30 days', minutes: 43200 },
  { label: 'Permanent', minutes: null },
];
