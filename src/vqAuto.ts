/**
 * Auto camera quality (lazy chunk). Samples getStats on every peer connection, aggregates the worst
 * case and feeds the pure step-down state machine in shared/videoQuality.ts.
 */
import { APP_NAME } from '../shared/config';
import { AUTO_CEILING, AUTO_TUNING, autoLevel, autoNotice, autoStep, initialAuto, type AutoState, type LevelId, type StatSample } from '../shared/videoQuality';

type Limitation = StatSample['limitation'];
const RANK: Record<Limitation, number> = { none: 0, other: 1, bandwidth: 2, cpu: 3 };

/** Worst-case sample across peer connections, or null when nothing video is being sent. */
export async function sampleStats(pcs: RTCPeerConnection[]): Promise<StatSample | null> {
  let any = false;
  let limitation: Limitation = 'none';
  let lossPct = 0;
  let rttMs = 0;
  let availBps: number | null = null;
  for (const pc of pcs) {
    if (pc.connectionState !== 'connected') continue;
    let report: RTCStatsReport;
    try { report = await pc.getStats(); } catch { continue; }
    let selectedPair = '';
    report.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) selectedPair = r.selectedCandidatePairId; });
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'video' && (r.bytesSent ?? 0) > 0) {
        any = true;
        const lim = (['none', 'bandwidth', 'cpu', 'other'].includes(r.qualityLimitationReason) ? r.qualityLimitationReason : 'none') as Limitation;
        if (RANK[lim] > RANK[limitation]) limitation = lim;
      } else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
        if (typeof r.fractionLost === 'number') lossPct = Math.max(lossPct, Math.max(0, r.fractionLost) * 100);
        if (typeof r.roundTripTime === 'number') rttMs = Math.max(rttMs, r.roundTripTime * 1000);
      } else if (r.type === 'candidate-pair' && (selectedPair ? r.id === selectedPair : r.nominated && r.state === 'succeeded')) {
        if (typeof r.availableOutgoingBitrate === 'number') availBps = availBps === null ? r.availableOutgoingBitrate : Math.min(availBps, r.availableOutgoingBitrate);
        if (typeof r.currentRoundTripTime === 'number') rttMs = Math.max(rttMs, r.currentRoundTripTime * 1000);
      }
    });
  }
  return any ? { limitation, lossPct, rttMs: Math.round(rttMs), availBps } : null;
}

/**
 * Debug override: localStorage `<app>.vqDebug` = JSON { sample: StatSample, intervalMs?: number } makes the
 * controller use that sample on every tick (no peers needed). Used by the UI check to show the indicator.
 */
function debugOverride(): { sample: StatSample; intervalMs?: number } | null {
  try {
    const raw = localStorage.getItem(`${APP_NAME.toLowerCase()}.vqDebug`);
    if (!raw) return null;
    const j = JSON.parse(raw);
    return j && typeof j === 'object' && j.sample ? j : null;
  } catch { return null; }
}

export class AutoQuality {
  private state: AutoState = initialAuto(Date.now());
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private pcs: () => RTCPeerConnection[],
    /** level null = at the ceiling (send with browser defaults); notice = text for the own tile */
    private onChange: (level: LevelId | null, notice: string | null) => void,
  ) {}

  start() {
    this.stopped = false;
    this.schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    if (this.stopped) return;
    const dbg = debugOverride();
    this.timer = setTimeout(() => { void this.tick(); }, dbg?.intervalMs ?? AUTO_TUNING.intervalMs);
  }

  private async tick() {
    if (this.stopped) return;
    const dbg = debugOverride();
    const sample = dbg ? dbg.sample : await sampleStats(this.pcs());
    if (this.stopped) return;
    if (sample) {
      const t = dbg?.intervalMs ? { ...AUTO_TUNING, cooldownMs: dbg.intervalMs * 2, intervalMs: dbg.intervalMs } : AUTO_TUNING;
      const { state, change } = autoStep(this.state, sample, Date.now(), t);
      this.state = state;
      if (change) {
        const lvl = autoLevel(state);
        this.onChange(lvl === AUTO_CEILING ? null : lvl, autoNotice(state));
      }
    }
    this.schedule();
  }
}
