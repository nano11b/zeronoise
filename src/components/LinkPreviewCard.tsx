import { useState } from 'react';
import { APP_NAME } from '../../shared/config';
import type { LinkPreviewInfo } from '../../shared/types';

const KEY = `${APP_NAME.toLowerCase()}.collapsedPreviews`;
function loadCollapsed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]') as string[]); } catch { return new Set(); }
}
function saveCollapsed(s: Set<string>) {
  try { localStorage.setItem(KEY, JSON.stringify([...s].slice(-300))); } catch { /* private mode */ }
}

/** Link preview card under a chat line. Anyone can collapse it (remembered on this device); the sender can remove it for everyone. */
export function LinkPreviewCard({ messageId, preview, canRemove, onRemove }: { messageId: string; preview: LinkPreviewInfo; canRemove: boolean; onRemove: () => void }) {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed().has(messageId));
  const [imgOk, setImgOk] = useState(true);
  const toggle = () => {
    const s = loadCollapsed();
    if (collapsed) s.delete(messageId); else s.add(messageId);
    saveCollapsed(s);
    setCollapsed(!collapsed);
  };
  let host = '';
  try { host = new URL(preview.url).hostname.replace(/^www\./, ''); } catch { /* keep blank */ }
  const video = preview.kind === 'youtube' || preview.kind === 'twitch';
  const image = preview.kind === 'image';
  return (
    <div className={`link-preview${collapsed ? ' collapsed' : ''}${video ? ' video' : ''}${image ? ' image' : ''}${preview.kind === 'x' ? ' xpost' : ''}`} data-preview={preview.id} data-kind={preview.kind}>
      <div className="lp-bar">
        <span className="lp-site">{preview.siteName || host}</span>
        <button type="button" className="icon-btn" data-action="preview-collapse" aria-expanded={!collapsed} title={collapsed ? 'Show preview' : 'Hide preview'} aria-label={collapsed ? 'Show preview' : 'Hide preview'} onClick={toggle}>{collapsed ? '▸' : '▾'}</button>
        {canRemove && <button type="button" className="icon-btn" data-action="preview-remove" title="Remove preview for everyone" aria-label="Remove preview" onClick={onRemove}>✕</button>}
      </div>
      {!collapsed && (
        <a className="lp-body" href={preview.url} target="_blank" rel="noopener noreferrer nofollow ugc">
          {preview.image && imgOk && (
            <span className="lp-thumb">
              <img src={preview.image} alt={image ? preview.title ?? 'image' : ''} loading="lazy" onError={() => setImgOk(false)} />
              {video && <span className="lp-play" aria-hidden="true">▶</span>}
            </span>
          )}
          {!image && <span className="lp-text">
            {preview.title && <span className="lp-title">{preview.title}</span>}
            {preview.description && <span className="lp-desc">{preview.description}</span>}
          </span>}
        </a>
      )}
    </div>
  );
}
