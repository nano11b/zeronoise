import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface BackupInfo { name: string; size: number; createdAt: number; ok: boolean }
interface BackupStatus { running: boolean; lastAt: number | null; lastOk: boolean | null; lastError: string | null; nextAt: number | null; disabled: boolean; keep: number; schedule: string }

const fmtSize = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtTime = (ts: number | null) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '-');

/** Admin-only backups list: download, and a rate-limited "Back up now". Restore is manual (deploy/RESTORE-BACKUP.md). */
export function AdminBackups({ onError, onNotice }: { onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [allowedAt, setAllowedAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api<{ backups: BackupInfo[]; status: BackupStatus; nowAllowedAt: number }>('/api/admin/backups');
      setList(r.backups); setStatus(r.status); setAllowedAt(r.nowAllowedAt);
    } catch (e) { onError((e as Error).message); }
  }, [onError]);
  useEffect(() => { void load(); }, [load]);
  // poll while a backup runs
  useEffect(() => {
    if (!status?.running) return;
    const t = window.setInterval(() => { void load(); }, 2000);
    return () => window.clearInterval(t);
  }, [status?.running, load]);
  const now = Date.now();
  const waitMin = allowedAt > now ? Math.ceil((allowedAt - now) / 60_000) : 0;
  const runNow = async () => {
    setBusy(true);
    try { await api('/api/admin/backups/run', {}); onNotice('Backup started'); await load(); }
    catch (e) { onError((e as Error).message); await load(); }
    finally { setBusy(false); }
  };
  return (
    <section className="admin-backups" data-section="backups">
      <div className="section-head">
        <h2>Backups</h2>
        <button className="btn ghost small-btn" onClick={() => void load()} data-action="backups-refresh">Refresh</button>
        <button className="btn primary small-btn" onClick={() => void runNow()} disabled={busy || !!status?.running || waitMin > 0} data-action="backup-now"
          title={waitMin > 0 ? `One manual backup per 10 minutes (about ${waitMin} min left)` : 'Make a backup now'}>
          {status?.running ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      {status && (
        <div className="panel backup-status" data-last-ok={status.lastOk === null ? 'none' : String(status.lastOk)}>
          <p>
            <strong>Last backup:</strong> {fmtTime(status.lastAt)}{' '}
            {status.lastOk === true && <span className="tag ok-tag">ok</span>}
            {status.lastOk === false && <span className="tag bad-tag">failed</span>}
          </p>
          {status.lastOk === false && status.lastError && <p className="small backup-error">{status.lastError}</p>}
          <p className="muted small">
            {status.disabled ? 'Automatic backups are off (BACKUP_DISABLED=1).' : <>Nightly at {status.schedule} server time{status.nextAt ? ` · next ${fmtTime(status.nextAt)}` : ''}.</>}
            {' '}The newest {status.keep} are kept. Database snapshot plus avatars, thumbnails, emotes, voice notes, sounds and chat images.
            {' '}Restoring is manual: see <code>deploy/RESTORE-BACKUP.md</code>.
          </p>
        </div>
      )}
      <div className="table-wrap">
        <table className="table backups-table">
          <thead><tr><th>Backup</th><th>Size</th><th>Created</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(list ?? []).map((b) => (
              <tr key={b.name} data-backup={b.name}>
                <td className="mono backup-name">{b.name}</td>
                <td>{fmtSize(b.size)}</td>
                <td>{fmtTime(b.createdAt)}</td>
                <td>{b.ok ? <span className="tag ok-tag">ok</span> : <span className="tag bad-tag">check failed</span>}</td>
                <td><a className="btn ghost small-btn" href={`/api/admin/backups/${encodeURIComponent(b.name)}`} download={b.name} data-action="backup-download">Download</a></td>
              </tr>
            ))}
            {list && list.length === 0 && <tr><td colSpan={5} className="muted">No backups yet.</td></tr>}
            {!list && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small">Backups contain the whole database (accounts, password hashes, emails, messages). Download only to a safe place.</p>
    </section>
  );
}
