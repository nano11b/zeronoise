/** Client markdown/sanitize contract (mirrors src/markdown.ts). */
import MarkdownIt from 'markdown-it';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const createDOMPurify = require('dompurify');

const { window } = new JSDOM('');
const DOMPurify = createDOMPurify(window);
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
function isAllowedGifUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    if (h === 'media.tenor.com' || h === 'media1.tenor.com' || h === 'c.tenor.com' || h.endsWith('.media.tenor.com')) return true;
    if (h === 'media.giphy.com' || h === 'i.giphy.com' || /^media\d\.giphy\.com$/.test(h)) return true;
    return false;
  } catch { return false; }
}
function isAllowedChatImage(raw) {
  if (isAllowedGifUrl(raw)) return true;
  return /^\/api\/uploads\/[A-Za-z0-9_-]{8,80}\.(webp|gif)$/.test(String(raw).trim());
}
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
md.renderer.rules.image = (tokens, idx) => {
  const src = tokens[idx].attrGet('src') || '';
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

const SHORTCODES = { smile: '😄', fire: '🔥', '+1': '👍' };
const expand = (t) => t.replace(/:([a-z0-9_+-]+):/gi, (f, n) => SHORTCODES[n.toLowerCase()] ?? f);

function render(source) {
  const raw = md.render(expand(source));
  let clean = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 's', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'img'],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'src', 'alt', 'loading'],
    ALLOW_DATA_ATTR: false,
  });
  clean = clean.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\bsrc=(["'])(.*?)\1/i.exec(tag);
    if (!m || !isAllowedChatImage(m[2])) return '';
    return tag;
  });
  clean = clean.replace(/<a\s+([^>]*?)>/gi, (_m, attrs) => {
    let a = attrs;
    if (!/\btarget=/i.test(a)) a += ' target="_blank"';
    if (!/\brel=/i.test(a)) a += ' rel="noopener noreferrer"';
    return `<a ${a}>`;
  });
  return clean;
}

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const bold = render('hello **world**');
ok(/<strong>world<\/strong>/.test(bold), 'bold');
ok(/<em>x<\/em>/.test(render('*x*')), 'italic');
ok(/<code>c<\/code>/.test(render('`c`')), 'code');
ok(/<s>z<\/s>|<del>z<\/del>/.test(render('~~z~~')), 'strike');
ok(/href="https:\/\/example\.com"/.test(render('see https://example.com')), 'linkify');
ok(/target="_blank"/.test(render('[x](https://ex.com)')), 'link target blank');
ok(/noopener/.test(render('[x](https://ex.com)')), 'link rel noopener');
ok(!/<script/i.test(render('a <script>alert(1)</script> b')), 'strips raw script tags (html disabled)');
ok(!/<a\b/i.test(render('[x](javascript:alert(1))')), 'javascript: not turned into a link');
ok(/<a\b/i.test(render('[x](https://ok.example)')), 'https links still work');
ok(!/<img/i.test(render('![x](https://evil/x.png)')), 'non-cdn images not rendered');
ok(/class="chat-gif"/.test(render('hello ![GIF](https://media.tenor.com/abc/x.gif)')), 'tenor gif image allowed');
ok(/<strong>hi<\/strong>/.test(render('**hi** ![GIF](https://media.tenor.com/abc/x.gif)')), 'markdown beside gif');
ok(!/<img/i.test(render('![x](http://media.tenor.com/a.gif)')), 'http gif rejected');
ok(!/<img/i.test(render('![x](https://evil.example/a.gif)')), 'foreign https image rejected');
ok(/chat-gif/.test(render('![image](/api/uploads/abcdefghij.webp)')), 'own upload path renders');
ok(!/<img/i.test(render('![x](https://chat.example/api/uploads/abcdefghij.webp)')), 'absolute foreign upload rejected');
ok(!/<img/i.test(render('![x](/api/uploads/../etc/passwd)')), 'upload path traversal rejected');
const sc = render('hi :smile: :fire:');
ok(sc.includes('😄') && sc.includes('🔥'), 'shortcodes expand');
ok(/<li>/.test(render('- one\n- two')), 'lists');
ok(/<blockquote>/.test(render('> quote')), 'blockquote');
ok(/\n|<br|<\/p><p>/.test(render('line1\nline2')), 'newlines');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
