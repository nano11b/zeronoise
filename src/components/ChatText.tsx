import { useMemo } from 'react';
import { renderChatMarkdown } from '../markdown';
import { useEmoteMap } from '../emotes';

/** Renders chat/PM body with sanitized markdown + emoji shortcodes (+ this room's :emotes:). */
export function ChatText({ text, className = '', color }: { text: string; className?: string; color?: string | null }) {
  const emotes = useEmoteMap();
  const html = useMemo(() => renderChatMarkdown(text, emotes ?? undefined), [text, emotes]);
  if (!html) return null;
  return <div className={`md ${className}${color ? ' msg-colored' : ''}`.trim()} style={color ? { color } : undefined} data-msg-color={color || undefined} dangerouslySetInnerHTML={{ __html: html }} />;
}
