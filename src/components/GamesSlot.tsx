import { useEffect, useRef } from 'react';
import { Icon } from '../icons';

/** Light entry points for the games dock. The dock itself loads on first open. */
export function GamesButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="more-item" data-action="games" title="Games" aria-label="Games" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
      <Icon name="games" />
      <span>Games</span>
    </button>
  );
}

/** Where a docked games panel should render. One slot is active at a time. */
const slotListeners = new Set<(el: HTMLElement | null) => void>();
let slotEl: HTMLElement | null = null;

export function subscribeGamesSlot(listen: (el: HTMLElement | null) => void): () => void {
  slotListeners.add(listen);
  listen(slotEl);
  return () => { slotListeners.delete(listen); };
}

export function GamesSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    slotEl = el;
    slotListeners.forEach((l) => l(el));
    return () => {
      if (slotEl === el) {
        slotEl = null;
        slotListeners.forEach((l) => l(null));
      }
    };
  }, []);
  return <div ref={ref} className="games-slot" />;
}
