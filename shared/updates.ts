/** Dotted numeric versions. Non-numeric pieces are skipped. Missing pieces count as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => String(v || '').split(/[^0-9]+/).filter(Boolean).map((n) => Number(n));
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** current: already on this release. install: download and hand it to the OS. manual: this copy cannot apply it. */
export type UpdateDecision = 'current' | 'install' | 'manual';

export function decideUpdate(input: {
  current: string;
  latest: string;
  minVersion?: string | null;
  /** False for a portable zip, or any build that cannot replace itself. */
  canApply: boolean;
}): UpdateDecision {
  if (!input.latest || compareVersions(input.current, input.latest) >= 0) return 'current';
  if (!input.canApply) return 'manual';
  if (input.minVersion && compareVersions(input.current, input.minVersion) < 0) return 'manual';
  return 'install';
}
