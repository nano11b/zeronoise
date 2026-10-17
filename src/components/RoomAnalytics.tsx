import { useEffect, useMemo, useState } from 'react';
import type { RoomAnalytics as RA } from '../../shared/types';
import { api } from '../api';
import { call, socket } from '../socket';

/** Batch F8: members, peak times and growth for room owners (and room mods). */
const pct = (n: number | null) => (n == null ? 'new' : `${n > 0 ? '+' : ''}${n}%`);
export function RoomAnalyticsSection({ range }: { range: 7 | 30 }) {
  const [a, setA] = useState<RA | null>(null);
  const [err, setErr] = useState('');
  const [mine, setMine] = useState<{ id: string; name: string; active7: number; growthPct: number | null; new7: number; peak: number; members: number }[] | null>(null);
  useEffect(() => {
    call<{ analytics: RA }>((ack) => socket.emit('stats:analytics', ack)).then((r) => setA(r.analytics), (e: Error) => setErr(e.message));
    api<{ rooms: NonNullable<typeof mine> }>('/api/me/rooms/analytics').then((r) => setMine(r.rooms), () => {});
  }, []);
  const v = useMemo(() => {
    if (!a) return null;
    const days = a.days.slice(-range);
    const maxA = Math.max(1, ...days.map((d) => d.active + d.guests));
    const maxN = Math.max(1, ...days.map((d) => d.newMembers));
    // peak times in the viewer's zone: shift UTC hours by the local offset
    const off = -new Date().getTimezoneOffset() / 60;
    const hours = Array.from({ length: 24 }, (_, h) => a.peakByHour[((h - off) % 24 + 24) % 24 | 0]);
    const maxH = Math.max(1, ...hours.map((h) => h?.[1] ?? 0));
    const best = hours.map((h, i) => [i, h?.[1] ?? 0] as const).sort((x, y) => y[1] - x[1]).filter((x) => x[1] > 0).slice(0, 3).map((x) => x[0]);
    return { days, maxA, maxN, hours, maxH, best };
  }, [a, range]);
  if (err) return <p className="muted small">{err}</p>;
  if (!a || !v) return <p className="muted small">Loading analytics…</p>;
  const t = a.totals;
  const label = (day: number) => { const d = new Date(day * 86_400_000); return range === 7 ? d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }) : String(d.getUTCDate()); };
  return (
    <section className="room-analytics" data-testid="room-analytics">
      <h4>Members &amp; growth</h4>
      <div className="stat-grid">
        <div className="stat" data-stat="active7"><b>{t.active7}</b><span>active members (7 days)</span></div>
        <div className={`stat ${t.growthPct != null && t.growthPct < 0 ? 'down' : 'up'}`} data-stat="growth"><b>{pct(t.growthPct)}</b><span>vs the week before ({t.activePrev7})</span></div>
        <div className="stat" data-stat="new7"><b>{t.new7}</b><span>new members (7 days)</span></div>
        <div className="stat" data-stat="returning7"><b>{t.returning7}</b><span>came back (7 days)</span></div>
      </div>
      <p className="muted small">{t.members} members have visited in total · {t.new30} new in 30 days · peak {t.peak30} online</p>
      <h5>Active members per day</h5>
      <div className={`day-bars n${range}`} data-testid="active-bars">
        {v.days.map((d, i) => (
          <span key={d.day} className="day-bar" title={`${label(d.day)}: ${d.active} members${d.guests ? ` + ${d.guests} guests` : ''}, ${d.chatters} chatted`}>
            <span className="bar" style={{ height: `${Math.round(((d.active + d.guests) / v.maxA) * 100)}%` }} />
            <span className="lbl">{range === 7 || i % 5 === 4 ? label(d.day) : ''}</span>
          </span>
        ))}
      </div>
      <h5>New members per day</h5>
      <div className={`day-bars n${range} new`} data-testid="new-bars">
        {v.days.map((d, i) => (
          <span key={d.day} className="day-bar" title={`${label(d.day)}: ${d.newMembers} new`}>
            <span className="bar" style={{ height: `${Math.round((d.newMembers / v.maxN) * 100)}%` }} />
            <span className="lbl">{range === 7 || i % 5 === 4 ? label(d.day) : ''}</span>
          </span>
        ))}
      </div>
      <h5>Peak times</h5>
      <p className="muted small">{v.best.length ? `Busiest: ${v.best.map((h) => `${h}:00`).join(', ')} (your time)` : 'Not enough visits yet.'}</p>
      <div className="hour-bars" data-testid="peak-hours" role="img" aria-label="Average people online by hour of day">
        {v.hours.map((h, i) => <span key={i} className="hour-bar" title={`${i}:00 · avg ${h?.[1] ?? 0}, max ${h?.[2] ?? 0}`}><span className="bar" style={{ height: `${Math.round(((h?.[1] ?? 0) / v.maxH) * 100)}%` }} /></span>)}
      </div>
      <div className="hour-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
      {mine && mine.length > 1 && (
        <>
          <h5>All your rooms</h5>
          <table className="rooms-growth" data-testid="rooms-growth">
            <thead><tr><th>Room</th><th>Active 7d</th><th>Growth</th><th>New</th><th>Peak</th></tr></thead>
            <tbody>{mine.map((r) => <tr key={r.id}><td>#{r.name}</td><td>{r.active7}</td><td>{pct(r.growthPct)}</td><td>{r.new7}</td><td>{r.peak}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </section>
  );
}
