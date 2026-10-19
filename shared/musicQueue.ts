/** batch MC2: shared music queue on top of watch together (YouTube links only). */
export const QUEUE_MAX = 25;
export const QUEUE_PER_USER = 3;
export interface QueueItem { id: string; videoId: string; url: string; by: string; addedAt: number }
export interface QueueState { items: QueueItem[]; current: QueueItem | null; canControl?: boolean }
