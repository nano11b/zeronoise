import { useMemo } from 'react';
import { renderChatMarkdown } from '../markdown';
import { useEmoteMap } from '../emotes';
import { msgStyleCss, parseMsgStyle } from '../../shared/msgColor';
import { STICKER_TOKEN_RE } from '../../shared/stickers';

/** Renders chat/PM body with sanitized markdown + emoji shortcodes (+ this room's :emotes:). */
export function ChatText({ text, className = '', color }: { text: string; className?: string; color?: string | null }) {
  const emotes = useEmoteMap();
  const sticker = STICKER_TOKEN_RE.exec(text.trim());
  const html = useMemo(() => renderChatMarkdown(text, emotes ?? undefined), [text, emotes]);
  // callers pass an already-checked value (safeMsgStyle / useMsgColor); gradients get a solid fallback colour
  const css = msgStyleCss(color ? parseMsgStyle(color) : null);
  if (sticker) return <div className={`md ${className} sticker-line`.trim()} data-sticker-id={sticker[1]}><img className="sticker" src={`/api/stickers/${sticker[1]}.webp`} alt="Sticker" width={160} height={160} loading="lazy" /></div>;
  if (!html) return null;
  return <div className={`md ${className} ${css.className}`.replace(/\s+/g, ' ').trim()} style={css.style as React.CSSProperties | undefined} data-msg-color={color || undefined} dangerouslySetInnerHTML={{ __html: html }} />;
}
