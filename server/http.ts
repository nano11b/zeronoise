import { isVideoQuality } from '../shared/videoQuality';
import { isUiTheme } from '../shared/uiTheme';
import * as repo6 from './repo6';
import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { createHash, createHmac, randomBytes, randomInt } from 'crypto';
import bcrypt from 'bcryptjs';
import { APP_NAME, BRAND_NAME, LIMITS, RESERVED_NAMES } from '../shared/config';
import type { BanKind, BadgesResponse, MeResponse, Role } from '../shared/types';
import {
  BOT_ROOM_READS_PER_MIN, COOKIE_SECURE, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GUEST_CAM_AFTER_MINUTES, NATIVE_AUTH_SCHEME, PUBLIC_URL, REGISTRATION_OPEN, STUN_URLS,
  TURN_PASS, TURN_SECRET, TURN_TTL, TURN_URLS, TURN_USER, googleEnabled, isProd, REGISTRATIONS_PER_IP_PER_HOUR,
  captchaMode, TURNSTILE_SITE_KEY, HCAPTCHA_SITE_KEY, smtpConfigured, mailConfigured,
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, discordEnabled, gifsEnabled,
  TIKTOK_AUTHORIZE_URL, TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_TOKEN_URL, TIKTOK_USERINFO_URL, tiktokEnabled,
  BADGE_THRESHOLD_DIV,
} from './env';
import { issueCaptcha, verifyCaptcha, hashToken } from './captcha';
import { brandedHtml, sendMail } from './mail';
import { emailVerifyRequiredEffective, roomEntryError } from './gate';
import { clientIp, DEVICE_RE, isHttps, originAllowed, parseCookies, trustSetting } from './net';
import { KeyedLimiter } from './rateLimit';
import * as repo from './repo';
import { backupHealth, backupPath, backupRunning, backupStatus, listBackups, runBackup } from './backup';
import { live, type BotIdentity, type BotModAction, type BotModBody } from './live';
import { consumeNativeHandoff, issueNativeHandoff } from './nativeHandoff';
import { registerDownloads } from './downloads';
import { privacyHtml, termsHtml } from './legal';
import { botApiHtml, botApiMarkdown, llmsTxt } from './botDocs';
import { isValidNick, normalizeEmail } from './validate';
import { hasFilteredWord } from './moderation';
import { clientPrecompressed, clientTextAssets, sendIndexHtml, staticHeaders } from './staticAssets';
import { searchGifs } from './gifs';
import { CHAT_IMAGE_MAX_BYTES, storeRoomChatImage, uploadPath } from './chatImages';
import { storeVoiceNote, voiceFilePath } from './voiceNotes';
import { VOICE_MAX_BYTES } from '../shared/voice';
import { BADGES, badgeThreshold, cleanShownBadges, shownBadges } from '../shared/badges';
import { SOUND_MAX_BYTES, cleanSoundName, removeSoundFile, soundFilePath, storeSound } from './sounds';
import { normalizeChatColor, normalizeChatEffect, AVATAR_MAX_BYTES, CHAT_COLORS } from '../shared/colors';
import { avatarExists, avatarPath, deleteAvatarFile, processAvatarUpload, writeAvatar } from './avatars';
import multer from 'multer';
import { asyncSafeRoutes, crashTestHooks, jsonErrorHandler } from './guard';
import * as repo2 from './repo2';
import * as modq from './modq';
import { pushEnabled, validEndpoint, validKeys, vapidPublicKey } from './push';
import { previewImage } from './linkPreview';
import { maskWords } from './moderation';
import { BIO_MAX, cleanBio } from '../shared/bio';
import { ROOM_THUMB_ID_RE, ROOM_THUMB_MAX_BYTES, roomThumbUrl } from '../shared/roomThumbs';
import { ROOM_BANNER_H, ROOM_BANNER_W, roomBannerUrl } from '../shared/theme';
import * as repo4 from './repo4';
import { statusHtml, type PublicStatus } from './status';
import { deleteRoomThumb, newThumbId, processRoomThumb, roomThumbExists, roomThumbPath, writeRoomThumb } from './roomThumbs';
import { ROOM_ICON_ID_RE, ROOM_ICON_MAX_BYTES, roomIconUrl } from '../shared/roomIcons';
import { deleteRoomIcon, newIconId, processRoomIcon, roomIconExists, roomIconPath, writeRoomIcon } from './roomIcons';
import * as repo3 from './repo3';
import { EMOTE_ID_RE, EMOTE_MAX_BYTES, EMOTE_NAME_RE, EMOTES_PER_ROOM, emoteUrl } from '../shared/batch3';
import { deleteEmoteFile, emoteFileExists, emotePath, newEmoteId, processEmote, writeEmote } from './roomEmotes';
import { ART_ID_RE, radioArt } from './radio';
import * as invites from './invites';
import * as repo7 from './repo7';
import { BANNER_ID_RE, bannerPath, bannerUrl, newBannerId, processBanner, retireBanner, writeBanner } from './banners';
import { BANNER_MAX_BYTES, checkProfileLinks, cleanNowPlaying, NOW_PLAYING_MAX } from '../shared/profile2';
import { INVITE_CODE_RE, INVITE_EXPIRY, INVITE_MAX_USES, INVITE_PATH_RE, INVITES_PER_ROOM, type InviteExpiry, type InvitePublic } from '../shared/invites';
import { cardVersion, injectMeta, roomCard, roomMeta, siteMeta, variantFor, type CardRoom, type Meta } from './og';

/** Cookie prefix stays camchat so existing sessions and device cookies keep working. */
const slugApp = APP_NAME.toLowerCase().replace(/[^a-z0-9]/g, '') || 'app';
export const COOKIE_SID = `${slugApp}_sid`;
export const COOKIE_DID = `${slugApp}_did`;
const COOKIE_OAUTH = `${slugApp}_oauth`;
/** Set only for ?client=native OAuth. Carries the app's nonce back through the system browser. */
const COOKIE_OAUTH_NONCE = `${slugApp}_oauth_nonce`;
/** PKCE code_verifier for TikTok. Web Login Kit does not require it; we send one anyway. */
const COOKIE_OAUTH_PKCE = `${slugApp}_oauth_pkce`;
const NATIVE_NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const BCRYPT_COST = 11;
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-password', BCRYPT_COST);
/** Account and room passwords share this hash. Never log the plaintext. */
export function hashSecret(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}
/** Same compare used for account login and room passwords. */
export function checkSecret(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ---------- helpers ----------
/** Process start (ms), for /api/health. */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const fail = (res: Response, status: number, error: string) => res.status(status).json({ ok: false, error });
const cookiesOf = (req: Request) => parseCookies(req.headers.cookie);
function setCookie(req: Request, res: Response, name: string, value: string, maxAgeSec: number) {
  const secure = COOKIE_SECURE === 'auto' ? isHttps(req) : COOKIE_SECURE;
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}
export function deviceIdsOf(cookieHeader: string | undefined, extra: unknown): string[] {
  const ids = new Set<string>();
  const c = parseCookies(cookieHeader)[COOKIE_DID];
  if (c && DEVICE_RE.test(c)) ids.add(c);
  if (typeof extra === 'string' && DEVICE_RE.test(extra)) ids.add(extra);
  return [...ids];
}
const reqAccount = (req: Request) => repo.sessionAccount(cookiesOf(req)[COOKIE_SID]);
const reqDevices = (req: Request) => deviceIdsOf(req.headers.cookie, req.headers['x-device-id']);
const rank: Record<Role, number> = { guest: 0, user: 1, moderator: 2, admin: 3 };
export const isStaffRole = (r: Role) => r === 'admin' || r === 'moderator';

// ---------- TURN / ICE ----------
interface IceServer { urls: string[]; username?: string; credential?: string }
/** coturn "use-auth-secret" REST credentials: username = "<expiry>:<id>", credential = base64(HMAC-SHA1(secret, username)). */
export function turnCredentials(id: string, ttlSec = TURN_TTL, secret = TURN_SECRET) {
  const username = `${Math.floor(Date.now() / 1000) + ttlSec}:${id.replace(/:/g, '')}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, ttl: ttlSec };
}
export function iceServers(id: string | null): { iceServers: IceServer[]; ttl: number | null } {
  const servers: IceServer[] = [];
  if (STUN_URLS.length) servers.push({ urls: STUN_URLS });
  let ttl: number | null = null;
  if (TURN_URLS.length && id) {
    if (TURN_SECRET) {
      const c = turnCredentials(id);
      servers.push({ urls: TURN_URLS, username: c.username, credential: c.credential });
      ttl = c.ttl;
    } else {
      servers.push({ urls: TURN_URLS, username: TURN_USER || undefined, credential: TURN_PASS || undefined });
    }
  }
  return { iceServers: servers, ttl };
}

// ---------- app ----------
export function createApp(roomList: () => unknown) {
  const app = express();
  // Async handlers registered below forward rejections to jsonErrorHandler (Express 4 does not do this itself).
  asyncSafeRoutes(app);
  app.disable('x-powered-by');
  app.set('trust proxy', trustSetting);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
    // Frames: only the official YouTube / Twitch players (watch party). No one may frame this site.
    res.setHeader('Content-Security-Policy', "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://embed.twitch.tv; frame-ancestors 'none'");
    next();
  });
  app.use('/api', express.json({ limit: '16kb' }));
  // Bot bearer routes are not the website session. They authenticate with Authorization and must work off-site (no CSRF cookie).
  const botBearerWrite = (req: Request) => req.method === 'POST' && (
    /^\/bots\/rooms\/[^/]+\/(?:join|chat|gif)$/.test(req.path) ||
    /^\/bots\/moderation\/(?:kick|ban|site-ban|unban|mute|delete)$/.test(req.path)
  );
  // CSRF: state-changing API calls must be same-origin JSON with our custom header (forces a CORS preflight cross-site).
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (botBearerWrite(req)) return next();
    if (!originAllowed(req)) return fail(res, 403, 'Cross-origin request blocked');
    if (req.headers['x-csrf'] !== '1') return fail(res, 403, 'Missing CSRF header');
    // DELETE may omit a body; POST/PATCH need JSON or multipart.
    if (req.method !== 'DELETE') {
      const okBody = req.is('application/json') || req.is('multipart/form-data');
      if (!okBody) return fail(res, 403, 'Missing CSRF header');
    }
    next();
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  const authLimiter = new KeyedLimiter(LIMITS.authAttemptsPerIp, 10 * 60_000);
  /** Confirmation and reset messages: 3 per address and 10 per IP each hour. */
  const mailAddrLimiter = new KeyedLimiter(3, 60 * 60_000);
  const mailIpLimiter = new KeyedLimiter(10, 60 * 60_000);
  const allowMail = (ip: string, addressKey: string) => mailIpLimiter.take(ip) && mailAddrLimiter.take(addressKey);
  const nameLimiter = new KeyedLimiter(10, 15 * 60_000);
  const regLimiter = new KeyedLimiter(REGISTRATIONS_PER_IP_PER_HOUR, 60 * 60_000);
  const iceLimiter = new KeyedLimiter(30, 60_000);
  const adminLimiter = new KeyedLimiter(120, 60_000);
  const captchaLimiter = new KeyedLimiter(30, 10 * 60_000);
  const gifLimiter = new KeyedLimiter(40, 60_000);
  const uploadLimiter = new KeyedLimiter(20, 60_000);
  const chatImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CHAT_IMAGE_MAX_BYTES, files: 1 } }).single('image');
  const voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: VOICE_MAX_BYTES, files: 1 } }).single('voice');
  const soundUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SOUND_MAX_BYTES, files: 1 } }).single('file');
  const profileLimiter = new KeyedLimiter(20, 60_000);
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
      else cb(new Error('Use JPEG, PNG, or WebP'));
    },
  }).single('avatar');

  app.get('/api/build', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ build: live.buildId });
  });
  app.get('/api/health', (_req, res) => {
    let db = true;
    try { repo.listActiveBans(); } catch { db = false; }
    res.setHeader('Cache-Control', 'no-store');
    res.status(db ? 200 : 500).json({
      ok: db, app: BRAND_NAME, db, build: live.buildId,
      package: live.release.packageSha256, commit: live.release.commit, release: live.release, ...live.stats(),
      mail: mailConfigured, emailVerifyRequired: emailVerifyRequiredEffective(),
      tiktok: tiktokEnabled,
      uptimeSec: Math.floor(process.uptime()), startedAt: PROCESS_STARTED_AT,
      ...backupHealth(),
    });
  });
  if (crashTestHooks) {
    // Test-only (CAMCHAT_TEST_CRASH_HOOKS=1): a sync throw and an async rejection must both become a 500 JSON.
    app.get('/api/test/throw', async (req) => {
      if (req.query.mode === 'async') { await Promise.resolve(); throw new Error('test async route failure'); }
      throw new Error('test sync route failure');
    });
  }
  const publicStatus = (): PublicStatus => {
    let db = true;
    try { repo.listActiveBans(); } catch { db = false; }
    const b = backupHealth();
    return {
      ok: db, db, uptimeSec: Math.floor(process.uptime()), startedAt: PROCESS_STARTED_AT,
      package: live.release.packageSha256, commit: live.release.commit, releasedAt: live.release.releasedAt,
      lastBackupAt: b.lastBackupAt ?? null, lastBackupOk: b.lastBackupOk ?? null, checkedAt: Date.now(),
    };
  };
  app.get('/api/status', (_req, res) => {
    const st = publicStatus();
    res.setHeader('Cache-Control', 'no-store');
    res.status(st.ok ? 200 : 503).json(st);
  });
  app.get('/status', (_req, res) => {
    const st = publicStatus();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(st.ok ? 200 : 503).send(statusHtml(st));
  });
  app.get('/api/rooms', (_req, res) => res.json({ rooms: roomList() }));

  /** Session probe + device id bootstrap (random id kept in localStorage AND an httpOnly cookie). */
  app.get('/api/me', (req, res) => {
    const c = cookiesOf(req)[COOKIE_DID];
    const hdr = req.headers['x-device-id'];
    let deviceId = c && DEVICE_RE.test(c) ? c : typeof hdr === 'string' && DEVICE_RE.test(hdr) ? hdr : randomBytes(18).toString('base64url');
    if (deviceId !== c) setCookie(req, res, COOKIE_DID, deviceId, 2 * 365 * 86400);
    const acct = reqAccount(req);
    const account = acct ? { ...acct, videoQuality: repo.videoQualityOf(acct.id), uiTheme: repo.uiThemeOf(acct.id), linkPreviews: repo6.linkPreviewsOn(acct.id) } : null;
    const body: MeResponse = {
      account, deviceId, google: googleEnabled, discord: discordEnabled, tiktok: tiktokEnabled, gifs: gifsEnabled, guestCamAfterMinutes: GUEST_CAM_AFTER_MINUTES,
      captchaMode, captchaSiteKey: captchaMode === 'turnstile' ? TURNSTILE_SITE_KEY : captchaMode === 'hcaptcha' ? HCAPTCHA_SITE_KEY : null,
      emailVerifyRequired: emailVerifyRequiredEffective(), mailConfigured,
    };
    res.json(body);
  });


  async function gifRoute(req: Request, res: Response, kind: 'search' | 'trending') {
    if (!gifsEnabled && process.env.GIF_FIXTURE !== '1') return fail(res, 503, 'GIF search is not configured');
    if (!gifLimiter.take(clientIp(req))) return fail(res, 429, 'Too many GIF searches. Try again later.');
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 20));
    const q = String(req.query.q ?? '').trim().slice(0, 80);
    if (kind === 'search' && !q) return fail(res, 400, 'Enter a search');
    try {
      const gifs = await searchGifs(kind, q, limit);
      res.json({ ok: true, gifs });
    } catch (e) {
      console.warn('[gifs]', (e as Error).message);
      return fail(res, 502, 'GIF search failed');
    }
  }
  app.get('/api/gifs/search', (req, res) => { void gifRoute(req, res, 'search'); });
  app.get('/api/gifs/trending', (req, res) => { void gifRoute(req, res, 'trending'); });

  const soundActor = (req: Request) => ({ accountId: reqAccount(req)?.id ?? null, devices: reqDevices(req) });

  /** Chat images belong to a room: only its members may upload, and the file is deleted with its message/room. */
  const chatImageRoute = (req: Request, res: Response, roomId: string) => {
    if (!uploadLimiter.take(clientIp(req))) return fail(res, 429, 'Too many uploads. Try again later.');
    if (!roomId) return fail(res, 400, 'Missing room');
    const actor = soundActor(req);
    if (!live.isRoomMember(roomId, actor.accountId, actor.devices)) return fail(res, 403, 'Join the room first');
    chatImageUpload(req, res, async (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        if (/File too large|LIMIT_FILE_SIZE/i.test(msg)) return fail(res, 400, 'Image too large (max 2 MB)');
        return fail(res, 400, 'Upload failed');
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return fail(res, 400, 'Choose an image');
      try {
        const saved = await storeRoomChatImage(roomId, file.buffer, { userId: actor.accountId, devices: actor.devices });
        res.json({ ok: true, url: saved.url, id: saved.name });
      } catch (e) {
        return fail(res, 400, (e as Error).message || 'Could not process image');
      }
    });
  };
  app.post('/api/rooms/:roomId/images', (req, res) => chatImageRoute(req, res, String(req.params.roomId)));
  // Older clients: same rules, room passed as ?roomId=. Without a room the upload is refused.
  app.post('/api/chat/image', (req, res) => chatImageRoute(req, res, typeof req.query.roomId === 'string' ? req.query.roomId : ''));

  app.get('/api/rooms/:roomId/sounds', (req, res) => {
    const roomId = String(req.params.roomId);
    const actor = soundActor(req);
    if (!live.isRoomMember(roomId, actor.accountId, actor.devices)) return fail(res, 403, 'Join the room first');
    const sounds = repo.listSounds(roomId).map((row) => ({ id: row.id, name: row.name }));
    res.json({ ok: true, sounds });
  });

  app.post('/api/rooms/:roomId/sounds', (req, res) => {
    if (!uploadLimiter.take(clientIp(req))) return fail(res, 429, 'Too many uploads. Try again later.');
    const roomId = String(req.params.roomId);
    const actor = soundActor(req);
    if (!live.isRoomCreator(roomId, actor.accountId, actor.devices)) return fail(res, 403, 'Only the room creator can add sounds');
    soundUpload(req, res, (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        if (/File too large|LIMIT_FILE_SIZE/i.test(msg)) return fail(res, 400, 'Sound too large (max 300 KB)');
        return fail(res, 400, 'Upload failed');
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return fail(res, 400, 'Choose an audio file');
      const name = cleanSoundName(req.body?.name);
      if (!name) return fail(res, 400, 'Name must be 1–24 characters');
      try {
        const saved = storeSound(roomId, name, file.buffer, file.mimetype);
        live.soundsChanged(roomId);
        res.json({ ok: true, sound: { id: saved.id, name: saved.name } });
      } catch (e) {
        return fail(res, 400, (e as Error).message || 'Could not store sound');
      }
    });
  });

  app.delete('/api/rooms/:roomId/sounds/:id', (req, res) => {
    const roomId = String(req.params.roomId);
    const actor = soundActor(req);
    if (!live.isRoomCreator(roomId, actor.accountId, actor.devices)) return fail(res, 403, 'Only the room creator can delete sounds');
    const row = repo.soundById(roomId, String(req.params.id));
    if (!row) return fail(res, 404, 'Sound not found');
    removeSoundFile(row);
    repo.deleteSound(roomId, row.id);
    live.soundsChanged(roomId);
    res.json({ ok: true });
  });

  app.get('/api/rooms/:roomId/sounds/:id/file', (req, res) => {
    const roomId = String(req.params.roomId);
    const actor = soundActor(req);
    if (!live.isRoomMember(roomId, actor.accountId, actor.devices)) return fail(res, 403, 'Join the room first');
    const row = repo.soundById(roomId, String(req.params.id));
    if (!row) return res.status(404).end();
    const file = soundFilePath(row.id, row.ext);
    if (!file || !fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file);
  });


  // ---------- voice notes: members-only upload + playback; message posted over the socket ----------
  app.post('/api/rooms/:roomId/voice', (req, res) => {
    if (!uploadLimiter.take(clientIp(req))) return fail(res, 429, 'Too many uploads. Try again later.');
    const roomId = String(req.params.roomId);
    const actor = soundActor(req);
    if (!live.isRoomMember(roomId, actor.accountId, actor.devices)) return fail(res, 403, 'Join the room first');
    voiceUpload(req, res, (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        if (/File too large|LIMIT_FILE_SIZE/i.test(msg)) return fail(res, 413, 'Voice note too large (max 1 MB)');
        return fail(res, 400, 'Upload failed');
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return fail(res, 400, 'No recording');
      try {
        const row = storeVoiceNote(roomId, file.buffer, { userId: actor.accountId, devices: actor.devices });
        res.json({ ok: true, id: row.id, mime: row.mime });
      } catch (e) {
        return fail(res, 400, (e as Error).message || 'Could not store voice note');
      }
    });
  });

  app.get('/api/voice/:id', (req, res) => {
    const row = repo.voiceNoteById(String(req.params.id));
    if (!row) return res.status(404).end();
    const actor = soundActor(req);
    if (!live.isRoomMember(row.room_id, actor.accountId, actor.devices)) return res.status(403).end();
    const file = voiceFilePath(row.id, row.ext);
    if (!file || !fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(file);
  });

  app.get('/api/uploads/:name', (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9_-]{8,80}\.(webp|gif)$/.test(name)) return res.status(404).end();
    const file = uploadPath(name);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Content-Type', name.endsWith('.gif') ? 'image/gif' : 'image/webp');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file);
  });


  app.get('/api/profile/colors', (_req, res) => {
    res.json({ ok: true, colors: CHAT_COLORS });
  });

  app.patch('/api/me/color', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    const raw = (req.body as { color?: unknown })?.color;
    if (raw === null || raw === '') {
      repo.setChatColor(a.id, null);
      live.profileChanged(a.id);
      return res.json({ ok: true, chatColor: null });
    }
    const color = normalizeChatColor(raw);
    if (!color) return fail(res, 400, 'Pick a color from the palette');
    repo.setChatColor(a.id, color);
    live.profileChanged(a.id);
    res.json({ ok: true, chatColor: color });
  });


  // ---- cosmetic badges ----
  const badgesBody = (userId: number): BadgesResponse => {
    const earned = repo.badgesFor(userId);
    const chosen = repo.shownBadgeChoice(userId);
    const thresholds: Record<string, number> = {};
    for (const b of BADGES) if (b.stat) thresholds[b.id] = badgeThreshold(b, BADGE_THRESHOLD_DIV);
    return { ok: true, earned, stats: repo.statsFor(userId), thresholds, shown: shownBadges(chosen, earned.map((b) => b.id)), chosen };
  };
  app.get('/api/me/badges', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    res.setHeader('Cache-Control', 'no-store');
    res.json(badgesBody(a.id));
  });
  /** body { shown: string[] (max 3, owned) } or { shown: null } for "most recent 3" */
  app.patch('/api/me/badges', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    const raw = (req.body as { shown?: unknown })?.shown;
    if (raw === null) repo.setShownBadges(a.id, null);
    else {
      const owned = new Set(repo.badgesFor(a.id).map((b) => b.id));
      const pick = cleanShownBadges(raw, owned);
      if (!pick) return fail(res, 400, 'Pick up to 3 badges you have earned');
      repo.setShownBadges(a.id, pick);
    }
    live.badgesChanged(a.id);
    res.json(badgesBody(a.id));
  });

  /** body { linkPreviews: boolean } - show link preview cards under chat lines */
  app.patch('/api/me/link-previews', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    const v = (req.body as { linkPreviews?: unknown })?.linkPreviews;
    if (typeof v !== 'boolean') return fail(res, 400, 'linkPreviews must be true or false');
    repo6.setLinkPreviews(a.id, v);
    res.json({ ok: true, linkPreviews: v });
  });

  /** body { uiTheme: 'dark' | 'dark-red' | 'dark-green' | 'dark-orange' } */
  app.patch('/api/me/ui-theme', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    const v = (req.body as { uiTheme?: unknown })?.uiTheme;
    if (!isUiTheme(v)) return fail(res, 400, 'Pick a theme from the list');
    repo.setUiTheme(a.id, v);
    res.json({ ok: true, uiTheme: v });
  });

  /** body { videoQuality: 'auto' | 'high' | 'medium' | 'low' | 'saver' } */
  app.patch('/api/me/video-quality', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    const v = (req.body as { videoQuality?: unknown })?.videoQuality;
    if (!isVideoQuality(v)) return fail(res, 400, 'Pick a quality from the list');
    repo.setVideoQuality(a.id, v);
    res.json({ ok: true, videoQuality: v });
  });

  app.patch('/api/me/effect', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    const raw = (req.body as { effect?: unknown })?.effect;
    const effect = normalizeChatEffect(raw);
    if (!effect) return fail(res, 400, 'Pick an effect from the list');
    const stored = effect === 'none' ? null : effect;
    repo.setChatEffect(a.id, stored);
    live.profileChanged(a.id);
    res.json({ ok: true, chatEffect: stored });
  });

  app.post('/api/me/avatar', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    avatarUpload(req, res, async (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        if (/File too large|LIMIT_FILE_SIZE/i.test(msg)) return fail(res, 400, 'Image too large (max 512 KB)');
        return fail(res, 400, msg.includes('JPEG') ? msg : 'Upload failed');
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return fail(res, 400, 'Choose an image file');
      try {
        const webp = await processAvatarUpload(file.buffer);
        writeAvatar(a.id, webp);
        repo.setHasAvatar(a.id, true);
        live.profileChanged(a.id);
        res.json({ ok: true, hasAvatar: true, url: `/api/avatars/${a.id}.webp` });
      } catch (e) {
        return fail(res, 400, (e as Error).message || 'Could not process image');
      }
    });
  });

  app.delete('/api/me/avatar', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    deleteAvatarFile(a.id);
    repo.setHasAvatar(a.id, false);
    live.profileChanged(a.id);
    res.json({ ok: true, hasAvatar: false });
  });

  // ---- custom room thumbnails (owner or site staff) ----
  const thumbLimiter = new KeyedLimiter(10, 10 * 60_000);
  const thumbUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: ROOM_THUMB_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
      else cb(new Error('Use PNG, JPEG, WebP or GIF'));
    },
  }).single('thumb');
  /** Only the owning account or site staff may change a room's thumbnail. Private calls have none. */
  const thumbGate = (req: Request, res: Response) => {
    const a = reqAccount(req);
    if (!a) { fail(res, 401, 'Sign in first'); return null; }
    const roomId = String(req.params.roomId ?? '');
    const info = live.roomThumbInfo(roomId);
    if (!info) { fail(res, 404, 'Room not found'); return null; }
    if (info.isPrivate) { fail(res, 403, 'Private calls cannot have a thumbnail'); return null; }
    if (!isStaffRole(a.role) && (info.ownerUserId == null || info.ownerUserId !== a.id)) { fail(res, 403, 'Only the room owner can change the thumbnail'); return null; }
    if (!thumbLimiter.take(`${clientIp(req)}|${a.id}`)) { fail(res, 429, 'Too many thumbnail changes. Try again later.'); return null; }
    return { a, roomId, info };
  };
  app.post('/api/rooms/:roomId/thumb', (req, res) => {
    const g = thumbGate(req, res);
    if (!g) return;
    thumbUpload(req, res, async (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        if (/File too large|LIMIT_FILE_SIZE/i.test(msg)) return fail(res, 400, 'Image too large (max 5 MB)');
        return fail(res, 400, msg.startsWith('Use ') ? msg : 'Upload failed');
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return fail(res, 400, 'Choose an image file');
      try {
        const webp = await processRoomThumb(file.buffer);
        const cur = live.roomThumbInfo(g.roomId);
        if (!cur) return fail(res, 404, 'Room not found');
        const id = newThumbId();
        writeRoomThumb(id, webp);
        repo.setRoomThumb(g.roomId, id);
        deleteRoomThumb(cur.thumbId);
        live.roomThumbChanged(g.roomId, id, g.a.username);
        repo.logAction(g.a.username, g.a.id, 'room-thumb', null, g.roomId, 'set');
        res.json({ ok: true, thumbUrl: roomThumbUrl(id) });
      } catch (e) {
        return fail(res, 400, (e as Error).message || 'Could not process image');
      }
    });
  });
  app.delete('/api/rooms/:roomId/thumb', (req, res) => {
    const g = thumbGate(req, res);
    if (!g) return;
    if (!g.info.thumbId) return res.json({ ok: true, thumbUrl: null });
    repo.setRoomThumb(g.roomId, null);
    deleteRoomThumb(g.info.thumbId);
    live.roomThumbChanged(g.roomId, null, g.a.username);
    repo.logAction(g.a.username, g.a.id, 'room-thumb', null, g.roomId, 'removed');
    res.json({ ok: true, thumbUrl: null });
  });
  // ---- room banner (theme), same rules as the thumbnail; stored next to thumbnails with its own random id ----
  const bannerGate = (req: Request, res: Response) => {
    const a = reqAccount(req);
    if (!a) { fail(res, 401, 'Sign in first'); return null; }
    const roomId = String(req.params.roomId ?? '');
    const info = live.roomBannerInfo(roomId);
    if (!info) { fail(res, 404, 'Room not found'); return null; }
    if (info.isPrivate) { fail(res, 403, 'Private calls cannot have a banner'); return null; }
    if (!isStaffRole(a.role) && (info.ownerUserId == null || info.ownerUserId !== a.id)) { fail(res, 403, 'Only the room owner can change the banner'); return null; }
    if (!thumbLimiter.take(`${clientIp(req)}|${a.id}`)) { fail(res, 429, 'Too many image changes. Try again later.'); return null; }
    return { a, roomId, info };
  };
  app.post('/api/rooms/:roomId/banner', (req, res) => {
    const g = bannerGate(req, res);
    if (!g) return;
    thumbUpload(req, res, async (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        if (/File too large|LIMIT_FILE_SIZE/i.test(msg)) return fail(res, 400, 'Image too large (max 5 MB)');
        return fail(res, 400, msg.startsWith('Use ') ? msg : 'Upload failed');
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return fail(res, 400, 'Choose an image file');
      try {
        const webp = await processRoomThumb(file.buffer, ROOM_BANNER_W, ROOM_BANNER_H);
        const cur = live.roomBannerInfo(g.roomId);
        if (!cur) return fail(res, 404, 'Room not found');
        const id = newThumbId();
        writeRoomThumb(id, webp);
        live.roomBannerChanged(g.roomId, id, g.a.username);
        deleteRoomThumb(cur.bannerId);
        repo.logAction(g.a.username, g.a.id, 'room-banner', null, g.roomId, 'set');
        res.json({ ok: true, bannerUrl: roomBannerUrl(id) });
      } catch (e) {
        return fail(res, 400, (e as Error).message || 'Could not process image');
      }
    });
  });
  app.delete('/api/rooms/:roomId/banner', (req, res) => {
    const g = bannerGate(req, res);
    if (!g) return;
    if (!g.info.bannerId) return res.json({ ok: true, bannerUrl: null });
    live.roomBannerChanged(g.roomId, null, g.a.username);
    deleteRoomThumb(g.info.bannerId);
    repo.logAction(g.a.username, g.a.id, 'room-banner', null, g.roomId, 'removed');
    res.json({ ok: true, bannerUrl: null });
  });
  app.get('/api/room-banners/:id.webp', (req, res) => {
    const id = String(req.params.id);
    if (!ROOM_THUMB_ID_RE.test(id)) return res.status(404).end();
    const row = repo4.roomByBannerId(id);
    if (!row || row.is_private || !roomThumbExists(id)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(roomThumbPath(id)!);
  });
  /** Unguessable id; only rooms listed in the lobby (never private calls) are served. A new id per upload, so cache forever. */
  app.get('/api/room-thumbs/:id.webp', (req, res) => {
    const id = String(req.params.id);
    if (!ROOM_THUMB_ID_RE.test(id)) return res.status(404).end();
    const row = repo.roomByThumbId(id);
    if (!row || row.is_private || !roomThumbExists(id)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(roomThumbPath(id)!);
  });

  // ---- custom room icons (owner or site staff; same rules as thumbnails and the same rate limit) ----
  const iconUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: ROOM_ICON_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
      else cb(new Error('Use PNG, JPEG, WebP or GIF'));
    },
  }).single('icon');
  const iconGate = (req: Request, res: Response) => {
    const a = reqAccount(req);
    if (!a) { fail(res, 401, 'Sign in first'); return null; }
    const roomId = String(req.params.roomId ?? '');
    const info = live.roomIconInfo(roomId);
    if (!info) { fail(res, 404, 'Room not found'); return null; }
    if (info.isPrivate) { fail(res, 403, 'Private calls cannot have an icon'); return null; }
    if (!isStaffRole(a.role) && (info.ownerUserId == null || info.ownerUserId !== a.id)) { fail(res, 403, 'Only the room owner can change the icon'); return null; }
    if (!thumbLimiter.take(`${clientIp(req)}|${a.id}`)) { fail(res, 429, 'Too many image changes. Try again later.'); return null; }
    return { a, roomId, info };
  };
  app.post('/api/rooms/:roomId/icon', (req, res) => {
    const g = iconGate(req, res);
    if (!g) return;
    iconUpload(req, res, async (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        if (/File too large|LIMIT_FILE_SIZE/i.test(msg)) return fail(res, 400, 'Image too large (max 2 MB)');
        return fail(res, 400, msg.startsWith('Use ') ? msg : 'Upload failed');
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return fail(res, 400, 'Choose an image file');
      try {
        const webp = await processRoomIcon(file.buffer);
        const cur = live.roomIconInfo(g.roomId);
        if (!cur) return fail(res, 404, 'Room not found');
        const id = newIconId();
        writeRoomIcon(id, webp);
        repo.setRoomIcon(g.roomId, id);
        deleteRoomIcon(cur.iconId);
        live.roomIconChanged(g.roomId, id, g.a.username);
        repo.logAction(g.a.username, g.a.id, 'room-icon', null, g.roomId, 'set');
        res.json({ ok: true, iconUrl: roomIconUrl(id) });
      } catch (e) {
        return fail(res, 400, (e as Error).message || 'Could not process image');
      }
    });
  });
  app.delete('/api/rooms/:roomId/icon', (req, res) => {
    const g = iconGate(req, res);
    if (!g) return;
    if (!g.info.iconId) return res.json({ ok: true, iconUrl: null });
    repo.setRoomIcon(g.roomId, null);
    deleteRoomIcon(g.info.iconId);
    live.roomIconChanged(g.roomId, null, g.a.username);
    repo.logAction(g.a.username, g.a.id, 'room-icon', null, g.roomId, 'removed');
    res.json({ ok: true, iconUrl: null });
  });
  /** Unguessable id; never served for private calls. A new id per upload, so cache forever. */
  app.get('/api/room-icons/:id.webp', (req, res) => {
    const id = String(req.params.id);
    if (!ROOM_ICON_ID_RE.test(id)) return res.status(404).end();
    const row = repo.roomByIconId(id);
    if (!row || row.is_private || !roomIconExists(id)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(roomIconPath(id)!);
  });

  // ---- invite links (/i/<code>) ----
  const inviteCreateLimiter = new KeyedLimiter(Number(process.env.INVITE_CREATE_BURST) || 20, 10 * 60_000);
  const inviteRedeemLimiter = new KeyedLimiter(Number(process.env.INVITE_REDEEM_BURST) || 30, 10 * 60_000);
  const inviteLookupLimiter = new KeyedLimiter(120, 60_000);
  type InviteRoom = NonNullable<ReturnType<typeof live.inviteRoom>>;
  /** owner / site staff always; room mods when the owner turned "room mods can create invites" on */
  const inviteRights = (a: repo.Account, room: InviteRoom) => {
    const full = isStaffRole(a.role) || (room.ownerUserId != null && room.ownerUserId === a.id);
    const mod = !full && room.modIds.includes(a.id) && invites.modsCanInvite(room.id);
    return { create: full || mod, full };
  };
  const inviteGate = (req: Request, res: Response) => {
    const a = reqAccount(req);
    if (!a) { fail(res, 401, 'Sign in first'); return null; }
    const room = live.inviteRoom(String(req.params.roomId ?? ''));
    if (!room) { fail(res, 404, 'Room not found'); return null; }
    if (room.isPrivate) { fail(res, 403, 'Private calls cannot have invite links'); return null; }
    const rights = inviteRights(a, room);
    if (!rights.create) { fail(res, 403, 'Only the room owner (or room mods, if the owner allows it) can manage invite links'); return null; }
    return { a, room, rights };
  };
  const inviteOut = (r: invites.InviteRow, a: repo.Account, full: boolean) => ({ ...invites.toInfo(r), canRevoke: full || r.created_by === a.id });
  const makeInvite = (a: repo.Account, room: InviteRoom, o: { expiresAt: number | null; maxUses: number | null; skipPassword: boolean; isDefault: boolean }) => {
    const r = invites.create({ roomId: room.id, byId: a.id, byName: a.username, ...o });
    const exp = o.expiresAt ? `expires ${new Date(o.expiresAt).toISOString()}` : 'never expires';
    repo.logAction(a.username, a.id, 'invite-create', null, room.id,
      `${r.code.slice(0, 4)}… ${exp}, ${o.maxUses ?? 'unlimited'} uses${o.skipPassword ? ', skips password' : ''}${o.isDefault ? ', default link' : ''}`);
    return r;
  };
  app.get('/api/rooms/:roomId/invites', (req, res) => {
    const g = inviteGate(req, res);
    if (!g) return;
    res.json({ ok: true, invites: invites.listForRoom(g.room.id).map((r) => inviteOut(r, g.a, g.rights.full)), modsCanInvite: invites.modsCanInvite(g.room.id), canSkipPassword: g.rights.full });
  });
  app.post('/api/rooms/:roomId/invites', (req, res) => {
    const g = inviteGate(req, res);
    if (!g) return;
    const exp = String(req.body?.expires ?? '1d') as InviteExpiry;
    if (!(exp in INVITE_EXPIRY)) return fail(res, 400, 'Pick an expiry: 30m, 1h, 1d, 7d or never');
    const mu = req.body?.maxUses ?? null;
    if (!(INVITE_MAX_USES as readonly (number | null)[]).includes(mu)) return fail(res, 400, 'Max uses must be 1, 5, 10, 25, 100 or unlimited');
    const skip = req.body?.skipPassword === true;
    if (skip && !g.rights.full) return fail(res, 403, 'Only the room owner or staff can make links that skip the password');
    if (invites.activeCount(g.room.id) >= INVITES_PER_ROOM) return fail(res, 400, `A room can have at most ${INVITES_PER_ROOM} active invite links. Revoke some first.`);
    if (!inviteCreateLimiter.take(`u:${g.a.id}`) || !inviteCreateLimiter.take(`ip:${clientIp(req)}`)) return fail(res, 429, 'Too many invite links. Try again later.');
    const ms = INVITE_EXPIRY[exp];
    const r = makeInvite(g.a, g.room, { expiresAt: ms == null ? null : Date.now() + ms, maxUses: mu, skipPassword: skip, isDefault: false });
    res.json({ ok: true, invite: inviteOut(r, g.a, g.rights.full), url: `${baseUrl(req)}/i/${r.code}` });
  });
  /** "Copy invite link": the caller's active default link (1 day, unlimited), or a new one. */
  app.post('/api/rooms/:roomId/invites/default', (req, res) => {
    const g = inviteGate(req, res);
    if (!g) return;
    let r = invites.activeDefault(g.room.id, g.a.id);
    let created = false;
    if (!r) {
      if (invites.activeCount(g.room.id) >= INVITES_PER_ROOM) return fail(res, 400, `A room can have at most ${INVITES_PER_ROOM} active invite links. Revoke some first.`);
      if (!inviteCreateLimiter.take(`u:${g.a.id}`) || !inviteCreateLimiter.take(`ip:${clientIp(req)}`)) return fail(res, 429, 'Too many invite links. Try again later.');
      r = makeInvite(g.a, g.room, { expiresAt: Date.now() + INVITE_EXPIRY['1d'], maxUses: null, skipPassword: false, isDefault: true });
      created = true;
    }
    res.json({ ok: true, invite: inviteOut(r, g.a, g.rights.full), url: `${baseUrl(req)}/i/${r.code}`, created });
  });
  app.delete('/api/rooms/:roomId/invites/:code', (req, res) => {
    const g = inviteGate(req, res);
    if (!g) return;
    const r = invites.byCode(String(req.params.code));
    if (!r || r.room_id !== g.room.id) return fail(res, 404, 'Invite not found');
    if (!g.rights.full && r.created_by !== g.a.id) return fail(res, 403, 'Room mods can revoke only their own links');
    if (invites.revoke(r.code, g.a.username)) repo.logAction(g.a.username, g.a.id, 'invite-revoke', null, g.room.id, `${r.code.slice(0, 4)}… (${r.uses} uses)`);
    res.json({ ok: true });
  });
  app.patch('/api/rooms/:roomId/invite-settings', (req, res) => {
    const g = inviteGate(req, res);
    if (!g) return;
    if (!g.rights.full) return fail(res, 403, 'Only the room owner or staff can change this');
    const on = req.body?.modsCanInvite === true;
    invites.setModsCanInvite(g.room.id, on);
    repo.logAction(g.a.username, g.a.id, 'invite-settings', null, g.room.id, `room mods can create invites: ${on ? 'on' : 'off'}`);
    live.inviteSettingsChanged(g.room.id, on, g.a.username);
    res.json({ ok: true, modsCanInvite: on });
  });
  /** What the landing page shows. Anyone holding the link may look (signed out too); nothing is consumed. */
  const invitePublic = (code: string): InvitePublic => {
    const r = invites.byCode(code);
    const st = invites.statusOf(r);
    if (!r || st !== 'ok') return { status: st };
    const room = live.inviteRoom(r.room_id);
    if (!room || room.isPrivate) return { status: 'notfound' };
    const open = !room.passwordRequired || !!r.skip_password;
    return {
      status: 'ok', skipPassword: !!r.skip_password, expiresAt: r.expires_at,
      room: {
        name: room.name, passwordRequired: room.passwordRequired,
        ...(room.iconId ? { iconUrl: roomIconUrl(room.iconId) } : {}), ...(room.thumbId ? { thumbUrl: roomThumbUrl(room.thumbId) } : {}),
        ...(open ? { topic: room.topic, users: room.users, category: room.category, tags: room.tags } : {}),
      },
    };
  };
  app.get('/api/invites/:code', (req, res) => {
    if (!inviteLookupLimiter.take(clientIp(req))) return fail(res, 429, 'Too many requests. Try again later.');
    const code = String(req.params.code);
    if (!INVITE_CODE_RE.test(code)) return res.json({ ok: true, invite: { status: 'notfound' } });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, invite: invitePublic(code) });
  });
  /** Signed in: count this account's use (once) and say which room to join. Bans are never bypassed. */
  app.post('/api/invites/:code/redeem', (req, res) => {
    const code = String(req.params.code);
    const a = reqAccount(req);
    if (!a) return res.status(401).json({ ok: false, error: 'Sign in or create an account to join.', needAuth: true, code: INVITE_CODE_RE.test(code) ? code : null });
    if (!inviteRedeemLimiter.take(`u:${a.id}`) || !inviteRedeemLimiter.take(`ip:${clientIp(req)}`)) return fail(res, 429, 'Too many invite attempts. Try again later.');
    const r = invites.byCode(code);
    const st = invites.statusOf(r);
    if (!r || st === 'notfound' || st === 'revoked' || st === 'expired') return res.status(410).json({ ok: false, status: st, error: 'This invite link is no longer valid.' });
    const room = live.inviteRoom(r.room_id);
    if (!room || room.isPrivate) return res.status(410).json({ ok: false, status: 'notfound', error: 'This room is gone.' });
    const gate = roomEntryError(a);
    if (gate) return res.status(403).json({ ok: false, error: gate, needsVerify: true });
    const siteBan = banCheck(req, a.id, isStaffRole(a.role));
    if (siteBan) return fail(res, 403, repo.banMessage(siteBan));
    if (!isStaffRole(a.role)) {
      const ban = repo.activeRoomBan(room.id, { userId: a.id, nick: a.username, ip: clientIp(req), deviceIds: reqDevices(req) });
      if (ban) return res.status(403).json({ ok: false, error: `You are banned from this room${ban.reason ? `: ${ban.reason}` : '.'}`, banned: true });
    }
    const out = invites.redeem(r.code, a.id);
    if (!out.ok) return res.status(410).json({ ok: false, status: out.status, error: out.status === 'used' ? 'This invite link has been used up.' : 'This invite link is no longer valid.' });
    res.json({ ok: true, roomId: room.id, roomName: room.name, skipPassword: !!out.row.skip_password, passwordRequired: room.passwordRequired, firstUse: out.first });
  });

  // ---- share preview cards (Open Graph / Twitter) ----
  const cardRoom = (room: InviteRoom): CardRoom => ({ ...room });
  const sendCard = async (req: Request, res: Response, room: InviteRoom | null, skips: boolean) => {
    const v = variantFor(room, skips);
    if (!room || v === 'none') return res.redirect(302, '/og-image.png');
    const e = await roomCard(cardRoom(room), v, clientDir);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('ETag', e.etag);
    if (req.headers['if-none-match'] === e.etag) return res.status(304).end();
    res.setHeader('Content-Length', String(e.buf.length));
    res.end(e.buf);
  };
  app.get('/api/og/room/:roomId.jpg', (req, res, next) => {
    sendCard(req, res, live.inviteRoom(String(req.params.roomId)), false).catch(next);
  });
  app.get('/api/og/invite/:code.jpg', (req, res, next) => {
    const r = invites.byCode(String(req.params.code));
    const ok = invites.statusOf(r) === 'ok';
    sendCard(req, res, ok && r ? live.inviteRoom(r.room_id) : null, ok && !!r?.skip_password).catch(next);
  });

  // ---- batch 3: custom room emotes (owner or site staff; same visibility as thumbnails) ----
  const emoteLimiter = new KeyedLimiter(30, 10 * 60_000);
  const emoteUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: EMOTE_MAX_BYTES, files: 1, fields: 4, fieldSize: 200 },
    fileFilter: (_req, file, cb) => {
      if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
      else cb(new Error('Use PNG, JPEG, WebP or GIF'));
    },
  }).single('emote');
  const emoteGate = (req: Request, res: Response) => {
    const a = reqAccount(req);
    if (!a) { fail(res, 401, 'Sign in first'); return null; }
    const roomId = String(req.params.roomId ?? '');
    const info = live.roomThumbInfo(roomId);
    if (!info) { fail(res, 404, 'Room not found'); return null; }
    if (info.isPrivate) { fail(res, 403, 'Private calls cannot have emotes'); return null; }
    if (!isStaffRole(a.role) && (info.ownerUserId == null || info.ownerUserId !== a.id)) { fail(res, 403, 'Only the room owner can manage emotes'); return null; }
    if (!emoteLimiter.take(`${clientIp(req)}|${a.id}`)) { fail(res, 429, 'Too many emote changes. Try again later.'); return null; }
    return { a, roomId };
  };
  const emoteJson = (e: repo3.EmoteRow) => ({ id: e.id, name: e.name, url: emoteUrl(e.id), animated: !!e.animated });
  const emoteName = (raw: unknown) => (typeof raw === 'string' ? raw.trim().toLowerCase().replace(/^:+|:+$/g, '') : '');
  app.get('/api/rooms/:roomId/emotes', (req, res) => {
    const info = live.roomThumbInfo(String(req.params.roomId));
    if (!info || info.isPrivate) return fail(res, 404, 'Room not found');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, emotes: repo3.emotesForRoom(String(req.params.roomId)).map(emoteJson) });
  });
  app.post('/api/rooms/:roomId/emotes', (req, res) => {
    const g = emoteGate(req, res);
    if (!g) return;
    emoteUpload(req, res, async (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        if (/File too large|LIMIT_FILE_SIZE/i.test(msg)) return fail(res, 400, 'Image too large (max 512 KB)');
        return fail(res, 400, msg.startsWith('Use ') ? msg : 'Upload failed');
      }
      const name = emoteName((req.body as { name?: unknown } | undefined)?.name);
      if (!EMOTE_NAME_RE.test(name)) return fail(res, 400, 'Emote names are 2-24 characters: a-z, 0-9 and _');
      if (hasFilteredWord(name) || hasFilteredWord(name.replace(/_/g, ' '))) return fail(res, 400, 'Please pick another name');
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return fail(res, 400, 'Choose an image file');
      if (repo3.emoteCount(g.roomId) >= EMOTES_PER_ROOM) return fail(res, 409, `A room can have at most ${EMOTES_PER_ROOM} emotes`);
      if (repo3.emoteNameTaken(g.roomId, name)) return fail(res, 409, `:${name}: already exists in this room`);
      try {
        const { webp, animated } = await processEmote(file.buffer);
        const row = { id: newEmoteId(), room_id: g.roomId, name, animated: animated ? 1 : 0, created_by: g.a.id, created_at: Date.now() };
        writeEmote(row.id, webp);
        try { repo3.insertEmote(row); } catch { deleteEmoteFile(row.id); return fail(res, 409, `:${name}: already exists in this room`); }
        repo.logAction(g.a.username, g.a.id, 'emote-add', name, g.roomId);
        live.roomEmotesChanged(g.roomId);
        live.emoteAdded(g.roomId, emoteJson(row), { id: g.a.id, username: g.a.username });
        res.json({ ok: true, emote: emoteJson(row) });
      } catch (e) {
        return fail(res, 400, (e as Error).message || 'Could not process image');
      }
    });
  });
  app.patch('/api/rooms/:roomId/emotes/:id', (req, res) => {
    const g = emoteGate(req, res);
    if (!g) return;
    const e = repo3.emoteById(String(req.params.id));
    if (!e || e.room_id !== g.roomId) return fail(res, 404, 'Emote not found');
    const name = emoteName((req.body as { name?: unknown } | undefined)?.name);
    if (!EMOTE_NAME_RE.test(name)) return fail(res, 400, 'Emote names are 2-24 characters: a-z, 0-9 and _');
    if (hasFilteredWord(name) || hasFilteredWord(name.replace(/_/g, ' '))) return fail(res, 400, 'Please pick another name');
    if (repo3.emoteNameTaken(g.roomId, name, e.id)) return fail(res, 409, `:${name}: already exists in this room`);
    repo3.renameEmote(e.id, name);
    repo.logAction(g.a.username, g.a.id, 'emote-rename', `${e.name}->${name}`, g.roomId);
    live.roomEmotesChanged(g.roomId);
    res.json({ ok: true, emote: emoteJson({ ...e, name }) });
  });
  app.delete('/api/rooms/:roomId/emotes/:id', (req, res) => {
    const g = emoteGate(req, res);
    if (!g) return;
    const e = repo3.emoteById(String(req.params.id));
    if (!e || e.room_id !== g.roomId) return fail(res, 404, 'Emote not found');
    repo3.deleteEmote(e.id);
    deleteEmoteFile(e.id);
    repo.logAction(g.a.username, g.a.id, 'emote-remove', e.name, g.roomId);
    live.roomEmotesChanged(g.roomId);
    res.json({ ok: true });
  });
  /** Unguessable id, never for private calls; a new id per upload (rename keeps it), so cache forever. */
  app.get('/api/room-emotes/:id.webp', (req, res) => {
    const id = String(req.params.id);
    if (!EMOTE_ID_RE.test(id)) return res.status(404).end();
    const e = repo3.emoteById(id);
    const info = e ? live.roomThumbInfo(e.room_id) : null;
    if (!e || !info || info.isPrivate || !emoteFileExists(id)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(emotePath(id)!);
  });
  // ---- batch 3: Labs FM album art, fetched + re-encoded server-side (never hotlinked) ----
  app.get('/api/radio/art/:id.webp', (req, res) => {
    const id = String(req.params.id);
    const body = ART_ID_RE.test(id) ? radioArt(id) : null;
    if (!body) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.end(body);
  });

  app.get('/api/avatars/:id.webp', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).end();
    const u = repo.userById(id);
    if (!u || !u.has_avatar || !avatarExists(id)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.sendFile(avatarPath(id));
  });

  app.get('/api/auth/captcha', (req, res) => {
    if (!captchaLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    res.json({ ok: true, ...issueCaptcha() });
  });

  app.get('/api/ice', (req, res) => {
    const ip = clientIp(req);
    if (!iceLimiter.take(ip)) return fail(res, 429, 'Too many requests');
    const account = reqAccount(req);
    const devices = reqDevices(req);
    // TURN credentials only for a known browser (device cookie / session) that isn't banned
    let id: string | null = account ? `u${account.id}` : devices[0] ? `g${createHash('sha256').update(devices[0]).digest('hex').slice(0, 12)}` : null;
    if (id && repo.activeBan({ userId: account?.id ?? null, ip, deviceIds: devices, staff: account ? isStaffRole(account.role) : false })) id = null;
    res.json(iceServers(id));
  });

  // ---------- accounts ----------
  function startSession(req: Request, res: Response, userId: number) {
    const s = repo.createSession(userId, clientIp(req), String(req.headers['user-agent'] ?? ''));
    setCookie(req, res, COOKIE_SID, s.token, s.maxAgeSec);
  }
  function banCheck(req: Request, userId: number | null, staff = false) {
    return repo.activeBan({ userId, ip: clientIp(req), deviceIds: reqDevices(req), staff });
  }

  app.post('/api/auth/register', async (req, res) => {
    const ip = clientIp(req);
    if (!authLimiter.take(ip)) return fail(res, 429, 'Too many attempts. Try again later.');
    if (!REGISTRATION_OPEN) return fail(res, 403, 'Registration is closed');
    const captchaErr = await verifyCaptcha(req.body ?? {}, ip);
    if (captchaErr) return fail(res, 400, captchaErr);
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!isValidNick(username)) return fail(res, 400, `Username must be ${LIMITS.nickMin}-${LIMITS.nickMax} chars: letters, numbers, _ or -, starting with a letter.`);
    if (password.length < LIMITS.passwordMin || password.length > LIMITS.passwordMax) return fail(res, 400, `Password must be ${LIMITS.passwordMin}-${LIMITS.passwordMax} characters.`);
    if (password.toLowerCase() === username.toLowerCase()) return fail(res, 400, 'Password must differ from the username.');
    const ban = banCheck(req, null);
    if (ban) return fail(res, 403, repo.banMessage(ban));
    if (RESERVED_NAMES.includes(username.toLowerCase()) || hasFilteredWord(username)) return fail(res, 400, 'That username is not available.');
    const email = normalizeEmail(req.body?.email);
    if (!email) return fail(res, 400, 'Enter a valid email address.');
    if (repo.userByName(username)) return fail(res, 409, 'That username is already registered.');
    if (repo.userByEmail(email)) return fail(res, 409, 'That email is already in use.');
    if (live.nickHeldByOther(username, reqDevices(req))) return fail(res, 409, 'Someone is using that name right now.');
    if (!regLimiter.take(ip)) return fail(res, 429, 'Too many new accounts from your network. Try later.');
    const hash = await hashSecret(password);
    let account: repo.Account;
    try { account = repo.createUser(username, hash, null, ip, null, email); } catch { return fail(res, 409, 'That username or email is already in use.'); }
    startSession(req, res, account.id);
    repo.logAction(account.username, account.id, 'register', account.username, null, `ip ${ip}`);
    // An invite being followed rides along in the confirmation link so it continues after the email step.
    const invite = typeof req.body?.invite === 'string' && INVITE_CODE_RE.test(req.body.invite) ? req.body.invite : null;
    await sendVerification(req, account.id, email, invite);
    res.json({ ok: true, account: repo.accountById(account.id) });
  });

  /** Mail a 60-minute link and 6-digit code. Does not throw. Returns false when the rate limit hits. */
  async function sendVerification(req: Request, userId: number, email: string, invite: string | null = null): Promise<boolean> {
    const ip = clientIp(req);
    const lower = email.toLowerCase();
    if (!allowMail(ip, lower)) return false;
    const raw = randomBytes(24).toString('base64url');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    repo.createEmailToken(userId, lower, hashToken(raw), hashToken(code), LIMITS.passwordResetTtlMin);
    const link = `${baseUrl(req)}/verify-email?token=${raw}${invite ? `&invite=${invite}` : ''}`;
    const text = [
      'Confirm your zeronoise email.',
      '',
      `Open this link (it expires in ${LIMITS.passwordResetTtlMin} minutes):`,
      link,
      '',
      `Or enter this code: ${code}`,
      '',
      'If you did not ask for this, you can ignore it.',
    ].join('\n');
    const html = brandedHtml('Confirm your email', [
      'This link expires in 60 minutes.',
      link,
      `Or enter this code: ${code}`,
      'If you did not ask for this, you can ignore it.',
    ]);
    if (mailConfigured) await sendMail(email, 'Confirm your zeronoise email', text, html);
    return true;
  }

  app.post('/api/auth/login', async (req, res) => {
    const ip = clientIp(req);
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!authLimiter.take(ip) || !nameLimiter.take(username.toLowerCase())) return fail(res, 429, 'Too many attempts. Try again later.');
    if (!username || !password || password.length > LIMITS.passwordMax) return fail(res, 400, 'Enter username and password.');
    const u = repo.userByName(username);
    const good = await checkSecret(password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !u.password_hash || !good) return fail(res, 401, 'Wrong username or password.');
    const ban = banCheck(req, u.id, isStaffRole(u.role));
    if (ban) return fail(res, 403, repo.banMessage(ban));
    const account = repo.touchLogin(u.id, ip)!;
    startSession(req, res, u.id);
    res.json({ ok: true, account });
  });

  app.post('/api/auth/logout', (req, res) => {
    repo.deleteSession(cookiesOf(req)[COOKIE_SID]);
    setCookie(req, res, COOKIE_SID, '', 0);
    res.json({ ok: true });
  });

  // ---------- optional Google sign-in (enabled only when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set) ----------
  const baseUrl = (req: Request) => PUBLIC_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;

  /**
   * Native shells cannot finish Google/Discord OAuth inside the webview (Google rejects embedded
   * user-agents). They open this route in the system browser with ?client=native&nonce=<challenge>,
   * where challenge is base64url(sha256(verifier)) and the verifier never leaves the app.
   * The challenge cookie rides along on the top-level Lax redirect back from the provider.
   * The app then loads /api/auth/native?token=&verifier= inside the webview.
   */
  function rememberNativeNonce(req: Request, res: Response) {
    if (req.query.client !== 'native') return;
    const n = typeof req.query.nonce === 'string' ? req.query.nonce : '';
    if (NATIVE_NONCE_RE.test(n)) setCookie(req, res, COOKIE_OAUTH_NONCE, n, 600);
  }
  function takeNativeNonce(req: Request, res: Response): string | null {
    const n = cookiesOf(req)[COOKIE_OAUTH_NONCE];
    if (n) setCookie(req, res, COOKIE_OAUTH_NONCE, '', 0);
    return n && NATIVE_NONCE_RE.test(n) ? n : null;
  }
  function nativeRedirect(res: Response, params: Record<string, string>) {
    const u = new URL(`${NATIVE_AUTH_SCHEME}://auth`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    res.setHeader('Cache-Control', 'no-store');
    res.status(302).setHeader('Location', u.toString()).end();
  }
  /** Browser OAuth redirects home. Native OAuth redirects to camchat://auth so the app can adopt the session. */
  function oauthReturn(req: Request, res: Response) {
    return (err?: string, userId?: number) => {
      const nonce = takeNativeNonce(req, res);
      if (nonce) {
        if (err || !userId) return nativeRedirect(res, { error: err || 'Sign-in failed.', nonce });
        startSession(req, res, userId);
        return nativeRedirect(res, { token: issueNativeHandoff(userId, nonce), nonce });
      }
      if (!err && userId) startSession(req, res, userId);
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(err ? `/?authError=${encodeURIComponent(err)}` : '/');
    };
  }

  /** Request a password reset. Always returns a generic message. Token is stored hashed; admins can mint a visible link. */
  app.post('/api/auth/forgot', async (req, res) => {
    const ip = clientIp(req);
    if (!authLimiter.take(ip)) return fail(res, 429, 'Too many attempts. Try again later.');
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const generic = { ok: true, message: 'If that account exists, a password reset was created. Ask a moderator for a reset link, or check email if configured.' };
    if (!username) return res.json(generic);
    const u = username.includes('@') ? repo.userByEmail(username) : repo.userByName(username);
    if (!u || !u.password_hash) return res.json(generic);
    const addressKey = u.email_lower || `user:${u.id}`;
    if (!allowMail(ip, addressKey)) return res.json(generic);
    const raw = randomBytes(24).toString('base64url');
    repo.createPasswordReset(u.id, hashToken(raw), 'self', LIMITS.passwordResetTtlMin);
    const link = `${baseUrl(req)}/reset?token=${raw}`;
    if (u.email && u.email_verified_at) {
      const text = [
        `A password reset was requested for ${u.username}.`,
        '',
        `Open this link (it expires in ${LIMITS.passwordResetTtlMin} minutes):`,
        link,
        '',
        'If you did not ask for this, you can ignore it. Your password stays the same.',
      ].join('\n');
      const html = brandedHtml('Reset your password', [
        `This link expires in ${LIMITS.passwordResetTtlMin} minutes.`,
        link,
        'If you did not ask for this, you can ignore it.',
      ]);
      await sendMail(u.email, 'Reset your zeronoise password', text, html);
    }
    if (smtpConfigured && process.env.SMTP_NOTIFY_EMAIL) {
      await sendMail(process.env.SMTP_NOTIFY_EMAIL, `${BRAND_NAME} password reset for ${u.username}`,
        `${BRAND_NAME}: password reset requested for ${u.username} from ${ip}.\nOne-time link (expires in ${LIMITS.passwordResetTtlMin} min):\n${link}\n`);
    }
    repo.logAction(u.username, u.id, 'password-reset-request', u.username, null, `ip ${ip}`);
    res.json(generic);
  });

  app.post('/api/auth/verify-email', (req, res) => {
    const ip = clientIp(req);
    if (!authLimiter.take(ip)) return fail(res, 429, 'Too many attempts. Try again later.');
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const secret = token || code;
    if (!secret || secret.length > 80) return fail(res, 400, 'That confirmation link or code is not valid.');
    const row = repo.consumeEmailToken(hashToken(secret));
    if (!row) return fail(res, 400, 'That confirmation link or code is not valid.');
    const u = repo.userById(row.userId);
    if (!u || u.email_lower !== row.emailLower) return fail(res, 400, 'That confirmation link or code is not valid.');
    repo.markEmailVerified(u.id, row.emailLower);
    const account = repo.accountById(u.id);
    const sessionUser = reqAccount(req);
    if (!sessionUser) startSession(req, res, u.id);
    res.json({ ok: true, account });
  });

  app.post('/api/auth/verify-email/send', async (req, res) => {
    const ip = clientIp(req);
    if (!authLimiter.take(ip)) return fail(res, 429, 'Too many attempts. Try again later.');
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    const u = repo.userById(a.id);
    if (!u?.email) return fail(res, 400, 'Add an email address first.');
    if (u.email_verified_at) return res.json({ ok: true, account: repo.accountById(u.id) });
    const invite = typeof req.body?.invite === 'string' && INVITE_CODE_RE.test(req.body.invite) ? req.body.invite : null;
    const sent = await sendVerification(req, u.id, u.email, invite);
    if (!sent) return fail(res, 429, 'Too many confirmation emails. Try again in a while.');
    res.json({ ok: true, account: repo.accountById(u.id) });
  });

  app.post('/api/me/email', async (req, res) => {
    const ip = clientIp(req);
    if (!authLimiter.take(ip)) return fail(res, 429, 'Too many attempts. Try again later.');
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    const email = normalizeEmail(req.body?.email);
    if (!email) return fail(res, 400, 'Enter a valid email address.');
    const saved = repo.setEmail(a.id, email, false);
    if (saved === 'taken') return fail(res, 409, 'That email is already in use.');
    repo.logAction(a.username, a.id, 'email-change', a.username, null, `ip ${ip}`);
    const sent = await sendVerification(req, a.id, email);
    if (!sent) return fail(res, 429, 'Email saved. Too many confirmation emails. Try again in a while.');
    res.json({ ok: true, account: repo.accountById(a.id) });
  });

  app.post('/api/auth/reset', async (req, res) => {
    const ip = clientIp(req);
    if (!authLimiter.take(ip)) return fail(res, 429, 'Too many attempts. Try again later.');
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!token || token.length > 80) return fail(res, 400, 'Invalid or expired reset link.');
    if (password.length < LIMITS.passwordMin || password.length > LIMITS.passwordMax) return fail(res, 400, `Password must be ${LIMITS.passwordMin}-${LIMITS.passwordMax} characters.`);
    const userId = repo.consumePasswordReset(hashToken(token));
    if (!userId) return fail(res, 400, 'Invalid or expired reset link.');
    const u = repo.userById(userId);
    if (!u) return fail(res, 400, 'Invalid or expired reset link.');
    if (password.toLowerCase() === u.username.toLowerCase()) return fail(res, 400, 'Password must differ from the username.');
    const hash = await hashSecret(password);
    repo.setPasswordHash(userId, hash);
    repo.logAction(u.username, u.id, 'password-reset', u.username, null, `ip ${ip}`);
    startSession(req, res, userId);
    res.json({ ok: true, account: repo.accountById(userId) });
  });

  app.get('/api/auth/google', (req, res) => {
    if (req.query.provider === 'tiktok') return startTikTok(req, res);
    if (!googleEnabled) return fail(res, 404, 'Google sign-in is not configured');
    const state = randomBytes(18).toString('base64url');
    setCookie(req, res, COOKIE_OAUTH, state, 600);
    rememberNativeNonce(req, res);
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, redirect_uri: `${baseUrl(req)}/api/auth/google/callback`, response_type: 'code',
      scope: 'openid email profile', state, prompt: 'select_account',
    }).toString();
    res.redirect(u.toString());
  });
  app.get('/api/auth/google/callback', async (req, res) => {
    const back = oauthReturn(req, res);
    if (!googleEnabled) return back('Google sign-in is not configured');
    const state = cookiesOf(req)[COOKIE_OAUTH];
    setCookie(req, res, COOKIE_OAUTH, '', 0);
    if (!state || req.query.state !== state || typeof req.query.code !== 'string') return back('Sign-in expired, please try again.');
    if (!authLimiter.take(clientIp(req))) return back('Too many attempts. Try again later.');
    try {
      const tok = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: req.query.code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: `${baseUrl(req)}/api/auth/google/callback`, grant_type: 'authorization_code' }),
      }).then((r) => r.json()) as { access_token?: string };
      if (!tok.access_token) return back('Google sign-in failed.');
      const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } })
        .then((r) => r.json()) as { sub?: string; email?: string; email_verified?: boolean; given_name?: string; name?: string };
      if (!info.sub) return back('Google sign-in failed.');
      const googleEmail = normalizeEmail(info.email);
      let u = repo.userByGoogle(info.sub);
      let userId: number;
      if (u) userId = u.id;
      else {
        const ban = banCheck(req, null);
        if (ban) return back(repo.banMessage(ban));
        if (!REGISTRATION_OPEN) return back('Registration is closed');
        if (googleEmail && repo.userByEmail(googleEmail)) return back('That email is already in use.');
        let base = (info.given_name || info.email?.split('@')[0] || 'user').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
        if (!/^[A-Za-z]/.test(base)) base = `u${base}`;
        if (base.length < 3) base = `${base}user`;
        let name = base;
        for (let i = 0; (repo.isNameReserved(name) || live.nickHeldByOther(name, [])) && i < 50; i++) name = `${base}${Math.floor(Math.random() * 9000 + 1000)}`;
        userId = repo.createUser(name, null, info.sub, clientIp(req), null, googleEmail).id;
        repo.logAction(name, userId, 'register', name, null, 'google');
      }
      if (googleEmail) {
        const row = repo.userById(userId)!;
        const same = row.email_lower === googleEmail.toLowerCase();
        if (!same && !(row.email_verified_at && row.email_lower)) {
          const saved = repo.setEmail(userId, googleEmail, info.email_verified === true);
          if (saved === 'taken') return back('That email is already in use.');
        } else if (same && info.email_verified === true && !row.email_verified_at) {
          repo.markEmailVerified(userId, googleEmail.toLowerCase());
        }
      }
      u = repo.userById(userId)!;
      const ban = banCheck(req, u.id, isStaffRole(u.role));
      if (ban) return back(repo.banMessage(ban));
      repo.touchLogin(u.id, clientIp(req));
      return back(undefined, u.id);
    } catch (err) {
      console.warn('google oauth error', (err as Error).message);
      back('Google sign-in failed.');
    }
  });


  // ---------- optional Discord sign-in (enabled only when DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET are set) ----------
  app.get('/api/auth/discord', (req, res) => {
    if (req.query.provider === 'tiktok') return startTikTok(req, res);
    if (!discordEnabled) return fail(res, 404, 'Discord sign-in is not configured');
    const state = randomBytes(18).toString('base64url');
    setCookie(req, res, COOKIE_OAUTH, state, 600);
    rememberNativeNonce(req, res);
    const u = new URL('https://discord.com/api/oauth2/authorize');
    u.search = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: `${baseUrl(req)}/api/auth/discord/callback`,
      response_type: 'code',
      scope: 'identify',
      state,
    }).toString();
    res.redirect(u.toString());
  });
  app.get('/api/auth/discord/callback', async (req, res) => {
    const back = oauthReturn(req, res);
    if (!discordEnabled) return back('Discord sign-in is not configured');
    const state = cookiesOf(req)[COOKIE_OAUTH];
    setCookie(req, res, COOKIE_OAUTH, '', 0);
    if (!state || req.query.state !== state || typeof req.query.code !== 'string') return back('Sign-in expired, please try again.');
    if (!authLimiter.take(clientIp(req))) return back('Too many attempts. Try again later.');
    try {
      const tok = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          redirect_uri: `${baseUrl(req)}/api/auth/discord/callback`,
          grant_type: 'authorization_code',
        }),
      }).then((r) => r.json()) as { access_token?: string; error?: string };
      if (!tok.access_token) return back('Discord sign-in failed.');
      const info = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      }).then((r) => r.json()) as { id?: string; username?: string; global_name?: string | null };
      if (!info.id) return back('Discord sign-in failed.');
      let u = repo.userByDiscord(info.id);
      let userId: number;
      if (u) userId = u.id;
      else {
        const ban = banCheck(req, null);
        if (ban) return back(repo.banMessage(ban));
        if (!REGISTRATION_OPEN) return back('Registration is closed');
        let base = (info.global_name || info.username || 'discord').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
        if (!/^[A-Za-z]/.test(base)) base = `d${base}`;
        if (base.length < 2) base = `${base}user`;
        if (base.length < 3) base = `${base}x`;
        let name = base.slice(0, 20);
        for (let i = 0; (repo.isNameReserved(name) || live.nickHeldByOther(name, [])) && i < 50; i++) {
          const suffix = String(Math.floor(Math.random() * 9000 + 1000));
          name = `${base.slice(0, Math.max(2, 20 - suffix.length))}${suffix}`;
        }
        userId = repo.createUser(name, null, null, clientIp(req), info.id).id;
        repo.logAction(name, userId, 'register', name, null, 'discord');
      }
      u = repo.userById(userId)!;
      const ban = banCheck(req, u.id, isStaffRole(u.role));
      if (ban) return back(repo.banMessage(ban));
      repo.touchLogin(u.id, clientIp(req));
      return back(undefined, u.id);
    } catch (err) {
      console.warn('discord oauth error', (err as Error).message);
      back('Discord sign-in failed.');
    }
  });

  /**
   * TikTok Login Kit for Web. Redirect URI is PUBLIC_URL + /auth/tiktok/callback.
   * Web does not require PKCE (state plus the client secret is the documented model).
   * Desktop uses hex(SHA256(code_verifier)) as S256. We send that challenge and the
   * verifier on every start so the token call can include code_verifier either way.
   * The 1.2.0 shells only leave the webview for /api/auth/google and /api/auth/discord.
   * Inside those apps the button hits one of those paths with ?provider=tiktok, which
   * lands here before the Google or Discord enabled check.
   */
  const TIKTOK_OPEN_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
  function startTikTok(req: Request, res: Response) {
    if (!tiktokEnabled) return fail(res, 404, 'TikTok sign-in is not configured');
    const state = randomBytes(18).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('hex');
    setCookie(req, res, COOKIE_OAUTH, state, 600);
    setCookie(req, res, COOKIE_OAUTH_PKCE, verifier, 600);
    rememberNativeNonce(req, res);
    const u = new URL(TIKTOK_AUTHORIZE_URL);
    u.search = new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      response_type: 'code',
      scope: 'user.info.basic',
      redirect_uri: `${baseUrl(req)}/auth/tiktok/callback`,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(u.toString());
  }
  app.get('/api/auth/tiktok', (req, res) => startTikTok(req, res));
  app.get('/auth/tiktok/callback', async (req, res) => {
    const back = oauthReturn(req, res);
    if (!tiktokEnabled) return back('TikTok sign-in is not configured');
    const state = cookiesOf(req)[COOKIE_OAUTH];
    const verifier = cookiesOf(req)[COOKIE_OAUTH_PKCE];
    setCookie(req, res, COOKIE_OAUTH, '', 0);
    setCookie(req, res, COOKIE_OAUTH_PKCE, '', 0);
    if (typeof req.query.error === 'string') return back('TikTok sign-in was cancelled.');
    if (!state || req.query.state !== state || typeof req.query.code !== 'string' || !verifier) return back('Sign-in expired, please try again.');
    if (!authLimiter.take(clientIp(req))) return back('Too many attempts. Try again later.');
    try {
      const tok = await fetch(TIKTOK_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
        body: new URLSearchParams({
          client_key: TIKTOK_CLIENT_KEY,
          client_secret: TIKTOK_CLIENT_SECRET,
          code: req.query.code,
          grant_type: 'authorization_code',
          redirect_uri: `${baseUrl(req)}/auth/tiktok/callback`,
          code_verifier: verifier,
        }),
      }).then((r) => r.json()) as { access_token?: string; data?: { access_token?: string }; error?: string };
      const access = tok.access_token || tok.data?.access_token;
      if (!access) {
        console.warn('tiktok oauth token', typeof tok.error === 'string' ? tok.error.slice(0, 40) : 'token');
        return back('TikTok sign-in failed.');
      }
      const infoUrl = new URL(TIKTOK_USERINFO_URL);
      infoUrl.searchParams.set('fields', 'open_id,union_id,avatar_url,display_name');
      const info = await fetch(infoUrl, { headers: { Authorization: `Bearer ${access}` } })
        .then((r) => r.json()) as { data?: { user?: { open_id?: string; display_name?: string } }; error?: { code?: string } };
      const openId = info.data?.user?.open_id || '';
      const infoCode = info.error?.code;
      if ((infoCode && infoCode !== 'ok') || !TIKTOK_OPEN_ID_RE.test(openId)) {
        console.warn('tiktok oauth userinfo', typeof infoCode === 'string' ? infoCode.slice(0, 40) : 'userinfo');
        return back('TikTok sign-in failed.');
      }
      let u = repo.userByTikTok(openId);
      let userId: number;
      if (u) userId = u.id;
      else {
        const ban = banCheck(req, null);
        if (ban) return back(repo.banMessage(ban));
        if (!REGISTRATION_OPEN) return back('Registration is closed');
        let base = (info.data?.user?.display_name || 'tiktok').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
        if (!/^[A-Za-z]/.test(base)) base = `t${base}`;
        if (base.length < 2) base = `${base}user`;
        if (base.length < 3) base = `${base}x`;
        let name = base.slice(0, 20);
        for (let i = 0; (repo.isNameReserved(name) || live.nickHeldByOther(name, [])) && i < 50; i++) {
          const suffix = String(Math.floor(Math.random() * 9000 + 1000));
          name = `${base.slice(0, Math.max(2, 20 - suffix.length))}${suffix}`;
        }
        userId = repo.createUser(name, null, null, clientIp(req), null, null, openId).id;
        repo.logAction(name, userId, 'register', name, null, 'tiktok');
      }
      u = repo.userById(userId)!;
      const ban = banCheck(req, u.id, isStaffRole(u.role));
      if (ban) return back(repo.banMessage(ban));
      repo.touchLogin(u.id, clientIp(req));
      return back(undefined, u.id);
    } catch (err) {
      console.warn('tiktok oauth error', (err as Error).message);
      back('TikTok sign-in failed.');
    }
  });

  /** The app webview loads this once, after the system browser bounced through camchat://auth. Sets the SameSite=Lax session cookie. */
  app.get('/api/auth/native', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const oops = (msg: string) => res.redirect(`/?authError=${encodeURIComponent(msg)}`);
    if (!authLimiter.take(clientIp(req))) return oops('Too many attempts. Try again later.');
    const userId = consumeNativeHandoff(req.query.token, req.query.verifier);
    if (!userId) return oops('Sign-in expired, please try again.');
    const u = repo.userById(userId);
    if (!u) return oops('Sign-in failed.');
    const ban = banCheck(req, u.id, isStaffRole(u.role));
    if (ban) return oops(repo.banMessage(ban));
    repo.touchLogin(u.id, clientIp(req));
    startSession(req, res, u.id);
    res.redirect('/');
  });

  // ---------- admin / moderator API ----------
  type StaffReq = Request & { staff: repo.Account };
  const requireStaff = (req: Request, res: Response, next: NextFunction) => {
    if (!adminLimiter.take(clientIp(req))) return fail(res, 429, 'Too many requests');
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!isStaffRole(a.role)) return fail(res, 403, 'Moderators only');
    (req as StaffReq).staff = a;
    next();
  };
  const admin = express.Router();
  asyncSafeRoutes(admin);
  admin.use(requireStaff);
  const actor = (req: Request) => (req as StaffReq).staff;
  const minutesOf = (v: unknown): number | null | undefined => (v === null || v === undefined || v === '' || v === 0 ? null : Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 60 * 24 * 3650 ? Math.round(Number(v)) : undefined);

  admin.get('/me', (req, res) => res.json({ ok: true, account: actor(req) }));
  // Site stats: daily active accounts / guests, busiest rooms, peak hours (?days=7|14|30, ?tz=<minutes east of UTC>)
  admin.get('/stats', (req, res) => {
    const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 14;
    const tz = Math.max(-840, Math.min(840, Math.round(Number(req.query.tz) || 0)));
    res.json({ ok: true, windowDays: days, ...repo6.adminStats(days, tz), live: live.liveCounts() });
  });
  // Moderation queue: ?view=queue groups reports by target (open / review / resolved / dismissed); without it, the flat list.
  admin.get('/reports', (req, res) => {
    if (req.query.view === 'queue') {
      const bucket = modq.isBucket(req.query.status) ? req.query.status : 'open';
      const sort = req.query.sort === 'oldest' || req.query.sort === 'newest' ? req.query.sort : 'count';
      return res.json({ ok: true, items: modq.listItems(bucket, sort, live.modqView(true)), counts: modq.counts() });
    }
    res.json({ ok: true, reports: repo.listReports(String(req.query.status || 'open')) });
  });
  admin.get('/reports/counts', (_req, res) => res.json({ ok: true, counts: modq.counts() }));
  admin.post('/reports/:id/claim', (req, res) => {
    const r = live.modqClaim(actor(req), Number(req.params.id), !!req.body?.release, !!req.body?.force);
    if (!r.ok) return fail(res, r.status, r.error);
    res.json({ ok: true });
  });
  admin.post('/reports/:id/action', (req, res) => {
    const r = live.modqAct(actor(req), Number(req.params.id), req.body);
    if (!r.ok) return fail(res, r.status, r.error);
    res.json(r);
  });
  /** Attachment copies kept with a report (site staff only). */
  admin.get('/reports/:id/evidence/:file', (req, res) => {
    const id = Number(req.params.id);
    const rep = modq.reportById(id);
    const f = rep ? modq.evidencePath(id, String(req.params.file)) : null;
    if (!f) return fail(res, 404, 'Not found');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
    res.sendFile(f);
  });
  admin.post('/reports/:id', (req, res) => {
    const status = req.body?.status;
    if (!['resolved', 'dismissed', 'open'].includes(status)) return fail(res, 400, 'Bad status');
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : null;
    if (!repo.setReportStatus(Number(req.params.id), status, actor(req).username, note)) return fail(res, 404, 'No such report');
    repo.logAction(actor(req).username, actor(req).id, `report:${status}`, `#${req.params.id}`, null, note);
    live.modqStatusChanged(Number(req.params.id), status);
    res.json({ ok: true });
  });
  admin.post('/reports/:id/ban', (req, res) => {
    const r = repo.reportRow(Number(req.params.id));
    if (!r) return fail(res, 404, 'No such report');
    const minutes = minutesOf(req.body?.minutes);
    if (minutes === undefined) return fail(res, 400, 'Bad duration');
    const reason = String(req.body?.reason || r.reason).slice(0, LIMITS.banReasonMax);
    if (r.target_user_id) {
      const t = repo.userById(r.target_user_id);
      if (t && rank[t.role] >= rank[actor(req).role]) return fail(res, 403, 'You cannot ban that user');
    }
    const label = r.target_nick;
    const ids: number[] = [];
    if (r.target_user_id) ids.push(repo.addBan('account', String(r.target_user_id), label, reason, actor(req).username, minutes));
    if (r.target_ip) ids.push(repo.addBan('ip', r.target_ip, label, reason, actor(req).username, minutes));
    if (r.target_device) ids.push(repo.addBan('device', r.target_device, label, reason, actor(req).username, minutes));
    if (!ids.length) return fail(res, 400, 'Nothing to ban');
    repo.setReportStatus(r.id, 'resolved', actor(req).username, `banned (${minutes ? `${minutes} min` : 'permanent'})`);
    repo.logAction(actor(req).username, actor(req).id, 'ban', label, r.room_id, `from report #${r.id}; ${minutes ? `${minutes} min` : 'permanent'}; ${reason}`);
    live.enforceBans();
    live.modqStatusChanged(r.id, 'resolved');
    res.json({ ok: true, bans: ids.length });
  });
  admin.get('/bans', (_req, res) => res.json({ ok: true, bans: repo.listActiveBans() }));
  admin.post('/bans', (req, res) => {
    const kind = req.body?.kind as BanKind;
    let value = typeof req.body?.value === 'string' ? req.body.value.trim() : '';
    const minutes = minutesOf(req.body?.minutes);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return fail(res, 400, 'A reason is required');
    if (minutes === undefined) return fail(res, 400, 'Bad duration');
    let label: string | null = null;
    if (kind === 'account') {
      const u = repo.userByName(value);
      if (!u) return fail(res, 404, 'No such user');
      if (rank[u.role] >= rank[actor(req).role]) return fail(res, 403, 'You cannot ban that user');
      label = u.username; value = String(u.id);
    } else if (kind === 'ip') {
      if (!net.isIP(value)) return fail(res, 400, 'Not an IP address');
    } else if (kind === 'device') {
      if (!DEVICE_RE.test(value)) return fail(res, 400, 'Not a device id');
    } else return fail(res, 400, 'Bad ban kind');
    const id = repo.addBan(kind, value, label, reason, actor(req).username, minutes);
    repo.logAction(actor(req).username, actor(req).id, 'ban', label ?? `${kind}:${value}`, null, `${minutes ? `${minutes} min` : 'permanent'}; ${reason}`);
    live.enforceBans();
    res.json({ ok: true, id });
  });
  admin.post('/bans/:id/lift', (req, res) => {
    if (!repo.liftBan(Number(req.params.id), actor(req).username)) return fail(res, 404, 'No active ban with that id');
    repo.logAction(actor(req).username, actor(req).id, 'unban', `#${req.params.id}`, null);
    res.json({ ok: true });
  });
  admin.get('/users', (req, res) => res.json({ ok: true, users: repo.searchUsers(String(req.query.q ?? '').slice(0, 40)) }));
  admin.post('/users/:id/role', (req, res) => {
    const me = actor(req);
    if (me.role !== 'admin') return fail(res, 403, 'Admins only');
    const role = req.body?.role;
    if (!repo.isRole(role)) return fail(res, 400, 'Bad role');
    const u = repo.userById(Number(req.params.id));
    if (!u) return fail(res, 404, 'No such user');
    if (u.id === me.id) return fail(res, 400, 'You cannot change your own role');
    if (u.role === 'admin' && role !== 'admin' && repo.adminCount() <= 1) return fail(res, 400, 'Cannot remove the last admin');
    repo.setRole(u.id, role);
    repo.logAction(me.username, me.id, 'role', u.username, null, `${u.role} -> ${role}`);
    live.roleChanged(u.id, role);
    res.json({ ok: true });
  });
  admin.get('/log', (_req, res) => res.json({ ok: true, log: repo.listLog() }));
  admin.get('/moderator-bot', (req, res) => {
    if (actor(req).role !== 'admin') return fail(res, 403, 'Admins only');
    res.json({ ok: true, botId: repo.moderatorBotId(), bots: repo.listAllBots() });
  });
  admin.post('/moderator-bot', (req, res) => {
    if (actor(req).role !== 'admin') return fail(res, 403, 'Admins only');
    const raw = req.body?.botId;
    if (raw === null || raw === undefined || raw === '' || raw === 'none') {
      const prev = repo.moderatorBotId();
      const prevBot = prev ? repo.botById(prev) : undefined;
      repo.setModeratorBotId(null);
      repo.logAction(actor(req).username, actor(req).id, 'moderator-bot', prevBot?.name ?? null, null, 'cleared');
      live.modBotChanged();
      return res.json({ ok: true, botId: null });
    }
    const id = Number(raw);
    const bot = repo.botById(id);
    if (!bot) return fail(res, 404, 'No such bot');
    repo.setModeratorBotId(bot.id);
    repo.logAction(actor(req).username, actor(req).id, 'moderator-bot', bot.name, null, 'set');
    live.modBotChanged();
    res.json({ ok: true, botId: bot.id, name: bot.name });
  });
  /** Mint a one-time password-reset link (shown once). Prefer this when SMTP is not configured. */
  /** Staff-only. The address is not written to the public action log. */
  admin.post('/users/:id/email', (req, res) => {
    const u = repo.userById(Number(req.params.id));
    if (!u) return fail(res, 404, 'No such user');
    if (rank[u.role] > rank[actor(req).role]) return fail(res, 403, 'You cannot edit that user');
    const wantVerified = req.body?.verified === true;
    const email = req.body?.email === undefined ? u.email : normalizeEmail(req.body?.email);
    if (req.body?.email !== undefined && !email) return fail(res, 400, 'Enter a valid email address.');
    if (email && email.toLowerCase() !== u.email_lower) {
      const saved = repo.setEmail(u.id, email, wantVerified);
      if (saved === 'taken') return fail(res, 409, 'That email is already in use.');
    } else if (wantVerified && u.email_lower) {
      repo.markEmailVerified(u.id, u.email_lower);
    }
    repo.logAction(actor(req).username, actor(req).id, 'email-update', u.username, null, wantVerified ? 'marked verified' : 'updated');
    res.json({ ok: true, user: repo.searchUsers(u.username).find((x) => x.id === u.id) ?? null });
  });
  admin.post('/users/:id/reset', (req, res) => {
    const u = repo.userById(Number(req.params.id));
    if (!u) return fail(res, 404, 'No such user');
    if (!u.password_hash) return fail(res, 400, 'That account has no password (e.g. Google-only).');
    const raw = randomBytes(24).toString('base64url');
    repo.createPasswordReset(u.id, hashToken(raw), actor(req).username, LIMITS.passwordResetTtlMin);
    repo.logAction(actor(req).username, actor(req).id, 'password-reset-issue', u.username, null);
    const link = `${baseUrl(req)}/reset?token=${raw}`;
    res.json({ ok: true, token: raw, link, expiresInMin: LIMITS.passwordResetTtlMin });
  });
  // ---------- backups (site admins only; names must match the exact archive pattern) ----------
  const BACKUP_NOW_GAP_MS = Math.max(0, Number(process.env.BACKUP_TEST_NOW_GAP_MS ?? 10 * 60_000));
  let lastManualBackupAt = 0;
  // Backups hold password hashes and emails: site admins only (moderators get 403).
  admin.use('/backups', (req, res, next) => {
    if (actor(req).role !== 'admin') return fail(res, 403, 'Admins only');
    next();
  });
  admin.get('/backups', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, backups: listBackups(), status: backupStatus(), nowAllowedAt: lastManualBackupAt ? lastManualBackupAt + BACKUP_NOW_GAP_MS : 0 });
  });
  admin.post('/backups/run', (req, res) => {
    if (backupRunning()) return fail(res, 409, 'A backup is already running');
    if (lastManualBackupAt && Date.now() - lastManualBackupAt < BACKUP_NOW_GAP_MS) {
      return fail(res, 429, `One manual backup per ${Math.round(BACKUP_NOW_GAP_MS / 60_000) || 1} minutes; try again later`);
    }
    lastManualBackupAt = Date.now();
    repo.logAction(actor(req).username, actor(req).id, 'backup:run', null, null, 'manual backup');
    void runBackup('manual');
    res.status(202).json({ ok: true, started: true });
  });
  admin.get('/backups/:name', (req, res) => {
    const file = backupPath(req.params.name);
    if (!file) return fail(res, 404, 'No such backup');
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return fail(res, 404, 'No such backup'); }
    repo.logAction(actor(req).username, actor(req).id, 'backup:download', req.params.name, null, null);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = fs.createReadStream(file);
    stream.on('error', (e) => { console.error('[backup] download failed', e.message); res.destroy(e); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  app.use('/api/admin', admin);

  // ---------- friends (REST mirror of socket helpers for initial load) ----------
  app.get('/api/friends', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    const rows = repo.listFriendships(a.id);
    const pack = (r: repo.FriendRow) => {
      const otherId = r.user_id === a.id ? r.peer_id : r.user_id;
      const other = repo.userById(otherId);
      return { userId: otherId, username: other?.username ?? '?', status: r.status as 'pending' | 'accepted', online: false };
    };
    const pendingIn = rows.filter((r) => r.status === 'pending' && r.requested_by !== a.id).map(pack);
    const pendingOut = rows.filter((r) => r.status === 'pending' && r.requested_by === a.id).map(pack);
    const friends = rows.filter((r) => r.status === 'accepted').map(pack);
    res.json({ ok: true, friends, pendingIn, pendingOut });
  });

  // ---------- batch 2: profiles, bio, web push, link-preview images ----------
  const publicLimiter = new KeyedLimiter(120, 60_000);
  app.get('/api/users/:name/profile', (req, res) => {
    if (!publicLimiter.take(clientIp(req))) return fail(res, 429, 'Too many requests. Try again later.');
    const viewer = reqAccount(req);
    if (!viewer) return fail(res, 401, 'Sign in first');
    const row = repo2.profileByName(String(req.params.name ?? '').slice(0, 40));
    if (!row) return fail(res, 404, 'No such user');
    let friend: 'self' | 'none' | 'friends' | 'pending-in' | 'pending-out' = 'none';
    if (row.id === viewer.id) friend = 'self';
    else {
      const f = repo.friendshipBetween(viewer.id, row.id);
      if (f) friend = f.status === 'accepted' ? 'friends' : f.requested_by === viewer.id ? 'pending-out' : 'pending-in';
    }
    const earned = repo.badgesFor(row.id).map((b) => b.id);
    const sid = live.accountSocket(row.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      profile: {
        id: row.id, username: row.username, role: row.role, chatColor: row.chat_color, chatEffect: row.chat_effect,
        hasAvatar: !!row.has_avatar, bio: row.bio ?? '', badges: shownBadges(repo.shownBadgeChoice(row.id), earned),
        joinedAt: row.created_at, rooms: repo2.publicRoomsOwned(row.id), friend, online: !!sid, ...(sid ? { socketId: sid } : {}),
        ...(() => {
          const p2 = repo7.profile2Of(row.id);
          return {
            bannerUrl: p2.bannerId ? bannerUrl(p2.bannerId) : null, links: p2.links, nowPlaying: p2.nowPlaying,
            mutualFriends: row.id === viewer.id ? [] : repo7.mutualFriends(viewer.id, row.id),
            mutualRooms: row.id === viewer.id ? [] : repo7.mutualRooms(viewer.id, row.id),
          };
        })(),
      },
    });
  });
  // ---- profiles 2.0 (batch C): banner, links, now playing ----
  const bannerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: BANNER_MAX_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
      else cb(new Error('Use JPEG, PNG, WebP or GIF'));
    },
  }).single('banner');
  app.get('/api/me/profile2', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    const p2 = repo7.profile2Of(a.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, bannerUrl: p2.bannerId ? bannerUrl(p2.bannerId) : null, links: p2.links, nowPlaying: p2.nowPlaying });
  });
  app.post('/api/me/banner', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    bannerUpload(req, res, async (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        if (/File too large|LIMIT_FILE_SIZE/i.test(msg)) return fail(res, 400, 'Image too large (max 2 MB)');
        return fail(res, 400, /Use JPEG/.test(msg) ? msg : 'Upload failed');
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file?.buffer?.length) return fail(res, 400, 'Choose an image file');
      try {
        const webp = await processBanner(file.buffer);
        const id = newBannerId();
        writeBanner(id, webp);
        const old = repo7.profile2Of(a.id).bannerId;
        repo7.setBanner(a.id, id);
        if (old) retireBanner(old);
        res.json({ ok: true, bannerUrl: bannerUrl(id) });
      } catch (e) { return fail(res, 400, (e as Error).message || 'Could not process image'); }
    });
  });
  app.delete('/api/me/banner', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    const old = repo7.profile2Of(a.id).bannerId;
    repo7.setBanner(a.id, null);
    if (old) retireBanner(old);
    res.json({ ok: true, bannerUrl: null });
  });
  app.get('/api/banners/:id.webp', (req, res) => {
    const id = String(req.params.id ?? '');
    if (!BANNER_ID_RE.test(id) || repo7.bannerOwner(id) == null) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(bannerPath(id), (e) => { if (e && !res.headersSent) res.status(404).end(); });
  });
  app.patch('/api/me/links', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    const v = checkProfileLinks((req.body as { links?: unknown })?.links);
    if (!v.ok) return fail(res, 400, v.error);
    const links = v.links.map((l) => ({ ...l, label: maskWords(l.label) }));
    if (links.some((l) => hasFilteredWord(l.url))) return fail(res, 400, 'Please use another link');
    repo7.setProfileLinks(a.id, links);
    res.json({ ok: true, links });
  });
  app.patch('/api/me/now-playing', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    const raw = (req.body as { text?: unknown })?.text;
    if (raw != null && typeof raw !== 'string') return fail(res, 400, 'Status must be text');
    if (typeof raw === 'string' && raw.trim().length > NOW_PLAYING_MAX) return fail(res, 400, `At most ${NOW_PLAYING_MAX} characters`);
    const text = cleanNowPlaying(raw ?? '');
    repo7.setNowPlaying(a.id, text ? maskWords(text) : null);
    res.json({ ok: true, nowPlaying: text ? maskWords(text) : null });
  });
  app.patch('/api/me/bio', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    const raw = (req.body as { bio?: unknown })?.bio;
    if (raw !== null && typeof raw !== 'string') return fail(res, 400, 'Bio must be text');
    const bio = cleanBio(raw ?? '');
    if (bio.length > BIO_MAX) return fail(res, 400, `Bio can be at most ${BIO_MAX} characters`);
    const stored = bio ? maskWords(bio) : null;
    repo2.setBio(a.id, stored);
    res.json({ ok: true, bio: stored ?? '' });
  });

  app.get('/api/push/key', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!pushEnabled) return res.json({ ok: true, enabled: false, key: null });
    res.json({ ok: true, enabled: true, key: vapidPublicKey });
  });
  app.post('/api/push/subscribe', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    if (!profileLimiter.take(clientIp(req))) return fail(res, 429, 'Too many attempts. Try again later.');
    if (!pushEnabled) return fail(res, 503, 'Push notifications are turned off on this server');
    const body = req.body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
    if (!validEndpoint(endpoint)) return fail(res, 400, 'Unsupported push service');
    const keys = { p256dh: body?.keys?.p256dh, auth: body?.keys?.auth };
    if (!validKeys(keys)) return fail(res, 400, 'Bad subscription keys');
    repo2.savePushSub(a.id, endpoint, keys.p256dh as string, keys.auth as string);
    res.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    const endpoint = typeof (req.body as { endpoint?: unknown })?.endpoint === 'string' ? (req.body as { endpoint: string }).endpoint : '';
    if (endpoint) repo2.deletePushSub(endpoint, a.id);
    else for (const sub of repo2.pushSubsFor(a.id)) repo2.deletePushSub(sub.endpoint, a.id);
    res.json({ ok: true });
  });
  app.get('/api/push/status', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, enabled: pushEnabled, subscriptions: repo2.pushSubsFor(a.id).length });
  });

  /** Preview thumbnails are fetched server-side (SSRF-checked) and re-encoded; only members of a room showing the preview may load it. */
  app.get('/api/link-preview/:id/image', async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) return res.status(404).end();
    if (!publicLimiter.take(clientIp(req))) return res.status(429).end();
    const actor = soundActor(req);
    const roomIds = repo2.previewRoomIds(id);
    if (!roomIds.some((r) => live.isRoomMember(r, actor.accountId, actor.devices))) return res.status(403).end();
    const img = await previewImage(id);
    if (!img) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.end(img);
  });

  // ---------- chat bots (session for the owner, bearer for the bot) ----------
  const botFailLimiter = new KeyedLimiter(30, 60_000);
  const botPostIp = new KeyedLimiter(30, 60_000);
  const MAX_BOTS = 20;
  const bearerToken = (req: Request): string | null => {
    const h = req.headers.authorization;
    if (typeof h !== 'string') return null;
    const m = /^Bearer\s+(\S+)$/.exec(h);
    if (!m || m[1].length > 200) return null;
    return m[1];
  };
  const newBotToken = () => {
    const token = `bot_${randomBytes(32).toString('base64url')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    return { token, hash };
  };
  const authedBot = (req: Request, res: Response): repo.BotRow | null => {
    const token = bearerToken(req);
    if (!token) { fail(res, 401, 'Missing bot token'); return null; }
    const bot = repo.botByToken(token);
    if (!bot) {
      if (!botFailLimiter.take(clientIp(req))) { fail(res, 429, 'Too many attempts. Try again later.'); return null; }
      fail(res, 401, 'Unknown bot token');
      return null;
    }
    live.noteModBot({ id: bot.id, name: bot.name, ownerUserId: bot.owner_user_id });
    return bot;
  };
  const botNameError = (name: string): string | null => {
    if (!isValidNick(name)) return 'Bot name must be 2-20 characters, start with a letter, and use only letters, numbers, _ or -.';
    if (hasFilteredWord(name)) return 'That name is not allowed';
    if (repo.isNameReserved(name) || repo.botByName(name)) return 'That name is taken';
    return null;
  };

  app.get('/api/bots', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    res.json({ ok: true, bots: repo.listBots(a.id) });
  });
  app.post('/api/bots', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const err = botNameError(name);
    if (err) return fail(res, err === 'That name is taken' ? 409 : 400, err);
    if (repo.countBots(a.id) >= MAX_BOTS) return fail(res, 400, 'Bot limit reached');
    const { token, hash } = newBotToken();
    try {
      const bot = repo.createBot(a.id, name, hash);
      res.json({ ok: true, bot: { id: bot.id, name: bot.name }, token });
    } catch {
      return fail(res, 409, 'That name is taken');
    }
  });
  app.get('/api/bots/me', (req, res) => {
    const bot = authedBot(req, res);
    if (!bot) return;
    const owner = repo.userById(bot.owner_user_id);
    res.json({ ok: true, id: bot.id, name: bot.name, owner: owner?.username ?? null });
  });
  app.post('/api/bots/:id/token', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    const id = Number(req.params.id);
    if (!repo.botOwned(id, a.id)) return fail(res, 404, 'No such bot');
    const { token, hash } = newBotToken();
    if (!repo.setBotToken(id, a.id, hash)) return fail(res, 404, 'No such bot');
    res.json({ ok: true, token });
  });
  app.post('/api/bots/:id/revoke', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    const id = Number(req.params.id);
    if (!repo.botOwned(id, a.id)) return fail(res, 404, 'No such bot');
    repo.setBotToken(id, a.id, null);
    live.botGone(id);
    res.json({ ok: true });
  });
  app.delete('/api/bots/:id', (req, res) => {
    const a = reqAccount(req);
    if (!a) return fail(res, 401, 'Sign in first');
    const id = Number(req.params.id);
    if (!repo.botOwned(id, a.id)) return fail(res, 404, 'No such bot');
    live.botGone(id);
    repo.deleteOwnedBot(id, a.id);
    live.modBotChanged();
    res.json({ ok: true });
  });
  app.post('/api/bots/rooms/:roomId/join', (req, res) => {
    const bot = authedBot(req, res);
    if (!bot) return;
    const r = live.botJoin(String(req.params.roomId), { id: bot.id, name: bot.name, ownerUserId: bot.owner_user_id });
    if (!r.ok) return fail(res, r.status, r.error);
    res.json({ ok: true });
  });
  app.post('/api/bots/rooms/:roomId/chat', (req, res) => {
    const bot = authedBot(req, res);
    if (!bot) return;
    if (!botPostIp.take(clientIp(req))) return fail(res, 429, 'Slow down');
    const r = live.botChat(String(req.params.roomId), { id: bot.id, name: bot.name, ownerUserId: bot.owner_user_id }, req.body?.text);
    if (!r.ok) return fail(res, r.status, r.error);
    res.json({ ok: true });
  });
  app.post('/api/bots/rooms/:roomId/gif', async (req, res) => {
    const bot = authedBot(req, res);
    if (!bot) return;
    if (!botPostIp.take(clientIp(req))) return fail(res, 429, 'Slow down');
    const r = await live.botGif(String(req.params.roomId), { id: bot.id, name: bot.name, ownerUserId: bot.owner_user_id }, String(req.body?.id ?? ''));
    if (!r.ok) return fail(res, r.status, r.error);
    res.json({ ok: true });
  });
  const botRoomReadBot = new KeyedLimiter(BOT_ROOM_READS_PER_MIN, 60_000);
  app.get('/api/bots/rooms/:roomId/messages', (req, res) => {
    const bot = authedBot(req, res);
    if (!bot) return;
    if (!botRoomReadBot.take(String(bot.id))) return fail(res, 429, 'Slow down');
    const rawLimit = req.query.limit;
    const limitExplicit = rawLimit !== undefined && rawLimit !== '';
    let limit: number | undefined;
    if (limitExplicit) {
      if (typeof rawLimit !== 'string' || !/^\d{1,3}$/.test(rawLimit)) return fail(res, 400, 'Bad limit');
      limit = Number(rawLimit);
      if (limit < 1 || limit > 100) return fail(res, 400, 'Bad limit');
    }
    const rawAfter = req.query.after;
    let after: string | undefined;
    if (rawAfter !== undefined && rawAfter !== '') {
      if (typeof rawAfter !== 'string') return fail(res, 400, 'Unknown cursor');
      after = rawAfter;
    }
    const r = live.botRoomMessages(String(req.params.roomId), { id: bot.id, name: bot.name, ownerUserId: bot.owner_user_id }, { after, limit, limitExplicit });
    if (!r.ok) return fail(res, r.status, r.error);
    res.json({ ok: true, messages: r.messages, cursor: r.cursor });
  });

  // Moderator-bot actions. Checked again inside live.botModerate so a normal bot token cannot reach them.
  const botModIp = new KeyedLimiter(30, 60_000);
  const botModBot = new KeyedLimiter(30, 60_000);
  const botReadBot = new KeyedLimiter(60, 60_000);
  const asBot = (bot: repo.BotRow): BotIdentity => ({ id: bot.id, name: bot.name, ownerUserId: bot.owner_user_id });
  const modFields = (req: Request): Omit<BotModBody, 'action'> => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const scope = b.scope === 'room' || b.scope === 'site' ? b.scope : undefined;
    return {
      roomId: typeof b.roomId === 'string' ? b.roomId : undefined,
      userId: typeof b.userId === 'string' ? b.userId : undefined,
      username: typeof b.username === 'string' ? b.username : undefined,
      reason: typeof b.reason === 'string' ? b.reason : undefined,
      minutes: b.minutes,
      banId: Number.isInteger(b.banId) ? b.banId as number : undefined,
      scope,
      messageId: typeof b.messageId === 'string' ? b.messageId : undefined,
    };
  };
  const runBotMod = (action: BotModAction) => (req: Request, res: Response) => {
    const bot = authedBot(req, res);
    if (!bot) return;
    if (!botModIp.take(clientIp(req)) || !botModBot.take(String(bot.id))) return fail(res, 429, 'Slow down');
    const r = live.botModerate(asBot(bot), { action, ...modFields(req) });
    if (!r.ok) return fail(res, r.status, r.error);
    res.json({ ok: true });
  };
  app.post('/api/bots/moderation/kick', runBotMod('kick'));
  app.post('/api/bots/moderation/ban', runBotMod('room-ban'));
  app.post('/api/bots/moderation/site-ban', runBotMod('site-ban'));
  app.post('/api/bots/moderation/unban', runBotMod('unban'));
  app.post('/api/bots/moderation/mute', runBotMod('mute'));
  app.post('/api/bots/moderation/delete', runBotMod('delete'));
  const botRead = (req: Request, res: Response, query: { kind: 'rooms' | 'messages'; roomId?: string }) => {
    const bot = authedBot(req, res);
    if (!bot) return;
    if (!botReadBot.take(String(bot.id))) return fail(res, 429, 'Slow down');
    let since: number | undefined;
    if (req.query.since !== undefined && req.query.since !== '') {
      const n = Number(req.query.since);
      if (!Number.isFinite(n) || n < 0) return fail(res, 400, 'Bad since');
      since = n;
    }
    let limit: number | undefined;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      const n = Number(req.query.limit);
      if (!Number.isFinite(n) || n <= 0) return fail(res, 400, 'Bad limit');
      limit = n;
    }
    const r = live.botModFeed(asBot(bot), { ...query, since, limit });
    if (!r.ok) return fail(res, r.status, r.error);
    if ('rooms' in r) res.json({ ok: true, rooms: r.rooms });
    else res.json({ ok: true, messages: r.messages });
  };
  app.get('/api/bots/moderation/rooms', (req, res) => botRead(req, res, { kind: 'rooms' }));
  app.get('/api/bots/moderation/messages', (req, res) => botRead(req, res, { kind: 'messages' }));
  app.get('/api/bots/moderation/rooms/:roomId/messages', (req, res) => botRead(req, res, { kind: 'messages', roomId: String(req.params.roomId) }));

  registerDownloads(app);

  /** Public. No session. HTML is in the response so a crawler does not need JavaScript. */
  const legal = (html: string) => (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  };
  app.get('/terms', legal(termsHtml()));
  app.get('/privacy', legal(privacyHtml()));

  /**
   * Public bot API docs. Registered before the SPA catch-all.
   * ETag plus must-revalidate: caches may store the page, but a deploy changes the hash.
   */
  const publicDoc = (body: string, contentType: string) => {
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    return (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.setHeader('ETag', etag);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Type', contentType);
      res.send(body);
    };
  };
  const botMarkdown = botApiMarkdown();
  app.get('/docs', (_req, res) => res.redirect(302, '/docs/bots'));
  app.get('/docs/bots.md', publicDoc(botMarkdown, 'text/markdown; charset=utf-8'));
  app.get('/docs/bots', publicDoc(botApiHtml(), 'text/html; charset=utf-8'));
  app.get('/llms.txt', publicDoc(llmsTxt(PUBLIC_URL), 'text/plain; charset=utf-8'));

  app.use('/api', (_req, res) => fail(res, 404, 'Not found'));

  // ---------- SPA ----------
  const clientDir = path.resolve(__dirname, '../../client'); // dist/server/server -> dist/client
  // push service worker: always revalidated so an update reaches browsers quickly
  // The build id is stamped in, so every deploy ships a byte-different worker: browsers install it and
  // its activate step drops the previous build's caches (see public/sw.js).
  app.get('/sw.js', (_req, res, next) => {
    const f = path.join(clientDir, 'sw.js');
    let src: string;
    try { src = fs.readFileSync(f, 'utf8'); } catch { return next(); }
    const body = src.replace(/__BUILD_ID__/g, String(live.buildId || 'dev').replace(/[^\w.-]/g, ''));
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
    res.type('application/javascript').send(body);
  });
  if (fs.existsSync(clientDir)) {
    // Text assets: brotli/gzip, immutable cache for hashed /assets/*, no-cache for index.html.
    app.use(clientTextAssets(clientDir, isProd));
    app.use(clientPrecompressed(clientDir, isProd));
    app.use(express.static(clientDir, { index: false, maxAge: isProd ? '1h' : 0, setHeaders: staticHeaders(isProd) }));
  }
  // A missing hashed bundle must not come back as the app HTML (that hides a bad deploy as a blank page).
  app.use('/assets', (_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  if (fs.existsSync(clientDir)) {
    // Share previews: the same SPA shell, with Open Graph / Twitter meta for this URL. Always revalidated.
    const shellFile = path.join(clientDir, 'index.html');
    let shell: { mtime: number; html: string } | null = null;
    const shellHtml = () => {
      const st = fs.statSync(shellFile);
      if (!shell || shell.mtime !== st.mtimeMs) shell = { mtime: st.mtimeMs, html: fs.readFileSync(shellFile, 'utf8') };
      return shell.html;
    };
    const metaFor = (req: Request): Meta => {
      const base = baseUrl(req);
      const inv = INVITE_PATH_RE.exec(req.path);
      if (inv) {
        const r = invites.byCode(inv[1]);
        const url = `${base}/i/${inv[1]}`;
        const room = r && invites.statusOf(r) === 'ok' ? live.inviteRoom(r.room_id) : null;
        if (!r || !room) return { ...siteMeta(base, url), title: `This invite link is no longer valid · ${BRAND_NAME}`, description: `Ask for a new invite, or browse open rooms on ${BRAND_NAME}.` };
        const v = variantFor(room, !!r.skip_password);
        return roomMeta(base, url, cardRoom(room), v, `/api/og/invite/${r.code}.jpg?v=${cardVersion(cardRoom(room), v)}`);
      }
      const roomId = req.path === '/' && typeof req.query.room === 'string' ? req.query.room : null;
      if (roomId) {
        const room = live.inviteRoom(roomId);
        const url = `${base}/?room=${encodeURIComponent(roomId)}`;
        if (!room) return siteMeta(base, `${base}/`);
        const v = variantFor(room);
        if (v === 'none') return siteMeta(base, `${base}/`);
        return roomMeta(base, url, cardRoom(room), v, `/api/og/room/${encodeURIComponent(room.id)}.jpg?v=${cardVersion(cardRoom(room), v)}`);
      }
      return siteMeta(base, `${base}/`);
    };
    app.get(['/', '/i/:code'], (req, res, next) => {
      if (req.path !== '/' && !INVITE_PATH_RE.test(req.path)) return next();
      let html: string;
      try { html = shellHtml(); } catch { return next(); }
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Vary', 'Accept-Encoding');
      res.type('html').send(injectMeta(html, metaFor(req)));
    });
    app.get('*', sendIndexHtml(clientDir));
  } else if (!isProd) {
    app.get('/', (_req, res) => res.type('text').send(`${BRAND_NAME} API running. In dev, open the Vite server on http://localhost:5173`));
  }
  // Last: any error that reaches here (sync throw, async rejection, body parser) becomes JSON; 5xx are logged.
  app.use(jsonErrorHandler);
  return app;
}
