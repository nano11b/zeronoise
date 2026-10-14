import { EMAIL_VERIFY_REQUIRED, mailConfigured } from './env';

/** Why this account cannot enter a room, or null when they can. Admins are never blocked. */
export function roomEntryError(account: { role: string; email: string | null; emailVerified: boolean } | null): string | null {
  if (!account) return 'Sign in to continue.';
  if (account.role === 'admin') return null;
  if (!account.email) return 'Add an email address before entering a room.';
  if (EMAIL_VERIFY_REQUIRED && mailConfigured && !account.emailVerified) return 'Confirm your email before entering a room.';
  return null;
}

/** The switch the client should honor: on only when mail can actually be sent. */
export function emailVerifyRequiredEffective(): boolean {
  return EMAIL_VERIFY_REQUIRED && mailConfigured;
}
