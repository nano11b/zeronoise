/** batch MC2 extras (server side): chat commands, and the HTTP routes for owner-managed room extras. */
import { randomInt } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { q } from './db';
import { live } from './live';
import type * as repo from './repo';
import { RESERVED_COMMANDS, ROOM_COMMANDS_MAX, ROOM_COMMAND_NAME, SHRUG, cleanCommandResponse, mdEscape, parseDice } from '../shared/chatCommands';

type Fail = (res: Response, status: number, error: string) => unknown;
export interface ExtrasDeps { fail: Fail; reqAccount: (req: Request) => repo.Account | null | undefined }

// ---------------- chat commands ----------------
export interface RoomCommand { name: string; response: string; uses: number; createdAt: number }
export const listCommands = (roomId: string): RoomCommand[] =>
  (q('SELECT name, response, uses, created_at FROM room_commands WHERE room_id = ? ORDER BY name').all(roomId) as { name: string; response: string; uses: number; created_at: number }[])
    .map((r) => ({ name: r.name, response: r.response, uses: r.uses, createdAt: r.created_at }));
/**
 * Expand a chat line that starts with a command. Returns null when the line is not a command we know
 * (it is then posted as typed), { text } for the line to post, or { error }.
 */
export function expandCommand(roomId: string, nick: string, raw: unknown): { text: string } | { error: string } | null {
  if (typeof raw !== 'string') return null;
  const m = /^\/([a-z][a-z0-9_-]{0,19})(?:\s+([\s\S]*))?$/i.exec(raw.trim());
  if (!m) return null;
  const name = m[1].toLowerCase(), arg = (m[2] ?? '').trim();
  switch (name) {
    case 'me': return arg ? { text: `_${mdEscape(nick)} ${mdEscape(arg.replace(/\s+/g, ' '))}_` } : { error: 'Usage: /me does something' };
    case 'shrug': return { text: `${arg ? `${arg} ` : ''}${SHRUG}` };
    case 'roll': {
      const d = parseDice(arg);
      if (!d) return { error: 'Usage: /roll NdM (1-20 dice, 2-1000 sides), e.g. /roll 2d6' };
      const rolls = Array.from({ length: d.n }, () => randomInt(1, d.sides + 1));
      const total = rolls.reduce((a, b) => a + b, 0);
      return { text: `🎲 rolled ${d.n}d${d.sides}: ${d.n > 1 ? `${rolls.join(' + ')} = ` : ''}**${total}**` };
    }
    case 'flip': return { text: `🪙 flipped a coin: **${randomInt(0, 2) ? 'heads' : 'tails'}**` };
    default: {
      const row = q('SELECT response FROM room_commands WHERE room_id = ? AND name = ?').get(roomId, name) as { response: string } | undefined;
      if (!row) return null;
      q('UPDATE room_commands SET uses = uses + 1 WHERE room_id = ? AND name = ?').run(roomId, name);
      return { text: row.response };
    }
  }
}

export function registerExtras(app: Express, d: ExtrasDeps) {
  const manager = (req: Request, res: Response) => {
    const a = d.reqAccount(req);
    if (!a) { d.fail(res, 401, 'Sign in first'); return null; }
    const roomId = String(req.params.id);
    if (!live.roomCanManage(roomId, a.id, a.role)) { d.fail(res, 403, 'Only the room owner (or site staff) can change this'); return null; }
    return { a, roomId };
  };
  // ---- commands ----
  app.get('/api/rooms/:id/commands', (req, res) => {
    if (!live.roomVisible(String(req.params.id))) return d.fail(res, 404, 'Room not found');
    res.json({ ok: true, commands: listCommands(String(req.params.id)), max: ROOM_COMMANDS_MAX });
  });
  app.put('/api/rooms/:id/commands/:name', (req, res) => {
    const g = manager(req, res); if (!g) return;
    const name = String(req.params.name).toLowerCase().replace(/^\//, '');
    if (!ROOM_COMMAND_NAME.test(name)) return d.fail(res, 400, 'Command names are 2-20 letters, numbers, - or _, starting with a letter');
    if (RESERVED_COMMANDS.has(name)) return d.fail(res, 400, `/${name} is built in or reserved`);
    const response = cleanCommandResponse((req.body as { response?: unknown })?.response);
    if (!response) return d.fail(res, 400, 'The reply must be 1-300 characters of text');
    const exists = q('SELECT 1 FROM room_commands WHERE room_id = ? AND name = ?').get(g.roomId, name);
    if (!exists && listCommands(g.roomId).length >= ROOM_COMMANDS_MAX) return d.fail(res, 400, `A room can have at most ${ROOM_COMMANDS_MAX} commands`);
    q(`INSERT INTO room_commands (room_id, name, response, created_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(room_id, name) DO UPDATE SET response = excluded.response`).run(g.roomId, name, response, g.a.id, Date.now());
    live.roomLog(g.roomId, g.a.username, 'command-set', `/${name}`);
    res.json({ ok: true, commands: listCommands(g.roomId) });
  });
  app.delete('/api/rooms/:id/commands/:name', (req, res) => {
    const g = manager(req, res); if (!g) return;
    const name = String(req.params.name).toLowerCase();
    q('DELETE FROM room_commands WHERE room_id = ? AND name = ?').run(g.roomId, name);
    live.roomLog(g.roomId, g.a.username, 'command-remove', `/${name}`);
    res.json({ ok: true, commands: listCommands(g.roomId) });
  });
}
