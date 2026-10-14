import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { APP_NAME } from '../../shared/config';
import { Icon } from '../icons';
import { subscribeGamesSlot } from './GamesSlot';
import { useEscape } from '../a11y';
import { TriviaPanel, useTrivia, type TriviaCtx } from './TriviaPanel';

const KEY = 'camchat.games';
type Scores = { duckBest: number; reactBest: number | null; ttt: { x: number; o: number; draws: number } };

function loadScores(): Scores {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '');
    return {
      duckBest: Number(raw?.duckBest) || 0,
      reactBest: typeof raw?.reactBest === 'number' ? raw.reactBest : null,
      ttt: {
        x: Number(raw?.ttt?.x) || 0,
        o: Number(raw?.ttt?.o) || 0,
        draws: Number(raw?.ttt?.draws) || 0,
      },
    };
  } catch {
    return { duckBest: 0, reactBest: null, ttt: { x: 0, o: 0, draws: 0 } };
  }
}

function saveScores(s: Scores) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

type Bird = { x: number; y: number; vx: number; r: number; color: string };

function spawnBird(w: number, h: number): Bird {
  const dir = Math.random() < 0.5 ? 1 : -1;
  const colors = ['#34d399', '#fbbf24', '#fb7185', '#38bdf8'];
  return {
    x: dir > 0 ? -28 : w + 28,
    y: 28 + Math.random() * Math.max(20, h - 56),
    vx: dir * (70 + Math.random() * 90),
    r: 12 + Math.random() * 6,
    color: colors[Math.floor(Math.random() * colors.length)],
  };
}

function drawBird(ctx: CanvasRenderingContext2D, b: Bird) {
  const face = b.vx >= 0 ? 1 : -1;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.fillStyle = b.color;
  ctx.beginPath();
  ctx.ellipse(0, 0, b.r * 1.35, b.r * 0.72, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(face * b.r * 0.85, -b.r * 0.15, b.r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0b0d15';
  ctx.beginPath();
  ctx.arc(face * b.r * 0.98, -b.r * 0.22, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fdba74';
  ctx.beginPath();
  ctx.moveTo(face * b.r * 1.15, -b.r * 0.05);
  ctx.lineTo(face * b.r * 1.7, b.r * 0.05);
  ctx.lineTo(face * b.r * 1.15, b.r * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

const AMMO = 8;

function DuckShoot({ best, onBest }: { best: number; onBest: (n: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const birds = useRef<Bird[]>([]);
  const ammo = useRef(AMMO);
  const hits = useRef(0);
  const over = useRef(false);
  const [hud, setHud] = useState({ ammo: AMMO, hits: 0, over: false });

  const reset = () => {
    const c = ref.current;
    const w = c?.width || 480;
    const h = c?.height || 200;
    birds.current = [0, 1, 2, 3].map(() => spawnBird(w, h));
    ammo.current = AMMO;
    hits.current = 0;
    over.current = false;
    setHud({ ammo: AMMO, hits: 0, over: false });
  };

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    reset();
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = c.width;
      const h = c.height;
      if (!over.current) {
        for (const b of birds.current) {
          b.x += b.vx * dt;
          if (b.x < -40 || b.x > w + 40) Object.assign(b, spawnBird(w, h));
        }
      }
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#03140c');
      sky.addColorStop(1, '#0c3b22');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#06210f';
      ctx.fillRect(0, h - 18, w, 18);
      for (const b of birds.current) drawBird(ctx, b);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const shoot = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (over.current) return;
    const c = ref.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * c.width;
    const y = ((e.clientY - rect.top) / rect.height) * c.height;
    let hit = false;
    for (const b of birds.current) {
      const dx = x - b.x;
      const dy = y - b.y;
      if (dx * dx + dy * dy <= (b.r * 1.5) * (b.r * 1.5)) {
        hit = true;
        Object.assign(b, spawnBird(c.width, c.height));
        break;
      }
    }
    if (hit) hits.current += 1;
    ammo.current -= 1;
    const finished = ammo.current <= 0;
    if (finished) {
      over.current = true;
      if (hits.current > best) onBest(hits.current);
    }
    setHud({ ammo: Math.max(0, ammo.current), hits: hits.current, over: finished });
  };

  return (
    <div className="game-duck">
      <p className="muted small">{hud.over ? `Round over. ${hud.hits} hit${hud.hits === 1 ? '' : 's'} from ${AMMO} shots.` : `${hud.hits} hits · ${hud.ammo} shots left. A miss uses a shot.`}</p>
      <canvas ref={ref} width={480} height={200} className="duck-canvas" onPointerDown={shoot} />
      <p className="muted small">Best: {Math.max(best, hud.over ? hud.hits : best)}</p>
      {hud.over && <button type="button" className="btn primary small-btn" onClick={reset}>Play again</button>}
    </div>
  );
}

function ReactionTap({ best, onBest }: { best: number | null; onBest: (ms: number) => void }) {
  const [phase, setPhase] = useState<'idle' | 'wait' | 'go' | 'early' | 'done'>('idle');
  const [ms, setMs] = useState<number | null>(null);
  const startAt = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const arm = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setMs(null);
    setPhase('wait');
    const delay = 800 + Math.random() * 2200;
    timer.current = window.setTimeout(() => {
      startAt.current = performance.now();
      setPhase('go');
    }, delay);
  };

  const tap = () => {
    if (phase === 'idle' || phase === 'done' || phase === 'early') { arm(); return; }
    if (phase === 'wait') {
      if (timer.current) window.clearTimeout(timer.current);
      setPhase('early');
      return;
    }
    const t = Math.round(performance.now() - startAt.current);
    setMs(t);
    setPhase('done');
    if (best == null || t < best) onBest(t);
  };

  const label = phase === 'go' ? 'Tap' : phase === 'wait' ? 'Wait…' : phase === 'early' ? 'Too soon' : phase === 'done' ? `${ms} ms` : 'Start';

  return (
    <div className="game-react">
      <button type="button" className={`react-pad ${phase}`} onClick={tap} data-action="react-tap">{label}</button>
      <p className="muted small">{phase === 'early' ? 'Early taps do not count. Tap to try again.' : 'Wait until the panel switches, then tap.'} Best: {best == null ? '—' : `${best} ms`}</p>
    </div>
  );
}

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function winnerOf(cells: Array<'X' | 'O' | null>): 'X' | 'O' | 'draw' | null {
  for (const [a, b, c] of LINES) {
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
  }
  if (cells.every(Boolean)) return 'draw';
  return null;
}

function TicTacToe({ tally, onTally }: { tally: Scores['ttt']; onTally: (t: Scores['ttt']) => void }) {
  const [cells, setCells] = useState<Array<'X' | 'O' | null>>(Array(9).fill(null));
  const [turn, setTurn] = useState<'X' | 'O'>('X');
  const result = winnerOf(cells);
  const recorded = useRef(false);

  useEffect(() => {
    if (!result || recorded.current) return;
    recorded.current = true;
    if (result === 'X') onTally({ ...tally, x: tally.x + 1 });
    else if (result === 'O') onTally({ ...tally, o: tally.o + 1 });
    else onTally({ ...tally, draws: tally.draws + 1 });
  }, [result, onTally, tally]);

  const play = (i: number) => {
    if (result || cells[i]) return;
    const next = cells.slice();
    next[i] = turn;
    setCells(next);
    setTurn(turn === 'X' ? 'O' : 'X');
  };

  const restart = () => {
    recorded.current = false;
    setCells(Array(9).fill(null));
    setTurn('X');
  };

  return (
    <div className="game-ttt">
      <p className="muted small">{result === 'draw' ? 'Draw.' : result ? `${result} wins.` : `${turn} to play.`} X {tally.x} · O {tally.o} · draws {tally.draws}</p>
      <div className="ttt-grid" role="grid" aria-label="Tic-tac-toe">
        {cells.map((c, i) => (
          <button key={i} type="button" className="ttt-cell" onClick={() => play(i)} disabled={!!result || !!c} aria-label={`Square ${i + 1}`}>{c || ''}</button>
        ))}
      </div>
      <button type="button" className="btn ghost small-btn" onClick={restart}>Restart</button>
    </div>
  );
}

export { GamesButton, GamesSlot } from './GamesSlot';

const PLACE_KEY = `${APP_NAME.toLowerCase()}.gamesPlace`;

function loadDocked(): boolean {
  try { return localStorage.getItem(PLACE_KEY) !== 'float'; } catch { return true; }
}

function clampFloat(x: number, y: number, w: number, h: number) {
  const narrow = window.matchMedia('(max-width: 860px)').matches;
  const topMin = narrow ? 128 : 72;
  const bottomGap = narrow ? 168 : 12;
  const maxX = Math.max(8, window.innerWidth - w - 8);
  const maxY = Math.max(topMin, window.innerHeight - h - bottomGap);
  return {
    x: Math.min(maxX, Math.max(8, x)),
    y: Math.min(maxY, Math.max(topMin, y)),
  };
}

/** One dock for lobby, room, and the mod panel. Stays mounted so a round survives navigation. */
export function GamesDock({ open, onClose, trivia, toast }: {
  open: boolean;
  onClose: () => void;
  trivia: TriviaCtx;
  toast: (t: string, tone?: 'error' | 'info') => void;
}) {
  const [tab, setTab] = useState<'duck' | 'react' | 'ttt' | 'trivia'>('duck');
  const { live: triviaLive, answer: triviaAnswer } = useTrivia(trivia.roomId, toast, open && tab === 'trivia');
  const [scores, setScores] = useState<Scores>(loadScores);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [docked, setDocked] = useState(loadDocked);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const patch = (next: Scores) => { setScores(next); saveScores(next); };
  useEscape(open, onClose);

  useEffect(() => {
    return subscribeGamesSlot((el) => setSlot(el));
  }, []);

  const setPlace = (nextDocked: boolean) => {
    setDocked(nextDocked);
    try { localStorage.setItem(PLACE_KEY, nextDocked ? 'docked' : 'float'); } catch { /* ignore */ }
  };

  const inSlot = docked && open && !!slot;
  const floating = open && !inSlot;

  const onDragDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!floating) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || !panelRef.current) return;
    const w = panelRef.current.offsetWidth;
    const h = panelRef.current.offsetHeight;
    setPos(clampFloat(e.clientX - drag.current.dx, e.clientY - drag.current.dy, w, h));
  };
  const onDragEnd = () => { drag.current = null; };

  const panel = (
    <aside
      ref={panelRef}
      className={`panel games-dock${floating ? ' is-float' : ''}${open ? '' : ' is-closed'}`}
      aria-hidden={!open}
      aria-label="Games"
      style={floating && pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}
    >
      <div className="users-head" onPointerDown={onDragDown} onPointerMove={onDragMove} onPointerUp={onDragEnd}>
        <h3>Games</h3>
        <button type="button" className="btn ghost small-btn" data-action="games-place" onClick={() => setPlace(!docked)}>{docked ? 'Undock' : 'Dock'}</button>
        <button type="button" className="btn ghost small-btn" onClick={onClose}>Close</button>
      </div>
      <div className="tabs" role="tablist">
        <button type="button" className={`tab ${tab === 'duck' ? 'active' : ''}`} onClick={() => setTab('duck')}>Duck shoot</button>
        <button type="button" className={`tab ${tab === 'react' ? 'active' : ''}`} onClick={() => setTab('react')}>Reaction tap</button>
        <button type="button" className={`tab ${tab === 'ttt' ? 'active' : ''}`} onClick={() => setTab('ttt')}>Tic-tac-toe</button>
        <button type="button" className={`tab ${tab === 'trivia' ? 'active' : ''}`} onClick={() => setTab('trivia')} data-tab="trivia">Trivia{triviaLive.state && tab !== 'trivia' ? ' •' : ''}</button>
      </div>
      {open && tab === 'duck' && <DuckShoot best={scores.duckBest} onBest={(n) => patch({ ...scores, duckBest: n })} />}
      {open && tab === 'react' && <ReactionTap best={scores.reactBest} onBest={(ms) => patch({ ...scores, reactBest: ms })} />}
      {open && tab === 'ttt' && <TicTacToe tally={scores.ttt} onTally={(ttt) => patch({ ...scores, ttt })} />}
      {open && tab === 'trivia' && <TriviaPanel ctx={trivia} live={triviaLive} answer={triviaAnswer} toast={toast} />}
    </aside>
  );

  if (!open) return <div className="games-dock-hold" hidden>{panel}</div>;
  if (inSlot && slot) return createPortal(panel, slot);
  return panel;
}
