/** Same rules as shared/updates.ts. Kept here because the Electron shell is plain JavaScript. */

function compareVersions(a, b) {
  const parts = (v) => String(v || '').split(/[^0-9]+/).filter(Boolean).map((n) => Number(n));
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * current: nothing to do.
 * install: download the installer, check sha256, then run it.
 * manual: this copy cannot replace itself (portable zip, or older than minVersion).
 */
function decideUpdate({ current, latest, minVersion, canApply }) {
  if (!latest || compareVersions(current, latest) >= 0) return 'current';
  if (!canApply) return 'manual';
  if (minVersion && compareVersions(current, minVersion) < 0) return 'manual';
  return 'install';
}

module.exports = { compareVersions, decideUpdate };
