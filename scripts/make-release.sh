#!/usr/bin/env bash
# Build an approved zeronoise release tarball (the only kind deploy/camchat-upgrade.sh installs).
#   scripts/make-release.sh <out.tar.gz> <apk-path>
# Packs the git-tracked files of a clean checkout (no build/ output, no secrets: .gitignore applies) plus the
# Android APK, then writes camchat/MANIFEST.sha256 (sha256 of every file) and camchat/RELEASE.json (format,
# commit, branch, manifest digest). Prints the tarball sha256. Never includes keystores or their passwords.
set -Eeuo pipefail
OUT=${1:?usage: make-release.sh <out.tar.gz> <apk-path>}
APK=${2:?usage: make-release.sh <out.tar.gz> <apk-path>}
OUT=$(realpath -m "$OUT"); APK=$(realpath "$APK")
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "working tree is not clean; commit first" >&2; exit 1; }
COMMIT=$(git rev-parse HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/camchat"
git ls-files -z | grep -zv -E '(^|/)build/' | tar --null -T - -cf - | tar -xf - -C "$WORK/camchat"
install -m 644 "$APK" "$WORK/camchat/downloads/$(basename "$APK")"
if find "$WORK/camchat" \( -name '*.jks' -o -name '*.keystore' -o -name '*.p12' -o -name 'keystore*.txt' -o -name '*passwords*' \) | grep -q .; then
  echo "refusing: keystore-like file in the package" >&2; exit 1
fi
cd "$WORK/camchat"
find . -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do sha256sum "$f"; done > MANIFEST.sha256
MAN=$(sha256sum MANIFEST.sha256 | awk '{print $1}')
printf '{\n  "format": "zeronoise-release/1",\n  "commit": "%s",\n  "branch": "%s",\n  "manifestSha256": "%s",\n  "createdAt": "%s"\n}\n' \
  "$COMMIT" "$BRANCH" "$MAN" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > RELEASE.json
cd "$WORK"
tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$OUT.tmp" camchat
mv "$OUT.tmp" "$OUT"
sha256sum "$OUT"
