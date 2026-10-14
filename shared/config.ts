/**
 * Branding + limits. Visible name is BRAND_NAME (wordmark, title, emails).
 * APP_NAME keys localStorage and must not change lightly. TAGLINE / LIMITS / DEFAULT_ROOMS
 * are also here. Values marked "env:" can be overridden at runtime (see README).
 */
export const APP_NAME = 'CamChat';
/** Visible brand (title, wordmark alt, emails). Separate from APP_NAME, which keys localStorage. */
export const BRAND_NAME = 'zeronoise';
export const TAGLINE = 'Hang out live. Cam, mic, or just type.';

export const LIMITS = {
  nickMin: 2,
  nickMax: 20,
  /** letters, digits, underscore, dash; must start with a letter */
  nickPattern: '^[A-Za-z][A-Za-z0-9_-]{1,19}$',
  passwordMin: 8,
  passwordMax: 128,
  roomNameMin: 3,
  roomNameMax: 32,
  roomTopicMax: 80,
  messageMax: 500,
  /** chat messages kept per room in the database and shown on join */
  historySize: 100,
  /** pinned messages per room (new pins; rooms pinned under the old limit of 10 keep showing theirs) */
  maxPins: 5,
  /** own messages can be edited for this long after sending */
  editWindowMs: 10 * 60_000,
  /** messages attached to a report as context */
  reportContext: 10,
  reportReasonMax: 300,
  banReasonMax: 200,
  maxUsersPerRoom: 50,
  /** WebRTC mesh gets heavy past this many simultaneous broadcasters */
  maxBroadcastersPerRoom: 8,
  maxRooms: 100,
  /** persistent rooms a registered (non-staff) user may own */
  maxRoomsPerUser: 3,
  /** chat / pm: tokens per window (per socket) */
  chatBurst: 5,
  chatWindowMs: 5000,
  /** generic actions (join, create, kick, media toggles) */
  actionBurst: 20,
  actionWindowMs: 10000,
  /** WebRTC signaling messages (ICE can be chatty) */
  signalBurst: 400,
  signalWindowMs: 10000,
  /** whiteboard strokes per socket */
  boardBurst: 30,
  boardWindowMs: 10000,
  boardHistory: 60,
  boardPoints: 200,
  /** the same buckets per client IP (all sockets from one IP share these) */
  ipChatBurst: 15,
  ipActionBurst: 60,
  ipSignalBurst: 1500,
  /** env: MAX_CONN_PER_IP - simultaneous sockets per IP */
  maxConnPerIp: 10,
  /** new socket connections per IP per minute */
  connectPerIpPerMin: 30,
  /** login/register attempts per IP per 10 minutes */
  authAttemptsPerIp: 20,
  /** accounts created per IP per hour */
  registrationsPerIpPerHour: 5,
  /** guests: max links in one message, and messages-with-links per minute */
  guestLinksPerMessage: 1,
  guestLinkMessagesPerMin: 2,
  mutePresetsMin: [5, 15, 60, 360, 1440] as readonly number[],
  /** room slow-mode presets (seconds between messages); 0 = off */
  slowModePresetsSec: [0, 5, 10, 30, 60] as readonly number[],
  /** password reset token lifetime */
  passwordResetTtlMin: 60,
} as const;

/**
 * Guest restrictions. camAfterMinutes: -1 = guests can never broadcast camera (must register),
 * 0 = guests can cam immediately, N = guests can cam after being connected N minutes.
 * env: GUEST_CAM_AFTER_MINUTES
 */
export const GUEST_POLICY = {
  camAfterMinutes: -1,
};

/** Names nobody (guest or account) can take. Registered usernames are reserved automatically. */
export const RESERVED_NAMES = ['admin', 'administrator', 'moderator', 'mod', 'mods', 'staff', 'system', 'support', 'root', 'owner', 'zeronoise', APP_NAME.toLowerCase()];

/**
 * Words masked with *** in chat, PMs and room topics (whole-word, case-insensitive).
 * env: WORD_FILTER (comma list, replaces this default; empty string disables) or WORD_FILTER_FILE (one per line).
 */
export const WORD_FILTER: string[] = ['fuck', 'fucking', 'shit', 'cunt', 'bitch', 'asshole', 'motherfucker'];

export const DEFAULT_ROOMS: { name: string; topic: string }[] = [
  { name: 'Lobby', topic: 'Say hi and find your people' },
  { name: 'Music', topic: 'Share what you are listening to' },
  { name: 'Gaming', topic: 'Squad up, talk games' },
  { name: 'Late Night', topic: 'Chill talk after dark' },
];
