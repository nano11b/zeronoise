import { useEffect, useState } from 'react';
import { BADGES, BADGE_SHOW_MAX, badgeById } from '../../shared/badges';
import type { BadgesResponse } from '../../shared/types';
import { api } from '../api';

export function clientTimeZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

export const badgeLabel = (id: string) => { const b = badgeById(id); return b ? `${b.emoji} ${b.name}` : id; };

/** Small emoji row after a name; tooltip = name + description. */
export function BadgeIcons({ ids, className = '' }: { ids?: string[]; className?: string }) {
  const list = (ids ?? []).map(badgeById).filter((b): b is NonNullable<typeof b> => !!b).slice(0, BADGE_SHOW_MAX);
  if (!list.length) return null;
  return (
    <span className={`badge-icons ${className}`} data-badges={list.map((b) => b.id).join(',')}>
      {list.map((b) => (
        <span key={b.id} className="badge-icon" title={`${b.name}: ${b.description}`} aria-label={`${b.name}: ${b.description}`} role="img">{b.emoji}</span>
      ))}
    </span>
  );
}

/** Profile card line: emoji + name for each shown badge. */
export function BadgeCard({ ids }: { ids?: string[] }) {
  const list = (ids ?? []).map(badgeById).filter((b): b is NonNullable<typeof b> => !!b);
  if (!list.length) return null;
  return (
    <div className="badge-card" data-badge-card="1">
      {list.map((b) => <span key={b.id} className="badge-chip" title={b.description}>{b.emoji} {b.name}</span>)}
    </div>
  );
}

function progressText(id: string, data: BadgesResponse): string {
  const b = badgeById(id);
  if (!b?.stat) return '';
  const have = data.stats[b.stat] ?? 0;
  const need = data.thresholds[id] ?? b.threshold ?? 1;
  if (b.unit === 'minutes') return `${Math.min(Math.floor(have / 60), Math.ceil(need / 60))}/${Math.ceil(need / 60)} min`;
  return `${Math.min(have, need)}/${need}`;
}

/** Profile settings: every badge (earned colored, locked grey with progress) + pick up to 3 to show. */
export function BadgesSection({ toast }: { toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [data, setData] = useState<BadgesResponse | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<BadgesResponse>('/api/me/badges').then(setData).catch((e) => toast((e as Error).message, 'error')); }, []);
  if (!data) return <div className="profile-section"><div className="muted small">Badges</div><p className="muted small">Loading…</p></div>;
  const earned = new Map(data.earned.map((e) => [e.id, e.earnedAt]));
  const save = async (shown: string[] | null) => {
    setBusy(true);
    try { setData(await api<BadgesResponse>('/api/me/badges', { shown }, 'PATCH')); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const toggle = (id: string) => {
    const cur = data.shown;
    if (cur.includes(id)) return save(cur.filter((x) => x !== id));
    if (cur.length >= BADGE_SHOW_MAX) { toast(`Show at most ${BADGE_SHOW_MAX} badges. Unpick one first.`, 'error'); return; }
    return save([...cur, id]);
  };
  return (
    <div className="profile-section badges-section" data-section="badges">
      <div className="muted small">Badges <span className="muted">({data.earned.length}/{BADGES.length})</span></div>
      <p className="muted small">Just for fun. Pick up to {BADGE_SHOW_MAX} to show next to your name{data.chosen ? '' : ' (now: your 3 most recent)'}.
        {data.chosen && <> <button type="button" className="linkish" disabled={busy} onClick={() => save(null)} data-action="badges-auto">Use most recent</button></>}
      </p>
      <ul className="badge-grid">
        {BADGES.map((b) => {
          const has = earned.has(b.id);
          const showing = data.shown.includes(b.id);
          return (
            <li key={b.id} className={`badge-tile ${has ? 'earned' : 'locked'}${showing ? ' showing' : ''}`} data-badge={b.id} title={b.description}>
              <span className="badge-emoji" aria-hidden="true">{b.emoji}</span>
              <span className="badge-text">
                <strong>{b.name}</strong>
                <span className="muted small">{b.description}</span>
                {!has && b.stat && <span className="badge-progress small" data-progress={progressText(b.id, data)}>{progressText(b.id, data)}</span>}
              </span>
              {has && (
                <label className="badge-show small">
                  <input type="checkbox" checked={showing} disabled={busy} onChange={() => toggle(b.id)} data-action="badge-show" /> Show
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
