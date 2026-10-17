import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/** Batch F9/F10: alerts sent to admins, the daily backup restore check, and how to watch from outside. */
interface Alert { id: number; kind: string; at: number; subject: string; detail: string; recipients: number; sent: number }
interface Check { id: number; at: number; backup: string | null; status: 'ok' | 'failed' | 'skipped'; ms: number; detail: { problems?: string[]; integrity?: unknown; sha256?: string; counts?: Record<string, [number, number]>; note?: string; reason?: string } }
interface Ops { alerts: Alert[]; checks: Check[]; schedule: { nextAt: number | null; disabled: boolean; schedule: string }; running: boolean; errors: { inWindow: number; threshold: number; windowMs: number }; recipients: number; mail: boolean }
const t = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '-');

export function AdminOps({ onError, onNotice }: { onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [d, setD] = useState<Ops | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Ops>('/api/admin/ops').then(setD).catch((e) => onError((e as Error).message)), [onError]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return null;
  const last = d.checks.find((c) => c.status !== 'skipped');
  return (
    <section className="admin-ops" data-testid="admin-ops">
      <h3>Backup restore check</h3>
      <p className={`ops-state ${!last ? 'warn' : last.status === 'ok' ? 'ok' : 'bad'}`} data-testid="restore-check-state" data-status={last?.status ?? 'none'}>
        {!last ? 'Not run yet.' : last.status === 'ok' ? `OK: ${last.backup} restored and checked ${t(last.at)} (${(last.ms / 1000).toFixed(1)} s).` : `FAILED ${t(last.at)}: ${(last.detail.problems ?? []).join('; ')}`}
      </p>
      <p className="muted small">The newest backup is restored into a temporary folder, then checked with integrity_check, its manifest checksum and row counts against the live site. {d.schedule.disabled ? 'Scheduled checks are off.' : `Schedule: ${d.schedule.schedule}${d.schedule.nextAt ? `, next ${t(d.schedule.nextAt)}` : ''}.`} Failures email the admins.</p>
      <button type="button" className="btn small-btn" data-action="restore-check-run" disabled={busy || d.running} onClick={async () => { setBusy(true); try { const r = await api<{ check: Check }>('/api/admin/ops/restore-check', {}); onNotice(r.check.status === 'ok' ? 'Restore check passed' : r.check.status === 'skipped' ? `Skipped: ${r.check.detail.note}` : 'Restore check FAILED'); await load(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); } }}>Run the check now</button>
      {d.checks.length > 0 && (
        <table className="ops-table" data-testid="restore-checks">
          <thead><tr><th>When</th><th>Backup</th><th>Result</th></tr></thead>
          <tbody>{d.checks.map((c) => (
            <tr key={c.id} data-status={c.status}><td>{t(c.at)}</td><td><code>{c.backup ?? '-'}</code></td>
              <td>{c.status === 'ok' ? `OK${c.detail.counts ? ` · ${Object.entries(c.detail.counts).map(([k, [b]]) => `${k} ${b}`).join(', ')}` : ''}` : c.status === 'skipped' ? `skipped (${c.detail.note})` : `failed: ${(c.detail.problems ?? []).join('; ')}`}</td></tr>
          ))}</tbody>
        </table>
      )}
      <h3>Alerts</h3>
      <p className="muted small">
        Admins with a verified email ({d.recipients}) get an email when errors spike ({d.errors.threshold} in {Math.round(d.errors.windowMs / 60000)} min; {d.errors.inWindow} now), after a crash restart, and when a restore check fails.{!d.mail && ' Mail is not configured, so alerts are only listed here.'}
      </p>
      <button type="button" className="btn ghost small-btn" data-action="test-alert" onClick={async () => { try { const r = await api<{ recipients: number }>('/api/admin/ops/test-alert', {}); onNotice(`Test alert sent to ${r.recipients} admin(s)`); await load(); } catch (e) { onError((e as Error).message); } }}>Send a test alert</button>
      {d.alerts.length === 0 ? <p className="muted small">No alerts yet.</p> : (
        <ul className="ops-alerts" data-testid="ops-alerts">
          {d.alerts.map((a) => <li key={a.id} data-kind={a.kind}><b>{a.subject}</b> <span className="muted small">{t(a.at)} · emailed {a.sent}/{a.recipients}</span><br /><span className="small">{a.detail}</span></li>)}
        </ul>
      )}
      <h3>Outside uptime check</h3>
      <p className="muted small">The server cannot email you while it is down, so add an outside pinger (for example UptimeRobot, free): an HTTP(s) keyword monitor on <code>{location.origin}/api/uptime</code>, keyword <code>OK</code>, every 5 minutes, alerting your email/phone. It answers 200 “OK”, or 503 when the database is not answering. Steps: deploy/UPTIME.md.</p>
    </section>
  );
}
