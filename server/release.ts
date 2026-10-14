import fs from 'fs';
import path from 'path';

/**
 * What package is running. RELEASE.json is written into the tarball by scripts/make-release.sh (commit, branch,
 * manifest digest); PACKAGE.json is written by camchat-upgrade.sh after it checked the tarball (its sha256).
 * Both are optional: a dev checkout reports nulls. Unlike the build id, these do not change on a rebuild.
 */
export interface ReleaseInfo {
  packageSha256: string | null;
  commit: string | null;
  branch: string | null;
  manifestSha256: string | null;
  releasedAt: string | null;
  installedAt: string | null;
}

function appRoot(): string {
  for (const dir of [path.resolve(__dirname, '../../..'), path.resolve(__dirname, '..'), process.cwd()]) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return process.cwd();
}
function readJson(file: string): Record<string, unknown> {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);
const HEX64 = /^[0-9a-f]{64}$/;

export function readReleaseInfo(root = appRoot()): ReleaseInfo {
  const rel = readJson(path.join(root, 'RELEASE.json'));
  const pkg = readJson(path.join(root, 'PACKAGE.json'));
  return {
    packageSha256: str(pkg.sha256, HEX64),
    commit: str(rel.commit, /^[0-9a-f]{7,40}$/),
    branch: str(rel.branch, /^[\w./-]{1,120}$/),
    manifestSha256: str(rel.manifestSha256, HEX64),
    releasedAt: str(rel.createdAt, /^[\dT:.Z+-]{10,40}$/),
    installedAt: str(pkg.installedAt, /^[\dT:.Z+-]{10,40}$/),
  };
}
