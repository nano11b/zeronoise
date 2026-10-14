import { useEffect, type RefObject } from 'react';
import { useEscape } from './a11y';

/** Close when the pointer lands outside `wrap`, or when Esc is pressed (focus goes back to the wrap's toggle). */
export function useDismiss(open: boolean, wrap: RefObject<HTMLElement | null>, close: () => void) {
  useEscape(open, close, () => wrap.current?.querySelector<HTMLElement>('[aria-expanded], [aria-haspopup]'));
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Node && wrap.current?.contains(t)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, wrap, close]);
}

/** Keep an absolutely positioned panel under its anchor and inside the viewport. */
export function placeBelow(anchor: HTMLElement, panel: HTMLElement) {
  const pad = 8;
  const a = anchor.getBoundingClientRect();
  const maxW = Math.min(360, window.innerWidth - pad * 2);
  panel.style.width = `${maxW}px`;
  const w = panel.offsetWidth || maxW;
  let viewLeft = a.left;
  if (viewLeft + w > window.innerWidth - pad) viewLeft = window.innerWidth - pad - w;
  if (viewLeft < pad) viewLeft = pad;
  panel.style.left = `${viewLeft - a.left}px`;
  const room = Math.max(160, window.innerHeight - a.bottom - pad - 6);
  panel.style.maxHeight = `${room}px`;
}

/**
 * Pin a panel to the viewport. Right-align it with the anchor, then clamp it
 * inside the screen. Fixed positioning does not widen the page the way an
 * absolute panel hanging off a right-edge chip does.
 */
export function placeFixedBelow(anchor: HTMLElement, panel: HTMLElement) {
  const pad = 8;
  const a = anchor.getBoundingClientRect();
  const maxW = Math.min(360, Math.max(0, window.innerWidth - pad * 2));
  panel.style.position = 'fixed';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.margin = '0';
  panel.style.width = `${maxW}px`;
  panel.style.maxWidth = `${maxW}px`;
  const w = Math.min(maxW, panel.getBoundingClientRect().width || maxW);
  let viewLeft = a.right - w;
  if (viewLeft + w > window.innerWidth - pad) viewLeft = window.innerWidth - pad - w;
  if (viewLeft < pad) viewLeft = pad;
  panel.style.left = `${viewLeft}px`;
  const top = Math.min(Math.max(pad, a.bottom + 6), Math.max(pad, window.innerHeight - pad));
  panel.style.top = `${top}px`;
  panel.style.maxHeight = `${Math.max(120, window.innerHeight - top - pad)}px`;
}
