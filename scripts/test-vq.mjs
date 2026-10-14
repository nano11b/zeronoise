/**
 * Video quality unit tests: presets, per-viewer encodings, screen-share modes and the Auto step-down
 * state machine driven by simulated getStats sequences. Runs against the compiled shared module
 * (npm run build first).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const vq = require(path.join(ROOT, 'dist/server/shared/videoQuality.js'));
const { AUTO_TUNING: T } = vq;

let pass = 0, failed = 0;
const ok = (c, name) => { if (c) { pass++; console.log(`PASS  ${name}`); } else { failed++; console.log(`FAIL  ${name}`); } };

const GOOD = { limitation: 'none', lossPct: 0, rttMs: 60, availBps: 3_000_000 };
const BW = { limitation: 'bandwidth', lossPct: 1, rttMs: 120, availBps: 300_000 };
const CPU = { limitation: 'cpu', lossPct: 0, rttMs: 50, availBps: 3_000_000 };
const LOSSY = { limitation: 'none', lossPct: 12, rttMs: 100, availBps: null };
const SLOW = { limitation: 'none', lossPct: 0, rttMs: 900, availBps: null };
const MEH = { limitation: 'other', lossPct: 3, rttMs: 350, availBps: null };

/** Run a sequence of [sample, count] at the sampling interval; returns the trace. */
function run(seq, start = vq.initialAuto(0), t0 = 0) {
  let s = start, now = t0;
  const changes = [];
  for (const [sample, n] of seq) {
    for (let i = 0; i < n; i++) {
      now += T.intervalMs;
      const r = vq.autoStep(s, sample, now);
      s = r.state;
      if (r.change) changes.push({ at: now, change: r.change, level: vq.autoLevel(s) });
    }
  }
  return { s, now, changes };
}

// ---- presets / constraints
ok(vq.VIDEO_QUALITIES.join() === 'auto,high,medium,low,saver' && vq.DEFAULT_VIDEO_QUALITY === 'auto', 'five presets, Auto is the default');
ok(vq.isVideoQuality('saver') && !vq.isVideoQuality('ultra') && !vq.isVideoQuality(null), 'isVideoQuality validates');
const cAuto = vq.captureConstraints('auto');
ok(cAuto.width.ideal === 640 && cAuto.height.ideal === 480 && cAuto.frameRate.ideal === 24, 'Auto keeps the existing 640x480 @ 24 capture');
ok(vq.captureConstraints('high').height.ideal === 720 && vq.captureConstraints('low').height.ideal === 360, 'High captures 720p, Low 360p');
const cs = vq.captureConstraints('saver', 'cam1');
ok(cs.height.ideal === 240 && cs.frameRate.max === 15 && cs.deviceId.exact === 'cam1', 'Data saver captures 240p, max 15 fps, keeps the chosen device');

// ---- camera encodings
const e0 = vq.cameraEncoding(null, 480);
ok(e0.active && e0.maxBitrate === undefined && e0.scaleResolutionDownBy === undefined, 'no cap: browser defaults (today\'s behaviour)');
const eLow = vq.cameraEncoding('low', 480);
ok(eLow.scaleResolutionDownBy === 1.33 && eLow.maxBitrate === 400_000 && eLow.maxFramerate === 20, 'Low on a 480p track: scale 1.33, 400 kbps, 20 fps');
const eSaver = vq.cameraEncoding('saver', 720);
ok(eSaver.scaleResolutionDownBy === 3 && eSaver.maxFramerate === 15 && eSaver.maxBitrate === 150_000, 'Data saver on 720p: scale 3, 15 fps, 150 kbps');
ok(vq.cameraEncoding('high', 480).scaleResolutionDownBy === 1, 'never scales up');
ok(vq.cameraEncoding('high', 720, 'low').scaleResolutionDownBy === 2, 'viewer "lower quality" caps that viewer at Low');
ok(vq.cameraEncoding('saver', 240, 'low').maxBitrate === 150_000, 'viewer "lower quality" never raises a lower level');
ok(vq.cameraEncoding(null, 480, 'low').maxBitrate === 400_000, 'viewer "lower quality" applies with no own cap');
ok(vq.cameraEncoding('medium', 480, 'paused').active === false, 'viewer "pause video" turns that encoding off');
ok(vq.isViewPref('paused') && !vq.isViewPref('off'), 'isViewPref validates');

// ---- screen share
const sd = vq.shareSettings('detail');
ok(sd.contentHint === 'detail' && sd.degradationPreference === 'maintain-resolution' && sd.encoding.active && sd.encoding.scaleResolutionDownBy === undefined, 'sharpness: contentHint detail + maintain-resolution, no scaling');
const sm = vq.shareSettings('motion');
ok(sm.contentHint === 'motion' && sm.degradationPreference === 'maintain-framerate', 'smoothness: contentHint motion + maintain-framerate');
ok(vq.shareSettings('detail', 'low').encoding.scaleResolutionDownBy === 2 && vq.shareSettings('motion', 'paused').encoding.active === false, 'viewer prefs apply to screen shares');

// ---- judge
ok(vq.judge(GOOD, 'medium').good && !vq.judge(GOOD, 'medium').bad, 'clean sample is good');
ok(vq.judge(BW, 'medium').bad === 'bandwidth', 'bandwidth limitation is bad (network)');
ok(vq.judge(CPU, 'medium').bad === 'cpu', 'cpu limitation is bad (device)');
ok(vq.judge(LOSSY, 'medium').bad === 'bandwidth' && vq.judge(SLOW, 'medium').bad === 'bandwidth', 'high loss / high RTT are bad');
ok(vq.judge({ ...GOOD, availBps: 350_000 }, 'medium').bad === 'bandwidth', 'available bitrate well under the level is bad');
ok(!vq.judge(MEH, 'medium').bad && !vq.judge(MEH, 'medium').good, 'middling sample is neither');
ok(!vq.judge({ ...GOOD, availBps: 700_000 }, 'low').good, 'not good unless there is headroom for the next level up');

// ---- state machine
const st0 = vq.initialAuto(0);
ok(vq.autoLevel(st0) === vq.AUTO_CEILING && vq.AUTO_CEILING === 'medium' && vq.autoNotice(st0) === null, 'Auto starts at the ceiling (Medium) with no notice');
let r = run([[GOOD, 50]]);
ok(r.changes.length === 0 && vq.autoLevel(r.s) === 'medium', 'healthy link: never changes, never exceeds the ceiling');
r = run([[BW, 2]]);
ok(r.changes.length === 0, 'two bad samples: no change (not sustained)');
r = run([[BW, 2], [GOOD, 1], [BW, 2]]);
ok(r.changes.length === 0, 'bad samples interrupted by a good one: counter resets');
r = run([[BW, 3]]);
ok(r.changes.length === 1 && r.changes[0].change === 'down' && vq.autoLevel(r.s) === 'low', 'three bad samples in a row: one step down');
ok(vq.autoNotice(r.s) === 'Lowered quality: weak connection', 'notice: weak connection');
r = run([[CPU, 3]]);
ok(vq.autoNotice(r.s) === 'Lowered quality: device is busy', 'cpu limit: busy-device notice');
r = run([[BW, 30]]);
ok(vq.autoLevel(r.s) === 'saver' && r.changes.length === 2, 'sustained limits walk down to Data saver and stop there');
ok(r.changes[1].at - r.changes[0].at >= T.cooldownMs, 'steps are spaced by the cooldown');
// recovery
const down = run([[BW, 3]]);
let up = run([[GOOD, T.goodToStepUp - 1]], down.s, down.now);
ok(up.changes.length === 0, 'recovery waits for enough good samples');
up = run([[GOOD, 30]], down.s, down.now);
ok(up.changes.length === 1 && up.changes[0].change === 'up' && vq.autoLevel(up.s) === 'medium' && vq.autoNotice(up.s) === null, 'sustained good samples: one step back up, notice clears');
ok(up.changes[0].at - down.now >= T.upHoldMs, 'step up waits at least the up-hold time');
r = run([[BW, 30], [GOOD, 200]]);
ok(vq.autoLevel(r.s) === 'medium' && r.changes.filter((c) => c.change === 'up').length === 2, 'from Data saver it climbs back one level at a time');
const ups = r.changes.filter((c) => c.change === 'up');
ok(ups.length === 2 && ups[1].at - ups[0].at >= T.upHoldMs, 'consecutive steps up are spaced by the up-hold');
// hysteresis / flapping
let s = run([[BW, 3]]).s, now = 9 * T.intervalMs, holds = [];
for (let i = 0; i < 8; i++) {
  const u = run([[GOOD, 200]], s, now); // climb back
  const upAt = u.changes.find((c) => c.change === 'up')?.at ?? 0;
  const d = run([[BW, 3]], vq.autoStep(u.s, GOOD, upAt).state, upAt); // fails right after the step up
  holds.push(d.s.upHoldMs);
  s = d.s; now = d.now;
}
ok(holds[0] > T.upHoldMs && holds.every((h, i) => i === 0 || h >= holds[i - 1]) && holds.at(-1) <= T.upHoldMaxMs, `flapping doubles the up-hold (${holds.join(', ')} ms), capped`);
ok(holds.at(-1) === T.upHoldMaxMs, 'up-hold reaches its cap after repeated flaps');
const calm = run([[GOOD, 400]], { ...s }, now);
ok(calm.s.upHoldMs < s.upHoldMs, 'calm recovery shrinks the up-hold again');
r = run([[MEH, 100]]);
ok(r.changes.length === 0, 'middling samples neither step down nor up');
r = run([[BW, 3], [MEH, 100]]);
ok(r.changes.length === 1 && vq.autoLevel(r.s) === 'low', 'middling samples after a step down: stay put');
r = run([[LOSSY, 3]]);
ok(vq.autoLevel(r.s) === 'low', 'sustained packet loss steps down');
r = run([[SLOW, 3]]);
ok(vq.autoLevel(r.s) === 'low', 'sustained high RTT steps down');

// ---- batch 4a: stage-mode helpers (server enforcement relies on these) ----
const stage = require(path.join(ROOT, 'dist/server/shared/stage.js'));
const S = (body, head = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n') => head + body;
ok(stage.sdpPublishes(S('m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n')), 'sdp: sendonly video publishes');
ok(stage.sdpPublishes(S('m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n')), 'sdp: sendrecv audio publishes');
ok(!stage.sdpPublishes(S('m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=inactive\r\n')), 'sdp: recvonly / inactive do not');
ok(!stage.sdpPublishes(S('m=video 0 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n')), 'sdp: a rejected (port 0) section does not');
ok(stage.sdpPublishes(S('m=video 0 UDP/TLS/RTP/SAVPF 96\r\na=bundle-only\r\na=sendonly\r\n')), 'sdp: port 0 + bundle-only still counts');
ok(stage.sdpPublishes(S('m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n')), 'sdp: no direction defaults to sendrecv (publishes)');
ok(!stage.sdpPublishes(S('m=video 9 UDP/TLS/RTP/SAVPF 96\r\n', 'v=0\r\ns=-\r\na=recvonly\r\n')), 'sdp: session-level recvonly applies to sections without one');
ok(!stage.sdpPublishes(S('m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sendrecv\r\n')), 'sdp: data channels are ignored');
ok(!stage.sdpPublishes(42) && !stage.sdpPublishes(''), 'sdp: junk is not publishing');
ok(stage.clampStageCap(99) === 8 && stage.clampStageCap(1) === 2 && stage.clampStageCap('5') === 5 && stage.clampStageCap('x') === 6 && stage.clampStageCap(0, 4) === 4, 'stage cap clamps to 2-8 with a fallback');

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
