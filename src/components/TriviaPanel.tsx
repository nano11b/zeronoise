import { useEffect, useRef, useState } from 'react';
import type { TriviaScore, TriviaState } from '../../shared/types';
import { TRIVIA_CATEGORIES, TRIVIA_COUNTS, TRIVIA_DEFAULT_COUNT, TRIVIA_LABELS, type TriviaPick } from '../../shared/trivia';
import { socket } from '../socket';

export interface TriviaCtx { roomId: string | null; canStop: boolean; me?: string }
type Toast = (t: string, tone?: 'error' | 'info') => void;

interface Live {
  state: TriviaState | null;
  /** client clock minus server clock */
  skew: number;
  myChoice: number | null;
  board: TriviaScore[];
  last: { winner: TriviaScore | null; scores: TriviaScore[]; stopped: boolean; by?: string } | null;
}

/** Room trivia state; lives in the always-mounted games dock so events are never missed. */
export function useTrivia(roomId: string | null, toast: Toast, dockOpen: boolean) {
  const [live, setLive] = useState<Live>({ state: null, skew: 0, myChoice: null, board: [], last: null });
  const openRef = useRef(dockOpen);
  openRef.current = dockOpen;

  useEffect(() => {
    setLive({ state: null, skew: 0, myChoice: null, board: [], last: null });
    if (!roomId) return;
    const refresh = () => socket.emit('trivia:get', (r) => {
      if (!r.ok) return;
      setLive((cur) => ({ ...cur, state: r.state, myChoice: r.myChoice, board: r.board, skew: r.state ? Date.now() - r.state.serverNow : cur.skew }));
    });
    refresh();
    const onState = (st: TriviaState) => setLive((cur) => {
      const fresh = !cur.state || cur.state.roundId !== st.roundId;
      if (fresh && st.index === 0 && st.phase === 'question' && !openRef.current) toast(`🧠 ${st.by} started trivia (${st.total} questions). Open Games ▸ Trivia to play.`);
      const newQ = fresh || cur.state!.index !== st.index;
      return { ...cur, state: st, skew: Date.now() - st.serverNow, myChoice: newQ ? null : cur.myChoice, last: fresh ? null : cur.last };
    });
    const onProgress = (p: { roundId: string; index: number; answered: number; players: number }) => setLive((cur) =>
      cur.state && cur.state.roundId === p.roundId && cur.state.index === p.index && cur.state.phase === 'question'
        ? { ...cur, state: { ...cur.state, answered: p.answered, players: p.players } } : cur);
    const onEnded = (p: { state: TriviaState; winner: TriviaScore | null; board: TriviaScore[]; stopped: boolean; by?: string }) => {
      setLive((cur) => ({ ...cur, state: null, myChoice: null, board: p.board, last: { winner: p.winner, scores: p.state.scores, stopped: p.stopped, by: p.by } }));
      toast(p.stopped ? `Trivia stopped${p.by ? ` by ${p.by}` : ''}` : p.winner ? `🏆 Trivia: ${p.winner.name} won with ${p.winner.points}` : 'Trivia over - nobody scored');
    };
    socket.on('trivia:state', onState);
    socket.on('trivia:progress', onProgress);
    socket.on('trivia:ended', onEnded);
    socket.on('connect', refresh);
    return () => {
      socket.off('trivia:state', onState);
      socket.off('trivia:progress', onProgress);
      socket.off('trivia:ended', onEnded);
      socket.off('connect', refresh);
    };
  }, [roomId, toast]);

  const answer = (choice: number) => {
    const st = live.state;
    if (!st || st.phase !== 'question' || live.myChoice != null) return;
    setLive((cur) => ({ ...cur, myChoice: choice }));
    socket.emit('trivia:answer', { roundId: st.roundId, index: st.index, choice }, (r) => {
      if (!r.ok) { toast(r.error, 'error'); setLive((cur) => (cur.state?.index === st.index && cur.myChoice === choice && /already/i.test(r.error) ? cur : { ...cur, myChoice: cur.state?.index === st.index ? null : cur.myChoice })); }
    });
  };
  return { live, answer };
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function Board({ title, rows, testid }: { title: string; rows: TriviaScore[]; testid: string }) {
  return (
    <div className="trivia-board" data-testid={testid}>
      <h4>{title}</h4>
      {rows.length === 0 ? <p className="muted small">No scores yet.</p> : (
        <ol>
          {rows.map((r, i) => (
            <li key={`${r.name}:${i}`}><span className="trivia-name">{r.name}{r.guest && <span className="muted small"> (guest)</span>}</span><span className="trivia-pts">{r.points}</span></li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function TriviaPanel({ ctx, live, answer, toast }: {
  ctx: TriviaCtx;
  live: Live;
  answer: (choice: number) => void;
  toast: Toast;
}) {
  const [count, setCount] = useState<number>(TRIVIA_DEFAULT_COUNT);
  const [category, setCategory] = useState<TriviaPick>('mixed');
  const [busy, setBusy] = useState(false);
  const st = live.state;
  const now = useNow(!!st);
  const boxRef = useRef<HTMLDivElement>(null);
  // In a short dock (phones) bring each new question to the top of the scroll area.
  useEffect(() => {
    const el = boxRef.current;
    const dock = el?.closest('.games-dock') as HTMLElement | null;
    if (!el || !dock || dock.scrollHeight <= dock.clientHeight) return;
    dock.scrollTop += el.getBoundingClientRect().top - dock.getBoundingClientRect().top - 4;
  }, [st?.roundId, st?.index]);

  if (!ctx.roomId) return <div className="game-trivia"><p className="muted small">Join a room to play trivia with everyone in it.</p></div>;

  const start = () => {
    setBusy(true);
    socket.emit('trivia:start', { count, category }, (r) => { setBusy(false); if (!r.ok) toast(r.error, 'error'); });
  };
  const stop = () => socket.emit('trivia:stop', (r) => { if (!r.ok) toast(r.error, 'error'); });

  if (!st) {
    return (
      <div className="game-trivia">
        {live.last && (
          <div className="trivia-result" data-testid="trivia-result">
            <p><strong>{live.last.stopped ? 'Round stopped.' : live.last.winner ? `🏆 ${live.last.winner.name} won with ${live.last.winner.points}` : 'Round over. Nobody scored.'}</strong></p>
            {!live.last.stopped && <Board title="This round" rows={live.last.scores} testid="trivia-round-board" />}
          </div>
        )}
        <div className="trivia-setup">
          <label>Questions
            <select value={count} onChange={(e) => setCount(Number(e.target.value))} data-testid="trivia-count">
              {TRIVIA_COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>Category
            <select value={category} onChange={(e) => setCategory(e.target.value as TriviaPick)} data-testid="trivia-category">
              {(['mixed', ...TRIVIA_CATEGORIES] as TriviaPick[]).map((c) => <option key={c} value={c}>{TRIVIA_LABELS[c]}</option>)}
            </select>
          </label>
          <button type="button" className="btn primary small-btn" disabled={busy} onClick={start} data-action="trivia-start">Start round</button>
        </div>
        <p className="muted small">Everyone in the room plays. 15 s per question, 100 points for a right answer plus up to 50 for speed.</p>
        <Board title="All-time top 10 (this room)" rows={live.board} testid="trivia-alltime" />
      </div>
    );
  }

  const serverNow = now - live.skew;
  const left = Math.max(0, st.endsAt - serverNow);
  const q = st.question;
  const revealing = st.phase === 'reveal' && !!st.reveal;
  const pct = st.phase === 'question' ? Math.min(100, (left / st.questionMs) * 100) : 0;
  return (
    <div className="game-trivia" data-trivia-phase={st.phase} ref={boxRef}>
      <div className="trivia-head">
        <span className="small">Q {st.index + 1}/{st.total} · {q ? TRIVIA_LABELS[q.category] : ''}</span>
        <span className="small trivia-left" data-testid="trivia-left">{st.phase === 'question' ? `${Math.ceil(left / 1000)}s` : `next in ${Math.ceil(left / 1000)}s`}</span>
        {ctx.canStop && <button type="button" className="btn ghost small-btn" onClick={stop} data-action="trivia-stop">Stop</button>}
      </div>
      <div className="trivia-timer" aria-hidden><span style={{ width: `${pct}%` }} /></div>
      {q && <p className="trivia-q" data-testid="trivia-question">{q.text}</p>}
      {q && (
        <div className="trivia-options" role="group" aria-label="Answers">
          {q.options.map((opt, i) => {
            const mine = live.myChoice === i;
            const correct = revealing && st.reveal!.correct === i;
            const wrong = revealing && mine && !correct;
            return (
              <button key={i} type="button" data-action="trivia-answer" data-choice={i}
                className={`trivia-opt${mine ? ' mine' : ''}${correct ? ' correct' : ''}${wrong ? ' wrong' : ''}`}
                disabled={st.phase !== 'question' || live.myChoice != null}
                onClick={() => answer(i)}>
                <span className="trivia-letter">{'ABCD'[i]}</span>
                <span className="trivia-text">{opt}</span>
                {revealing && <span className="trivia-count" title="How many picked this">{st.reveal!.counts[i]}</span>}
              </button>
            );
          })}
        </div>
      )}
      <p className="muted small">
        {st.phase === 'question'
          ? (live.myChoice != null ? `Locked in. ${st.answered}/${st.players} answered.` : `${st.answered}/${st.players} answered. One answer each.`)
          : live.myChoice == null ? 'You did not answer this one.' : st.reveal && live.myChoice === st.reveal.correct ? '✔ Correct!' : '✘ Not this time.'}
      </p>
      <Board title="This round" rows={st.scores} testid="trivia-live-board" />
    </div>
  );
}
