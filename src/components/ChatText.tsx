import { useMemo } from 'react';
import { renderChatMarkdown } from '../markdown';
import { useEmoteMap } from '../emotes';
import { msgStyleCss, parseMsgStyle } from '../../shared/msgColor';

/** Renders chat/PM body with sanitized markdown + emoji shortcodes (+ this room's :emotes:). */
export function ChatText({ text, className = '', color }: { text: string; className?: string; color?: string | null }) {
  const emotes = useEmoteMap();
  const html = useMemo(() => renderChatMarkdown(text, emotes ?? undefined), [text, emotes]);
  // callers pass an already-checked value (safeMsgStyle / useMsgColor); gradients get a solid fallback colour
  const css = msgStyleCss(color ? parseMsgStyle(color) : null);
  if (!html) return null;
  return <div className={`md ${className} ${css.className}`.replace(/\s+/g, ' ').trim()} style={css.style as React.CSSProperties | undefined} data-msg-color={color || undefined} dangerouslySetInnerHTML={{ __html: html }} />;
}
