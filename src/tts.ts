/**
 * Batch H10: read messages aloud with the browser's speechSynthesis. Off by default; settings are per account
 * on this browser (voices differ per device). A small queue with skip/stop, and rate limits so a flood of
 * messages can't take over: at most 2 lines per sender per 10 s, 12 per minute overall, 5 waiting at once.
 */
export type TtsMode = 'off' | 'mentions' | 'all';
export interface TtsPrefs { mode: TtsMode; lastOn: Exclude<TtsMode, 'off'>; voiceURI: string; rate: number; volume: number; mutedRooms: string[] }
export const TTS_DEFAULTS: TtsPrefs = { mode: 'off', lastOn: 'mentions', voiceURI: '', rate: 1, volume: 1, mutedRooms: [] };
export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

let who = 'guest';
let prefs: TtsPrefs = { ...TTS_DEFAULTS };
const listeners = new Set<() => void>();
const keyFor = (w: string) => `zn.tts.${w}`;
const notify = () => { for (const l of listeners) l(); };
export function ttsUser(accountId: number | null | undefined) {
  who = accountId ? `u${accountId}` : 'guest';
  try { const raw = localStorage.getItem(keyFor(who)); prefs = raw ? { ...TTS_DEFAULTS, ...(JSON.parse(raw) as Partial<TtsPrefs>) } : { ...TTS_DEFAULTS }; } catch { prefs = { ...TTS_DEFAULTS }; }
  notify();
}
export const getTts = () => prefs;
export function setTts(p: Partial<TtsPrefs>) {
  prefs = { ...prefs, ...p };
  if (p.mode && p.mode !== 'off') prefs.lastOn = p.mode;
  prefs.rate = Math.min(2, Math.max(0.5, Number(prefs.rate) || 1));
  prefs.volume = Math.min(1, Math.max(0, Number.isFinite(Number(prefs.volume)) ? Number(prefs.volume) : 1));
  try { localStorage.setItem(keyFor(who), JSON.stringify(prefs)); } catch { /* private mode */ }
  if (prefs.mode === 'off') ttsStop();
  notify();
}
export function onTts(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export const roomMuted = (roomId: string) => prefs.mutedRooms.includes(roomId);
export const setRoomMuted = (roomId: string, muted: boolean) => setTts({ mutedRooms: muted ? [...new Set([...prefs.mutedRooms, roomId])] : prefs.mutedRooms.filter((r) => r !== roomId) });

// ---------- text clean-up: links, emoji, markdown ----------
const URL_RE = /\bhttps?:\/\/([^\s/?#]+)[^\s]*/gi;
const EMOJI_RUN = /(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*)(?:\s*\1)+/gu;
export function speakable(text: string): string {
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, ' code block ');
  t = t.replace(URL_RE, (_m, host: string) => ` link to ${host.replace(/^www\./, '')} `);
  t = t.replace(/:([a-z0-9_]{2,32}):/gi, (_m, n: string) => ` ${n.replace(/_/g, ' ')} `); // custom room emotes
  t = t.replace(EMOJI_RUN, '$1'); // "😂😂😂😂" is read once
  t = t.replace(/(^|\s)@([\w-]{2,32})/g, '$1at $2');
  t = t.replace(/[*_~`>#|]+/g, ' ');
  t = t.replace(/(.)\1{4,}/g, '$1$1$1'); // "noooooooo" -> "nooo"
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > 220 ? `${t.slice(0, 200).replace(/\s+\S*$/, '')}, and more` : t;
}

// ---------- queue ----------
interface Item { id: string; text: string; sender: string }
const queue: Item[] = [];
let current: Item | null = null;
let dropped = 0;
const bySender = new Map<string, number[]>();
let global: number[] = [];
const qListeners = new Set<() => void>();
export const onQueue = (fn: () => void) => { qListeners.add(fn); return () => { qListeners.delete(fn); }; };
const qNotify = () => { for (const l of qListeners) l(); };
export const queueState = () => ({ current, waiting: queue.length, dropped });

function voiceFor(): SpeechSynthesisVoice | null {
  if (!prefs.voiceURI) return null;
  return window.speechSynthesis.getVoices().find((v) => v.voiceURI === prefs.voiceURI) ?? null;
}
function next() {
  if (current || !queue.length || !ttsSupported()) { qNotify(); return; }
  current = queue.shift()!;
  const u = new SpeechSynthesisUtterance(current.text);
  const v = voiceFor(); if (v) { u.lang = v.lang; try { u.voice = v; } catch { /* voice list changed under us: keep the language */ } }
  u.rate = prefs.rate; u.volume = prefs.volume;
  const done = () => { if (current && u === utter) { current = null; utter = null; next(); } };
  u.onend = done; u.onerror = done;
  utter = u;
  try { window.speechSynthesis.speak(u); } catch { current = null; utter = null; setTimeout(next, 0); }
  qNotify();
}
let utter: SpeechSynthesisUtterance | null = null;

/** Queue a line. Returns false when it was rate-limited or TTS is off. */
export function ttsSay(id: string, sender: string, text: string, opts: { force?: boolean } = {}): boolean {
  if (!ttsSupported() || (!opts.force && prefs.mode === 'off')) return false;
  const now = Date.now();
  const s = (bySender.get(sender) ?? []).filter((t) => now - t < 10_000);
  global = global.filter((t) => now - t < 60_000);
  if (!opts.force && (s.length >= 2 || global.length >= 12)) { dropped++; qNotify(); return false; }
  s.push(now); bySender.set(sender, s); global.push(now);
  if (queue.length >= 5) { queue.shift(); dropped++; }
  queue.push({ id, sender, text });
  next();
  return true;
}
export function ttsSkip() {
  if (!current) return;
  current = null; utter = null;
  try { window.speechSynthesis.cancel(); } catch { /* */ }
  next();
}
export function ttsStop() {
  queue.length = 0; current = null; utter = null; dropped = 0;
  try { if (ttsSupported()) window.speechSynthesis.cancel(); } catch { /* */ }
  qNotify();
}
