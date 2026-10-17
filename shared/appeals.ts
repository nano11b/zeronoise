/** Ban appeals (batch D): one per ban, a short message, reviewed in the staff mod queue. */
export const APPEAL_MIN = 20;
export const APPEAL_MAX = 1000;
export interface AppealInfo {
  id: number; banId: number; username: string | null; text: string; createdAt: number;
  status: 'open' | 'approved' | 'denied'; decidedBy: string | null; decidedAt: number | null; note: string | null;
  reason?: string | null; expiresAt?: number | null;
}
