/** Batch 3 room UI: category/tags, announcement banner + editor, scheduled messages, emotes, stats. */
import { RoomAnalyticsSection } from './RoomAnalytics';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ANNOUNCE_MAX, CATEGORY_ICON, CATEGORY_LABEL, EMOTE_MAX_BYTES, EMOTE_NAME_RE, EMOTES_PER_ROOM, isRoomCategory, ROOM_CATEGORIES,
  SCHEDULE_TEXT_MAX, SCHEDULES_PER_ROOM, TAGS_MAX, cleanTags,
} from '../../shared/batch3';
import type { RoomAnnouncement, RoomEmote, RoomScheduleInfo, RoomStats, RoomStatsWindow } from '../../shared/types';
import { api, storedDeviceId } from '../api';
import { call, socket } from '../socket';
import { FILTER_DOMAINS_MAX, FILTER_WORDS_MAX, type LinkMode, type RoomFilters } from '../../shared/filters';

type Toast = (t: string, tone?: 'error' | 'info') => void;

// Category + tags display lives in RoomMeta (light, used by the lobby).
export { CategorySelect, CategoryTag, TagList } from './RoomMeta';
import { CategorySelect, TagList } from './RoomMeta';

export function RoomMetaEditor({ category, tags, toast }: { category: string | null; tags: string[]; toast: Toast }) {
  const [cat, setCat] = useState(category ?? '');
  const [tagText, setTagText] = useState(tags.join(', '));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCat(category ?? ''); setTagText(tags.join(', ')); }, [category, tags]);
  const parsed = cleanTags(tagText);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if ('error' in parsed) return toast(parsed.error, 'error');
    setBusy(true);
    try { await call((ack) => socket.emit('room:meta', { category: cat || null, tags: parsed.tags }, ack)); toast('Category and tags saved'); }
    catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <form className="stack manage-form" onSubmit={save} data-form="room-meta">
      <CategorySelect value={cat} onChange={setCat} />
      <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder={`Tags, comma separated (up to ${TAGS_MAX})`} maxLength={140} aria-label="Tags" data-field="room-tags" />
      {'error' in parsed ? <p className="muted small error-text">{parsed.error}</p> : parsed.tags.length > 0 && <p className="muted small"><TagList tags={parsed.tags} /></p>}
      <button className="btn small-btn" disabled={busy} data-action="save-room-meta">Save</button>
    </form>
  );
}

// ---------------- announcement ----------------
export { AnnouncementBanner } from './AnnouncementBanner';
export function AnnouncementEditor({ ann, toast }: { ann: RoomAnnouncement | null; toast: Toast }) {
  const [text, setText] = useState(ann?.text ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(ann?.text ?? ''); }, [ann]);
  const set = async (value: string) => {
    setBusy(true);
    try { await call((ack) => socket.emit('announce:set', { text: value }, ack)); toast(value ? 'Announcement updated' : 'Announcement removed'); }
    catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <form className="stack manage-form" onSubmit={(e) => { e.preventDefault(); void set(text.trim()); }} data-form="announcement">
      <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={ANNOUNCE_MAX} rows={3} placeholder="Banner shown above the chat. **bold**, _italic_, links work." aria-label="Announcement" data-field="announcement" />
      <div className="row-between"><span className="muted small">{text.length}/{ANNOUNCE_MAX}{ann ? ` · by ${ann.by}` : ''}</span>
        <span className="btn-row">
          {ann && <button type="button" className="btn ghost small-btn" disabled={busy} onClick={() => void set('')} data-action="clear-announcement">Remove</button>}
          <button className="btn small-btn" disabled={busy || !text.trim()} data-action="save-announcement">Post banner</button>
        </span>
      </div>
    </form>
  );
}

// ---------------- scheduled messages ----------------
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fmtWhen = (ts: number) => new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function SchedulePanel({ schedules, toast }: { schedules: RoomScheduleInfo[]; toast: Toast }) {
  const [text, setText] = useState('');
  const [when, setWhen] = useState(() => toLocalInput(Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000));
  const [repeat, setRepeat] = useState<'once' | 'daily' | 'weekly'>('once');
  const [kind, setKind] = useState<'message' | 'banner' | 'poll'>('message');
  const [pollOpts, setPollOpts] = useState('');
  const optList = pollOpts.split(/\n|\|/).map((o) => o.trim()).filter(Boolean);
  const [busy, setBusy] = useState(false);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const at = new Date(when).getTime();
    if (!Number.isFinite(at)) return toast('Pick a date and time', 'error');
    setBusy(true);
    try {
      await call((ack) => socket.emit('schedule:create', { text: text.trim(), at, repeat, kind, ...(kind === 'poll' ? { poll: { options: optList, durationMin: 60 } } : {}), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, ack));
      setText(''); setPollOpts('');
      toast(`${kind === 'banner' ? 'Banner' : kind === 'poll' ? 'Poll' : 'Announcement'} ${repeat === 'once' ? 'scheduled' : `repeats ${repeat}`}`);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await call((ack) => socket.emit('schedule:delete', { id }, ack)); } catch (err) { toast((err as Error).message, 'error'); }
  };
  return (
    <div className="schedules" data-schedules={schedules.length}>
      {schedules.length === 0 ? <p className="muted small">Nothing scheduled.</p> : (
        <ul className="sched-list">
          {schedules.map((s) => (
            <li key={s.id} className="sched-row" data-schedule={s.id}>
              <span className="sched-main">
                <span className="sched-when">{s.repeat === 'once' ? '⏰' : '🔁'} {fmtWhen(s.nextAt)}{s.repeat !== 'once' ? ` · ${s.repeat}` : ''} · <span data-schedule-kind={s.kind ?? 'message'}>{s.kind === 'banner' ? 'banner' : s.kind === 'poll' ? `📊 poll (${s.poll?.options.length ?? 0} options)` : 'chat'}</span></span>
                <span className="sched-text" title={s.text}>{s.text}</span>
                <span className="muted small">by {s.by}</span>
              </span>
              <button type="button" className="icon-btn" aria-label="Delete scheduled message" title="Delete" data-action="delete-schedule" onClick={() => void remove(s.id)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {schedules.length < SCHEDULES_PER_ROOM && (
        <form className="stack manage-form" onSubmit={add} data-form="schedule">
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={SCHEDULE_TEXT_MAX} rows={2} required placeholder={kind === 'poll' ? 'Poll question' : 'Message to post as a room announcement'} aria-label="Scheduled message" data-field="schedule-text" />
          {kind === 'poll' && <textarea value={pollOpts} onChange={(e) => setPollOpts(e.target.value)} rows={3} placeholder={'Options, one per line\nYes\nNo'} aria-label="Poll options" data-field="schedule-poll-options" />}
          <div className="sched-inputs">
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required aria-label="When" data-field="schedule-when" />
            <select value={repeat} onChange={(e) => setRepeat(e.target.value as 'once' | 'daily' | 'weekly')} aria-label="Repeat" data-field="schedule-repeat">
              <option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
            </select>
            <select value={kind} onChange={(e) => setKind(e.target.value as 'message' | 'banner' | 'poll')} aria-label="Post as" data-field="schedule-kind">
              <option value="message">Post in chat</option><option value="banner">Set the banner</option><option value="poll">Post a poll (closes in 1 h)</option>
            </select>
          </div>
          <button className="btn small-btn" disabled={busy || !text.trim() || (kind === 'poll' && optList.length < 2)} data-action="add-schedule">Schedule</button>
        </form>
      )}
    </div>
  );
}

// ---------------- emotes ----------------
export function EmoteManager({ roomId, emotes, toast }: { roomId: string; emotes: RoomEmote[]; toast: Toast }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const nm = name.trim().toLowerCase().replace(/^:+|:+$/g, '');
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return toast('Choose an image', 'error');
    if (!EMOTE_NAME_RE.test(nm)) return toast('Names are 2-24 characters: a-z, 0-9 and _', 'error');
    if (file.size > EMOTE_MAX_BYTES) return toast('Image too large (max 512 KB)', 'error');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('name', nm);
      fd.append('emote', file);
      const headers: Record<string, string> = { 'X-CSRF': '1' };
      const dev = storedDeviceId();
      if (dev) headers['X-Device-Id'] = dev;
      const r = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/emotes`, { method: 'POST', headers, credentials: 'same-origin', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data?.ok === false) throw new Error(data?.error || 'Upload failed');
      setName(''); setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      toast(`:${nm}: added`);
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    try { await api(`/api/rooms/${encodeURIComponent(roomId)}/emotes/${renaming.id}`, { name: renaming.name }, 'PATCH'); setRenaming(null); }
    catch (err) { toast((err as Error).message, 'error'); }
  };
  const remove = async (id: string) => {
    try { await api(`/api/rooms/${encodeURIComponent(roomId)}/emotes/${id}`, undefined, 'DELETE'); } catch (err) { toast((err as Error).message, 'error'); }
  };
  return (
    <div className="emote-manage" data-emotes={emotes.length}>
      {emotes.length > 0 && (
        <ul className="emote-list">
          {emotes.map((e) => (
            <li key={e.id} className="emote-row" data-emote={e.name}>
              <img src={e.url} alt="" width={28} height={28} loading="lazy" />
              {renaming?.id === e.id ? (
                <form className="emote-rename" onSubmit={rename}>
                  <input autoFocus value={renaming.name} maxLength={24} onChange={(ev) => setRenaming({ id: e.id, name: ev.target.value.toLowerCase() })} aria-label="New name" data-field="emote-rename" />
                  <button className="btn small-btn">Save</button>
                </form>
              ) : (
                <>
                  <code className="emote-name">:{e.name}:</code>
                  <button type="button" className="icon-btn" title="Rename" aria-label={`Rename :${e.name}:`} data-action="rename-emote" onClick={() => setRenaming({ id: e.id, name: e.name })}>✎</button>
                  <button type="button" className="icon-btn" title="Delete" aria-label={`Delete :${e.name}:`} data-action="delete-emote" onClick={() => void remove(e.id)}>✕</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {emotes.length < EMOTES_PER_ROOM ? (
        <form className="stack manage-form" onSubmit={upload} data-form="emote">
          <div className="emote-inputs">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={26} placeholder="name (a-z, 0-9, _)" aria-label="Emote name" data-field="emote-name" />
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-field="emote-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button type="button" className="btn ghost small-btn" onClick={() => fileRef.current?.click()} data-action="emote-pick">{file ? 'Change image' : 'Image…'}</button>
          </div>
          {file && <span className="muted small file-name" title={file.name}>{file.name}</span>}
          <button className="btn small-btn" disabled={busy || !file || !nm} data-action="emote-upload">Add emote</button>
          <p className="muted small">PNG, JPEG, WebP or GIF up to 512 KB; shown at up to 128 px. GIFs stay animated. {emotes.length}/{EMOTES_PER_ROOM}</p>
        </form>
      ) : <p className="muted small">This room has {EMOTES_PER_ROOM} emotes (the maximum).</p>}
    </div>
  );
}

// ---------------- stats ----------------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function StatsPanel({ roomName, toast }: { roomName: string; toast: Toast }) {
  const [stats, setStats] = useState<RoomStats | null>(null);
  const [range, setRange] = useState<7 | 30>(7);
  const load = async () => {
    try { setStats((await call<{ stats: RoomStats }>((ack) => socket.emit('stats:get', ack))).stats); }
    catch (err) { toast((err as Error).message, 'error'); }
  };
  useEffect(() => { void load(); /* once per open */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const view = useMemo(() => {
    if (!stats) return null;
    const win: RoomStatsWindow = range === 7 ? stats.d7 : stats.d30;
    // local calendar days, newest last
    const today = new Date(stats.serverNow); today.setHours(0, 0, 0, 0);
    const days: { label: string; key: string; n: number }[] = [];
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      days.push({ key: d.toDateString(), label: range === 7 ? DAYS[d.getDay()] : String(d.getDate()), n: 0 });
    }
    const byKey = new Map(days.map((d) => [d.key, d]));
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    const from = today.getTime() - (range - 1) * 86_400_000;
    for (const [h, m] of stats.hours) {
      const t = h * 3_600_000;
      if (t < from) continue;
      const d = new Date(t);
      const k = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toDateString();
      const slot = byKey.get(k);
      if (slot) slot.n += m;
      heat[d.getDay()][d.getHours()] += m;
    }
    const maxDay = Math.max(1, ...days.map((d) => d.n));
    const maxHeat = Math.max(1, ...heat.flat());
    return { win, days, maxDay, heat, maxHeat };
  }, [stats, range]);
  return (
    <div className="side-body stats-side" data-panel="stats">
      <div className="row-between"><h3>Stats</h3>
        <span className="seg" role="group" aria-label="Range">
          <button type="button" className={range === 7 ? 'on' : ''} aria-pressed={range === 7} onClick={() => setRange(7)} data-action="stats-7">7 days</button>
          <button type="button" className={range === 30 ? 'on' : ''} aria-pressed={range === 30} onClick={() => setRange(30)} data-action="stats-30">30 days</button>
        </span>
      </div>
      <p className="muted small">#{roomName} · times in your local zone</p>
      {!view ? <p className="muted">Loading…</p> : (
        <>
          <div className="stat-grid">
            <div className="stat" data-stat="peak"><b>{view.win.peak}</b><span>peak online</span></div>
            <div className="stat" data-stat="visitors"><b>{view.win.visitors}</b><span>visitors</span></div>
            <div className="stat" data-stat="messages"><b>{view.win.messages}</b><span>messages</span></div>
          </div>
          <p className="muted small">{view.win.registered} registered{view.win.guests ? ` + ${view.win.guests} guest visits` : ''}</p>
          <h4>Messages per day</h4>
          <div className={`day-bars n${range}`} data-day-bars={view.days.length}>
            {view.days.map((d) => (
              <span key={d.key} className="day-bar" title={`${d.key}: ${d.n}`}>
                <span className="bar" style={{ height: `${Math.round((d.n / view.maxDay) * 100)}%` }} />
                <span className="lbl">{range === 7 || view.days.indexOf(d) % 5 === 4 ? d.label : ''}</span>
              </span>
            ))}
          </div>
          <h4>Busiest hours</h4>
          <div className="heatmap" role="img" aria-label="Messages by weekday and hour">
            {view.heat.map((row, di) => (
              <div key={di} className="heat-row">
                <span className="heat-day">{DAYS[di].slice(0, 2)}</span>
                {row.map((n, h) => <span key={h} className="heat-cell" title={`${DAYS[di]} ${h}:00 · ${n}`} style={{ opacity: n ? 0.18 + 0.82 * (n / view.maxHeat) : 0.06 }} />)}
              </div>
            ))}
            <div className="heat-row heat-axis"><span className="heat-day" />{[0, 6, 12, 18].map((h) => <span key={h} className="heat-tick" style={{ gridColumn: `${h + 2} / span 6` }}>{h}</span>)}</div>
          </div>
          <RoomAnalyticsSection range={range} />
          <h4>Top chatters</h4>
          {view.win.top.length === 0 ? <p className="muted small">No messages from registered users yet.</p> : (
            <ol className="top-list">
              {view.win.top.map((t) => <li key={t.username}><span className="top-name">{t.username}</span><span className="muted">{t.messages}</span></li>)}
            </ol>
          )}
          <button type="button" className="btn ghost small-btn" onClick={() => void load()} data-action="stats-refresh">Refresh</button>
        </>
      )}
    </div>
  );
}

// ---------------- word / link filters (enforced by the moderator bot) ----------------
export function FiltersPanel({ toast }: { toast: Toast }) {
  const [f, setF] = useState<RoomFilters | null>(null);
  const [bot, setBot] = useState('Meowington');
  const [words, setWords] = useState('');
  const [links, setLinks] = useState<LinkMode>('off');
  const [allow, setAllow] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call<{ filters: RoomFilters; bot: string }>((ack) => socket.emit('room:filters:get', ack)).then((r) => {
      setF(r.filters); setBot(r.bot); setWords(r.filters.words.join(', ')); setLinks(r.filters.links); setAllow(r.filters.allow.join(', '));
    }, (e: Error) => toast(e.message, 'error'));
  }, [toast]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await call<{ filters: RoomFilters }>((ack) => socket.emit('room:filters:set', { words, links, allow }, ack));
      setF(r.filters); setWords(r.filters.words.join(', ')); setAllow(r.filters.allow.join(', '));
      toast('Filters saved');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  if (!f) return <p className="muted small">Loading…</p>;
  return (
    <form className="stack manage-form" onSubmit={save} data-form="room-filters">
      <p className="muted small">{bot} blocks matching lines before they post and files them in this room&apos;s reports. You and room mods are not filtered.</p>
      <label className="muted small" htmlFor="flt-words">Blocked words or phrases (comma separated, up to {FILTER_WORDS_MAX})</label>
      <textarea id="flt-words" value={words} onChange={(e) => setWords(e.target.value)} rows={2} maxLength={4200} placeholder="e.g. spoiler, buy followers" data-field="filter-words" />
      <label className="muted small" htmlFor="flt-links">Links</label>
      <select id="flt-links" value={links} onChange={(e) => setLinks(e.target.value as LinkMode)} data-field="filter-links">
        <option value="off">Allow all links</option>
        <option value="block">Block all links</option>
        <option value="allowlist">Only allow these sites</option>
      </select>
      {links === 'allowlist' && (
        <input value={allow} onChange={(e) => setAllow(e.target.value)} placeholder={`youtube.com, x.com (up to ${FILTER_DOMAINS_MAX})`} aria-label="Allowed sites" data-field="filter-allow" />
      )}
      <button className="btn small-btn" disabled={busy} data-action="save-filters">Save filters</button>
    </form>
  );
}
