/** Invite code format (tiny on purpose: the app shell imports it). */
export const INVITE_CODE_LEN = 12;
/** base62; other lengths still parse */
export const INVITE_CODE_RE = /^[A-Za-z0-9]{8,32}$/;
export const INVITE_PATH_RE = /^\/i\/([A-Za-z0-9]{8,32})\/?$/;
