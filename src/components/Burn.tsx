import { useEffect, useState } from 'react';
import type { BurnInfo } from '../../shared/types';
import { BURN_DEFAULT_TTL, BURN_HINT, BURN_TTLS, isBurnTtl, type BurnTtl } from '../../shared/burn';
import { call, socket } from '../socket';
import { ChatText } from './ChatText';

/** 🔥 composer toggle + ttl picker. `ttl` is null when off. */
export function BurnToggle({ armed, ttl, onArmed, onTtl }: { armed: boolean; ttl: BurnTtl; onArmed: (on: boolean) => void; onTtl: (t: BurnTtl) => void }) {
  return (
    <span className={`burn-toggle${armed ? ' armed' : ''}`}>
      <button type="button" className={`btn ghost burn-btn${armed ? ' on' : ''}`} data-action="burn-toggle" aria-pressed={armed}
        title={armed ? `Burn on: next message disappears ${ttl}s after viewing. Screenshots are still possible.` : `Burn after reading. ${BURN_HINT}`}
        aria-label={armed ? 'Burn after reading is on' : 'Burn after reading'} onClick={() => onArmed(!armed)}>🔥</button>
      {armed && (
        <select className="burn-ttl" aria-label="Burn timer" title={BURN_HINT} value={ttl} data-action="burn-ttl"
          onChange={(e) => { const v = Number(e.target.value); if (isBurnTtl(v)) onTtl(v); }}>
          {BURN_TTLS.map((t) => <option key={t} value={t}>{t}s</option>)}
        </select>
      )}
    </span>
  );
}
export { BURN_DEFAULT_TTL };

type Revealed = { text: string; endsAt: number; totalMs: number };

function Ring({ endsAt, totalMs, onDone }: { endsAt: number; totalMs: number; onDone: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, endsAt - now);
  useEffect(() => { if (left <= 0) onDone(); }, [left, onDone]);
  const r = 8, c = 2 * Math.PI * r;
  const frac = totalMs > 0 ? left / totalMs : 0;
  return (
    <span className="burn-ring" title={`${Math.ceil(left / 1000)}s left`} aria-label={`${Math.ceil(left / 1000)} seconds left`} data-left={Math.ceil(left / 1000)}>
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle cx="10" cy="10" r={r} className="burn-ring-bg" />
        <circle cx="10" cy="10" r={r} className="burn-ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} transform="rotate(-90 10 10)" />
      </svg>
      <span className="burn-ring-n">{Math.ceil(left / 1000)}</span>
    </span>
  );
}

/** Body of a burn message: covered → revealed with countdown → burned (per viewer). */
export function BurnBody({ id, text, burn, onLocalBurn, toast }: { id: string; text: string; burn: BurnInfo; onLocalBurn: (id: string) => void; toast: (m: string, kind?: 'error') => void }) {
  const [state, setState] = useState<'covered' | 'loading' | 'burned' | Revealed>('covered');
  const done = useCallbackStable(() => { setState('burned'); onLocalBurn(id); });
  if (burn.burned || state === 'burned') return <span className="burn-burned" data-burn="burned">🔥 Burned</span>;
  if (burn.mine) {
    return (
      <span className="burn-mine" data-burn="mine">
        <ChatText text={text} className="text" />
        <span className="burn-tag" title={`Burn message (${burn.ttlSec}s after viewing). ${BURN_HINT}`}>🔥 {burn.ttlSec}s</span>
      </span>
    );
  }
  if (state === 'covered' || state === 'loading') {
    const reveal = async () => {
      setState('loading');
      try {
        const r = await call<{ text: string; ttlSec: number; firstAt: number; expiresAt: number; serverNow: number }>((ack) => socket.emit('chat:reveal', { messageId: id }, ack));
        const skew = Date.now() - r.serverNow;
        setState({ text: r.text, endsAt: r.expiresAt + skew, totalMs: Math.max(1, r.expiresAt - r.firstAt) });
      } catch (e) {
        const msg = (e as Error).message;
        if (/burn/i.test(msg)) done();
        else { setState('covered'); toast(msg, 'error'); }
      }
    };
    return (
      <button type="button" className="burn-cover" data-burn="covered" data-action="burn-reveal" title={BURN_HINT} disabled={state === 'loading'} onClick={reveal}>
        <span className="burn-blur" aria-hidden="true">████████ ██████ ████</span>
        <span className="burn-cover-label">🔥 Tap to reveal</span>
      </button>
    );
  }
  return (
    <span className="burn-open" data-burn="revealed">
      <ChatText text={state.text} className="text" />
      <Ring endsAt={state.endsAt} totalMs={state.totalMs} onDone={done} />
    </span>
  );
}

function useCallbackStable<T extends () => void>(fn: T): () => void {
  const [ref] = useState(() => ({ fn }));
  ref.fn = fn;
  const [stable] = useState(() => () => ref.fn());
  return stable;
}
