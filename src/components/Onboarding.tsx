import { useEffect, useRef, useState } from 'react';
import type { RoomSummary } from '../../shared/types';
import { CATEGORY_ICON, CATEGORY_LABEL, ROOM_CATEGORIES, type RoomCategory } from '../../shared/batch3';
import { api } from '../api';
import { useModal } from '../a11y';

/** Batch H6: skippable first-visit tour, interest picks, and suggested rooms. */
const TOUR = [
  { icon: '🏠', title: 'Rooms', text: 'Pick a room from the lobby to chat. Voice rooms are audio only; others let you turn on your camera too.' },
  { icon: '🎙', title: 'Cam, mic and voice', text: 'Your camera and mic stay off until you turn them on. Raise your hand in voice rooms to ask for the floor.' },
  { icon: '🤫', title: 'Whispers and settings', text: 'Tap a name to whisper or message privately. Room info has settings, captions, read-aloud and more.' },
];

export function Onboarding({ rooms, onJoin, onDone }: { rooms: RoomSummary[]; onJoin: (r: RoomSummary) => void; onDone: () => void }) {
  const [step, setStep] = useState(0); // 0..2 tour, 3 interests, 4 suggestions
  const [picks, setPicks] = useState<RoomCategory[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const finish = (interests?: RoomCategory[]) => { void api('/api/me/onboarding', { done: true, ...(interests ? { interests } : {}) }).catch(() => {}); onDone(); };
  useModal(ref, () => finish());
  const headRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { const r = requestAnimationFrame(() => headRef.current?.focus({ preventScroll: true })); return () => cancelAnimationFrame(r); }, [step]);
  const suggested = (() => {
    const open = rooms.filter((r) => !r.passwordRequired);
    const match = open.filter((r) => picks.includes(r.category as RoomCategory)).sort((a, b) => b.users - a.users);
    const rest = open.filter((r) => !match.includes(r)).sort((a, b) => b.users - a.users);
    return [...match, ...rest].slice(0, 5).map((r) => ({ r, match: match.includes(r) }));
  })();
  const title = step < 3 ? TOUR[step].title : step === 3 ? 'What are you into?' : 'Rooms you might like';
  return (
    <div className="modal-backdrop onboarding-backdrop">
      <div ref={ref} className="modal panel onboarding" role="dialog" aria-modal="true" aria-labelledby="onb-title" data-testid="onboarding" data-step={step}>
        <p className="small muted onb-progress" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <span key={i} className={i === step ? 'on' : ''}>●</span>)}</p>
        <h3 id="onb-title" ref={headRef} tabIndex={-1}>{step < 3 ? <span aria-hidden="true">{TOUR[step].icon} </span> : null}{title}</h3>
        {step < 3 && <p>{TOUR[step].text}</p>}
        {step === 3 && (
          <div className="onb-interests" role="group" aria-label="Interests">
            {ROOM_CATEGORIES.map((c) => (
              <button key={c} type="button" className={`chip${picks.includes(c) ? ' on' : ''}`} aria-pressed={picks.includes(c)} data-interest={c}
                onClick={() => setPicks((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))}><span aria-hidden="true">{CATEGORY_ICON[c]}</span> {CATEGORY_LABEL[c]}</button>
            ))}
          </div>
        )}
        {step === 4 && (
          <ul className="onb-rooms" data-testid="onb-suggested">
            {suggested.length === 0 && <li className="muted small">No open rooms right now. Make your own from the lobby!</li>}
            {suggested.map(({ r, match }) => (
              <li key={r.id} data-room={r.name} data-match={match ? '1' : '0'}>
                <span><strong>#{r.name}</strong> <span className="small muted">{r.users} here{r.voice ? ' · voice' : ''}{match && r.category ? ` · ${CATEGORY_LABEL[r.category as RoomCategory]}` : ''}</span></span>
                <button type="button" className="btn small-btn" data-action="onb-join" onClick={() => { finish(picks); onJoin(r); }} aria-label={`Join ${r.name}`}>Join</button>
              </li>
            ))}
          </ul>
        )}
        <div className="onb-actions">
          <button type="button" className="btn ghost small-btn" data-action="onb-skip" onClick={() => finish(step >= 3 ? picks : undefined)}>{step >= 3 ? 'Done' : 'Skip tour'}</button>
          <span className="spacer" />
          {step > 0 && <button type="button" className="btn ghost small-btn" data-action="onb-back" onClick={() => setStep(step - 1)}>Back</button>}
          {step < 4 && <button type="button" className="btn small-btn" data-action="onb-next" onClick={() => { if (step === 3) void api('/api/me/onboarding', { interests: picks }).catch(() => {}); setStep(step + 1); }}>{step === 3 ? (picks.length ? 'Show rooms' : 'Skip') : 'Next'}</button>}
        </div>
      </div>
    </div>
  );
}
