/** Per-room word and link filters (enforced by the moderator bot, Meowington). Shared by server and the settings UI. */
export type LinkMode = 'off' | 'block' | 'allowlist';
export const LINK_MODES: readonly LinkMode[] = ['off', 'block', 'allowlist'];
export const FILTER_WORDS_MAX = 100;
export const FILTER_WORD_LEN = 40;
export const FILTER_DOMAINS_MAX = 50;
export interface RoomFilters { words: string[]; links: LinkMode; allow: string[] }
export const isLinkMode = (v: unknown): v is LinkMode => typeof v === 'string' && (LINK_MODES as readonly string[]).includes(v);

/** Normalise a word list (comma / newline separated or an array). */
export function cleanWords(raw: unknown): { words: string[] } | { error: string } {
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\n]/) : []).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  const out = [...new Set(list)];
  if (out.length > FILTER_WORDS_MAX) return { error: `At most ${FILTER_WORDS_MAX} filtered words` };
  if (out.some((w) => w.length > FILTER_WORD_LEN)) return { error: `Each word or phrase is at most ${FILTER_WORD_LEN} characters` };
  return { words: out };
}
export function cleanDomains(raw: unknown): { domains: string[] } | { error: string } {
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : []).map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean);
  const out = [...new Set(list)];
  if (out.length > FILTER_DOMAINS_MAX) return { error: `At most ${FILTER_DOMAINS_MAX} allowed domains` };
  if (out.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) return { error: 'Domains look like example.com' };
  return { domains: out };
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The first filtered word / phrase in `text` (whole-word, case-insensitive), or null. */
export function matchWord(text: string, words: readonly string[]): string | null {
  const t = text.toLowerCase();
  for (const w of words) {
    if (!w) continue;
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(w)}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(t)) return w;
  }
  return null;
}
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"'`]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|gg|tv|me|co|xyz|ru|info|biz|app|dev|link|ly|to)(?:\/[^\s<>"'`]*)?)/gi;
/** Hosts of links in `text` (bare domains count too). */
export function linkHosts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[1].replace(/[),.!?;:\]]+$/, '');
    try { out.push(new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* skip */ }
  }
  return out;
}
/** A blocked link host in `text` under these rules, or null. `ownHosts` (this site) are always allowed. */
export function blockedLink(text: string, f: Pick<RoomFilters, 'links' | 'allow'>, ownHosts: readonly string[] = []): string | null {
  if (f.links === 'off') return null;
  for (const h of linkHosts(text)) {
    if (ownHosts.includes(h)) continue;
    if (f.links === 'block') return h;
    if (!f.allow.some((d) => h === d || h.endsWith(`.${d}`))) return h;
  }
  return null;
}
