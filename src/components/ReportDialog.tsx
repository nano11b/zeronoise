import { FormEvent, useRef, useState } from 'react';
import { useModal } from '../a11y';
import { MODQ, REPORT_CATEGORIES, REPORT_CATEGORY_LABELS, type ReportCategory } from '../../shared/modq';
import { call, socket } from '../socket';

export type ReportTarget =
  | { kind: 'message'; messageId: string; from: string; preview: string }
  | { kind: 'whisper'; messageId: string; from: string; preview: string }
  | { kind: 'user'; userId?: string; accountId?: number; nick: string }
  | { kind: 'room'; roomId: string; name: string };

function titleOf(t: ReportTarget) {
  if (t.kind === 'message' || t.kind === 'whisper') return `Report message from ${t.from}`;
  if (t.kind === 'user') return `Report ${t.nick}`;
  return `Report #${t.name}`;
}

/** Reason picker + optional note. Site moderators see the report with recent chat for context. */
export function ReportDialog({ target, onClose, toast, registered }: {
  target: ReportTarget;
  onClose: () => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
  registered: boolean;
}) {
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLFormElement>(null);
  useModal(ref, onClose);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!category) { setError('Pick a reason.'); return; }
    setBusy(true); setError('');
    const body = {
      category, note: note.trim() || undefined, notify: registered && notify,
      ...(target.kind === 'message' ? { messageId: target.messageId }
        : target.kind === 'whisper' ? { whisperMessageId: target.messageId }
          : target.kind === 'room' ? { roomId: target.roomId }
            : target.accountId != null && !target.userId ? { accountId: target.accountId } : { userId: target.userId }),
    };
    try {
      const r = await call<{ reportId: number; updated?: boolean }>((ack) => socket.emit('report', body, ack));
      toast(r.updated ? 'Report updated. Thank you.' : 'Report sent. Thank you.');
      onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const quote = target.kind === 'message' || target.kind === 'whisper' ? target.preview : '';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form ref={ref} className="modal panel report-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit} role="dialog" aria-modal="true" aria-label={titleOf(target)} data-testid="report-dialog">
        <h3>{titleOf(target)}</h3>
        {quote && <p className="muted small report-quote">“{quote.slice(0, 140)}{quote.length > 140 ? '…' : ''}”</p>}
        {target.kind === 'whisper' && <p className="muted small">Whispers are private. Reporting sends this message and the whisper lines you saw to site moderators.</p>}
        <fieldset className="report-reasons">
          <legend>What is wrong?</legend>
          {REPORT_CATEGORIES.map((c) => (
            <label key={c} className={`rq-reason${category === c ? ' on' : ''}`}>
              <input type="radio" name="report-category" value={c} checked={category === c} onChange={() => { setCategory(c); setError(''); }} data-category={c} />
              <span>{REPORT_CATEGORY_LABELS[c]}</span>
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>Anything else? <span className="muted">(optional)</span></span>
          <textarea name="note" value={note} maxLength={MODQ.noteMax} rows={3} onChange={(e) => setNote(e.target.value)} aria-describedby="report-note-count" />
          <span id="report-note-count" className="muted small report-count">{note.length}/{MODQ.noteMax}</span>
        </label>
        {registered && (
          <label className="check-row report-notify">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} name="notify" />
            <span>Tell me when it has been reviewed</span>
          </label>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy} data-action="report-submit">Send report</button>
        </div>
      </form>
    </div>
  );
}
