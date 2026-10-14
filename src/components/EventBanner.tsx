/** Next-event line above chat. Apart from EventsPanel so the panel can load on demand. */
import type { RoomEventInfo } from '../../shared/types';

const fmtShort = (ts: number) => new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Pinned line above chat for the next event within 24 h. */
export function EventBanner({ ev, onOpen }: { ev: RoomEventInfo; onOpen: () => void }) {
  const live = ev.startsAt <= Date.now();
  return (
    <button type="button" className="event-banner" data-event-banner={ev.id} onClick={onOpen} title="Open events">
      <span className="event-banner-text">📅 {ev.title} · {live ? 'happening now' : fmtShort(ev.startsAt)} · {ev.going} going</span>
      <span className="event-banner-link">Details</span>
    </button>
  );
}

