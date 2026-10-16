import { useEffect, useState } from 'react';
import { api } from '../api';

interface Stats {
  windowDays: number;
  days: { day: number; users: number; guests: number; messages: number }[];
  rooms: { roomId: string; name: string; messages: number; visitors: number; peak: number }[];
  hours: { hour: number; messages: number; peak: number }[];
  totals: { users: number; messages: number; activeToday: number };
  live: { online: number; rooms: number };
}
const dayLabel = (ms: number) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;

/** Admin panel "Stats" tab: daily active users, busiest rooms, peak hours (in this browser's time zone). */
export function AdminStats({ onError }: { onError: (m: string) => void }) {
  const [days, setDays] = useState(14);
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    const tz = -new Date().getTimezoneOffset();
    api<Stats>(`/api/admin/stats?days=${days}&tz=${tz}`).then(setS, (e: Error) => onError(e.message));
  }, [days, onError]);
  if (!s) return <p className="muted">Loading…</p>;
  const maxDay = Math.max(1, ...s.days.map((d) => d.users + d.guests));
  const maxHour = Math.max(1, ...s.hours.map((h) => h.messages));
  const peakHour = s.hours.reduce((a, b) => (b.messages > a.messages ? b : a), s.hours[0]);
  return (
    <div className="admin-stats" data-testid="admin-stats">
      <div className="row-between">
        <div className="stat-cards">
          <div className="stat-card"><b data-stat="online">{s.live.online}</b><span>online now</span></div>
          <div className="stat-card"><b data-stat="active-today">{s.totals.activeToday}</b><span>active accounts today</span></div>
          <div className="stat-card"><b>{s.totals.messages}</b><span>messages, {s.windowDays} days</span></div>
          <div className="stat-card"><b>{s.totals.users}</b><span>accounts</span></div>
        </div>
        <label className="muted small">Window{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} data-field="stats-days">
            <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option>
          </select>
        </label>
      </div>
      <h3>Daily active users</h3>
      <div className="bars" role="img" aria-label="Daily active accounts and guests" data-chart="dau">
        {s.days.map((d) => (
          <div key={d.day} className="bar-col" title={`${dayLabel(d.day)}: ${d.users} accounts, ${d.guests} guest visits, ${d.messages} messages`}>
            <span className="bar-stack" style={{ height: `${((d.users + d.guests) / maxDay) * 100}%` }}>
              <span className="bar guest" style={{ flex: d.guests }} />
              <span className="bar user" style={{ flex: d.users }} />
            </span>
            <span className="bar-x">{dayLabel(d.day)}</span>
          </div>
        ))}
      </div>
      <p className="muted small"><span className="key user" /> accounts <span className="key guest" /> guest visits</p>
      <h3>Busiest rooms</h3>
      {s.rooms.length === 0 ? <p className="muted">No activity yet.</p> : (
        <table className="admin-table stats-rooms" data-table="busiest">
          <thead><tr><th>Room</th><th>Messages</th><th>Accounts</th><th>Peak online</th></tr></thead>
          <tbody>{s.rooms.map((r) => <tr key={r.roomId}><td>#{r.name}</td><td>{r.messages}</td><td>{r.visitors}</td><td>{r.peak}</td></tr>)}</tbody>
        </table>
      )}
      <h3>Peak hours <span className="muted small">(your time; busiest {hourLabel(peakHour.hour)})</span></h3>
      <div className="bars hours" role="img" aria-label="Messages by hour of day" data-chart="hours">
        {s.hours.map((h) => (
          <div key={h.hour} className={`bar-col${h.hour === peakHour.hour && h.messages ? ' peak' : ''}`} title={`${hourLabel(h.hour)}: ${h.messages} messages, peak ${h.peak} online`}>
            <span className="bar-stack" style={{ height: `${(h.messages / maxHour) * 100}%` }}><span className="bar user" style={{ flex: 1 }} /></span>
            <span className="bar-x">{h.hour % 3 === 0 ? hourLabel(h.hour) : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
