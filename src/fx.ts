/**
 * Full-screen celebration effects. Everything is drawn here on one canvas
 * (no user CSS/HTML, no external assets). pointer-events: none, rAF driven,
 * capped particle counts, paused while the tab is hidden, honours reduced motion.
 */
import { FX_DURATION_MS, type FxId } from '../shared/fx';
import { fxAudioContext, loadSoundVolume } from './soundboard';

const SHOW_KEY = 'camchat.fx';
const SOUND_KEY = 'camchat.fxSound';
const readFlag = (k: string) => { try { return localStorage.getItem(k) !== '0'; } catch { return true; } };
const writeFlag = (k: string, on: boolean) => { try { localStorage.setItem(k, on ? '1' : '0'); } catch { /* private mode */ } };
export const fxShowEnabled = () => readFlag(SHOW_KEY);
export const setFxShowEnabled = (on: boolean) => writeFlag(SHOW_KEY, on);
export const fxSoundEnabled = () => readFlag(SOUND_KEY);
export const setFxSoundEnabled = (on: boolean) => writeFlag(SOUND_KEY, on);
export const prefersReducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

interface P { x: number; y: number; vx: number; vy: number; r: number; rot: number; vr: number; c: string; life: number; born: number; kind?: number; ch?: string }
type Ctx = CanvasRenderingContext2D;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const PARTY = ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ff9f1c', '#f72585'];
const MATRIX_CH = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789ZERONOISE';

/** Max particles alive at once; phones get fewer. */
export function fxParticleCap(width: number): number { return width < 600 ? 90 : 220; }

let active: { stop: () => void } | null = null;

function heart(g: Ctx, s: number) {
  g.beginPath();
  g.moveTo(0, s * 0.3);
  g.bezierCurveTo(-s, -s * 0.4, -s * 0.5, -s, 0, -s * 0.45);
  g.bezierCurveTo(s * 0.5, -s, s, -s * 0.4, 0, s * 0.3);
  g.fill();
}

/** Start one effect. Replaces any effect already running. */
export function runFx(id: FxId): void {
  if (prefersReducedMotion()) return;
  active?.stop();
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-overlay';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.fx = id;
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d');
  if (!g) { canvas.remove(); return; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = 0, H = 0;
  const size = () => {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  const cap = fxParticleCap(W);
  const ps: P[] = [];
  let t = 0; // active ms (hidden time does not count)
  let last = performance.now();
  let raf = 0;
  let spawnAcc = 0;
  let nextBurst = 0;
  const add = (p: Omit<P, 'born' | 'rot' | 'vr'> & Partial<Pick<P, 'rot' | 'vr'>>) => { if (ps.length < cap) ps.push({ rot: 0, vr: 0, born: t, ...p }); };

  // spawners: called with dt; return nothing
  const spawn: Record<FxId, (dt: number) => void> = {
    confetti: () => {
      if (t < 900) for (let i = 0; i < 8; i++) add({ x: rand(0, W), y: rand(-40, -5), vx: rand(-60, 60), vy: rand(120, 260), r: rand(5, 9), rot: rand(0, 6), vr: rand(-8, 8), c: pick(PARTY), life: 4000 });
    },
    fireworks: () => {
      if (t >= nextBurst && t < FX_DURATION_MS - 900) {
        nextBurst = t + rand(380, 650);
        const cx = rand(W * 0.15, W * 0.85), cy = rand(H * 0.15, H * 0.5), c = pick(PARTY), n = Math.min(40, Math.floor(cap / 5));
        for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, sp = rand(120, 260); add({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: rand(1.6, 2.8), c, life: rand(900, 1300) }); }
      }
    },
    balloons: (dt) => {
      spawnAcc += dt;
      while (spawnAcc > 140 && t < 2200) { spawnAcc -= 140; add({ x: rand(20, W - 20), y: H + 60, vx: rand(-15, 15), vy: -rand(140, 230), r: rand(18, 30), c: pick(PARTY), life: 5000 }); }
    },
    hearts: (dt) => {
      spawnAcc += dt;
      while (spawnAcc > 50 && t < 2400) { spawnAcc -= 50; add({ x: rand(0, W), y: H + 20, vx: rand(-30, 30), vy: -rand(120, 260), r: rand(8, 18), rot: rand(-0.4, 0.4), c: pick(['#ff4d6d', '#ff758f', '#f72585', '#ff8fab']), life: 5000 }); }
    },
    rain: () => { for (let i = 0; i < 6; i++) add({ x: rand(-40, W), y: rand(-60, -5), vx: 120, vy: rand(700, 950), r: rand(10, 20), c: 'rgba(160,200,255,0.65)', life: 1500 }); },
    snow: () => { for (let i = 0; i < 2; i++) add({ x: rand(0, W), y: -10, vx: rand(-20, 20), vy: rand(40, 90), r: rand(1.5, 4), rot: rand(0, 6), c: 'rgba(255,255,255,0.9)', life: 6000 }); },
    money: () => { add({ x: rand(0, W), y: rand(-50, -10), vx: rand(-30, 30), vy: rand(110, 200), r: rand(14, 20), rot: rand(0, 6), vr: rand(-3, 3), c: pick(['#2e7d32', '#43a047', '#66bb6a']), life: 5000 }); },
    matrix: () => {
      const col = Math.max(14, Math.floor(W / Math.min(60, Math.floor(cap / 3))));
      if (Math.random() < 0.6) add({ x: Math.floor(rand(0, W / col)) * col, y: -20, vx: 0, vy: rand(260, 520), r: col * 0.9, c: '#39ff14', life: 4000, ch: '' });
    },
  };

  const draw = (p: P, age: number) => {
    g.save();
    g.translate(p.x, p.y);
    g.rotate(p.rot);
    g.fillStyle = p.c;
    g.strokeStyle = p.c;
    switch (id) {
      case 'confetti': g.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2 * (0.6 + 0.4 * Math.abs(Math.sin(p.rot * 2)))); break;
      case 'fireworks': g.globalAlpha = Math.max(0, 1 - age / p.life); g.beginPath(); g.arc(0, 0, p.r, 0, Math.PI * 2); g.fill(); break;
      case 'balloons': {
        g.beginPath(); g.ellipse(0, 0, p.r * 0.8, p.r, 0, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 0.35; g.fillStyle = '#fff'; g.beginPath(); g.ellipse(-p.r * 0.3, -p.r * 0.4, p.r * 0.18, p.r * 0.28, -0.4, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 0.8; g.strokeStyle = '#ddd'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, p.r); g.quadraticCurveTo(6, p.r * 1.8, -2, p.r * 2.6); g.stroke();
        break;
      }
      case 'hearts': g.globalAlpha = 0.9; heart(g, p.r); break;
      case 'rain': g.lineWidth = 1.4; g.beginPath(); g.moveTo(0, 0); g.lineTo(-p.r * 0.13, -p.r); g.stroke(); break;
      case 'snow': g.beginPath(); g.arc(0, 0, p.r, 0, Math.PI * 2); g.fill(); break;
      case 'money': {
        const w = p.r * 2.2, h = p.r * 1.1;
        g.fillRect(-w / 2, -h / 2, w, h);
        g.strokeStyle = '#c8e6c9'; g.lineWidth = 1; g.strokeRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4);
        g.fillStyle = '#e8f5e9'; g.font = `bold ${Math.round(h * 0.8)}px monospace`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$', 0, 1);
        break;
      }
      case 'matrix': {
        g.rotate(-p.rot);
        g.font = `${Math.round(p.r)}px monospace`; g.textAlign = 'center';
        for (let k = 0; k < 8; k++) {
          g.globalAlpha = k === 0 ? 1 : Math.max(0, 0.75 - k * 0.09);
          g.fillStyle = k === 0 ? '#d7ffd0' : '#39ff14';
          g.fillText(pick(MATRIX_CH.split('')), 0, -k * p.r);
        }
        break;
      }
    }
    g.restore();
  };

  const gravity: Partial<Record<FxId, number>> = { confetti: 60, fireworks: 140 };
  const frame = (now: number) => {
    const dt = Math.min(50, now - last);
    last = now;
    t += dt;
    const s = dt / 1000;
    if (t < FX_DURATION_MS - 600) spawn[id](dt);
    g.clearRect(0, 0, W, H);
    // fade the whole layer over the last 500 ms
    g.globalAlpha = 1;
    const fade = Math.max(0, Math.min(1, (FX_DURATION_MS - t) / 500));
    if (id === 'matrix') { g.fillStyle = `rgba(0,10,0,${0.25 * fade})`; g.fillRect(0, 0, W, H); }
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      const age = t - p.born;
      p.vy += (gravity[id] ?? 0) * s;
      if (id === 'confetti' || id === 'snow' || id === 'money') p.vx += Math.sin((t + i * 97) / 300) * 20 * s;
      p.x += p.vx * s; p.y += p.vy * s; p.rot += p.vr * s;
      if (age > p.life || p.y > H + 80 || p.y < -120) { ps.splice(i, 1); continue; }
      g.globalAlpha = fade;
      draw(p, age);
    }
    if (t >= FX_DURATION_MS) { stop(); return; }
    raf = requestAnimationFrame(frame);
  };
  const onVis = () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  };
  const stop = () => {
    cancelAnimationFrame(raf); raf = 0;
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', size);
    canvas.remove();
    if (active?.stop === stop) active = null;
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('resize', size);
  active = { stop };
  if (!document.hidden) raf = requestAnimationFrame(frame);
}

export function stopFx() { active?.stop(); }

/** Short synthesized sound (no files) through the selected speaker. */
export async function playFxSound(id: FxId): Promise<void> {
  const c = await fxAudioContext();
  if (!c) return;
  const vol = Math.min(1, Math.max(0, loadSoundVolume())) * 0.35;
  if (vol <= 0) return;
  const out = c.createGain();
  out.gain.value = vol;
  out.connect(c.destination);
  const t0 = c.currentTime + 0.01;
  const tone = (freq: number, at: number, dur: number, type: OscillatorType = 'sine', to?: number, peak = 1) => {
    const o = c.createOscillator(), gn = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0 + at);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + at + dur);
    gn.gain.setValueAtTime(0.0001, t0 + at);
    gn.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.015);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    o.connect(gn); gn.connect(out); o.start(t0 + at); o.stop(t0 + at + dur + 0.05);
  };
  const noise = (at: number, dur: number, filter: number, peak = 1, type: BiquadFilterType = 'bandpass') => {
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(), f = c.createBiquadFilter(), gn = c.createGain();
    src.buffer = buf; f.type = type; f.frequency.value = filter; gn.gain.value = peak;
    src.connect(f); f.connect(gn); gn.connect(out); src.start(t0 + at);
  };
  switch (id) {
    case 'confetti': noise(0, 0.12, 1800, 1.2); tone(600, 0.05, 0.25, 'triangle', 1400, 0.5); break;
    case 'fireworks': tone(300, 0, 0.4, 'sine', 1200, 0.25); noise(0.4, 0.5, 600, 1.4, 'lowpass'); noise(0.75, 0.4, 900, 1); break;
    case 'balloons': tone(400, 0, 0.35, 'sine', 900, 0.4); tone(520, 0.3, 0.3, 'sine', 1100, 0.3); break;
    case 'hearts': tone(659, 0, 0.3, 'sine', undefined, 0.5); tone(880, 0.18, 0.45, 'sine', undefined, 0.45); break;
    case 'rain': noise(0, 1.0, 3000, 0.6, 'highpass'); break;
    case 'snow': tone(1568, 0, 0.6, 'sine', undefined, 0.25); tone(2093, 0.15, 0.6, 'sine', undefined, 0.2); break;
    case 'money': tone(1318, 0, 0.12, 'square', undefined, 0.2); tone(1760, 0.1, 0.4, 'square', undefined, 0.2); noise(0.05, 0.3, 5000, 0.4, 'highpass'); break;
    case 'matrix': for (let i = 0; i < 6; i++) tone(rand(300, 1200), i * 0.08, 0.06, 'square', undefined, 0.15); break;
  }
  window.setTimeout(() => { try { out.disconnect(); } catch { /* ignore */ } }, 2500);
}
