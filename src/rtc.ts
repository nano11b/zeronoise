import { APP_NAME } from '../shared/config';
import type { SignalData } from '../shared/types';
import { classifyRemoteTrack } from '../shared/shareAudio';
import { getIceServers, type AppSocket } from './socket';
import { cameraEncoding, shareSettings, type EncodingParams, type LevelId, type ShareMode, type ViewPref } from '../shared/videoQuality';

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  senders: { video?: RTCRtpSender; audio?: RTCRtpSender; shareAudio?: RTCRtpSender };
  queue: Promise<void>;
  stream: MediaStream | null;
  /** remote's announced screen-share audio stream id (from its description signals) */
  shareStreamId: string | null;
  /** live remote screen-share audio tracks, kept off `stream` so the tile video never plays them */
  shareTracks: MediaStreamTrack[];
  restartTimer: ReturnType<typeof setTimeout> | null;
  restartAttempt: number;
  /** what this remote viewer asked of our video */
  pref: ViewPref;
  /** the receive preference we last sent to this remote */
  sentWant: ViewPref;
}

/**
 * Full-mesh WebRTC manager using the "perfect negotiation" pattern.
 * Sending uses dedicated sendonly transceivers (not addTrack) so glare rollback
 * cannot attach our send track to a transceiver that was receiving remote media.
 */
export class Mesh {
  private peers = new Map<string, Peer>();
  private tracks: { video: MediaStreamTrack | null; audio: MediaStreamTrack | null } = { video: null, audio: null };
  /** display/tab audio. Never replaces the microphone sender. */
  private shareAudio: MediaStreamTrack | null = null;
  /** camera track kept while screen-sharing so we can restore it */
  private cameraHold: MediaStreamTrack | null = null;
  readonly local = new MediaStream();
  /** Own msid for display audio, distinct from `local`, so receivers can classify it. */
  readonly shareStream = new MediaStream();
  /** remote tracks classified as screen-share audio (speaking indicator ignores them) */
  private shareTrackSet = new WeakSet<MediaStreamTrack>();
  /** camera send cap (null = browser defaults) and screen-share mode */
  private vq: { level: LevelId | null; share: ShareMode; sharing: boolean } = { level: null, share: 'detail', sharing: false };
  /** receive preferences we want from each remote (by current socket id) */
  private wants = new Map<string, ViewPref>();

  constructor(
    private socket: AppSocket,
    private selfId: string,
    private iceServers: RTCIceServer[],
    private onStream: (peerId: string, stream: MediaStream | null) => void,
    private onShareAudio: (peerId: string, stream: MediaStream | null) => void = () => {},
  ) {}

  /** Socket id changed after a signaling reconnect. Existing peers keep their polite bit. */
  adoptId(id: string) {
    if (id) this.selfId = id;
  }

  /** Route signaling to a peer's new socket id without closing the RTCPeerConnection. */
  renamePeer(from: string, to: string) {
    if (!from || !to || from === to) return;
    const peer = this.peers.get(from);
    if (!peer) return;
    this.peers.delete(from);
    const occupied = this.peers.get(to);
    if (occupied && occupied !== peer) this.closePeer(to, occupied);
    this.peers.set(to, peer);
    const w = this.wants.get(from);
    if (w) { this.wants.delete(from); this.wants.set(to, w); }
  }

  isShareAudioTrack(track: MediaStreamTrack | null | undefined) {
    return !!track && this.shareTrackSet.has(track);
  }

  get hasLocalTracks() {
    return !!(this.tracks.video || this.tracks.audio);
  }

  get videoTrack() { return this.tracks.video; }
  get audioTrack() { return this.tracks.audio; }

  /** Live peer RTCPeerConnections for stats / speaking indicators. */
  peerConnections(): Iterable<[string, RTCPeerConnection]> {
    return [...this.peers.entries()].map(([id, p]) => [id, p.pc] as [string, RTCPeerConnection]);
  }

  private send(to: string, data: SignalData) {
    const out: SignalData = data.type === 'description' ? { ...data, shareStream: this.shareStream.id } : data;
    this.socket.emit('rtc:signal', { to, data: out });
  }

  private relayOnly() {
    try { return localStorage.getItem(`${APP_NAME.toLowerCase()}.relay`) === '1'; } catch { return false; }
  }

  ensurePeer(id: string): Peer {
    const existing = this.peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: this.relayOnly() ? 'relay' : 'all' });
    const peer: Peer = {
      pc, polite: this.selfId > id, makingOffer: false, ignoreOffer: false, senders: {}, queue: Promise.resolve(),
      stream: null, shareStreamId: null, shareTracks: [], restartTimer: null, restartAttempt: 0,
      pref: 'full', sentWant: 'full',
    };
    this.peers.set(id, peer);

    pc.onicecandidate = ({ candidate }) => {
      const to = this.idOf(peer);
      if (candidate && to) this.send(to, { type: 'candidate', candidate: candidate.toJSON() });
    };
    pc.onnegotiationneeded = async () => {
      const to = this.idOf(peer);
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        await this.sendDescription(peer, to);
      } catch (e) {
        console.warn('negotiation failed', e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.ontrack = (e) => {
      const who = () => this.idOf(peer);
      const role = classifyRemoteTrack(e.track.kind, e.streams.map((x) => x.id), peer.shareStreamId);
      if (role === 'shareAudio') {
        // A media element plays only the first audio track of a MediaStream (Chrome),
        // so display audio gets its own stream and its own <audio> element.
        this.shareTrackSet.add(e.track);
        if (!peer.shareTracks.includes(e.track)) peer.shareTracks.push(e.track);
        const drop = () => {
          peer.shareTracks = peer.shareTracks.filter((t) => t !== e.track);
          const id = who();
          if (id) this.emitShare(id, peer);
        };
        e.track.addEventListener('ended', drop, { once: true });
        e.track.addEventListener('unmute', () => { const id = who(); if (id) this.emitShare(id, peer); });
        const id = who();
        if (id) this.emitShare(id, peer);
        return;
      }
      // Prefer a stable stream object so UI effects see track additions.
      let stream = peer.stream;
      if (!stream) {
        stream = e.streams[0] ? e.streams[0] : new MediaStream();
        peer.stream = stream;
      }
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
      e.track.addEventListener('unmute', () => { const id = who(); if (id) this.onStream(id, stream); }, { once: true });
      e.track.addEventListener('ended', () => {
        stream.removeTrack(e.track);
        const id = who();
        if (id) this.onStream(id, stream.getTracks().length ? stream : null);
      });
      const id = who();
      if (id) this.onStream(id, stream);
    };
    const watch = () => {
      this.scheduleRestart(peer);
      // encodings set before the first negotiation may be ignored; re-apply once media flows
      if (this.linkUp(pc)) { void this.applyEncoding(peer); this.flushWant(peer); }
    };
    pc.onconnectionstatechange = watch;
    pc.oniceconnectionstatechange = watch;

    for (const kind of ['video', 'audio'] as const) {
      const t = this.tracks[kind];
      if (t) peer.senders[kind] = this.addSender(pc, t);
    }
    if (this.shareAudio) peer.senders.shareAudio = this.addSender(pc, this.shareAudio, this.shareStream);
    return peer;
  }

  private emitShare(id: string, peer: Peer) {
    const live = peer.shareTracks.filter((t) => t.readyState === 'live');
    peer.shareTracks = live;
    this.onShareAudio(id, live.length ? new MediaStream(live) : null);
  }

  /**
   * Send on a fresh sendonly transceiver instead of pc.addTrack(). addTrack() reuses a transceiver
   * that is already receiving the remote's media of the same kind; after glare rollback Chrome's
   * receiver on that transceiver stops delivering (black / silent tile).
   */
  private addSender(pc: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream = this.local): RTCRtpSender {
    return pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] }).sender;
  }

  private senderUsable(pc: RTCPeerConnection, sender: RTCRtpSender) {
    const tr = pc.getTransceivers().find((t) => t.sender === sender);
    return !!tr && !(tr as RTCRtpTransceiver & { stopped?: boolean }).stopped && tr.currentDirection !== 'stopped' && tr.direction !== 'stopped';
  }

  handleSignal(from: string, data: SignalData) {
    const peer = this.ensurePeer(from);
    peer.queue = peer.queue.then(() => this.applySignal(peer, data)).catch((e) => console.warn('signal error', e));
  }

  private async applySignal(peer: Peer, data: SignalData) {
    const { pc } = peer;
    if (data.type === 'pref') {
      peer.pref = data.video;
      await this.applyEncoding(peer);
      return;
    }
    if (data.type === 'description') {
      if (typeof data.shareStream === 'string' && data.shareStream) peer.shareStreamId = data.shareStream;
      const desc = data.description as RTCSessionDescriptionInit;
      const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        await this.sendDescription(peer, this.idOf(peer));
      }
    } else {
      try {
        await pc.addIceCandidate(data.candidate as RTCIceCandidateInit);
      } catch (e) {
        if (!peer.ignoreOffer) throw e;
      }
    }
  }

  private idOf(peer: Peer) {
    for (const [id, p] of this.peers) if (p === peer) return id;
    return '';
  }

  private async sendDescription(peer: Peer, to: string) {
    const desc = peer.pc.localDescription;
    if (!desc || !to) return;
    this.send(to, { type: 'description', description: desc.toJSON() as RTCSessionDescriptionInit });
  }

  private linkUp(pc: RTCPeerConnection) {
    return pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
  }

  private badLink(pc: RTCPeerConnection) {
    return pc.connectionState === 'failed' || pc.connectionState === 'disconnected'
      || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected';
  }

  /**
   * `disconnected` often recovers on its own; wait before restarting.
   * `failed` does not. Back off so a dead path cannot renegotiate in a loop,
   * and refresh TURN credentials first so a long call can still allocate a relay.
   */
  private scheduleRestart(peer: Peer) {
    const pc = peer.pc;
    if (pc.connectionState === 'closed' || pc.iceConnectionState === 'closed') return;
    if (this.linkUp(pc)) {
      if (peer.restartTimer) clearTimeout(peer.restartTimer);
      peer.restartTimer = null;
      peer.restartAttempt = 0;
      return;
    }
    // `checking` means ICE is already working. Cancel a pending restart, but keep the
    // attempt count: a brief visit to `checking` must not zero the backoff.
    const trying = pc.iceConnectionState === 'checking' || pc.connectionState === 'connecting';
    if (trying) {
      if (peer.restartTimer) clearTimeout(peer.restartTimer);
      peer.restartTimer = null;
      return;
    }
    if (!this.badLink(pc)) return;
    if (peer.restartTimer) return;
    const failed = pc.connectionState === 'failed' || pc.iceConnectionState === 'failed';
    const base = failed ? 300 : 2000;
    const wait = Math.min(15_000, base * 2 ** peer.restartAttempt) + Math.floor(Math.random() * 400);
    peer.restartTimer = setTimeout(() => {
      peer.restartTimer = null;
      if (pc.connectionState === 'closed') return;
      if (this.linkUp(pc)) { peer.restartAttempt = 0; return; }
      if (!this.badLink(pc)) return;
      peer.restartAttempt += 1;
      void this.restartPeer(peer);
    }, wait);
  }

  private async restartPeer(peer: Peer) {
    const pc = peer.pc;
    try {
      const servers = await getIceServers(true);
      if (hasTurn(servers) || !hasTurn(this.iceServers)) {
        this.iceServers = servers;
        pc.setConfiguration({ iceServers: servers, iceTransportPolicy: this.relayOnly() ? 'relay' : 'all' });
      }
    } catch { /* keep the servers this peer already has */ }
    if (pc.connectionState === 'closed' || pc.signalingState === 'closed') return;
    try { pc.restartIce(); } catch (e) { console.warn('restartIce failed', e); }
  }

  private closePeer(id: string, peer: Peer) {
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    peer.restartTimer = null;
    peer.pc.close();
    this.peers.delete(id);
    this.onStream(id, null);
    if (peer.shareTracks.length) this.onShareAudio(id, null);
  }

  /** Set / clear the local camera or mic track and push it to every peer. */
  async setTrack(kind: 'video' | 'audio', track: MediaStreamTrack | null, roomPeerIds: string[], opts?: { keepStopped?: boolean }) {
    const old = this.tracks[kind];
    if (old && old !== track) {
      this.local.removeTrack(old);
      if (!opts?.keepStopped) old.stop();
    }
    this.tracks[kind] = track;
    if (track && !this.local.getTracks().includes(track)) this.local.addTrack(track);
    if (track) roomPeerIds.forEach((id) => this.ensurePeer(id));
    for (const peer of this.peers.values()) {
      if (peer.pc.signalingState === 'closed') continue;
      let sender = peer.senders[kind];
      if (sender && !this.senderUsable(peer.pc, sender)) {
        delete peer.senders[kind];
        sender = undefined;
      }
      if (sender) await sender.replaceTrack(track).catch((e) => console.warn('replaceTrack failed', e));
      else if (track) peer.senders[kind] = this.addSender(peer.pc, track);
      if (kind === 'video' && track) await this.applyEncoding(peer);
    }
  }

  // ---------------------------------------------------------------- video quality

  /** Camera send cap for every peer (null = no cap). Applied with setParameters, no renegotiation. */
  async setVideoLevel(level: LevelId | null) {
    if (this.vq.level === level) return;
    this.vq.level = level;
    await this.applyAll();
  }

  get videoLevel() { return this.vq.level; }

  /** Screen-share priority: 'detail' (sharpness) or 'motion' (smoothness). */
  async setShareMode(mode: ShareMode) {
    this.vq.share = mode;
    const t = this.tracks.video;
    if (this.vq.sharing && t) t.contentHint = mode;
    await this.applyAll();
  }

  /** Re-derive every sender's encoding (e.g. after the camera's capture size changed). */
  refreshEncodings() { return this.applyAll(); }

  private async applyAll() {
    await Promise.all([...this.peers.values()].map((p) => this.applyEncoding(p)));
  }

  /** Ask one remote to send us full / lower / no video. Audio is never affected. */
  setReceivePref(peerId: string, pref: ViewPref) {
    if (pref === 'full') this.wants.delete(peerId); else this.wants.set(peerId, pref);
    const peer = this.peers.get(peerId);
    if (peer) this.flushWant(peer);
  }

  private flushWant(peer: Peer) {
    const id = this.idOf(peer);
    if (!id) return;
    const want = this.wants.get(id) ?? 'full';
    if (want === peer.sentWant) return;
    if (!this.linkUp(peer.pc)) return; // sent once connected (watch())
    peer.sentWant = want;
    this.socket.emit('rtc:signal', { to: id, data: { type: 'pref', video: want } });
  }

  /** Current outbound encoding params per peer (tests / diagnostics). */
  encodingFor(peerId: string): EncodingParams | null {
    const p = this.peers.get(peerId);
    return p ? this.desiredEncoding(p) : null;
  }

  private desiredEncoding(peer: Peer): EncodingParams {
    const t = this.tracks.video;
    if (this.vq.sharing) return shareSettings(this.vq.share, peer.pref).encoding;
    return cameraEncoding(this.vq.level, t?.getSettings().height ?? 0, peer.pref);
  }

  private async applyEncoding(peer: Peer) {
    const sender = peer.senders.video;
    if (!sender || !sender.track || peer.pc.signalingState === 'closed') return;
    try {
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      if (!params.encodings || !params.encodings.length) return; // not negotiated yet; watch() re-applies
      const want = this.desiredEncoding(peer);
      const enc = params.encodings[0] as RTCRtpEncodingParameters & { maxFramerate?: number; scaleResolutionDownBy?: number };
      enc.active = want.active;
      for (const k of ['maxBitrate', 'scaleResolutionDownBy', 'maxFramerate'] as const) {
        if (want[k] !== undefined) enc[k] = want[k];
        else delete enc[k];
      }
      if (this.vq.sharing) params.degradationPreference = shareSettings(this.vq.share).degradationPreference;
      else delete params.degradationPreference;
      await sender.setParameters(params);
    } catch (e) {
      // degradationPreference is not settable in every browser; retry without it
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) return;
        const want = this.desiredEncoding(peer);
        const enc = params.encodings[0] as RTCRtpEncodingParameters & { maxFramerate?: number; scaleResolutionDownBy?: number };
        enc.active = want.active;
        for (const k of ['maxBitrate', 'scaleResolutionDownBy', 'maxFramerate'] as const) {
          if (want[k] !== undefined) enc[k] = want[k]; else delete enc[k];
        }
        await sender.setParameters(params);
      } catch { console.warn('setParameters failed', e); }
    }
  }

  /**
   * Screen share via replaceTrack on the existing video sender (no new m-line → no glare regression).
   * Camera track is held and restored when sharing stops.
   */
  async setScreenShare(track: MediaStreamTrack | null, roomPeerIds: string[], restoreCamera: boolean) {
    if (track) {
      if (this.tracks.video && this.tracks.video !== this.cameraHold) {
        this.cameraHold = this.tracks.video;
        this.local.removeTrack(this.tracks.video);
        this.cameraHold.enabled = false;
      }
      track.contentHint = this.vq.share;
      this.vq.sharing = true;
      await this.setTrack('video', track, roomPeerIds, { keepStopped: true });
    } else {
      this.vq.sharing = false;
      const screen = this.tracks.video;
      const cam = restoreCamera ? this.cameraHold : null;
      this.cameraHold = null;
      await this.setTrack('video', cam, roomPeerIds, { keepStopped: true });
      screen?.stop();
      if (cam) cam.enabled = true;
      await this.setShareAudio(null, roomPeerIds);
    }
  }

  /**
   * Tab/system audio on its own sender. Does not replace the microphone.
   * Passing null stops the track and drops it from every peer connection.
   */
  async setShareAudio(track: MediaStreamTrack | null, roomPeerIds: string[]) {
    const old = this.shareAudio;
    // Point at the new track before stopping the old one so an `ended` event
    // from stop() cannot clear a share that just started.
    this.shareAudio = track;
    if (old && old !== track) {
      this.shareStream.removeTrack(old);
      old.stop();
    }
    if (track && track !== old) {
      track.addEventListener('ended', () => {
        if (this.shareAudio === track) void this.setShareAudio(null, []);
      });
    }
    if (track && !this.shareStream.getTracks().includes(track)) this.shareStream.addTrack(track);
    if (track) roomPeerIds.forEach((id) => this.ensurePeer(id));
    for (const peer of this.peers.values()) {
      if (peer.pc.signalingState === 'closed') continue;
      let sender = peer.senders.shareAudio;
      if (sender && !this.senderUsable(peer.pc, sender)) {
        delete peer.senders.shareAudio;
        sender = undefined;
      }
      if (track) {
        if (sender) await sender.replaceTrack(track).catch((e) => console.warn('replaceTrack failed', e));
        else peer.senders.shareAudio = this.addSender(peer.pc, track, this.shareStream);
      } else if (sender) {
        await sender.replaceTrack(null).catch((e) => console.warn('replaceTrack failed', e));
        const tr = peer.pc.getTransceivers().find((x) => x.sender === sender);
        try { tr?.stop(); } catch { /* already stopped */ }
        delete peer.senders.shareAudio;
      }
    }
  }

  /** Stop camera and screen-share tracks, including display audio. Mic is left alone. */
  async releaseVideo() {
    const held = this.cameraHold;
    this.cameraHold = null;
    held?.stop();
    await this.setShareAudio(null, []);
    await this.setTrack('video', null, []);
  }

  /**
   * Stage mode demotion: stop every local track and stop the send transceivers, so the next
   * offer / answer carries no send direction (the server drops audience descriptions that publish).
   */
  async stopSending() {
    await this.releaseVideo();
    await this.setTrack('audio', null, []);
    for (const peer of this.peers.values()) {
      if (peer.pc.signalingState === 'closed') continue;
      for (const kind of ['video', 'audio', 'shareAudio'] as const) {
        const sender = peer.senders[kind];
        if (!sender) continue;
        const tr = peer.pc.getTransceivers().find((x) => x.sender === sender);
        try { tr?.stop(); } catch { /* already stopped */ }
        delete peer.senders[kind];
      }
    }
  }

  removePeer(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    this.closePeer(id, p);
  }

  destroy() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    for (const kind of ['video', 'audio'] as const) this.tracks[kind]?.stop();
    this.shareAudio?.stop();
    this.shareAudio = null;
    this.cameraHold?.stop();
    this.cameraHold = null;
    this.tracks = { video: null, audio: null };
  }
}

function hasTurn(list: RTCIceServer[]) {
  return list.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).toLowerCase().includes('turn')));
}

// unlockAudio lives in ./audioUnlock so the app shell can import it without pulling in the mesh.
export { unlockAudio } from './audioUnlock';
