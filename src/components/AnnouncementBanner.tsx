/** Room announcement banner. Apart from RoomManage so the editors can load on demand. */
import { useMemo, useState } from 'react';
import { APP_NAME } from '../../shared/config';
import type { RoomAnnouncement } from '../../shared/types';
import { renderBioMarkdown } from '../markdown';

const annKey = (roomId: string) => `${APP_NAME.toLowerCase()}.ann.${roomId}`;
/** Dismissible per user until the announcement changes (keyed by its timestamp). */
export function AnnouncementBanner({ roomId, ann }: { roomId: string; ann: RoomAnnouncement | null }) {
  const [dismissed, setDismissed] = useState<number>(() => { try { return Number(localStorage.getItem(annKey(roomId))) || 0; } catch { return 0; } });
  const html = useMemo(() => (ann ? renderBioMarkdown(ann.text) : ''), [ann]);
  if (!ann || dismissed === ann.at || !html) return null;
  const dismiss = () => { try { localStorage.setItem(annKey(roomId), String(ann.at)); } catch { /* ignore */ } setDismissed(ann.at); };
  return (
    <div className="ann-banner" role="note" data-announcement="1">
      <span className="ann-ic" aria-hidden>📣</span>
      <div className="ann-text md" dangerouslySetInnerHTML={{ __html: html }} />
      <button type="button" className="icon-btn" aria-label="Dismiss announcement" title="Dismiss until it changes" data-action="dismiss-announcement" onClick={dismiss}>✕</button>
    </div>
  );
}
