/** Curated chat nick colors (dark UI). Only these ids/hexes are accepted. */
export const CHAT_COLORS = [
  { id: 'rose', hex: '#fb7185', label: 'Rose' },
  { id: 'orange', hex: '#fb923c', label: 'Orange' },
  { id: 'amber', hex: '#fbbf24', label: 'Amber' },
  { id: 'lime', hex: '#a3e635', label: 'Lime' },
  { id: 'emerald', hex: '#34d399', label: 'Emerald' },
  { id: 'teal', hex: '#2dd4bf', label: 'Teal' },
  { id: 'cyan', hex: '#22d3ee', label: 'Cyan' },
  { id: 'sky', hex: '#38bdf8', label: 'Sky' },
  { id: 'blue', hex: '#60a5fa', label: 'Blue' },
  { id: 'indigo', hex: '#818cf8', label: 'Indigo' },
  { id: 'violet', hex: '#a78bfa', label: 'Violet' },
  { id: 'fuchsia', hex: '#e879f9', label: 'Fuchsia' },
  { id: 'pink', hex: '#f472b6', label: 'Pink' },
  { id: 'slate', hex: '#94a3b8', label: 'Slate' },
  { id: 'white', hex: '#e2e8f0', label: 'White' },
  { id: 'peach', hex: '#fdba74', label: 'Peach' },
] as const;

export type ChatColorId = (typeof CHAT_COLORS)[number]['id'];

const byId = new Map(CHAT_COLORS.map((c) => [c.id, c]));
const byHex = new Map(CHAT_COLORS.map((c) => [c.hex.toLowerCase(), c]));

export function isChatColorId(v: unknown): v is ChatColorId {
  return typeof v === 'string' && byId.has(v as ChatColorId);
}

/** Accept palette id or exact whitelist hex; returns canonical id or null. */
export function normalizeChatColor(v: unknown): ChatColorId | null {
  if (v === null || v === '' || v === undefined) return null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (byId.has(s as ChatColorId)) return s as ChatColorId;
  const hex = s.startsWith('#') ? s : `#${s}`;
  return byHex.get(hex)?.id ?? null;
}

export function chatColorHex(id: ChatColorId | null | undefined): string | null {
  if (!id) return null;
  return byId.get(id)?.hex ?? null;
}

export function chatColorClass(id: string | null | undefined): string | undefined {
  if (!id || !byId.has(id as ChatColorId)) return undefined;
  return `nick-c-${id}`;
}

export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_SIZE = 128;

/** Preset name effects. Only these ids are stored or turned into CSS classes. */
export const CHAT_EFFECTS = ['none', 'glow', 'gradient', 'pulse'] as const;
export type ChatEffectId = (typeof CHAT_EFFECTS)[number];
const EFFECT_SET = new Set<string>(CHAT_EFFECTS);

export function isChatEffectId(v: unknown): v is ChatEffectId {
  return typeof v === 'string' && EFFECT_SET.has(v);
}

/** Whitelist only. null/blank/'none' means no effect. Anything else is rejected (returns null). */
export function normalizeChatEffect(v: unknown): ChatEffectId | null {
  if (v === null || v === undefined || v === '') return 'none';
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!EFFECT_SET.has(s)) return null;
  return s as ChatEffectId;
}

/** Value safe to send to clients. Drops "none" and anything outside the preset list. */
export function publicChatEffect(effect: string | null | undefined): 'glow' | 'gradient' | 'pulse' | null {
  if (effect === 'glow' || effect === 'gradient' || effect === 'pulse') return effect;
  return null;
}

/** Fixed class names. Unknown values, including CSS, produce no class. */
export function chatEffectClass(effect: string | null | undefined): string | undefined {
  const id = publicChatEffect(effect);
  return id ? `nick-fx-${id}` : undefined;
}
