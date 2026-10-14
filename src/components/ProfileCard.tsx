import { useEffect, useMemo, useState, useRef } from 'react';
import { useModal } from '../a11y';
import type { PublicProfile } from '../../shared/types';
import { api } from '../api';
import { renderBioMarkdown } from '../markdown';
import { call, socket } from '../socket';
import { BadgeCard } from './Badges';
import { RoleTag } from './RoleTag';
import { NickLabel, UserAvatar } from './UserAvatar';

/** Profile card opened from a name: avatar, bio, badges, joined date, rooms they own, friend status; Add friend / Message / Block. */
export function ProfileCard({ nick, onClose, toast, isIgnored, toggleIgnore, openPm, onWhisper, onOpenRoom, roomMod, onReport }: {
  nick: string;
  onClose: () => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
  isIgnored: boolean;
  toggleIgnore: () => void;
  openPm: (t: { id: string; nick: string }) => void;
  onWhisper?: () => void;
  onOpenRoom?: (roomId: string) => void;
  roomMod?: boolean;
  /** opens the report dialog for this account */
  onReport?: (p: { id: number; username: string }) => void;
}) {
  const [p, setP] = useState<PublicProfile | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<{ profile: PublicProfile }>(`/api/users/${encodeURIComponent(nick)}/profile`).then((r) => setP(r.profile)).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, [nick]); // eslint-disable-line react-hooks/exhaustive-deps
  const bioHtml = useMemo(() => renderBioMarkdown(p?.bio ?? ''), [p?.bio]);
  const friend = async () => {
    if (!p) return;
    setBusy(true);
    try {
      if (p.friend === 'pending-in') await call((ack) => socket.emit('friends:respond', { userId: p.id, accept: true }, ack));
      else await call((ack) => socket.emit('friends:request', { username: p.username }, ack));
      toast(p.friend === 'pending-in' ? `You and ${p.username} are now friends` : 'Friend request sent');
      await load();
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const friendLabel = !p ? '' : p.friend === 'friends' ? 'Friends ✓' : p.friend === 'pending-out' ? 'Request sent' : p.friend === 'pending-in' ? 'Accept friend' : 'Add friend';
  const modalRef = useRef<HTMLDivElement>(null);
  useModal(modalRef, onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={modalRef} className="modal panel profile-card" role="dialog" aria-modal="true" aria-label={`Profile of ${nick}`} onClick={(e) => e.stopPropagation()} data-profile={nick}>
        {!p && !error && <p className="muted">Loading…</p>}
        {error && <p className="muted">{error}</p>}
        {p && (
          <>
            <div className="pc-head">
              <UserAvatar nick={p.username} accountId={p.id} chatColor={p.chatColor} hasAvatar={p.hasAvatar} size={64} />
              <div className="pc-id">
                <NickLabel nick={p.username} chatColor={p.chatColor} chatEffect={p.chatEffect} className="pc-name" />
                <span className="pc-tags">
                  <RoleTag role={p.role} />
                  {roomMod && <span className="tag room-mod" title="Room moderator">mod</span>}
                  <span className={`pc-online${p.online ? ' on' : ''}`}>{p.online ? 'online' : 'offline'}</span>
                </span>
                <span className="muted small">Joined {new Date(p.joinedAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}</span>
              </div>
            </div>
            {bioHtml ? <div className="pc-bio md" data-bio="1" dangerouslySetInnerHTML={{ __html: bioHtml }} /> : <p className="muted small pc-bio">No bio yet.</p>}
            <BadgeCard ids={p.badges} />
            {p.rooms.length > 0 && (
              <div className="pc-rooms">
                <span className="muted small">Rooms</span>
                <span className="pc-room-list">
                  {p.rooms.slice(0, 8).map((r) => (
                    <button key={r.id} type="button" className="tag pc-room" data-room={r.id} onClick={() => onOpenRoom?.(r.id)} disabled={!onOpenRoom}>#{r.name}</button>
                  ))}
                </span>
              </div>
            )}
            {p.friend !== 'self' && (
              <div className="pc-actions">
                <button type="button" className={`btn small-btn ${p.friend === 'none' || p.friend === 'pending-in' ? 'primary' : 'ghost'}`} data-action="add-friend" disabled={busy || p.friend === 'friends' || p.friend === 'pending-out'} onClick={() => void friend()}>{friendLabel}</button>
                <button type="button" className="btn small-btn ghost" data-action="message" disabled={!p.online || !p.socketId || isIgnored} title={p.online ? 'Private message' : 'Offline'} onClick={() => { if (p.socketId) { openPm({ id: p.socketId, nick: p.username }); onClose(); } }}>Message</button>
                {onWhisper && <button type="button" className="btn small-btn ghost" data-action="whisper" onClick={() => { onWhisper(); onClose(); }}>🤫 Whisper</button>}
                <button type="button" className="btn small-btn ghost danger" data-action="block" onClick={() => { toggleIgnore(); onClose(); }}>{isIgnored ? 'Unblock' : 'Block'}</button>
                {onReport && <button type="button" className="btn small-btn ghost" data-action="report-profile" onClick={() => onReport({ id: p.id, username: p.username })}>Report…</button>}
              </div>
            )}
          </>
        )}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose} data-action="profile-close">Close</button></div>
      </div>
    </div>
  );
}
