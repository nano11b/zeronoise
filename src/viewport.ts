/**
 * On-screen keyboard handling for phones. iOS keeps the layout viewport (and 100dvh) at full height
 * while the keyboard covers the bottom, so the composer can end up hidden. We follow visualViewport:
 * --vvh is the visible height, and html.kb-open is set while a keyboard is up, so the app shrinks to
 * the visible area and the bottom media bar steps aside until typing is done.
 */
export function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let raf = 0;
  let base = window.innerHeight;
  const apply = () => {
    raf = 0;
    const h = Math.round(vv.height);
    if (!root.classList.contains('kb-open')) base = Math.max(window.innerHeight, h);
    const editing = (() => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
    })();
    const kb = editing && base - h > 120 && window.matchMedia('(pointer: coarse)').matches;
    root.style.setProperty('--vvh', `${h}px`);
    root.classList.toggle('kb-open', kb);
    if (kb) {
      // iOS scrolls the whole page up to reveal the field; pin it back so the shrunken app fits exactly.
      if (vv.offsetTop > 0) window.scrollTo(0, 0);
      const a = document.activeElement as HTMLElement | null;
      a?.scrollIntoView?.({ block: 'nearest' });
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('focusin', schedule);
  window.addEventListener('focusout', () => setTimeout(schedule, 50));
  apply();
}
