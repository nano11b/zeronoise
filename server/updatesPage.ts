/** batch X: public changelog at /updates, built from shared/changelog.json (newest first, collapsible, themed, phone friendly). */
import fs from 'node:fs';
import path from 'node:path';
import { uiThemeCss } from '../shared/uiTheme';
import { BRAND_NAME } from '../shared/config';

export interface ChangelogEntry { id: string; date: string; period?: string; title: string; sections: { heading: string; items: string[] }[] }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : d; };

export function loadChangelog(file = path.resolve(__dirname, '../../../shared/changelog.json')): ChangelogEntry[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: ChangelogEntry[] };
    return (j.entries ?? []).filter((e) => e && typeof e.id === 'string' && typeof e.title === 'string' && Array.isArray(e.sections))
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch { return []; }
}

export function updatesHtml(entries: ChangelogEntry[]): string {
  const body = entries.map((e, i) => `
    <details class="rel" id="${esc(e.id)}"${i === 0 ? ' open' : ''}>
      <summary><span class="when">${esc(e.period ?? longDate(e.date))}</span><span class="title">${esc(e.title)}</span></summary>
      ${e.sections.map((s) => `<h3>${esc(s.heading)}</h3><ul>${s.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul>`).join('\n')}
    </details>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>What's new · ${esc(BRAND_NAME)}</title>
  <meta name="description" content="Everything that has changed in ${esc(BRAND_NAME)}, newest first.">
  <meta name="theme-color" content="#0b1220">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.png" type="image/png" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <script src="/theme-boot.js"></script>
  <style>
    ${uiThemeCss()}
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(900px 480px at 50% -10%, rgb(var(--accent-rgb) / .06), transparent 55%), var(--bg); color: var(--text); font: 16px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
    a { color: var(--accent); }
    .page { width: min(46rem, calc(100% - 32px)); margin: 0 auto; padding: 40px 0 72px; }
    .mark { height: 72px; width: auto; display: block; }
    h1 { margin: 18px 0 4px; font-size: 28px; font-weight: 650; line-height: 1.25; }
    .lead { margin: 0 0 20px; color: var(--muted); }
    .tools { display: flex; gap: 12px; margin: 0 0 12px; font-size: 14px; }
    .tools button { background: none; border: 1px solid var(--line); color: var(--text); border-radius: 999px; padding: 6px 12px; font: inherit; cursor: pointer; min-height: 36px; }
    .tools button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .rel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; margin: 0 0 12px; padding: 0 16px; }
    .rel[open] { padding-bottom: 8px; }
    summary { cursor: pointer; list-style: none; padding: 14px 0; display: flex; flex-direction: column; gap: 2px; min-height: 44px; }
    summary::-webkit-details-marker { display: none; }
    summary::after { content: '+'; position: absolute; right: 0; }
    summary { position: relative; padding-right: 28px; }
    summary::after { top: 14px; color: var(--muted); font-size: 20px; line-height: 1; }
    .rel[open] > summary::after { content: '−'; }
    .when { color: var(--accent-2); font-size: 13px; font-weight: 600; letter-spacing: .02em; }
    .title { font-size: 18px; font-weight: 650; color: var(--text); }
    h3 { margin: 14px 0 6px; font-size: 15px; font-weight: 650; color: var(--text); }
    ul { margin: 4px 0 8px; padding-left: 1.2em; }
    li { margin: 0 0 6px; color: var(--text); }
    .nav { margin: 28px 0 0; color: var(--muted); font-size: 14px; }
    @media (max-width: 640px) { .page { padding-top: 24px; } h1 { font-size: 24px; } .title { font-size: 16px; } .rel { padding: 0 12px; } }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
  </style>
</head>
<body>
  <main class="page">
    <a href="/"><img class="mark" src="/logo-lockup.png" alt="${esc(BRAND_NAME)}"></a>
    <h1>What's new</h1>
    <p class="lead">Everything that has changed in ${esc(BRAND_NAME)}, newest first.</p>
    <div class="tools"><button type="button" id="all-open">Expand all</button><button type="button" id="all-close">Collapse all</button></div>
    ${body || '<p>No updates yet.</p>'}
    <p class="nav"><a href="/">Back to ${esc(BRAND_NAME)}</a> · <a href="/download">Get the app</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>
  </main>
  <script src="/updates.js"></script>
</body>
</html>`;
}
/** tiny script for the expand/collapse buttons and #id deep links (no inline script, so the CSP stays strict) */
export const UPDATES_JS = `(function(){var d=document.querySelectorAll('details.rel');function s(v){d.forEach(function(x){x.open=v;});}
var a=document.getElementById('all-open'),c=document.getElementById('all-close');if(a)a.onclick=function(){s(true);};if(c)c.onclick=function(){s(false);};
function go(){if(!location.hash)return;var t=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(t&&t.tagName==='DETAILS'){t.open=true;t.scrollIntoView();}}go();window.addEventListener('hashchange',go);})();`;
