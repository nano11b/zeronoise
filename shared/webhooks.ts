/** Room webhooks: limits and shapes shared by server, client and docs. */
export const WEBHOOK = {
  maxPerRoom: 10,
  nameMax: 80,
  contentMax: 2000,
  embedsMax: 10,
  embedTotalMax: 6000,
  logKeep: 20,
  /** outgoing: final failures in a row before the hook turns itself off */
  maxFails: 10,
  timeoutMs: 5000,
  /** retry schedule after the first attempt (ms) */
  retryDelays: [10_000, 60_000, 300_000],
  queueMax: 100,
} as const;
export const WEBHOOK_EVENTS = ['message', 'join', 'leave', 'voice', 'poll', 'mod'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_EVENT_LABEL: Record<WebhookEvent, string> = {
  message: 'New message', join: 'Someone joins', leave: 'Someone leaves', voice: 'Mic / camera / screen starts', poll: 'Poll created or closed', mod: 'Moderation action',
};
export interface WebhookEmbed {
  title?: string; description?: string; url?: string; color?: number;
  author?: { name: string; url?: string }; footer?: { text: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string; image?: string; thumbnail?: string;
}
export interface WebhookInfo {
  id: string; kind: 'incoming' | 'outgoing'; name: string; avatarUrl: string | null;
  enabled: boolean; disabledReason: string | null; createdAt: number; createdBy: string | null; lastUsedAt: number | null;
  /** outgoing only */
  url?: string; events?: WebhookEvent[]; failCount?: number;
  /** incoming: masked URL (the full one is shown once, on create or regenerate) */
  urlHint?: string;
}
export interface WebhookLogEntry { id: string; ts: number; direction: 'in' | 'out'; event: string | null; status: number | null; ok: boolean; attempt: number; durationMs: number | null; error: string | null; summary: string | null }
