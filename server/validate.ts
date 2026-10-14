import { LIMITS } from '../shared/config';

const nickRe = new RegExp(LIMITS.nickPattern);
/** Trimmed address, or null when it is not a normal mailbox. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim();
  if (email.length < 6 || email.length > 254) return null;
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) return null;
  return email;
}

export function isValidNick(nick: string): boolean {
  return nickRe.test(nick);
}

export function isValidRoomName(name: string): boolean {
  return name.length >= LIMITS.roomNameMin && name.length <= LIMITS.roomNameMax && /[A-Za-z0-9]/.test(name);
}

/** Trim, strip control / zero-width / bidi-override chars, collapse whitespace runs, cap length. */
export function cleanText(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** Escape for any context that is NOT rendered via React text nodes (logs, exports, emails). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
