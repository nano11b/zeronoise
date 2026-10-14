/** Moderation queue: report reasons, limits and the shapes the queue UI works with. */

export const REPORT_CATEGORIES = ['spam', 'harassment', 'sexual', 'hate', 'self-harm', 'impersonation', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  spam: 'Spam',
  harassment: 'Harassment or bullying',
  sexual: 'Nudity or sexual content',
  hate: 'Hate speech',
  'self-harm': 'Self-harm or suicide',
  impersonation: 'Impersonation',
  other: 'Something else',
};
export const isReportCategory = (v: unknown): v is ReportCategory => typeof v === 'string' && (REPORT_CATEGORIES as readonly string[]).includes(v);

export const MODQ = {
  noteMax: 500,
  /** new reports per reporter (account, or guest ip+nick) */
  perUserPerHour: 10,
  /** a second report from the same reporter on the same target within this window updates the first */
  dedupeMs: 24 * 60 * 60_000,
  /** distinct registered reporters on one message within autoHideWindowMs hide it pending review */
  autoHideReporters: 3,
  autoHideWindowMs: 10 * 60_000,
  /** messages before + after the reported one kept as context */
  contextSize: 10,
  resolutionNoteMax: 500,
} as const;

/** open = unclaimed, review = claimed ("I'm on it"), then resolved / dismissed */
export type QueueBucket = 'open' | 'review' | 'resolved' | 'dismissed';
export const QUEUE_BUCKETS: QueueBucket[] = ['open', 'review', 'resolved', 'dismissed'];
export type QueueSort = 'count' | 'oldest' | 'newest';
export type ReportTargetKind = 'message' | 'user' | 'room' | 'whisper';
export type QueueAction = 'delete' | 'mute' | 'kick' | 'ban' | 'warn' | 'dismiss' | 'resolve';

export interface ReportAttachment { kind: 'image' | 'voice'; ref: string; mime?: string; ms?: number; /** copy kept for staff (file name under report evidence) */ evidence?: string | null }
/** Frozen copy of what was reported, taken when the first report arrived. */
export interface ReportSnapshot {
  text: string | null;
  attachments: ReportAttachment[];
  senderAccountId: number | null;
  senderNick: string | null;
  roomId: string | null;
  roomName: string | null;
  ts: number | null;
  editedAt?: number | null;
  /** 'burn' / 'whisper': private content kept because the reporter could see it */
  private?: 'burn' | 'whisper' | null;
  /** room reports: topic at report time */
  topic?: string | null;
}
export interface ReportContextLine { ts: number; from: string; text: string; target?: boolean; deleted?: boolean }

export interface QueueReport {
  id: number; createdAt: number; updatedAt: number | null; category: ReportCategory; note: string | null;
  /** staff only; omitted for room owners / room mods */
  reporterNick?: string; reporterUserId?: number | null;
}
export interface QueueItem {
  key: string;
  /** newest report id: the handle for claim / actions */
  id: number;
  kind: ReportTargetKind;
  bucket: QueueBucket;
  count: number;
  reporters: number;
  firstAt: number;
  lastAt: number;
  categories: Partial<Record<ReportCategory, number>>;
  targetNick: string | null;
  targetUserId: number | null;
  targetRole: string | null;
  roomId: string | null;
  roomName: string | null;
  messageId: string | null;
  /** message no longer exists (deleted or purged) */
  messageGone: boolean;
  /** auto-hidden pending review */
  hidden: boolean;
  snapshot: ReportSnapshot | null;
  context: ReportContextLine[];
  reports: QueueReport[];
  claimedBy: string | null;
  claimedAt: number | null;
  handledBy: string | null;
  handledAt: number | null;
  resolution: string | null;
  note: string | null;
  targetOnline: boolean;
}
export type QueueCounts = Record<QueueBucket, number>;

export const REPORTER_THANKS = {
  action: 'Thanks, we took action on your report.',
  reviewed: 'Thanks, your report was reviewed.',
} as const;
