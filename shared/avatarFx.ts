/** batch MC2: profile effects - subtle avatar frames and glows. Only these ids are stored or turned into classes. */
export const AVATAR_FX = [
  { id: 'ring', label: 'Ring' },
  { id: 'double', label: 'Double ring' },
  { id: 'glow', label: 'Soft glow' },
  { id: 'sunrise', label: 'Sunrise' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'breathe', label: 'Breathing glow' },
] as const;
export type AvatarFxId = (typeof AVATAR_FX)[number]['id'];
const SET = new Set<string>(AVATAR_FX.map((f) => f.id));
export const publicAvatarFx = (v: unknown): AvatarFxId | null => (typeof v === 'string' && SET.has(v) ? (v as AvatarFxId) : null);
export const AVATAR_FX_KEY = 'zn.hideAvatarFx';
