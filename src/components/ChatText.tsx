import { useMemo } from 'react';
import { renderChatMarkdown } from '../markdown';
import { useEmoteMap } from '../emotes';

/** Renders chat/PM body with sanitized markdown + emoji shortcodes (+ this room's :emotes:). */
export function ChatText({ text, className = '' }: { text: string; className?: string }) {
  const emotes = useEmoteMap();
  const html = useMemo(() => renderChatMarkdown(text, emotes ?? undefined), [text, emotes]);
  if (!html) return null;
  return <div className={`md ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}
