import { useState, useRef } from 'react';
import { useModal } from '../a11y';
import { FX, type FxId } from '../../shared/fx';
import { fxShowEnabled, fxSoundEnabled, prefersReducedMotion, setFxShowEnabled, setFxSoundEnabled } from '../fx';

/** Small grid of the 8 effects + per-user toggles. */
export function FxPanel({ onPlay, onClose }: { onPlay: (id: FxId) => void; onClose: () => void }) {
  const [show, setShow] = useState(fxShowEnabled);
  const [sound, setSound] = useState(fxSoundEnabled);
  const modalRef = useRef<HTMLDivElement>(null);
  useModal(modalRef, onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={modalRef} className="modal panel fx-panel" role="dialog" aria-modal="true" aria-label="Effects" onClick={(e) => e.stopPropagation()}>
        <h3>Effects</h3>
        <p className="muted small">Everyone in the room sees it. One every 10 s per person. Tip: type /confetti, /fireworks, /balloons, /hearts, /rain, /snow, /money or /matrix in chat.</p>
        <div className="fx-grid">
          {FX.map((f) => (
            <button key={f.id} type="button" className="btn fx-btn" data-action="fx-play" data-fx={f.id} title={`${f.name} (/${f.id})`} onClick={() => onPlay(f.id)}>
              <span className="fx-emoji" aria-hidden="true">{f.emoji}</span>
              <span className="small">{f.name}</span>
            </button>
          ))}
        </div>
        <label className="fx-toggle"><input type="checkbox" checked={show} data-action="fx-show" onChange={(e) => { setShow(e.target.checked); setFxShowEnabled(e.target.checked); }} /> Show effects</label>
        <label className="fx-toggle"><input type="checkbox" checked={sound} data-action="fx-sound" onChange={(e) => { setSound(e.target.checked); setFxSoundEnabled(e.target.checked); }} /> Effect sounds</label>
        {prefersReducedMotion() && <p className="muted small">Reduced motion is on: effects show as a small note instead of animating.</p>}
        <button type="button" className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
