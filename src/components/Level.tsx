/** XP levels (batch D): small level badge next to names, and the Level section of the Profile dialog. */
import { useEffect, useState } from 'react';
import { api } from '../api';

export function LevelBadge({ level }: { level?: number | null }) {
  if (!level) return null;
  const tier = level >= 20 ? 'gold' : level >= 10 ? 'silver' : level >= 5 ? 'bronze' : 'base';
  return <span className={`lvl-badge lvl-${tier}`} title={`Level ${level}`} aria-label={`Level ${level}`} data-level={level}>Lv {level}</span>;
}

type Xp = { xp: number; level: number; into: number; span: number; next: number; hidden: boolean; today: number; dailyCap: number; perMessage: number; cooldownSec: number };
export function LevelSection({ toast }: { toast: (t: string, tone?: 'error' | 'info') => void }) {
  const [x, setX] = useState<Xp | null>(null);
  useEffect(() => { api<Xp>('/api/me/xp').then(setX).catch(() => {}); }, []);
  if (!x) return null;
  const pct = Math.max(0, Math.min(100, Math.round((x.into / Math.max(1, x.span)) * 100)));
  return (
    <div className="profile-section" data-section="level">
      <div className="muted small">Level</div>
      <p className="lvl-row"><LevelBadge level={x.level} /> <b>{x.xp} XP</b> <span className="muted small">· {x.next - x.xp} XP to level {x.level + 1}</span></p>
      <div className="lvl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progress to the next level"><span style={{ width: `${pct}%` }} /></div>
      <p className="muted small">{x.perMessage} XP for chatting with others, at most every {x.cooldownSec}s (longer in slow-mode rooms), up to {x.dailyCap} XP a day. Repeats and talking alone earn nothing. Today: {x.today}/{x.dailyCap}.</p>
      <label className="push-toggle">
        <input type="checkbox" checked={x.hidden} data-action="xp-hide" onChange={(e) => {
          const hidden = e.currentTarget.checked;
          setX({ ...x, hidden });
          void api('/api/me/xp', { hidden }, 'PATCH').then(() => toast(hidden ? 'Your level is hidden' : 'Your level is shown'), (err: Error) => { setX({ ...x, hidden: !hidden }); toast(err.message, 'error'); });
        }} />
        <span>Hide my level from others</span>
      </label>
    </div>
  );
}
