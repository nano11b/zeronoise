import { useEffect, useState } from 'react';
import { socket } from '../socket';
import { ROOM_GAME_LABELS, type GameBoardRow, type RoomGamesState } from '../../shared/roomGames';

type Toast = (t: string, tone?: 'error' | 'info') => void;
type Boards = Record<'ttt' | 'chain' | 'trivia', GameBoardRow[]>;

/** batch MC2: room-wide tic-tac-toe and word chain, plus the per-room leaderboards (trivia included). */
export function RoomGamesPanel({ roomId, me, toast }: { roomId: string | null; me: string; toast: Toast }) {
  const [st, setSt] = useState<RoomGamesState>({ ttt: null, chain: null });
  const [boards, setBoards] = useState<Boards | null>(null);
  const [word, setWord] = useState('');
  const [board, setBoard] = useState<'ttt' | 'chain' | 'trivia'>('ttt');
  const [, tick] = useState(0);
  const [recvAt, setRecvAt] = useState(Date.now());
  useEffect(() => {
    if (!roomId) return;
    const get = () => socket.emit('game:get', (r) => { if (r.ok) { setRecvAt(Date.now()); setSt(r.state); setBoards(r.boards); } });
    get();
    const on = (s: RoomGamesState) => { setRecvAt(Date.now()); setSt((cur) => { if ((cur.ttt && !cur.ttt.winner && s.ttt?.winner) || (cur.chain && !cur.chain.ended && s.chain?.ended)) setTimeout(get, 300); return s; }); };
    socket.on('game:state', on); socket.on('connect', get);
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => { socket.off('game:state', on); socket.off('connect', get); clearInterval(t); };
  }, [roomId]);
  if (!roomId) return <p className="muted small">Join a room to play with others.</p>;
  const act = (p: Parameters<typeof socket.emit<'game:act'>>[1]) => new Promise<boolean>((res) => socket.emit('game:act', p, (r) => { if (!r.ok) toast(r.error, 'error'); res(r.ok); }));
  const t = st.ttt; const c = st.chain;
  const mine = t ? (t.turn === 'X' ? t.x : t.o) === me : false;
  const left = c && !c.ended ? Math.max(0, Math.ceil((c.deadline - c.serverNow - (Date.now() - recvAt)) / 1000)) : 0;
  return (
    <div className="room-games" data-testid="room-games">
      <section className="rg-ttt" aria-label="Room tic-tac-toe">
        <h4>Tic-tac-toe <span className="small muted">3 pts for a win, 1 for a draw</span></h4>
        {!t || t.winner ? (
          <>
            {t?.winner && <p className="small" data-testid="ttt-result">{t.winner === 'draw' ? `Draw${t.endedBy ? ` (${t.endedBy === 'timeout' ? 'timed out' : `ended by ${t.endedBy}`})` : ''}` : `${t.winner === 'X' ? t.x : t.o} won${t.endedBy ? ` (${t.endedBy})` : ''}`}</p>}
            <button type="button" className="btn small-btn primary" data-action="ttt-open" onClick={() => void act({ game: 'ttt', action: 'open' })}>New game</button>
          </>
        ) : (
          <p className="small" data-testid="ttt-status">{t.x} (X) vs {t.o ?? '…'} (O) · {!t.o ? (t.x === me ? 'waiting for someone to join' : '') : mine ? 'your turn' : `${t.turn === 'X' ? t.x : t.o}'s turn`}
            {!t.o && t.x !== me && <> <button type="button" className="btn small-btn primary" data-action="ttt-join" onClick={() => void act({ game: 'ttt', action: 'join' })}>Join as O</button></>}
            {' '}<button type="button" className="btn ghost small-btn" data-action="ttt-end" onClick={() => void act({ game: 'ttt', action: 'end' })}>{t.o && (t.x === me || t.o === me) ? 'Resign' : 'End'}</button></p>
        )}
        {t && (
          <div className="rg-ttt-grid" role="grid" aria-label="Board">
            {t.cells.map((v, i) => <button key={i} type="button" role="gridcell" className={`rg-cell${t.line?.includes(i) ? ' win' : ''}`} data-cell={i} aria-label={`Square ${i + 1}${v ? `: ${v}` : ''}`} disabled={!!v || !!t.winner || !mine} onClick={() => void act({ game: 'ttt', action: 'move', cell: i, gameId: t.id })}>{v ?? ''}</button>)}
          </div>
        )}
      </section>
      <section className="rg-chain" aria-label="Word chain">
        <h4>Word chain <span className="small muted">each word starts with the last letter of the one before</span></h4>
        {!c || c.ended ? (
          <>
            {c?.ended && <p className="small" data-testid="chain-result">Round over{c.endedBy ? ` (stopped by ${c.endedBy})` : ''}: {c.scores.length ? c.scores.map((s) => `${s.name} ${s.points}`).join(', ') : 'no words'}</p>}
            <button type="button" className="btn small-btn primary" data-action="chain-start" onClick={() => void act({ game: 'chain', action: 'start' })}>Start a round</button>
          </>
        ) : (
          <>
            <p className="small" data-testid="chain-status">{c.next ? <>Next word starts with <b className="rg-letter">{c.next.toUpperCase()}</b></> : 'Any word to start'} · {left}s left · {c.words.length} words</p>
            <form className="row-actions" onSubmit={(e) => { e.preventDefault(); const w = word; void act({ game: 'chain', action: 'play', word: w }).then((okd) => { if (okd) setWord(''); }); }}>
              <input value={word} onChange={(e) => setWord(e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 20))} placeholder={c.next ? `${c.next}…` : 'word'} aria-label="Your word" data-field="chain-word" autoComplete="off" />
              <button type="submit" className="btn small-btn primary" disabled={word.length < 3}>Play</button>
              <button type="button" className="btn ghost small-btn" data-action="chain-stop" onClick={() => void act({ game: 'chain', action: 'stop' })}>Stop</button>
            </form>
          </>
        )}
        {c && c.words.length > 0 && <ol className="rg-words small" data-testid="chain-words">{c.words.slice(-8).map((w) => <li key={w.word}><b>{w.word}</b> <span className="muted">{w.by} +{w.points}</span></li>)}</ol>}
      </section>
      <section className="rg-board" aria-label="Room leaderboard">
        <h4>Room leaderboard</h4>
        <div className="row-actions" role="tablist">{(['ttt', 'chain', 'trivia'] as const).map((k) => <button key={k} type="button" role="tab" aria-selected={board === k} className={`btn small-btn ${board === k ? 'primary' : 'ghost'}`} data-board={k} onClick={() => setBoard(k)}>{ROOM_GAME_LABELS[k]}</button>)}</div>
        {!boards ? <p className="small muted">Loading…</p> : boards[board].length === 0 ? <p className="small muted">No scores yet. Registered players are ranked.</p> : (
          <ol className="rg-top small" data-testid="game-board">{boards[board].map((r) => <li key={r.name} data-board-row={r.name}><b>{r.name}</b> <span>{r.points} pts · {r.wins} wins · {r.played} played</span></li>)}</ol>
        )}
      </section>
    </div>
  );
}
