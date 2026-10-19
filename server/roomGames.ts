import { randomBytes } from 'crypto';
import { q, tx } from './db';
import { CHAIN_MAX_WORDS, CHAIN_TURN_MS, GAME_BOARD_TOP, TTT_IDLE_MS, chainPoints, chainProblem, tttOutcome, type ChainPublic, type ChainWord, type GameBoardRow, type RoomGameKind, type RoomGamesState, type TttPublic } from '../shared/roomGames';

export interface GamePlayer { key: string; name: string; accountId: number | null }
interface Ttt extends TttPublic { xp: GamePlayer; op: GamePlayer | null; timer: NodeJS.Timeout | null }
interface Chain { id: string; by: string; words: (ChainWord & { key: string; accountId: number | null })[]; deadline: number; ended: boolean; endedBy?: string; timer: NodeJS.Timeout | null }
type Res = { ok: true } | { ok: false; error: string; status?: number };

export function recordGame(roomId: string, game: RoomGameKind, rows: { userId: number; points: number; won: boolean }[]) {
  if (!rows.length) return;
  tx(() => {
    const up = q(`INSERT INTO room_game_scores (room_id, user_id, game, points, wins, played, updated_at) VALUES (?,?,?,?,?,1,?)
      ON CONFLICT(room_id, user_id, game) DO UPDATE SET points = points + excluded.points, wins = wins + excluded.wins, played = played + 1, updated_at = excluded.updated_at`);
    for (const r of rows) up.run(roomId, r.userId, game, Math.max(0, Math.round(r.points)), r.won ? 1 : 0, Date.now());
  });
}
export function gameTop(roomId: string, game: RoomGameKind, n = GAME_BOARD_TOP): GameBoardRow[] {
  return q(`SELECT u.username AS name, g.points, g.wins, g.played FROM room_game_scores g JOIN users u ON u.id = g.user_id
    WHERE g.room_id = ? AND g.game = ? ORDER BY g.points DESC, g.wins DESC, g.updated_at ASC LIMIT ?`).all(roomId, game, n) as unknown as GameBoardRow[];
}

const id = () => randomBytes(8).toString('hex');
/** One room's tic-tac-toe table and word-chain round (memory only; finished results go to room_game_scores). */
export class RoomGames {
  ttt: Ttt | null = null;
  chain: Chain | null = null;
  constructor(private roomId: string, private emit: (st: RoomGamesState) => void) {}

  state(): RoomGamesState {
    const t = this.ttt;
    const c = this.chain;
    const scores = new Map<string, { name: string; points: number }>();
    for (const w of c?.words ?? []) { const s = scores.get(w.key) ?? { name: w.by, points: 0 }; s.points += w.points; scores.set(w.key, s); }
    return {
      ttt: t ? { id: t.id, x: t.x, o: t.o, cells: t.cells, turn: t.turn, winner: t.winner, line: t.line, endedBy: t.endedBy, updatedAt: t.updatedAt } : null,
      chain: c ? { id: c.id, by: c.by, words: c.words.map(({ word, by, points }) => ({ word, by, points })), next: c.words.length ? c.words[c.words.length - 1].word.slice(-1) : null, deadline: c.deadline, scores: [...scores.values()].sort((a, b) => b.points - a.points), ended: c.ended, endedBy: c.endedBy, serverNow: Date.now() } satisfies ChainPublic : null,
    };
  }
  private push() { this.emit(this.state()); }
  private tttTouch() {
    const t = this.ttt!; t.updatedAt = Date.now();
    if (t.timer) clearTimeout(t.timer);
    t.timer = t.winner ? null : setTimeout(() => { if (this.ttt === t && !t.winner) { t.winner = 'draw'; t.endedBy = 'timeout'; t.timer = null; this.push(); } }, TTT_IDLE_MS);
  }

  tttOpen(p: GamePlayer): Res {
    if (this.ttt && !this.ttt.winner) return { ok: false, error: 'A tic-tac-toe game is already on', status: 409 };
    this.ttt = { id: id(), x: p.name, o: null, xp: p, op: null, cells: Array(9).fill(null), turn: 'X', winner: null, line: null, updatedAt: Date.now(), timer: null };
    this.tttTouch(); this.push(); return { ok: true };
  }
  tttJoin(p: GamePlayer): Res {
    const t = this.ttt;
    if (!t || t.winner) return { ok: false, error: 'No game waiting for a player' };
    if (t.op) return { ok: false, error: 'This game already has two players', status: 409 };
    if (t.xp.key === p.key) return { ok: false, error: 'You cannot play yourself' };
    t.op = p; t.o = p.name; this.tttTouch(); this.push(); return { ok: true };
  }
  tttMove(p: GamePlayer, cell: number, gameId: unknown): Res {
    const t = this.ttt;
    if (!t || t.winner || t.id !== gameId) return { ok: false, error: 'That game is over' };
    if (!t.op) return { ok: false, error: 'Waiting for a second player' };
    const mine = t.turn === 'X' ? t.xp : t.op;
    if (mine.key !== p.key) return { ok: false, error: [t.xp.key, t.op.key].includes(p.key) ? 'Not your turn' : 'You are watching this game', status: 403 };
    if (!Number.isInteger(cell) || cell < 0 || cell > 8 || t.cells[cell]) return { ok: false, error: 'Pick an empty square' };
    t.cells[cell] = t.turn;
    const o = tttOutcome(t.cells);
    t.winner = o.winner; t.line = o.line;
    if (!o.winner) t.turn = t.turn === 'X' ? 'O' : 'X';
    else this.tttRecord();
    this.tttTouch(); this.push(); return { ok: true };
  }
  private tttRecord() {
    const t = this.ttt!;
    const rows: { userId: number; points: number; won: boolean }[] = [];
    for (const [side, pl] of [['X', t.xp], ['O', t.op]] as const) {
      if (pl?.accountId == null) continue;
      const won = t.winner === side;
      rows.push({ userId: pl.accountId, points: won ? 3 : t.winner === 'draw' ? 1 : 0, won });
    }
    try { recordGame(this.roomId, 'ttt', rows); } catch (e) { console.error('[games] ttt save failed', (e as Error).message); }
  }
  tttEnd(p: GamePlayer, canManage: boolean): Res {
    const t = this.ttt;
    if (!t || t.winner) return { ok: false, error: 'No game running' };
    const player = t.xp.key === p.key || t.op?.key === p.key;
    if (!player && !canManage) return { ok: false, error: 'Only the players or the room owner can end this game', status: 403 };
    if (player && t.op) { t.winner = t.xp.key === p.key ? 'O' : 'X'; t.endedBy = `${p.name} resigned`; this.tttRecord(); }
    else { t.winner = 'draw'; t.endedBy = p.name; }
    this.tttTouch(); this.push(); return { ok: true };
  }

  private chainArm() {
    const c = this.chain!;
    if (c.timer) clearTimeout(c.timer);
    c.deadline = Date.now() + CHAIN_TURN_MS;
    c.timer = setTimeout(() => { if (this.chain === c && !c.ended) this.chainFinish(c, null); }, CHAIN_TURN_MS);
  }
  chainStart(p: GamePlayer): Res {
    if (this.chain && !this.chain.ended) return { ok: false, error: 'A word chain is already running', status: 409 };
    this.chain = { id: id(), by: p.name, words: [], deadline: 0, ended: false, timer: null };
    this.chainArm(); this.push(); return { ok: true };
  }
  chainPlay(p: GamePlayer, raw: unknown): Res {
    const c = this.chain;
    if (!c || c.ended) return { ok: false, error: 'No word chain running' };
    const word = String(raw ?? '').trim().toLowerCase();
    const why = chainProblem(word, c.words, p.name);
    if (why) return { ok: false, error: why };
    c.words.push({ word, by: p.name, points: chainPoints(word), key: p.key, accountId: p.accountId });
    if (c.words.length >= CHAIN_MAX_WORDS) this.chainFinish(c, null);
    else { this.chainArm(); this.push(); }
    return { ok: true };
  }
  chainStop(p: GamePlayer, canManage: boolean): Res {
    const c = this.chain;
    if (!c || c.ended) return { ok: false, error: 'No word chain running' };
    if (!canManage && c.by !== p.name) return { ok: false, error: 'Only whoever started it or the room owner can stop it', status: 403 };
    this.chainFinish(c, p.name); return { ok: true };
  }
  private chainFinish(c: Chain, by: string | null) {
    if (c.timer) clearTimeout(c.timer);
    c.timer = null; c.ended = true; if (by) c.endedBy = by;
    const per = new Map<number, number>();
    for (const w of c.words) if (w.accountId != null) per.set(w.accountId, (per.get(w.accountId) ?? 0) + w.points);
    const best = Math.max(0, ...per.values());
    try { recordGame(this.roomId, 'chain', [...per].map(([userId, points]) => ({ userId, points, won: points === best && best > 0 }))); } catch (e) { console.error('[games] chain save failed', (e as Error).message); }
    this.push();
  }
  dispose() { if (this.ttt?.timer) clearTimeout(this.ttt.timer); if (this.chain?.timer) clearTimeout(this.chain.timer); }
}
