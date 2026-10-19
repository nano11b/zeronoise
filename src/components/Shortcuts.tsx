import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';

const OFF_KEY = 'zn.singleKeyShortcutsOff';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};
const singleOff = () => { try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; } };

const GROUPS: { title: string; rows: [string[], string][] }[] = [
  { title: 'Anywhere', rows: [[['?'], 'Show this list'], [['/'], 'Jump to the message box'], [['Esc'], 'Close a menu, dialog or popup']] },
  { title: 'Message box', rows: [[['Enter'], 'Send'], [['/'], 'Start a command (/me, /shrug, /roll 2d6, /flip, room commands)'], [['Esc'], 'Close the open thread, panel or menu']] },
  { title: 'People and messages', rows: [[['Shift', 'F10'], 'Open the menu for the focused person'], [['Menu'], 'Same, with the context-menu key'], [['Tab'], 'Move between controls; menus keep focus inside']] },
];

/** batch MC2: '?' opens the keyboard shortcuts panel. Single-key shortcuts can be turned off (WCAG 2.1.4). */
export function ShortcutsHost() {
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState(singleOff);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || singleOff()) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]') && e.key !== '?') return;
      if (e.key === '?') { e.preventDefault(); setOpen((v) => !v); return; }
      if (e.key === '/') {
        const box = document.querySelector<HTMLInputElement>('input[aria-label="Chat message"]');
        if (box && box.offsetParent !== null) { e.preventDefault(); box.focus(); }
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('zn:shortcuts', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('zn:shortcuts', onOpen); };
  }, []);
  if (!open) return null;
  return (
    <Sheet name="shortcuts" title="Keyboard shortcuts" onClose={() => setOpen(false)}>
      <div className="shortcuts" data-testid="shortcuts">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <dl>
              {g.rows.map(([keys, what]) => (
                <div key={what} className="sc-row"><dt>{keys.map((k, i) => <span key={k}>{i > 0 && ' + '}<kbd>{k === 'Enter' && isMac ? 'Return' : k}</kbd></span>)}</dt><dd>{what}</dd></div>
              ))}
            </dl>
          </section>
        ))}
        <label className="small sc-off"><input type="checkbox" checked={off} data-field="single-key-off" onChange={(e) => { setOff(e.target.checked); try { localStorage.setItem(OFF_KEY, e.target.checked ? '1' : '0'); } catch { /* ignore */ } }} /> Turn off single-key shortcuts (? and /). You can still open this list from the Your profile menu.</label>
      </div>
    </Sheet>
  );
}
