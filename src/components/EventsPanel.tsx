import { FormEvent, useState } from 'react';
import { EVENT_DESC_MAX, EVENT_TITLE_MAX, eventEnd, eventIcs, relativeTime } from '../../shared/events';
import type { RoomEventInfo } from '../../shared/types';
import { call, socket } from '../socket';
import { ChatText } from './ChatText';
import { UserAvatar } from './UserAvatar';

export const fmtEventTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export { EventBanner } from './EventBanner';

/** value for <input type="datetime-local"> in the viewer's own zone */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const DURATIONS = [0, 30, 60, 90, 120, 180, 240];

function EventForm({ initial, onDone, toast }: { initial?: RoomEventInfo; onDone: () => void; toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [when, setWhen] = useState(initial ? toLocalInput(initial.startsAt) : toLocalInput(Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000));
  const [duration, setDuration] = useState(initial?.durationMin ?? 0);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const startsAt = new Date(when).getTime(); // parsed in the creator's local zone, sent as UTC ms
    const body = { title: title.trim(), description: description.trim(), startsAt, durationMin: duration || null };
    setBusy(true);
    try {
      if (initial) await call((ack) => socket.emit('events:update', { id: initial.id, ...body }, ack));
      else await call((ack) => socket.emit('events:create', body, ack));
      toast(initial ? 'Event updated' : 'Event scheduled');
      onDone();
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <form className="event-form stack" onSubmit={submit} data-event-form={initial ? 'edit' : 'new'}>
      <input value={title} maxLength={EVENT_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. Movie night" aria-label="Event title" required data-field="title" />
      <textarea value={description} maxLength={EVENT_DESC_MAX} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional, **markdown** ok)" aria-label="Event description" rows={2} data-field="description" />
      <div className="event-form-row">
        <label className="small">Starts (your time)
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required aria-label="Start date and time" data-field="when" />
        </label>
        <label className="small">Duration
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label="Duration" data-field="duration">
            {DURATIONS.map((d) => <option key={d} value={d}>{d === 0 ? 'Not set' : d < 60 ? `${d} min` : `${d / 60} h`}</option>)}
          </select>
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={busy || !title.trim() || !when} data-action="event-save">{initial ? 'Save' : 'Schedule'}</button>
      </div>
    </form>
  );
}

function downloadIcs(ev: RoomEventInfo, roomName: string) {
  const url = `${location.origin}/`;
  const blob = new Blob([eventIcs(ev, roomName, url)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${ev.title.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'event'}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Events list for the room side panel: RSVP, .ics, and (owner / room mods / staff) schedule, edit, cancel. */
export function EventsPanel({ events, canManage, registered, roomName, toast }: {
  events: RoomEventInfo[]; canManage: boolean; registered: boolean; roomName: string;
  toast: (t: string, tone?: 'error' | 'info') => void;
}) {
  const [editing, setEditing] = useState<RoomEventInfo | 'new' | null>(null);
  const now = Date.now();
  const rsvp = async (ev: RoomEventInfo, status: 'going' | 'maybe' | 'no') => {
    try { await call((ack) => socket.emit('events:rsvp', { id: ev.id, status: ev.myRsvp === status ? null : status }, ack)); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const cancel = async (ev: RoomEventInfo) => {
    if (!window.confirm(`Cancel "${ev.title}"?`)) return;
    try { await call((ack) => socket.emit('events:cancel', { id: ev.id }, ack)); toast('Event cancelled'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="side-body events-side">
      <div className="events-panel" aria-label="Events">
        <div className="events-head">
          <h3>Events</h3>
          {canManage && !editing && <button type="button" className="btn small-btn primary" data-action="event-new" onClick={() => setEditing('new')}>+ Schedule</button>}
        </div>
        {editing && <EventForm initial={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} toast={toast} />}
        {events.length === 0 && !editing && <p className="muted">No upcoming events.{canManage ? ' Schedule one for this room.' : ''}</p>}
        <ul className="event-list">
          {events.map((ev) => {
            const live = ev.startsAt <= now && now < eventEnd(ev);
            return (
              <li key={ev.id} className={`event-item${live ? ' live' : ''}`} data-event={ev.id}>
                <div className="event-top">
                  <strong className="event-title">{ev.title}</strong>
                  <span className="muted small event-when" title={new Date(ev.startsAt).toString()}>
                    {fmtEventTime(ev.startsAt)}{ev.durationMin ? ` · ${ev.durationMin < 60 ? `${ev.durationMin} min` : `${ev.durationMin / 60} h`}` : ''} · {live ? 'happening now' : relativeTime(ev.startsAt, now)}
                  </span>
                </div>
                {ev.description && <ChatText text={ev.description} className="event-desc small" />}
                <div className="event-going">
                  <span className="event-avatars">
                    {ev.goingUsers.map((u) => <UserAvatar key={u.accountId} nick={u.nick} accountId={u.accountId} chatColor={u.chatColor} hasAvatar={u.hasAvatar} size={20} />)}
                  </span>
                  <span className="small" data-counts={`${ev.going}/${ev.maybe}/${ev.notGoing}`}>{ev.going} going · {ev.maybe} maybe · {ev.notGoing} not going</span>
                </div>
                <div className="event-actions">
                  {registered ? (
                    (['going', 'maybe', 'no'] as const).map((st) => (
                      <button key={st} type="button" className={`btn small-btn ${ev.myRsvp === st ? 'primary' : 'ghost'}`} aria-pressed={ev.myRsvp === st} data-rsvp={st} onClick={() => rsvp(ev, st)}>
                        {st === 'going' ? 'Going' : st === 'maybe' ? 'Maybe' : 'Not going'}
                      </button>
                    ))
                  ) : <span className="muted small">Sign in to RSVP.</span>}
                  <button type="button" className="btn small-btn ghost" data-action="event-ics" title="Add to calendar (.ics)" onClick={() => downloadIcs(ev, roomName)}>📅 .ics</button>
                  {canManage && <button type="button" className="btn small-btn ghost" data-action="event-edit" onClick={() => setEditing(ev)}>Edit</button>}
                  {canManage && <button type="button" className="btn small-btn ghost danger" data-action="event-cancel" onClick={() => cancel(ev)}>Cancel event</button>}
                </div>
                <div className="muted small">by {ev.createdBy}</div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
