/** Safe chat markdown → sanitized HTML (client-only; messages stored as plain text). */
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import type { Config as DomPurifyConfig } from 'dompurify';
import { isAllowedChatImage } from '../shared/gifs';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});
md.enable('image');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
md.renderer.rules.image = (tokens, idx) => {
  const src = String(tokens[idx].attrGet('src') || '');
  if (!isAllowedChatImage(src)) return '';
  const href = escAttr(src);
  return `<a class="gif-link" href="${href}" target="_blank" rel="noopener noreferrer"><img class="chat-gif" src="${href}" alt="GIF" loading="lazy"></a>`;
};

const defaultValidate = md.validateLink.bind(md);
md.validateLink = (url) => {
  const u = String(url).trim().toLowerCase();
  if (/^(javascript|vbscript|data):/.test(u)) return false;
  return defaultValidate(url);
};


/** Optional shortcodes → Unicode emoji (applied before markdown). */
const SHORTCODES: Record<string, string> = {
  smile: '😄', smiley: '😃', grin: '😁', joy: '😂', laugh: '😆', wink: '😉', blush: '😊',
  heart_eyes: '😍', kissing_heart: '😘', thinking: '🤔', sunglasses: '😎', sob: '😭',
  cry: '😢', angry: '😠', rage: '😡', thumbsup: '👍', thumbsdown: '👎', ok_hand: '👌',
  clap: '👏', wave: '👋', fire: '🔥', 100: '💯', sparkles: '✨', star: '⭐', tada: '🎉',
  heart: '❤️', broken_heart: '💔', eyes: '👀', rocket: '🚀', coffee: '☕', pizza: '🍕',
  '+1': '👍', '-1': '👎', check: '✅', x: '❌', warning: '⚠️', question: '❓',
  sweat_smile: '😅', upside_down: '🙃', shrug: '🤷', pray: '🙏', muscle: '💪',
};

const shortcodeRe = /:([a-z0-9_+-]+):/gi;

export function expandShortcodes(text: string): string {
  return text.replace(shortcodeRe, (full, name: string) => SHORTCODES[name.toLowerCase()] ?? full);
}

const PURIFY: DomPurifyConfig = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 's', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'img'],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'src', 'alt', 'loading'],
  ALLOW_DATA_ATTR: false,
  // javascript: / data: / vbscript: stripped by default
};

function hardenLinks(html: string): string {
  // DOMPurify keeps http(s)/mailto; force new-tab + noopener on anchors
  return html.replace(/<a\s+([^>]*?)>/gi, (_m, attrs: string) => {
    let a = attrs;
    if (!/\btarget=/i.test(a)) a += ' target="_blank"';
    if (!/\brel=/i.test(a)) a += ' rel="noopener noreferrer"';
    else a = a.replace(/\brel=(["']).*?\1/i, 'rel="noopener noreferrer"');
    return `<a ${a}>`;
  });
}

/** Render user chat text to safe HTML. Empty → empty string. */
export function renderChatMarkdown(source: string, emotes?: ReadonlyMap<string, string>): string {
  // Room emotes (:name: -> id) become private-use placeholders that survive markdown + sanitizing untouched.
  const used: string[] = [];
  let src = source;
  if (emotes && emotes.size) {
    src = source.replace(/:([a-z0-9_]{2,24}):/g, (full, name: string) => {
      const id = emotes.get(name);
      if (!id || !/^[a-f0-9]{32}$/.test(id)) return full;
      used.push(name);
      return `\uE000${used.length - 1}\uE001`;
    });
  }
  const text = expandShortcodes(src);
  if (!text.trim()) return '';
  const raw = md.render(text);
  let clean = String(DOMPurify.sanitize(raw, PURIFY));
  clean = clean.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\bsrc=(["'])(.*?)\1/i.exec(tag);
    if (!m || !isAllowedChatImage(m[2])) return '';
    return tag;
  });
  clean = hardenLinks(clean);
  // Highlight @username tokens in text, not inside tags.
  clean = clean.replace(/(<[^>]+>)|(@[A-Za-z][A-Za-z0-9_-]{1,19})/g, (full, tag, mention) => tag || `<span class="mention">${mention}</span>`);
  if (used.length) {
    clean = clean.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => {
      const name = used[Number(i)];
      const id = name ? emotes!.get(name) : undefined;
      return name && id ? `<img class="emote" src="/api/room-emotes/${id}.webp" alt=":${name}:" title=":${name}:" loading="lazy">` : '';
    });
  }
  return clean;
}

export const EMOJI_GRID = [
  '😀','😁','😂','🤣','😅','😊','😍','😘','😎','🤔','🙄','😴','😭','😤','🤯','🥳',
  '👍','👎','👏','🙌','👋','🙏','💪','✨','🔥','💯','❤️','🧡','💛','💚','💙','💜',
  '🖤','🤍','💔','⭐','🌟','🎉','🎊','🎈','🚀','☕','🍕','🍔','🎂','🌈','☀️','🌙',
  '✅','❌','⚠️','❓','💬','👀','🤷','🤣','😜','😇','🥰','😈','👻','💀','🤖','🐱',
] as const;

// ---- profile bio: markdown-lite (bold, italic, strike, inline code, links, line breaks; no images, lists or blocks) ----
const bioMd = new MarkdownIt('zero', { html: false, linkify: true, breaks: true, typographer: false })
  .enable(['emphasis', 'strikethrough', 'backticks', 'link', 'linkify', 'newline', 'escape', 'entity']);
bioMd.validateLink = md.validateLink;
const BIO_PURIFY: DomPurifyConfig = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 's', 'del', 'code', 'a'],
  ALLOWED_ATTR: ['href', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
};
/** Render a profile bio (max 280 chars) to safe HTML. */
export function renderBioMarkdown(source: string): string {
  const text = expandShortcodes(source || '');
  if (!text.trim()) return '';
  return hardenLinks(String(DOMPurify.sanitize(bioMd.render(text), BIO_PURIFY)));
}
