import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { GUEST_POLICY, LIMITS, WORD_FILTER } from '../shared/config';

const e = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const PORT = num(e.PORT, 3000);
export const HOST = e.HOST || undefined;
export const isProd = e.NODE_ENV === 'production';
export const DATA_DIR = path.resolve(e.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });

/** Used to HMAC session tokens, sign device cookies and OAuth state. Generated + persisted in DATA_DIR if unset. */
export const SESSION_SECRET: string = (() => {
  if (e.SESSION_SECRET && e.SESSION_SECRET.length >= 16) return e.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.session_secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* create */ }
  const s = randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
})();

export const PUBLIC_URL = (e.PUBLIC_URL || '').replace(/\/$/, '');
/**
 * Custom URL scheme the native apps register (`camchat://auth`). Used only when a system-browser
 * OAuth flow was started with ?client=native. Invalid values fall back to camchat.
 */
export const NATIVE_AUTH_SCHEME = (() => {
  const s = (e.NATIVE_AUTH_SCHEME || 'camchat').trim().toLowerCase();
  return /^[a-z][a-z0-9+.-]{0,31}$/.test(s) ? s : 'camchat';
})();
/** 'auto' = Secure when the request arrived over HTTPS (per trust proxy / X-Forwarded-Proto) */
export const COOKIE_SECURE: 'auto' | boolean = e.COOKIE_SECURE === 'true' ? true : e.COOKIE_SECURE === 'false' ? false : 'auto';
export const TRUST_PROXY = e.TRUST_PROXY ?? 'loopback';
export const CORS_ORIGINS = list(e.CORS_ORIGIN);

export const ADMIN_USERNAMES = list(e.ADMIN_USERNAMES).map((s) => s.toLowerCase());
export const REGISTRATION_OPEN = e.REGISTRATION !== 'closed';
export const GUEST_CAM_AFTER_MINUTES = num(e.GUEST_CAM_AFTER_MINUTES, GUEST_POLICY.camAfterMinutes);
export const MAX_CONN_PER_IP = num(e.MAX_CONN_PER_IP, LIMITS.maxConnPerIp);
export const SESSION_DAYS = num(e.SESSION_DAYS, 30);
export const REGISTRATIONS_PER_IP_PER_HOUR = num(e.REGISTRATIONS_PER_IP_PER_HOUR, LIMITS.registrationsPerIpPerHour);

export const GOOGLE_CLIENT_ID = e.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = e.GOOGLE_CLIENT_SECRET || '';
export const googleEnabled = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

export const DISCORD_CLIENT_ID = e.DISCORD_CLIENT_ID || '';
export const DISCORD_CLIENT_SECRET = e.DISCORD_CLIENT_SECRET || '';
export const discordEnabled = !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET);

export const TIKTOK_CLIENT_KEY = e.TIKTOK_CLIENT_KEY || '';
export const TIKTOK_CLIENT_SECRET = e.TIKTOK_CLIENT_SECRET || '';
export const tiktokEnabled = !!(TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET);
/**
 * Login Kit endpoints. Web does not require PKCE; the overrides exist so tests can
 * point token and user-info calls at a local mock. Leave them unset in production.
 */
export const TIKTOK_AUTHORIZE_URL = e.TIKTOK_AUTHORIZE_URL || 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_URL = e.TIKTOK_TOKEN_URL || 'https://open.tiktokapis.com/v2/oauth/token/';
export const TIKTOK_USERINFO_URL = e.TIKTOK_USERINFO_URL || 'https://open.tiktokapis.com/v2/user/info/';

/** GIF search (server-side only; keys never sent to the browser). Tenor preferred over Giphy. */
export const TENOR_API_KEY = e.TENOR_API_KEY || '';
export const GIPHY_API_KEY = e.GIPHY_API_KEY || '';
export const gifsEnabled = !!(TENOR_API_KEY || GIPHY_API_KEY || e.GIF_FIXTURE === '1');

// TURN: time-limited (coturn use-auth-secret) preferred; static user/pass fallback.
export const TURN_URLS = list(e.TURN_URLS || e.TURN_URL);
export const TURN_SECRET = e.TURN_SECRET || '';
export const TURN_TTL = num(e.TURN_TTL, 6 * 3600);
/** How long a dropped socket keeps its room seat and peer id before the call is torn down. */
export const RECONNECT_GRACE_MS = num(e.RECONNECT_GRACE_MS, 20_000);
/** How long the moderator bot stays in people lists after its last authenticated API call. */
export const MOD_BOT_PRESENCE_MS = num(e.MOD_BOT_PRESENCE_MS, 60_000);
/** Room-message polls per bot per minute. 120 covers a read every 1–2 seconds. */
export const BOT_ROOM_READS_PER_MIN = num(e.BOT_ROOM_READS_PER_MIN, 120);
export const TURN_USER = e.TURN_USER || '';
export const TURN_PASS = e.TURN_PASS || '';
export const STUN_URLS = e.STUN_URLS !== undefined ? list(e.STUN_URLS) : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

/** Public RTMP hostname for Meld. Empty means rtmp.nano11bravo.com. Not the Cloudflare web tunnel. */
export const RTMP_PUBLIC_HOST = (e.RTMP_PUBLIC_HOST || '').trim();
export const RTMP_PORT = num(e.RTMP_PORT, 1935);

export const WORDS: string[] = (() => {
  if (e.WORD_FILTER_FILE) {
    try { return fs.readFileSync(e.WORD_FILTER_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')); }
    catch (err) { console.warn('WORD_FILTER_FILE unreadable:', (err as Error).message); }
  }
  if (e.WORD_FILTER !== undefined) return list(e.WORD_FILTER);
  return WORD_FILTER;
})();

/** Optional SMTP (plain AUTH, STARTTLS on 587, implicit TLS on 465). */
export const SMTP_HOST = e.SMTP_HOST || '';
export const SMTP_PORT = num(e.SMTP_PORT, 587);
export const SMTP_USER = e.SMTP_USER || '';
export const SMTP_PASS = e.SMTP_PASS || '';
export const SMTP_FROM = e.SMTP_FROM || '';
/** Port 465 is implicit TLS. SMTP_IMPLICIT_TLS=1 forces that on any other port. */
export const SMTP_IMPLICIT_TLS = SMTP_PORT === 465 || e.SMTP_IMPLICIT_TLS === '1' || e.SMTP_IMPLICIT_TLS === 'true';
export const smtpConfigured = !!(SMTP_HOST && SMTP_FROM);

/** Resend HTTP API. Primary sender when both are set. */
export const RESEND_API_KEY = e.RESEND_API_KEY || '';
export const MAIL_FROM = e.MAIL_FROM || '';
export const resendConfigured = !!(RESEND_API_KEY && MAIL_FROM);

/**
 * Test-only sink. When set, messages are appended as JSON lines and not sent
 * to the network. Never set this on the public server.
 */
export const MAIL_CAPTURE_PATH = e.MAIL_CAPTURE_PATH || '';

/** A sender exists: Resend, SMTP, or the test capture file. */
export const mailConfigured = resendConfigured || smtpConfigured || !!MAIL_CAPTURE_PATH;

/**
 * When true AND mail is configured, unverified non-admins cannot join rooms.
 * Default off so a missing provider does not lock the site.
 */
export const EMAIL_VERIFY_REQUIRED = e.EMAIL_VERIFY_REQUIRED === '1' || e.EMAIL_VERIFY_REQUIRED === 'true';

/** Shown on /terms and /privacy. Empty means the pages tell people to ask a moderator. */
export const CONTACT_EMAIL = (() => {
  const v = (e.CONTACT_EMAIL || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : '';
})();

/** Optional third-party CAPTCHA. If unset, the built-in math challenge is used. */
export const TURNSTILE_SECRET = e.TURNSTILE_SECRET || '';
export const TURNSTILE_SITE_KEY = e.TURNSTILE_SITE_KEY || '';
export const HCAPTCHA_SECRET = e.HCAPTCHA_SECRET || '';
export const HCAPTCHA_SITE_KEY = e.HCAPTCHA_SITE_KEY || '';
export const captchaMode: 'builtin' | 'turnstile' | 'hcaptcha' =
  TURNSTILE_SECRET && TURNSTILE_SITE_KEY ? 'turnstile'
    : HCAPTCHA_SECRET && HCAPTCHA_SITE_KEY ? 'hcaptcha' : 'builtin';

/** Test-only: divide every badge threshold (1 = production). */
export const BADGE_THRESHOLD_DIV = Math.max(1, Number(e.BADGE_THRESHOLD_DIV) || 1);
