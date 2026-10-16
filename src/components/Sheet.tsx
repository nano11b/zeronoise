import { useEffect, useRef, type ReactNode } from 'react';
import { useModal } from '../a11y';

/**
 * Popup dialog: centred card on desktop, full-screen sheet on phones (CSS, <= 520px).
 * Esc, the close button, a backdrop click and the browser/phone Back button all close it; focus is trapped inside
 * and returns to the opener.
 */
export function Sheet({ title, name, onClose, children, wide }: { title: string; name: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    // drop the history entry this sheet added, so Back keeps working as before
    if ((history.state as { znSheet?: string } | null)?.znSheet === name) history.back();
    onClose();
  };
  useModal(ref, close);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    try { history.pushState({ ...(history.state ?? {}), znSheet: name }, ''); } catch { /* ignore */ }
    const onPop = () => { if (!closing.current) { closing.current = true; onClose(); } };
    window.addEventListener('popstate', onPop);
    return () => {
      alive.current = false;
      window.removeEventListener('popstate', onPop);
      // Unmounted without closing (e.g. "Create" moved into the new room and took the lobby with it):
      // drop our history entry too, so the next Back press is not wasted on a sheet that is gone.
      if (!closing.current) {
        window.setTimeout(() => {
          if (alive.current) return;
          if ((history.state as { znSheet?: string } | null)?.znSheet === name) history.back();
        }, 0);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-backdrop sheet-backdrop" onClick={close}>
      <div ref={ref} className={`modal panel sheet${wide ? ' sheet-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} data-sheet={name} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn sheet-close" aria-label={`Close ${title}`} data-action="sheet-close" onClick={close}>✕</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
