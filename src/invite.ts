import { INVITE_CODE_RE } from '../shared/inviteCode';

/**
 * An invite code being carried through sign-in, sign-up and email confirmation. localStorage (not session) so the
 * confirmation link opened in a new tab still finds it. Kept for 2 hours.
 */
const KEY = 'camchat.invite';
const TTL = 2 * 60 * 60_000;

export function savePendingInvite(code: string) {
  if (!INVITE_CODE_RE.test(code)) return;
  try { localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() })); } catch { /* ignore */ }
}
export function peekPendingInvite(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null') as { code?: string; at?: number } | null;
    if (!v?.code || !INVITE_CODE_RE.test(v.code) || !v.at || Date.now() - v.at > TTL) return null;
    return v.code;
  } catch { return null; }
}
export function clearPendingInvite() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
