/** Batch G3: room templates. Each one presets the accent, filters, slow mode, roles and welcome message. */
import type { LinkMode } from './filters';
import type { RoomRolePerm } from './types';
export interface RoomTemplate {
  label: string; icon: string; blurb: string; category: 'gaming' | 'talk' | 'music' | 'hangout' | 'other';
  accent: string; welcome: string; slowModeSec: number;
  filters: { words: string[]; links: LinkMode; allow: string[] };
  roles: { name: string; color: string; perms: RoomRolePerm[] }[];
}
export const ROOM_TEMPLATES = {
  gaming: { label: 'Gaming', icon: '🎮', blurb: 'Fast chat, squad leads run voice', category: 'gaming', accent: '#a78bfa', slowModeSec: 0,
    welcome: 'Welcome, player! Keep it friendly, no spoilers without a warning, and ask a Squad Lead for the mic.',
    filters: { words: [], links: 'allowlist', allow: ['twitch.tv', 'youtube.com', 'steamcommunity.com', 'discord.gg'] },
    roles: [{ name: 'Squad Lead', color: '#c4b5fd', perms: ['floor', 'pin'] }, { name: 'Ref', color: '#fca5a5', perms: ['messages', 'mute', 'kick'] }] },
  study: { label: 'Study', icon: '📚', blurb: 'Quiet focus, slow mode on, no link spam', category: 'talk', accent: '#60a5fa', slowModeSec: 30,
    welcome: 'Study room: keep chat on topic and short. Slow mode is on so everyone can focus. Share notes, not memes.',
    filters: { words: [], links: 'allowlist', allow: ['wikipedia.org', 'khanacademy.org', 'arxiv.org', 'docs.google.com'] },
    roles: [{ name: 'Tutor', color: '#93c5fd', perms: ['pin', 'floor'] }, { name: 'Proctor', color: '#fde68a', perms: ['messages', 'mute'] }] },
  music: { label: 'Music', icon: '🎵', blurb: 'Share tracks, DJs hold the floor', category: 'music', accent: '#f472b6', slowModeSec: 0,
    welcome: 'Drop your tracks and vibes. DJs run the voice queue. Be kind about taste!',
    filters: { words: [], links: 'allowlist', allow: ['youtube.com', 'youtu.be', 'soundcloud.com', 'bandcamp.com', 'spotify.com'] },
    roles: [{ name: 'DJ', color: '#f9a8d4', perms: ['floor', 'pin'] }] },
  chill: { label: 'Chill', icon: '🌙', blurb: 'Relaxed hangout, light moderation', category: 'hangout', accent: '#34d399', slowModeSec: 0,
    welcome: 'Kick back and say hi. Keep it chill and be nice to each other.',
    filters: { words: [], links: 'off', allow: [] },
    roles: [{ name: 'Regular', color: '#6ee7b7', perms: [] }, { name: 'Host', color: '#a7f3d0', perms: ['pin', 'messages'] }] },
  support: { label: 'Support', icon: '🤝', blurb: 'Safe space, links blocked, gentle pace', category: 'talk', accent: '#fbbf24', slowModeSec: 10,
    welcome: 'This is a supportive space. Listen first, no judgement, no DMs without asking. If you are in crisis, contact local emergency services.',
    filters: { words: [], links: 'block', allow: [] },
    roles: [{ name: 'Listener', color: '#fcd34d', perms: ['floor'] }, { name: 'Guardian', color: '#fdba74', perms: ['messages', 'mute', 'kick', 'pin'] }] },
} satisfies Record<string, RoomTemplate>;
export type RoomTemplateKey = keyof typeof ROOM_TEMPLATES;
export const TEMPLATE_KEYS = Object.keys(ROOM_TEMPLATES) as RoomTemplateKey[];
export const isTemplateKey = (x: unknown): x is RoomTemplateKey => typeof x === 'string' && (TEMPLATE_KEYS as string[]).includes(x);
