/** batch MC2: chat commands. Built-ins are expanded on the server; owners can add short text commands per room. */
export const BUILTIN_COMMANDS = [
  { name: 'me', usage: '/me waves', help: 'Say something as an action' },
  { name: 'shrug', usage: '/shrug [text]', help: 'Add ¯\\_(ツ)_/¯' },
  { name: 'roll', usage: '/roll 2d6', help: 'Roll dice (1-20 dice, 2-1000 sides)' },
  { name: 'flip', usage: '/flip', help: 'Flip a coin' },
] as const;
export const ROOM_COMMANDS_MAX = 20;
export const ROOM_COMMAND_RESPONSE_MAX = 300;
export const ROOM_COMMAND_NAME = /^[a-z][a-z0-9_-]{1,19}$/;
/** names that can't be used for custom commands (built-ins, effects, and common words people type) */
export const RESERVED_COMMANDS = new Set(['me', 'shrug', 'roll', 'flip', 'help', 'confetti', 'fireworks', 'balloons', 'hearts', 'rain', 'snow', 'everyone', 'here', 'admin', 'mod', 'staff', 'nick', 'join', 'leave', 'kick', 'ban', 'mute']);
/** markdown-safe: escape the characters our chat markdown treats specially */
export const mdEscape = (s: string) => s.replace(/([\\`*_~[\]()#>|])/g, '\\$1');
export const SHRUG = '¯\\\\\\_(ツ)\\_/¯';
/** /roll argument: NdM, dM or empty (1d6). null = invalid */
export function parseDice(arg: string): { n: number; sides: number } | null {
  const a = arg.trim().toLowerCase();
  if (!a) return { n: 1, sides: 6 };
  const m = /^(\d{0,2})d(\d{1,4})$/.exec(a);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1, sides = Number(m[2]);
  return n >= 1 && n <= 20 && sides >= 2 && sides <= 1000 ? { n, sides } : null;
}
/** clean an owner-written response: plain text on one or a few lines, no mass mentions, no raw HTML */
export function cleanCommandResponse(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›')).replace(/@(everyone|here|room)\b/gi, '＠$1');
  if (!s || s.length > ROOM_COMMAND_RESPONSE_MAX) return null;
  return s;
}
