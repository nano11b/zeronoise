/** Discord-style embeds posted by an incoming room webhook. Remote images are links only (no third-party loads). */
import type { WebhookEmbed } from '../../shared/webhooks';
import { ChatText } from './ChatText';

const safeHref = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : undefined);
export function WebhookEmbeds({ embeds }: { embeds: WebhookEmbed[] }) {
  return (
    <div className="wh-embeds" data-testid="wh-embeds">
      {embeds.map((e, i) => (
        <div key={i} className="wh-embed" style={e.color != null ? { borderLeftColor: `#${e.color.toString(16).padStart(6, '0')}` } : undefined}>
          {e.author && <div className="wh-embed-author small">{safeHref(e.author.url) ? <a href={e.author.url} target="_blank" rel="noopener noreferrer nofollow">{e.author.name}</a> : e.author.name}</div>}
          {e.title && <div className="wh-embed-title">{safeHref(e.url) ? <a href={e.url} target="_blank" rel="noopener noreferrer nofollow">{e.title}</a> : e.title}</div>}
          {e.description && <ChatText text={e.description} className="wh-embed-desc" />}
          {!!e.fields?.length && (
            <div className="wh-embed-fields">
              {e.fields.map((f, j) => (
                <div key={j} className={`wh-embed-field${f.inline ? ' inline' : ''}`}>
                  <div className="wh-embed-fname small">{f.name}</div>
                  <ChatText text={f.value} className="wh-embed-fval" />
                </div>
              ))}
            </div>
          )}
          {(e.image || e.thumbnail) && (
            <div className="wh-embed-links small">{e.image && <a href={e.image} target="_blank" rel="noopener noreferrer nofollow">🖼 Image</a>} {e.thumbnail && <a href={e.thumbnail} target="_blank" rel="noopener noreferrer nofollow">🖼 Thumbnail</a>}</div>
          )}
          {(e.footer || e.timestamp) && <div className="wh-embed-footer small muted">{e.footer?.text}{e.footer && e.timestamp ? ' · ' : ''}{e.timestamp ? new Date(e.timestamp).toLocaleString() : ''}</div>}
        </div>
      ))}
    </div>
  );
}
