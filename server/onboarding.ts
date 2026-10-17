/** Batch H6: first-visit onboarding (tour, interests, suggested rooms). Accounts created before this
 *  version shipped are never shown the tour: only those created after `onboarding_since`. */
import { q } from './db';
import { getSetting, setSetting } from './settings';
import { ROOM_CATEGORIES } from '../shared/batch3';

export function onboardingSince(): number {
  // test harnesses for older features set this far in the future so the tour never covers their pages
  const env = Number(process.env.ONBOARDING_SINCE);
  if (env > 0) return env;
  const v = Number(getSetting('onboarding_since'));
  if (v > 0) return v;
  const now = Date.now(); setSetting('onboarding_since', String(now), 'system');
  return now;
}
export function onboardingState(userId: number): { needed: boolean; interests: string[] } {
  const r = q('SELECT created_at, onboarded_at, interests FROM users WHERE id = ?').get(userId) as { created_at: number; onboarded_at: number | null; interests: string | null } | undefined;
  if (!r) return { needed: false, interests: [] };
  let interests: string[] = [];
  try { interests = r.interests ? (JSON.parse(r.interests) as string[]) : []; } catch { /* none */ }
  return { needed: r.onboarded_at == null && r.created_at >= onboardingSince(), interests };
}
export function saveOnboarding(userId: number, interests: unknown, done: boolean) {
  const list = Array.isArray(interests) ? [...new Set(interests.filter((x): x is string => (ROOM_CATEGORIES as readonly string[]).includes(String(x))))].slice(0, 7) : null;
  if (list) q('UPDATE users SET interests = ? WHERE id = ?').run(JSON.stringify(list), userId);
  if (done) q('UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').run(Date.now(), userId);
}
