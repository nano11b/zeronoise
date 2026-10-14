import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UserInfo } from '../../shared/types';
import { chatColorHex, isChatColorId } from '../../shared/colors';
import { applyAudioOutput } from '../mediaDevices';
import { colorFor } from '../util';
import { Icon } from '../icons';
import type { ClipRecorder } from '../clipRecorder';
import type { ViewPref } from '../../shared/videoQuality';

/** Same check as clipRecorder's, kept here so the recorder code loads only when clip-ready is turned on. */
const clipSupported = () => typeof MediaRecorder !== 'undefined'
  && ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].some((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });

interface Props {
  user: UserInfo;
  stream: MediaStream | null;
  /** Remote screen-share audio on its own stream (played by a hidden <audio>, never by the video). */
  shareAudio?: MediaStream | null;
  isSelf: boolean;
  muted: boolean;
  big: boolean;
  speaking?: boolean;
  onToggleMute?: () => void;
  onClick: () => void;
  /** Hide this person's video locally. Audio is muted with it. */
  unwatched?: boolean;
  onToggleWatch?: () => void;
  /** Wide layout only: drag this tile's camera dock into a drop box. */
  onDockGrip?: (e: PointerEvent<HTMLButtonElement>) => void;
  /** Pixel size chosen so every tile fits in the video pane. */
  box?: { w: number; h: number };
  /** Report the frame's aspect so the pane can scale every tile together. */
  onLayout?: (info: { ar: number; audioOnly: boolean }) => void;
  /** batch 3: opt-in rolling clip buffer; called after a clip was saved to this device */
  onClipSaved?: (seconds: number) => void;
  onClipError?: (message: string) => void;
  /** remote tiles: what I asked this sender for (full / lower / paused video; audio always stays on) */
  viewPref?: ViewPref;
  onViewPref?: (p: ViewPref) => void;
  /** own tile: Auto quality note, e.g. "Lowered quality: weak connection" */
  notice?: string | null;
}

export function VideoTile({ user, stream, shareAudio, isSelf, muted, big, speaking, onToggleMute, onClick, unwatched, onToggleWatch, onDockGrip, box, onLayout, onClipSaved, onClipError, viewPref = 'full', onViewPref, notice }: Props) {
  /** the tile clips its content, so the menu is portalled to <body> at the button's position */
  const [menuAt, setMenuAt] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const menuOpen = !!menuAt;
  const setMenuOpen = (open: boolean | ((v: boolean) => boolean)) => {
    const next = typeof open === 'function' ? open(menuOpen) : open;
    if (!next) { setMenuAt(null); return; }
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    setMenuAt({ left: b.left, right: b.right, top: b.top, bottom: b.bottom });
  };
  // Place the menu above the button (below if there is no room), right-aligned to it, kept inside the viewport.
  useLayoutEffect(() => {
    const m = menuRef.current;
    if (!m || !menuAt) return;
    const W = window.innerWidth, H = window.innerHeight, pad = 6;
    const w = m.offsetWidth, h = m.offsetHeight;
    const left = Math.min(Math.max(pad, menuAt.right - w), Math.max(pad, W - w - pad));
    const above = menuAt.top - 4 - h;
    const top = above >= pad ? above : Math.min(menuAt.bottom + 4, Math.max(pad, H - h - pad));
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
    m.style.visibility = 'visible';
  }, [menuAt]);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: Event) => { const t = e.target as Node; if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setMenuOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenuOpen(false); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', esc, true);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const gone = () => setMenuOpen(false);
    window.addEventListener('resize', gone);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', esc, true); window.removeEventListener('resize', gone); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);
  const ref = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    const play = () => { v.play().catch(() => {}); };
    play();
    // Remote (and any unmuted) playback uses the chosen speaker when setSinkId exists.
    if (!isSelf) applyAudioOutput(v).catch(() => {});
    if (!stream) return;
    // New tracks (e.g. audio after glare renegotiation) arrive on the same MediaStream object
    const onAdd = () => {
      play();
      if (!isSelf) applyAudioOutput(v).catch(() => {});
    };
    stream.addEventListener('addtrack', onAdd);
    stream.getTracks().forEach((t) => t.addEventListener('unmute', play));
    return () => {
      stream.removeEventListener('addtrack', onAdd);
      stream.getTracks().forEach((t) => t.removeEventListener('unmute', play));
    };
  }, [stream, isSelf]);

  // The tile's box follows the real frame (local and remote). `resize` covers mid-call resolution changes.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const measure = () => {
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (w > 0 && h > 0) setFrame((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    v.addEventListener('loadedmetadata', measure);
    v.addEventListener('resize', measure);
    return () => {
      v.removeEventListener('loadedmetadata', measure);
      v.removeEventListener('resize', measure);
    };
  }, [stream]);

  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.srcObject !== (shareAudio ?? null)) a.srcObject = shareAudio ?? null;
    if (!shareAudio) return;
    const play = () => { a.play().catch(() => {}); };
    // Same speaker as the rest of the room (setSinkId), then start; unlockAudio retries after a gesture.
    applyAudioOutput(a).catch(() => {}).finally(play);
    shareAudio.getTracks().forEach((t) => t.addEventListener('unmute', play));
    return () => { shareAudio.getTracks().forEach((t) => t.removeEventListener('unmute', play)); };
  }, [shareAudio, user.screen, isSelf]);

  const canWatch = !isSelf && (user.cam || user.screen);
  const hidden = !!unwatched && canWatch;
  const paused = !isSelf && viewPref === 'paused' && !hidden && (user.cam || user.screen);
  const showVideo = !hidden && !paused && (user.cam || user.screen) && !!stream?.getVideoTracks().some((t) => t.readyState === 'live');
  const hasShareAudio = !isSelf && user.screen && !!shareAudio?.getAudioTracks().some((t) => t.readyState === 'live');
  // One "Mute for me" covers everything this tile plays (mic and screen audio).
  const canMute = !isSelf && (user.mic || hasShareAudio);
  useEffect(() => {
    const broadcasting = !!(user.cam || user.screen);
    const audioOnly = !showVideo && !paused;
    const ar = showVideo && frame && frame.h > 0 ? frame.w / frame.h : 4 / 3;
    onLayout?.({ ar, audioOnly: audioOnly || !broadcasting });
  }, [onLayout, showVideo, frame, user.cam, user.screen]);

  // ---- clip recorder (opt-in per tile; stops when the tile, the stream or the video goes away / is hidden) ----
  const [clipReady, setClipReady] = useState(false);
  const [clipBusy, setClipBusy] = useState(false);
  const clipRef = useRef<ClipRecorder | null>(null);
  const canClip = !!onClipSaved && showVideo && clipSupported();
  useEffect(() => {
    if (!clipReady || !canClip || !stream) { if (clipReady && !canClip) setClipReady(false); return; }
    let rec: ClipRecorder | null = null;
    let gone = false;
    import('../clipRecorder').then(({ ClipRecorder: Rec }) => {
      if (gone) return;
      try { rec = new Rec(stream); rec.start(); } catch (e) { onClipError?.((e as Error).message); setClipReady(false); return; }
      clipRef.current = rec;
    }).catch(() => { if (!gone) { onClipError?.('Could not load the clip recorder'); setClipReady(false); } });
    return () => { gone = true; const r = rec; r?.stop(); if (r && clipRef.current === r) clipRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipReady, canClip, stream]);
  const saveClip = async () => {
    const rec = clipRef.current;
    if (!rec || clipBusy) return;
    setClipBusy(true);
    try {
      const { blob, seconds } = await rec.save();
      const d = new Date(); const p2 = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`; // local time
      const { downloadBlob } = await import('../clipRecorder');
      downloadBlob(blob, `clip-${user.nick.replace(/[^A-Za-z0-9_-]/g, '') || 'stream'}-${stamp}.webm`);
      onClipSaved?.(seconds);
    } catch (e) { onClipError?.((e as Error).message || 'Could not save the clip'); }
    finally { setClipBusy(false); }
  };

  const frameStyle: CSSProperties = {
    ...(box ? { width: `${box.w}px`, height: `${box.h}px` } : {}),
  };
  return (
    <div
      className={`tile ${big ? 'big' : ''} ${showVideo ? '' : 'audio-only'} ${user.screen ? 'screen' : ''} ${speaking ? 'speaking' : ''} ${hidden ? 'unwatched' : ''}`}
      style={frameStyle}
      onClick={onClick}
      data-user={user.nick}
      data-frame={showVideo && frame ? `${frame.w}x${frame.h}` : undefined}
      data-tile={box ? `${box.w}x${box.h}` : undefined}
      title="Click to enlarge"
      data-speaking={speaking ? '1' : '0'}
    >
      {speaking && <div className="speak-ring" aria-hidden />}
      {clipReady && canClip && <div className="clip-badge" data-clip-ready="1" title="Clip-ready: only you see this; the last ~30 s stay in this browser">● CLIP</div>}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={isSelf || muted || hidden}
        // mirror only local camera, never screen share
        className={isSelf && !user.screen ? 'mirror' : ''}
        style={{ visibility: showVideo ? 'visible' : 'hidden', width: '100%', height: '100%', objectFit: 'contain' }}
      />
      {!isSelf && user.screen && (
        <audio ref={audioRef} data-share-audio="1" autoPlay muted={muted || hidden} hidden />
      )}
      {!showVideo && (
        user.hasAvatar && user.accountId
          ? <img className="avatar img" src={`/api/avatars/${user.accountId}.webp`} alt="" width={72} height={72} loading="lazy" />
          : <div className="avatar" style={{ background: chatColorHex(isChatColorId(user.chatColor) ? user.chatColor : null) || colorFor(user.nick) }}>{user.nick.slice(0, 1).toUpperCase()}</div>
      )}
      <div className="tile-bar">
        <span className="tile-name">{user.nick}{isSelf && ' (you)'}{user.screen ? ' · screen' : ''}</span>
        <span className="tile-icons">
          {onDockGrip && (
            <button type="button" className="icon-btn dock-grip" title="Move cameras" aria-label="Move cameras" onPointerDown={onDockGrip} onClick={(e) => e.stopPropagation()}>
              <Icon name="grip" size={14} />
            </button>
          )}
          {canClip && (
            <button type="button" className={`icon-btn clip-toggle${clipReady ? ' on' : ''}`} data-action="clip-ready" aria-pressed={clipReady} onClick={(e) => { e.stopPropagation(); setClipReady((v) => !v); }} title={clipReady ? 'Stop clip buffer' : 'Clip-ready: keep the last ~30 s here (nothing is uploaded)'} aria-label={clipReady ? 'Stop clip buffer' : 'Turn clip-ready on'}>⏺</button>
          )}
          {canClip && clipReady && (
            <button type="button" className="icon-btn clip-save" data-action="clip-save" disabled={clipBusy} onClick={(e) => { e.stopPropagation(); void saveClip(); }} title="Save the last ~30 s as a .webm" aria-label="Save clip">✂</button>
          )}
          {canWatch && !hidden && onViewPref && (
            <span className="tile-menu-wrap">
              <button ref={btnRef} type="button" className={`icon-btn tile-menu-btn${viewPref !== 'full' ? ' on' : ''}`} data-action="tile-menu" aria-haspopup="menu" aria-expanded={menuOpen} onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }} title="Video options" aria-label={`Video options for ${user.nick}`}>⋯</button>
              {menuAt && createPortal(
                <div ref={menuRef} className="tile-menu" role="menu" aria-label={`Video options for ${user.nick}`} style={{ left: 0, top: 0, visibility: 'hidden' }} onClick={(e) => e.stopPropagation()}>
                  <button type="button" role="menuitem" data-action="view-low" aria-checked={viewPref === 'low'} onClick={() => { onViewPref(viewPref === 'low' ? 'full' : 'low'); setMenuOpen(false); }}>
                    {viewPref === 'low' ? 'Back to full quality' : 'Lower quality for me'}
                  </button>
                  <button type="button" role="menuitem" data-action="view-pause" aria-checked={viewPref === 'paused'} onClick={() => { onViewPref(viewPref === 'paused' ? 'full' : 'paused'); setMenuOpen(false); }}>
                    {viewPref === 'paused' ? 'Resume video' : 'Pause video (keep audio)'}
                  </button>
                  <p className="tile-menu-note">Only changes what you receive.</p>
                </div>,
                document.body,
              )}
            </span>
          )}
          {canWatch && (
            <button type="button" className="icon-btn" data-action={hidden ? 'watch' : 'unwatch'} onClick={(e) => { e.stopPropagation(); onToggleWatch?.(); }} title={hidden ? 'Watch' : 'Unwatch'} aria-label={hidden ? 'Watch' : 'Unwatch'}>
              <Icon name={hidden ? 'eye' : 'eyeOff'} size={14} />
            </button>
          )}
          {user.mic ? <span title="Mic on">🎙</span> : <span className="off" title="Mic off">🎙</span>}
          {!isSelf && user.screen && (hasShareAudio
            ? <span className="share-audio" title="Screen audio" data-share-audio-state="on">🔈</span>
            : <span className="share-audio off" title="No screen audio" data-share-audio-state="off">🔈</span>)}
          {canMute && (
            <button type="button" className="icon-btn" data-action={muted ? 'unmute' : 'mute'} onClick={(e) => { e.stopPropagation(); onToggleMute?.(); }} title={muted ? 'Unmute for me' : 'Mute for me'} aria-label={muted ? `Unmute ${user.nick}` : `Mute ${user.nick}`}>
              {muted ? '🔇' : '🔊'}
            </button>
          )}
        </span>
      </div>
      {hidden && <div className="tile-status">Unwatched</div>}
      {paused && <div className="tile-status" data-view-paused="1">Video paused · audio on</div>}
      {!paused && !isSelf && viewPref === 'low' && showVideo && <div className="tile-chip" data-view-low="1" title="You asked for lower quality">Low</div>}
      {isSelf && notice && <div className="tile-vq-note" role="status" data-vq-notice="1">{notice}</div>}
      {!hidden && !isSelf && !stream && (user.cam || user.mic || user.screen) && <div className="tile-status">connecting…</div>}
    </div>
  );
}
