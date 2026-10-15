import { FormEvent, useEffect, useRef, useState } from 'react';
import type { NotifyLevel, QuietHours } from '../../shared/notify';
import { useModal } from '../a11y';
import { call, socket } from '../socket';

const toHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHm = (v: string) => { const [h, m] = v.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const LEVELS: { v: NotifyLevel; label: string; hint: string }[] = [
  { v: 'all', label: 'Everything', hint: 'A push for every new message while you are away' },
  { v: 'mentions', label: 'Mentions only', hint: '@mentions and whispers (default)' },
  { v: 'mute', label: 'Mute', hint: 'No pushes from this room, not even mentions' },
];

/** Per-room notification level, plus push quiet hours (account-wide). */
export function NotifyDialog({ roomName, onClose, onLevel }: { roomName: string; onClose: () => void; onLevel?: (l: NotifyLevel) => void }) {
  const [level, setLevel] = useState<NotifyLevel>('mentions');
  const [quietOn, setQuietOn] = useState(false);
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('07:00');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLFormElement>(null);
  useModal(ref, onClose);
  useEffect(() => {
    call<{ level: NotifyLevel; quiet: QuietHours | null }>((ack) => socket.emit('notify:get', ack))
      .then((r) => { setLevel(r.level); if (r.quiet) { setQuietOn(true); setStart(toHm(r.quiet.start)); setEnd(toHm(r.quiet.end)); } setLoaded(true); })
      .catch((e) => { setError((e as Error).message); setLoaded(true); });
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await call((ack) => socket.emit('notify:set', { level }, ack));
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      await call((ack) => socket.emit('notify:quiet', quietOn ? { start: fromHm(start), end: fromHm(end), tz } : null, ack));
      onLevel?.(level);
      onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form ref={ref} className="modal panel notify-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit} role="dialog" aria-modal="true" aria-label="Notifications" data-dialog="notify">
        <h3>Notifications for #{roomName}</h3>
        <fieldset className="notify-levels" disabled={!loaded}>
          <legend className="muted small">Push notifications</legend>
          {LEVELS.map((l) => (
            <label key={l.v} className={`notify-level${level === l.v ? ' on' : ''}`}>
              <input type="radio" name="notify-level" value={l.v} checked={level === l.v} onChange={() => setLevel(l.v)} data-notify-level={l.v} />
              <span><strong>{l.label}</strong><span className="muted small">{l.hint}</span></span>
            </label>
          ))}
        </fieldset>
        <fieldset className="notify-quiet" disabled={!loaded}>
          <label className="check-row"><input type="checkbox" checked={quietOn} onChange={(e) => setQuietOn(e.target.checked)} data-action="quiet-toggle" /> <span>Quiet hours (no pushes from any room)</span></label>
          {quietOn && (
            <div className="quiet-times">
              <label className="field"><span>From</span><input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Quiet hours start" data-field="quiet-start" /></label>
              <label className="field"><span>Until</span><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Quiet hours end" data-field="quiet-end" /></label>
            </div>
          )}
        </fieldset>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !loaded} data-action="notify-save">Save</button>
        </div>
      </form>
    </div>
  );
}
