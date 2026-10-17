import { FormEvent, useEffect, useState, useRef } from 'react';
import { useModal } from '../a11y';
import type { PollInfo } from '../../shared/types';
import { POLL_DURATIONS_MIN, POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX } from '../../shared/polls';
import { call, socket } from '../socket';

const durLabel = (m: number) => (m === 0 ? 'No time limit' : m < 60 ? `${m} min` : m < 1440 ? `${m / 60} h` : `${m / 1440} day`);
function left(ms: number) {
  if (ms <= 0) return 'closing…';
  const m = Math.ceil(ms / 60_000);
  return m < 60 ? `${m} min left` : m < 1440 ? `${Math.round(m / 60)} h left` : `${Math.round(m / 1440)} d left`;
}

/** Live poll card inside a chat line: single choice, results as bars, close for creator / owner / mods. */
export function PollCard({ poll, canClose, toast, onPoll }: { poll: PollInfo; canClose: boolean; toast: (t: string, tone?: 'error' | 'info') => void; onPoll?: (p: PollInfo) => void }) {
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (poll.closed || !poll.closesAt) return;
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [poll.closed, poll.closesAt]);
  const voted = poll.myVote != null;
  const showResults = voted || poll.closed;
  const top = Math.max(0, ...poll.options.map((o) => o.votes));
  const vote = async (i: number) => {
    if (poll.closed || busy) return;
    setBusy(true);
    try { const r = await call<{ poll: PollInfo }>((ack) => socket.emit('poll:vote', { pollId: poll.id, option: i }, ack)); onPoll?.(r.poll); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const close = async () => {
    setBusy(true);
    try { const r = await call<{ poll: PollInfo }>((ack) => socket.emit('poll:close', { pollId: poll.id }, ack)); onPoll?.(r.poll); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className={`poll-card${poll.closed ? ' closed' : ''}`} data-poll={poll.id} role="group" aria-label={`Poll: ${poll.question}`}>
      <div className="poll-q"><span aria-hidden="true">📊</span> {poll.question}</div>
      <ul className="poll-options">
        {poll.options.map((o, i) => {
          const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
          return (
            <li key={i}>
              <button type="button" className={`poll-opt${poll.myVote === i ? ' mine' : ''}${poll.closed && o.votes === top && top > 0 ? ' win' : ''}`} disabled={poll.closed || busy} aria-pressed={poll.myVote === i} data-poll-option={i} onClick={() => void vote(i)}>
                {showResults && <span className="poll-bar" style={{ width: `${pct}%` }} aria-hidden="true" />}
                <span className="poll-opt-text">{poll.myVote === i ? '✓ ' : ''}{o.text}</span>
                {showResults && <span className="poll-pct">{pct}%</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="poll-foot muted small">
        <span data-poll-total={poll.total}>{poll.total} {poll.total === 1 ? 'vote' : 'votes'}</span>
        <span>· {poll.closed ? 'closed' : poll.closesAt ? left(poll.closesAt - Date.now()) : 'open'}</span>
        {!poll.closed && !voted && <span>· tap to vote</span>}
        {canClose && !poll.closed && <button type="button" className="btn ghost small-btn" disabled={busy} data-action="poll-close" onClick={() => void close()}>Close poll</button>}
      </div>
    </div>
  );
}

/** Create a poll: question, 2-6 options, optional time limit. */
export function PollDialog({ initial, onClose, toast, parentId }: { initial?: { question: string; options: string[] }; parentId?: string; onClose: () => void; toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [question, setQuestion] = useState(initial?.question ?? '');
  const [options, setOptions] = useState<string[]>(() => {
    const o = (initial?.options ?? []).slice(0, POLL_MAX_OPTIONS);
    while (o.length < POLL_MIN_OPTIONS) o.push('');
    return o;
  });
  const [duration, setDuration] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await call((ack) => socket.emit('poll:create', { question: question.trim(), options: filled, durationMin: duration || null, ...(parentId ? { parentId } : {}) }, ack));
      onClose();
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const modalRef = useRef<HTMLFormElement>(null);
  useModal(modalRef, onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form ref={modalRef} className="modal panel poll-dialog" role="dialog" aria-modal="true" aria-label={parentId ? 'New poll in thread' : 'New poll'} data-thread-poll={parentId ? '1' : undefined} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{parentId ? 'New poll in this thread' : 'New poll'}</h3>
        <input autoFocus value={question} maxLength={POLL_QUESTION_MAX} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question" aria-label="Poll question" data-field="poll-question" required />
        <div className="poll-edit-options">
          {options.map((o, i) => (
            <div key={i} className="poll-edit-row">
              <input value={o} maxLength={POLL_OPTION_MAX} onChange={(e) => setOptions((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} data-field={`poll-option-${i}`} />
              {options.length > POLL_MIN_OPTIONS && <button type="button" className="icon-btn" aria-label={`Remove option ${i + 1}`} title="Remove option" onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          {options.length < POLL_MAX_OPTIONS && <button type="button" className="btn ghost small-btn" data-action="poll-add-option" onClick={() => setOptions((cur) => [...cur, ''])}>+ Add option</button>}
        </div>
        <label className="small poll-duration">Closes
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label="Poll duration" data-field="poll-duration">
            {POLL_DURATIONS_MIN.map((d) => <option key={d} value={d}>{durLabel(d)}</option>)}
          </select>
        </label>
        <p className="muted small">Tip: type <code>/poll Question | Option 1 | Option 2</code> in chat.</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !question.trim() || filled.length < POLL_MIN_OPTIONS} data-action="poll-create">Post poll</button>
        </div>
      </form>
    </div>
  );
}
