import { FormEvent, useCallback, useEffect, useState } from 'react';
import { APP_NAME, LIMITS } from '../../shared/config';
import type { AdminBan, AdminLogEntry, AdminUser, BanKind, Role } from '../../shared/types';
import { ModQueue } from './ModQueue';
import { useStaffCounts } from '../modq';
import { api } from '../api';
import type { Account } from '../App';
import { BAN_DURATIONS, Dialog, DialogSpec } from './Dialog';
import { Logo } from './Login';
import { RoleTag } from './RoleTag';
import { UserAvatar } from './UserAvatar';
import { GamesButton, GamesSlot } from './GamesSlot';
import { AdminBackups } from './AdminBackups';

type Tab = 'reports' | 'bans' | 'users' | 'log' | 'backups';
const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '-');

export function AdminPanel({ account, onBack, onGames }: { account: Account | null; onBack: () => void; onGames: () => void }) {
  const [tab, setTab] = useState<Tab>('reports');
  const [bans, setBans] = useState<AdminBan[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [log, setLog] = useState<AdminLogEntry[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [newBan, setNewBan] = useState<{ kind: BanKind; value: string }>({ kind: 'account', value: '' });
  const [resetLink, setResetLink] = useState('');
  const [modBots, setModBots] = useState<{ id: number; name: string }[]>([]);
  const [modBotId, setModBotId] = useState('');
  const staff = account && (account.role === 'admin' || account.role === 'moderator');
  const isAdmin = account?.role === 'admin';
  const queueCounts = useStaffCounts();
  const waiting = queueCounts.open + queueCounts.review;

  const load = useCallback(async () => {
    if (!staff) return;
    setError('');
    try {
      if (tab === 'bans') setBans((await api<{ bans: AdminBan[] }>('/api/admin/bans')).bans);
      if (tab === 'users') setUsers((await api<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(search)}`)).users);
      if (tab === 'log') setLog((await api<{ log: AdminLogEntry[] }>('/api/admin/log')).log);
    } catch (e) { setError((e as Error).message); }
  }, [tab, search, staff]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api<{ botId: number | null; bots: { id: number; name: string }[] }>('/api/admin/moderator-bot')
      .then((r) => {
        if (cancelled) return;
        setModBots(r.bots);
        setModBotId(r.botId ? String(r.botId) : '');
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [isAdmin]);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setError('');
    try { await fn(); setNotice(msg); setTimeout(() => setNotice(''), 3000); await load(); } catch (e) { setError((e as Error).message); }
  };

  if (!staff) {
    return (
      <main className="login"><section className="login-card">
        <Logo size={48} />
        <h1 className="brand-title">Mod panel</h1>
        <p className="form-error">{account ? 'This page is for moderators and admins.' : 'Sign in with a moderator or admin account first.'}</p>
        <button className="btn primary" onClick={onBack}>Back to zeronoise</button>
      </section></main>
    );
  }

  const banAccount = (u: AdminUser) => setDialog({
    title: `Ban account ${u.username}`, confirm: 'Ban', danger: true, durations: BAN_DURATIONS,
    reason: { label: 'Reason (shown to the user)', required: true, max: LIMITS.banReasonMax },
    onSubmit: async ({ reason, minutes }) => { await api('/api/admin/bans', { kind: 'account', value: u.username, reason, minutes }); setNotice('Banned'); await load(); },
  });
  const issueReset = async (u: AdminUser) => {
    try {
      const r = await api<{ link: string; expiresInMin: number }>(`/api/admin/users/${u.id}/reset`, {});
      setResetLink(r.link);
      setNotice(`Reset link (expires in ${r.expiresInMin} min) — copy it now; it will not be shown again.`);
    } catch (e) { setError((e as Error).message); }
  };
  const addBan = (e: FormEvent) => {
    e.preventDefault();
    if (!newBan.value.trim()) return;
    setDialog({
      title: `Ban ${newBan.kind} ${newBan.value}`, confirm: 'Ban', danger: true, durations: BAN_DURATIONS,
      reason: { label: 'Reason', required: true, max: LIMITS.banReasonMax },
      onSubmit: async ({ reason, minutes }) => { await api('/api/admin/bans', { ...newBan, reason, minutes }); setNewBan({ ...newBan, value: '' }); setNotice('Banned'); await load(); },
    });
  };

  return (
    <div className="admin">
      <header className="topbar">
        <div className="brand"><Logo /> <img className="wordmark" src="/logo-wordmark.png" alt="zeronoise" width={512} height={80} /> <span className="muted">· Mod panel</span></div>
        <nav className="tabs admin-tabs">
          {(['reports', 'bans', 'users', 'log', ...(isAdmin ? ['backups'] : [])] as Tab[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)} data-tab={t}>
              {t === 'reports' ? <>Reports{waiting > 0 && <span className="admin-badge inline" data-testid="modq-tab-badge"> {waiting}</span>}</> : t === 'bans' ? 'Active bans' : t === 'users' ? 'Users' : t === 'log' ? 'Action log' : 'Backups'}
            </button>
          ))}
        </nav>
        <div className="top-actions">
          <GamesButton onOpen={onGames} />
          <div className="me-chip">{account!.username} <RoleTag role={account!.role} /></div>
          <button className="btn ghost small-btn" onClick={onBack}>Back to chat</button>
        </div>
      </header>
      <main className="admin-main">
        <GamesSlot />
        {error && <div className="form-error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        {isAdmin && (
          <section className="panel mod-bot-setting">
            <h2>Moderator bot</h2>
            <p className="muted small">One bot can kick and ban in every room. Every other bot can only send messages. The choice is saved immediately. Admins, and the bot itself, are protected.</p>
            <p className="small" data-current-moderator={modBotId || 'none'}>Current moderator bot: <strong>{modBots.find((b) => String(b.id) === modBotId)?.name ?? 'None'}</strong></p>
            <label className="mod-bot-row" htmlFor="moderator-bot">
              <span>Moderator bot</span>
              <select
                id="moderator-bot"
                aria-label="Moderator bot"
                data-setting="moderator-bot"
                value={modBotId}
                onChange={(e) => {
                  const next = e.target.value;
                  const prev = modBotId;
                  setModBotId(next);
                  void (async () => {
                    try {
                      await api('/api/admin/moderator-bot', { botId: next ? Number(next) : null });
                      setNotice(next ? 'Moderator bot updated' : 'Moderator bot cleared');
                      setTimeout(() => setNotice(''), 3000);
                    } catch (err) {
                      setModBotId(prev);
                      setError((err as Error).message);
                    }
                  })();
                }}
              >
                <option value="">None</option>
                {modBots.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
              </select>
            </label>
          </section>
        )}
      {resetLink && <div className="panel" style={{ margin: '12px 24px' }}><code className="mono" style={{ wordBreak: 'break-all' }}>{resetLink}</code>
        <button className="btn small-btn" onClick={() => { navigator.clipboard?.writeText(resetLink); setNotice('Copied'); }}>Copy</button>
        <button className="btn ghost small-btn" onClick={() => setResetLink('')}>Dismiss</button></div>}

        {tab === 'reports' && (
          <section>
            <div className="section-head"><h2>Reports</h2></div>
            <ModQueue mode="site" toast={(t, tone) => { if (tone === 'error') setError(t); else { setError(''); setNotice(t); setTimeout(() => setNotice(''), 3000); } }} />
          </section>
        )}
        {tab === 'bans' && (
          <section>
            <div className="section-head"><h2>Active bans</h2></div>
            <form className="inline-form panel" onSubmit={addBan}>
              <select value={newBan.kind} onChange={(e) => setNewBan({ ...newBan, kind: e.target.value as BanKind })} aria-label="Ban type">
                <option value="account">Account (username)</option><option value="ip">IP address</option><option value="device">Device id</option>
              </select>
              <input placeholder={newBan.kind === 'account' ? 'username' : newBan.kind === 'ip' ? '203.0.113.7' : 'device id'} aria-label={newBan.kind === 'account' ? 'Username to ban' : newBan.kind === 'ip' ? 'IP address to ban' : 'Device id to ban'} value={newBan.value} onChange={(e) => setNewBan({ ...newBan, value: e.target.value })} />
              <button className="btn danger-btn small-btn">Add ban…</button>
            </form>
            <table className="table">
              <thead><tr><th>Type</th><th>Who</th><th>Reason</th><th>By</th><th>Since</th><th>Expires</th><th /></tr></thead>
              <tbody>
                {bans.map((b) => (
                  <tr key={b.id} data-ban={b.id}>
                    <td><span className="tag">{b.kind}</span></td>
                    <td>{b.label ?? ''} <span className="muted small mono">{b.kind === 'account' ? `#${b.value}` : b.value}</span></td>
                    <td>{b.reason}</td><td>{b.createdBy}</td><td>{fmt(b.createdAt)}</td><td>{b.expiresAt ? fmt(b.expiresAt) : <strong>permanent</strong>}</td>
                    <td><button className="btn ghost small-btn" onClick={() => run(() => api(`/api/admin/bans/${b.id}/lift`, {}), 'Ban lifted')} data-action="unban">Unban</button></td>
                  </tr>
                ))}
                {bans.length === 0 && <tr><td colSpan={7} className="muted">No active bans.</td></tr>}
              </tbody>
            </table>
          </section>
        )}

        {tab === 'users' && (
          <section>
            <div className="section-head">
              <h2>Users</h2>
              <input className="search" placeholder="Search username or email" aria-label="Search username or email" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <table className="table">
              <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Joined</th><th>Last login</th><th>Status</th><th /></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} data-user={u.username}>
                    <td className="admin-user-cell"><UserAvatar nick={u.username} accountId={u.id} chatColor={u.chatColor} hasAvatar={u.hasAvatar} size={22} /> <strong>{u.username}</strong> {u.google && <span className="tag">google</span>} {u.discord && <span className="tag">discord</span>} {u.tiktok && <span className="tag">TikTok linked</span>}</td>
                    <td>
                      <form className="inline-form" key={`${u.id}:${u.email ?? ''}:${u.emailVerified}`} onSubmit={(e) => { e.preventDefault(); const email = String(new FormData(e.currentTarget).get('email') || ''); void run(() => api(`/api/admin/users/${u.id}/email`, { email }), 'Email updated'); }}>
                        <input name="email" aria-label={`Email of ${u.username}`} defaultValue={u.email ?? ''} />
                        <button className="btn ghost small-btn" type="submit">Save</button>
                        {u.emailVerified ? <span className="tag">verified</span> : <button type="button" className="btn ghost small-btn" data-action="mark-verified" onClick={() => void run(() => api(`/api/admin/users/${u.id}/email`, { verified: true }), 'Marked verified')}>Mark verified</button>}
                      </form>
                    </td>
                    <td>
                      {isAdmin && u.id !== account!.id ? (
                        <select value={u.role} aria-label={`Role of ${u.username}`} onChange={(e) => run(() => api(`/api/admin/users/${u.id}/role`, { role: e.target.value as Role }), `${u.username} is now ${e.target.value}`)}>
                          <option value="user">user</option><option value="moderator">moderator</option><option value="admin">admin</option>
                        </select>
                      ) : <span>{u.role}</span>}
                    </td>
                    <td>{fmt(u.createdAt)}</td><td>{fmt(u.lastLoginAt)}</td>
                    <td>{u.banned ? <span className="tag status-open">banned</span> : <span className="muted small">ok</span>}</td>
                    <td className="row-actions">
                      {(u.role === 'user' || (isAdmin && u.role === 'moderator')) && <button className="btn ghost small-btn" onClick={() => banAccount(u)}>Ban…</button>}
                      <button className="btn ghost small-btn" onClick={() => issueReset(u)} data-action="issue-reset">Issue reset</button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td colSpan={7} className="muted">No users found.</td></tr>}
              </tbody>
            </table>
            {!isAdmin && <p className="muted small">Only admins can change roles.</p>}
          </section>
        )}

        {tab === 'backups' && isAdmin && <AdminBackups onError={setError} onNotice={(m) => { setNotice(m); setTimeout(() => setNotice(''), 3000); }} />}

        {tab === 'log' && (
          <section>
            <div className="section-head"><h2>Recent moderation actions</h2><button className="btn ghost small-btn" onClick={load}>Refresh</button></div>
            <table className="table">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Room</th><th>Details</th></tr></thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.id}><td>{fmt(l.ts)}</td><td>{l.actor}</td><td><span className="tag">{l.action}</span></td><td>{l.target ?? ''}</td><td>{l.roomId ? `#${l.roomId}` : ''}</td><td className="small">{l.details ?? ''}</td></tr>
                ))}
                {log.length === 0 && <tr><td colSpan={6} className="muted">Nothing yet.</td></tr>}
              </tbody>
            </table>
          </section>
        )}
      </main>
      {dialog && <Dialog spec={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
