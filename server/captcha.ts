import { createHash, randomBytes, randomInt } from 'crypto';
import { captchaMode, HCAPTCHA_SECRET, TURNSTILE_SECRET } from './env';
import type { CaptchaChallenge } from '../shared/types';

interface Challenge { answer: string; expires: number }
const challenges = new Map<string, Challenge>();

setInterval(() => {
  try {
    const t = Date.now();
    for (const [id, c] of challenges) if (c.expires < t) challenges.delete(id);
  } catch (err) { console.error('[timer] captcha sweep failed', err); }
}, 60_000).unref?.();

export function issueCaptcha(): CaptchaChallenge {
  if (captchaMode === 'turnstile') return { mode: 'turnstile', siteKey: process.env.TURNSTILE_SITE_KEY };
  if (captchaMode === 'hcaptcha') return { mode: 'hcaptcha', siteKey: process.env.HCAPTCHA_SITE_KEY };
  const a = randomInt(2, 12);
  const b = randomInt(1, 10);
  const id = randomBytes(12).toString('base64url');
  challenges.set(id, { answer: String(a + b), expires: Date.now() + 10 * 60_000 });
  return { mode: 'builtin', id, question: `What is ${a} + ${b}?` };
}

export async function verifyCaptcha(body: {
  captchaId?: string; captchaAnswer?: string; captchaToken?: string;
}, ip: string): Promise<string | null> {
  if (captchaMode === 'turnstile' || captchaMode === 'hcaptcha') {
    const token = typeof body.captchaToken === 'string' ? body.captchaToken : '';
    if (!token) return 'Complete the CAPTCHA.';
    const secret = captchaMode === 'turnstile' ? TURNSTILE_SECRET : HCAPTCHA_SECRET;
    const endpoint = captchaMode === 'turnstile'
      ? 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
      : 'https://hcaptcha.com/siteverify';
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      }).then((x) => x.json()) as { success?: boolean };
      if (!r.success) return 'CAPTCHA failed. Try again.';
      return null;
    } catch {
      return 'CAPTCHA verification unavailable. Try again.';
    }
  }
  const id = typeof body.captchaId === 'string' ? body.captchaId : '';
  const answer = typeof body.captchaAnswer === 'string' ? body.captchaAnswer.trim() : '';
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || c.expires < Date.now()) return 'CAPTCHA expired. Refresh and try again.';
  if (answer !== c.answer) return 'Wrong CAPTCHA answer.';
  return null;
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
