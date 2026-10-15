import { BRAND_NAME } from '../shared/config';

/** Public status: only what is safe to show anyone. No counts, hosts, paths, config or user data. */
export interface PublicStatus {
  ok: boolean;
  db: boolean;
  uptimeSec: number;
  startedAt: number;
  package: string | null;
  commit: string | null;
  releasedAt: string | null;
  lastBackupAt: number | null;
  lastBackupOk: boolean | null;
  checkedAt: number;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function dur(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${sec % 60}s`;
}
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString().replace('.000', '') : 'never');

/** Server-rendered, no script (the site CSP stays strict); refreshes itself every 30 s. */
export function statusHtml(s: PublicStatus): string {
  const row = (k: string, v: string, cls = '') => `<tr><th>${esc(k)}</th><td${cls ? ` class="${cls}"` : ''}>${v}</td></tr>`;
  const backupOld = s.lastBackupAt == null || s.checkedAt - s.lastBackupAt > 36 * 3600_000;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30"><title>${esc(BRAND_NAME)} status</title><meta name="robots" content="noindex">
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#0b0f17;color:#e6edf3;display:flex;justify-content:center}
main{max-width:640px;width:100%;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}.big{font-size:18px;font-weight:700;margin:12px 0 18px}
.ok{color:#39ff14}.bad{color:#ff6b6b}.warn{color:#ffd166}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #1f2a3a;vertical-align:top}
th{color:#8b98a9;font-weight:500;width:40%}code{font-size:12px;word-break:break-all}a{color:#7cc4ff}</style></head><body><main>
<h1>${esc(BRAND_NAME)} status</h1>
<p class="big ${s.ok ? 'ok' : 'bad'}" data-status="${s.ok ? 'ok' : 'down'}">${s.ok ? 'All systems normal' : 'Problem: the database is not answering'}</p>
<table>
${row('Health', s.ok ? 'OK' : 'Down', s.ok ? 'ok' : 'bad')}
${row('Database', s.db ? 'OK' : 'Not answering', s.db ? 'ok' : 'bad')}
${row('Uptime', esc(dur(s.uptimeSec)) + ` <span style="color:#8b98a9">(since ${esc(iso(s.startedAt))})</span>`)}
${row('Live package', s.package ? `<code data-package>${esc(s.package)}</code>` : 'unknown')}
${row('Commit', s.commit ? `<code data-commit>${esc(s.commit)}</code>` : 'unknown')}
${row('Released', esc(s.releasedAt ?? 'unknown'))}
${row('Last backup', esc(iso(s.lastBackupAt)) + (s.lastBackupOk === false ? ' (failed)' : ''), s.lastBackupOk === false ? 'bad' : backupOld ? 'warn' : 'ok')}
${row('Checked', esc(iso(s.checkedAt)))}
</table>
<p style="color:#8b98a9">Times are UTC. Machine-readable: <a href="/api/status">/api/status</a>. Back to <a href="/">${esc(BRAND_NAME)}</a>.</p>
</main></body></html>`;
}
