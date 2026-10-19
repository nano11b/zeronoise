/** batch X: a short "What's new" note once after each update (only for people who used the app before it). */
import { useEffect, useState } from 'react';
import changelog from '../../shared/changelog.json';

const KEY = 'zn.seenUpdate';
const latest = [...changelog.entries].sort((a, b) => b.date.localeCompare(a.date))[0];

export function WhatsNewNotice() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!latest) return;
    try {
      const seen = localStorage.getItem(KEY);
      if (seen === latest.id) return;
      const returning = seen != null || Object.keys(localStorage).some((k) => k.startsWith('zn.') && k !== KEY);
      if (returning) setShow(true);
      else localStorage.setItem(KEY, latest.id); // first visit: nothing is "new" yet
    } catch { /* storage blocked */ }
  }, []);
  if (!show || !latest) return null;
  const close = () => { try { localStorage.setItem(KEY, latest.id); } catch { /* */ } setShow(false); };
  return (
    <div className="whats-new" role="status" data-testid="whats-new">
      <span className="whats-new-text"><strong>What's new:</strong> {latest.title}.</span>
      <a href={`/updates#${latest.id}`} onClick={close} data-action="whats-new-open">See all updates</a>
      <button type="button" className="btn ghost small-btn" onClick={close} data-action="whats-new-dismiss">Dismiss</button>
    </div>
  );
}
