import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ThemePicker } from './ThemePicker';
import type { UserInfo } from '../../shared/types';
import { placeFixedBelow, useDismiss } from '../dropdown';
import type { Account } from '../App';
import { Icon } from '../icons';
import { Logo } from './Login';
import { Lazy, lazyNamed } from '../lazy';
import { RoleTag } from './RoleTag';
import { NickLabel, UserAvatar } from './UserAvatar';
import { useStaffCounts } from '../modq';

const loadProfile = () => import('./ProfilePanel');
const ProfilePanel = lazyNamed(loadProfile, 'ProfilePanel');

/** Shared top bar: logo, centered section buttons, online status, and the name chip. */
export function SiteBar({
  me, account, onAccount, toast, signOut, openAdmin, wantAccount, showGuestActions, onAudioVideo, extras, children,
}: {
  me: UserInfo;
  account?: Account | null;
  onAccount?: (a: Account) => void;
  toast: (t: string, tone?: 'error' | 'info') => void;
  signOut?: () => void;
  openAdmin?: () => void;
  wantAccount?: (m: 'signin' | 'register') => void;
  showGuestActions?: boolean;
  /** Opens the audio and video settings dialog. Shown in the profile menu. */
  onAudioVideo?: () => void;
  extras?: ReactNode;
  children?: ReactNode;
}) {
  const staff = me.role === 'admin' || me.role === 'moderator';
  const queue = useStaffCounts();
  const waiting = staff ? queue.open + queue.review : 0;
  const profileRef = useRef<HTMLDivElement>(null);
  const profilePanelRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  // The profile panel loads the first time it opens, then stays mounted.
  const [profileEver, setProfileEver] = useState(false);
  if (profileOpen && !profileEver) setProfileEver(true);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  const closeStatus = useCallback(() => setStatusOpen(false), []);
  useDismiss(!!account && profileOpen, profileRef, closeProfile);
  useDismiss(statusOpen, statusRef, closeStatus);
  useLayoutEffect(() => {
    if (!profileOpen) return;
    const anchor = profileRef.current;
    const panel = profilePanelRef.current;
    if (!anchor || !panel) return;
    const run = () => placeFixedBelow(anchor, panel);
    run();
    window.addEventListener('resize', run);
    window.addEventListener('scroll', run, true);
    // Content can arrive after open (lazy chunk), so re-place when the panel resizes.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(run) : null;
    ro?.observe(panel);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', run);
      window.removeEventListener('scroll', run, true);
    };
  }, [profileOpen]);

  return (
    <header className="topbar" onClick={(e) => e.stopPropagation()}>
      <div className="brand"><Logo /> <img className="wordmark" src="/logo-wordmark.png" alt="zeronoise" width={512} height={80} /></div>
      <nav className="top-nav" aria-label="Sections">{children}</nav>
      <div className="top-actions">
        {extras}
        {staff && openAdmin && (
          <button type="button" className="btn ghost small-btn admin-btn" onClick={openAdmin} data-action="admin" title="Mod panel" aria-label={waiting ? `Mod panel, ${waiting} report${waiting === 1 ? '' : 's'} waiting` : 'Mod panel'}>
            <Icon name="settings" />
            <span className="admin-label">Mod panel</span>
            {waiting > 0 && <span className="admin-badge" data-testid="modq-badge" aria-hidden="true">{waiting > 99 ? '99+' : waiting}</span>}
          </button>
        )}
        {!account && wantAccount && (
        <div className="status-pop" ref={statusRef}>
          <button
            type="button"
            className={`status-btn account-btn${statusOpen ? ' open' : ''}`}
            aria-expanded={statusOpen}
            aria-haspopup="menu"
            aria-label="Account"
            data-action="account"
            onClick={() => setStatusOpen((v) => !v)}
          >
            <Icon name="user" />
            <span className="account-label">Account</span>
          </button>
          {statusOpen && (
            <div className="status-menu" role="menu" aria-label="Account">
              <a role="menuitem" href="/download" data-action="get-app-menu">Get the app</a>
              <button type="button" role="menuitem" onClick={() => { setStatusOpen(false); wantAccount('signin'); }}>Sign in</button>
              <button type="button" role="menuitem" onClick={() => { setStatusOpen(false); wantAccount('register'); }}>Register</button>
              <ThemePicker />
            </div>
          )}
        </div>
        )}
        {account && onAccount ? (
          <div className="me-pop" ref={profileRef}>
            <button
              type="button"
              className={`me-chip me-chip-btn${profileOpen ? ' open' : ''}`}
              aria-expanded={profileOpen}
              aria-haspopup="dialog"
              data-action="profile"
              onClick={() => setProfileOpen((v) => !v)}
              onPointerEnter={() => { void loadProfile().catch(() => {}); }}
            >
              <UserAvatar nick={me.nick} accountId={me.accountId} chatColor={me.chatColor} hasAvatar={me.hasAvatar} size={22} />
              <NickLabel nick={me.nick} chatColor={me.chatColor} chatEffect={me.chatEffect} />
              <RoleTag role={me.role} />
            </button>
            <div className="me-pop-panel" ref={profilePanelRef} hidden={!profileOpen} role="dialog" aria-label="Your profile">
              {profileEver && <Lazy fallback={<p className="muted">Loading…</p>}><ProfilePanel
                account={account}
                onAccount={onAccount}
                toast={toast}
                signOut={signOut ? () => { setProfileOpen(false); signOut(); } : undefined}
                onAudioVideo={onAudioVideo ? () => { setProfileOpen(false); onAudioVideo(); } : undefined}
              /></Lazy>}
            </div>
          </div>
        ) : (
          <div className="me-chip"><UserAvatar nick={me.nick} accountId={me.accountId} chatColor={me.chatColor} hasAvatar={me.hasAvatar} size={22} /> <NickLabel nick={me.nick} chatColor={me.chatColor} chatEffect={me.chatEffect} /> <RoleTag role={me.role} /></div>
        )}
        {showGuestActions && !account && wantAccount && (
          <>
            <button className="btn ghost small-btn guest-action" onClick={() => wantAccount('signin')}>Sign in</button>
            <button className="btn primary small-btn guest-action" onClick={() => wantAccount('register')}>Register</button>
          </>
        )}
      </div>
    </header>
  );
}
