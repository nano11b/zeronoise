import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';

/**
 * Escape layers, innermost last: menus, pickers, drawers and modals all register here, and one Escape
 * closes only the top one (a picker inside a menu closes before the menu). Modals also trap Tab.
 */
type Layer = { close: () => void; trap?: HTMLElement };
const layers: Layer[] = [];
let listening = false;

function visible(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest('[hidden],[inert]')) return false;
  return el.getClientRects().length > 0;
}

function onKey(e: KeyboardEvent) {
  const top = layers[layers.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    if (e.defaultPrevented) return; // a control inside handled it (e.g. the voice recorder)
    e.preventDefault();
    e.stopPropagation();
    top.close();
    return;
  }
  const el = top.trap;
  if (e.key !== 'Tab' || !el) return;
  const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
  if (!items.length) { e.preventDefault(); el.focus(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const a = document.activeElement;
  if (e.shiftKey && (a === first || !el.contains(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (a === last || !el.contains(a))) { e.preventDefault(); first.focus(); }
}

function push(layer: Layer): () => void {
  layers.push(layer);
  if (!listening) { document.addEventListener('keydown', onKey); listening = true; }
  return () => {
    const i = layers.lastIndexOf(layer);
    if (i >= 0) layers.splice(i, 1);
  };
}

/** Remember what had focus (and the menu button around it) so focus can go back after a close. */
export function captureOpener(): () => void {
  const a = document.activeElement;
  const opener = a instanceof HTMLElement && a !== document.body ? a : null;
  // Resolve a fallback now: an item in a menu that closes on click is gone by the time we restore.
  let fallback: HTMLElement | null = null;
  for (let p = opener?.parentElement ?? null; p && p !== document.body && !fallback; p = p.parentElement) {
    const btn = p.querySelector<HTMLElement>('[aria-haspopup], [aria-expanded]');
    if (btn && btn !== opener && !btn.closest('[role="menu"]')) fallback = btn;
  }
  return () => {
    const cur = document.activeElement;
    // Only pull focus back if it was left nowhere useful (body, or inside what just closed).
    if (cur && cur !== document.body && cur.isConnected && visible(cur as HTMLElement)) return;
    const t = opener && visible(opener) ? opener : fallback && visible(fallback) ? fallback : null;
    t?.focus({ preventScroll: true });
  };
}

/**
 * Modal behaviour for a dialog element: focus moves inside on open, Tab stays inside,
 * Escape calls onClose, and focus returns to whatever opened it.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void, active = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const restore = captureOpener();
    const pop = push({ close: () => closeRef.current(), trap: el });
    const raf = requestAnimationFrame(() => {
      if (el.contains(document.activeElement)) return; // autoFocus already placed it
      const first = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible);
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      (first ?? el).focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      pop();
      setTimeout(restore, 0); // after React commits the close
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/**
 * Escape closes a menu, picker, popover or drawer while it is open. Focus returns to `trigger`
 * (or to whatever opened it) when it had moved inside or was lost.
 */
export function useEscape(open: boolean, close: () => void, trigger?: RefObject<HTMLElement | null> | (() => HTMLElement | null | undefined)) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const trigRef = useRef(trigger);
  trigRef.current = trigger;
  useEffect(() => {
    if (!open) return;
    const restore = captureOpener();
    const pop = push({
      close: () => {
        const t = trigRef.current;
        const el = typeof t === 'function' ? t() : t?.current;
        closeRef.current();
        setTimeout(() => {
          if (el && visible(el)) el.focus({ preventScroll: true });
          else restore();
        }, 0);
      },
    });
    return pop;
  }, [open]);
}
