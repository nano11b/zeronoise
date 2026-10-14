import { useEffect, useState } from 'react';
import type { RadioNowPlaying } from '../../shared/types';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Compact Labs FM card: art, title, artist, listeners, progress (ticks locally between updates). */
export function NowPlayingCard({ np, here, compact, onOpen }: { np: RadioNowPlaying; here?: number; compact?: boolean; onOpen?: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  const elapsed = np.duration > 0 ? Math.min(np.duration, np.elapsed + Math.max(0, (now - np.serverNow) / 1000)) : 0;
  const pct = np.duration > 0 ? Math.round((elapsed / np.duration) * 100) : 0;
  const title = np.offline ? 'Station offline' : np.title || 'Live radio';
  const Tag = onOpen ? 'button' : 'div';
  return (
    <Tag className={`np-card${compact ? ' compact' : ''}${np.offline ? ' offline' : ''}`} data-now-playing="1" {...(onOpen ? { type: 'button' as const, onClick: onOpen, title: 'Open the radio' } : {})}>
      {np.artUrl && !np.offline ? <img className="np-art" src={np.artUrl} alt="" width={compact ? 34 : 48} height={compact ? 34 : 48} /> : <span className="np-art empty" aria-hidden>🎵</span>}
      <span className="np-meta">
        <span className="np-title" title={title}>{np.isLive && !np.offline ? '🔴 ' : ''}{title}</span>
        <span className="np-artist" title={np.artist}>{np.offline ? np.station : [np.artist, np.isLive && np.streamer ? `live: ${np.streamer}` : ''].filter(Boolean).join(' · ') || np.station}</span>
        {!np.offline && np.duration > 0 && (
          <span className="np-progress" aria-label={`${fmt(elapsed)} of ${fmt(np.duration)}`}>
            <span className="np-bar"><span style={{ width: `${pct}%` }} /></span>
            <span className="np-time">{fmt(elapsed)} / {fmt(np.duration)}</span>
          </span>
        )}
      </span>
      <span className="np-count" title="Listening on the station">🎧 {np.listeners}{here ? <span className="np-here" title="Listening in this room"> · {here} here</span> : null}</span>
    </Tag>
  );
}
