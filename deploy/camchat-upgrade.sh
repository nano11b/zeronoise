#!/usr/bin/env bash
# zeronoise upgrade for the Debian server (systemd camchat.service, user camchat, /opt/camchat).
# Run as root:   ssh -t manager@10.0.10.55 'sudo bash /home/manager/camchat-upgrade.sh'
# Undo:          ssh -t manager@10.0.10.55 'sudo bash /home/manager/camchat-upgrade.sh --rollback [--keep-db]'
# Expects /home/manager/camchat.tar.gz (top-level folder "camchat/"), optionally with camchat.tar.gz.sha256.
# Optional Windows build: put zeronoise-1.2.1-setup.exe and zeronoise-1.2.1-win.zip, or their .part00, part01, ...
# in /home/manager/camchat-downloads/. The script checks the sha256 shipped in the tarball, then copies
# the whole file to /var/lib/camchat/downloads. Files already there are never deleted.
# Safe to re-run. Builds in a staging dir first; on a failed health check it rolls back automatically.
# Deploy lock: only a package made by scripts/make-release.sh is installed. It carries camchat/RELEASE.json and
# camchat/MANIFEST.sha256 (every file's sha256); anything else, e.g. an old v3 build, is refused before any change.
set -Eeuo pipefail

TARBALL=${TARBALL:-/home/manager/camchat.tar.gz}
APP=/opt/camchat
STAGE=/opt/camchat.new
DATA=/var/lib/camchat
ENVF=/etc/camchat.env
UNIT=camchat.service
DROPIN_DIR=/etc/systemd/system/camchat.service.d
PUBLIC_URL_DEFAULT=https://chat.nano11bravo.com
TS=$(date +%Y%m%d-%H%M%S)
BACKUP=/opt/camchat.bak-$TS

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# BEGIN refresh_downloads
# Copy bundled files from the tarball's downloads/ and a checksum-verified Windows zip
# (whole file or .part00, .part01, ...) from $extra into $data/downloads.
# Never removes anything already in the data directory.
refresh_downloads() {
  local stage="$1" data="$2" extra="$3" owner="$4" group="$5"
  local dest f base sha expect src tmp got i
  dest="$data/downloads"
  install -d -o "$owner" -g "$group" -m 750 "$dest"
  if [ -d "$stage/downloads" ]; then
    for f in "$stage/downloads"/*; do
      [ -f "$f" ] || continue
      base=$(basename "$f")
      case "$base" in
        *.sha256|*.part[0-9][0-9]) continue ;;
      esac
      install -m 644 -o "$owner" -g "$group" "$f" "$dest/$base"
      echo "   installed $base from the tarball"
    done
  fi
  [ -d "$stage/downloads" ] || return 0
  for sha in "$stage/downloads"/*.sha256; do
    [ -f "$sha" ] || continue
    base=$(basename "$sha" .sha256)
    expect=$(tr -d '\r' < "$sha" | awk 'NR==1{print $1}' | tr 'A-F' 'a-f')
    if ! [[ "$expect" =~ ^[0-9a-f]{64}$ ]]; then
      echo "   warning: $base checksum file is not a sha256; skipped"
      continue
    fi
    src=""
    tmp=""
    if [ -n "$extra" ] && [ -f "$extra/$base" ]; then
      src="$extra/$base"
    elif [ -n "$extra" ] && [ -f "$extra/$base.part00" ]; then
      tmp=$(mktemp)
      : > "$tmp"
      i=0
      while [ -f "$extra/$base.part$(printf '%02d' "$i")" ]; do
        cat "$extra/$base.part$(printf '%02d' "$i")" >> "$tmp"
        i=$((i + 1))
      done
      src="$tmp"
    elif [ -f "$dest/$base" ]; then
      got=$(sha256sum "$dest/$base" | awk '{print $1}')
      if [ "$got" = "$expect" ]; then echo "   $base already installed"; else echo "   warning: $dest/$base does not match the checksum in the tarball"; fi
      continue
    else
      echo "   $base not in camchat-downloads; the download page hides it until you add the file"
      continue
    fi
    got=$(sha256sum "$src" | awk '{print $1}')
    if [ "$got" != "$expect" ]; then
      echo "   warning: $base checksum mismatch; left any previous copy in place"
      if [ -n "$tmp" ]; then rm -f "$tmp"; fi
      continue
    fi
    install -m 644 -o "$owner" -g "$group" "$src" "$dest/$base"
    echo "   installed $base"
    if [ -n "$tmp" ]; then rm -f "$tmp"; fi
  done
}
# END refresh_downloads

# BEGIN release_lock
# Refuse a package that is not a zeronoise release: RELEASE.json (format zeronoise-release/1) must name the sha256
# of MANIFEST.sha256, every file in the manifest must match, and no file may be outside the manifest.
check_release() {
  local dir="$1" rel man want got extra
  rel="$dir/RELEASE.json"; man="$dir/MANIFEST.sha256"
  refuse() {
    printf '\n\033[1;31mREFUSED: %s\033[0m\n' "$1" >&2
    printf 'This package is not an approved zeronoise release (made by scripts/make-release.sh).\n' >&2
    printf 'Old v3 builds and hand-made tarballs are refused. Nothing was changed; the site keeps running.\n' >&2
    rm -rf "$dir"
    exit 3
  }
  [ -f "$rel" ] || refuse "no RELEASE.json approval marker in the tarball"
  [ -f "$man" ] || refuse "no MANIFEST.sha256 in the tarball"
  grep -q '"format": *"zeronoise-release/1"' "$rel" || refuse "RELEASE.json is not format zeronoise-release/1"
  want=$(sed -n 's/.*"manifestSha256": *"\([0-9a-f]\{64\}\)".*/\1/p' "$rel" | head -1)
  [ -n "$want" ] || refuse "RELEASE.json has no manifestSha256"
  got=$(sha256sum "$man" | awk '{print $1}')
  [ "$got" = "$want" ] || refuse "MANIFEST.sha256 does not match RELEASE.json (package was altered)"
  (cd "$dir" && sha256sum --quiet --strict -c MANIFEST.sha256 >/dev/null 2>&1) || refuse "a file does not match MANIFEST.sha256 (package was altered)"
  extra=$(cd "$dir" && comm -23 <(find . -type f ! -name MANIFEST.sha256 ! -name RELEASE.json | sed 's|^\./||' | LC_ALL=C sort) \
    <(sed 's/^[0-9a-f]\{64\}  //' MANIFEST.sha256 | LC_ALL=C sort) | head -5 || true)
  [ -z "$extra" ] || refuse "files not in MANIFEST.sha256: $(echo $extra)"
  RELEASE_COMMIT=$(sed -n 's/.*"commit": *"\([0-9a-f]\{7,40\}\)".*/\1/p' "$rel" | head -1)
  echo "   approved release: commit ${RELEASE_COMMIT:-unknown}, manifest $want"
}
# END release_lock

# BEGIN release_sig
# Signed releases. The trusted public key lives in /etc/camchat-release.pub (root-owned; the private key stays on the
# release PC). With the key installed, camchat.tar.gz must come with camchat.tar.gz.sig made by ssh-keygen -Y sign
# (ed25519, namespace zeronoise-release) and the signature must verify, or nothing is changed.
# Transition: until the key file exists, an unsigned package with the current zeronoise-release/1 marker is still
# accepted (the deploy lock above checks it), with a warning. Once the key is installed, unsigned packages are refused.
RELEASE_PUBKEY_FILE=${RELEASE_PUBKEY_FILE:-/etc/camchat-release.pub}
RELEASE_SIG_NS=zeronoise-release
check_signature() {
  local tarball="$1" sig="$1.sig" key line allowed out
  RELEASE_SIGNED=0
  if [ ! -f "$RELEASE_PUBKEY_FILE" ]; then
    if [ -f "$sig" ]; then echo "   note: $sig present but no trusted key at $RELEASE_PUBKEY_FILE; signature not checked"; fi
    echo "   warning: TRANSITION MODE - no release key installed at $RELEASE_PUBKEY_FILE; accepting the unsigned"
    echo "            zeronoise-release/1 marker. Install the key to require signatures (see deploy/RELEASE-SIGNING.md)."
    return 0
  fi
  command -v ssh-keygen >/dev/null || { printf '\n\033[1;31mREFUSED: ssh-keygen not found; cannot verify the signature\033[0m\n' >&2; exit 4; }
  key=$(tr -d '\r' < "$RELEASE_PUBKEY_FILE" | awk '$1=="ssh-ed25519"{print $1" "$2; exit}')
  if [ -z "$key" ]; then printf '\n\033[1;31mREFUSED: %s is not an ssh-ed25519 public key\033[0m\n' "$RELEASE_PUBKEY_FILE" >&2; exit 4; fi
  [ -f "$sig" ] || { printf '\n\033[1;31mREFUSED: no signature %s (release signing is required). Nothing was changed.\033[0m\n' "$sig" >&2; exit 4; }
  allowed=$(mktemp)
  printf 'zeronoise-release namespaces="%s" %s\n' "$RELEASE_SIG_NS" "$key" > "$allowed"
  if out=$(ssh-keygen -Y verify -f "$allowed" -I zeronoise-release -n "$RELEASE_SIG_NS" -s "$sig" < "$tarball" 2>&1); then
    rm -f "$allowed"; RELEASE_SIGNED=1
    echo "   signature OK ($(ssh-keygen -lf "$RELEASE_PUBKEY_FILE" 2>/dev/null | awk '{print $2}'))"
  else
    rm -f "$allowed"
    printf '\n\033[1;31mREFUSED: bad signature on %s: %s. Nothing was changed.\033[0m\n' "$tarball" "$(echo $out | head -c 200)" >&2
    exit 4
  fi
}
# END release_sig


health_ok() {
  local PORT PUB i
PORT=$(systemctl show "$UNIT" -p Environment --value | tr ' ' '\n' | sed -n 's/^PORT=//p'); PORT=${PORT:-3000}
PUB=$(sed -n 's/^PUBLIC_URL=//p' "$ENVF" | tail -1); PUB=${PUB:-$PUBLIC_URL_DEFAULT}
for i in $(seq 1 30); do
  sleep 1
  if node -e '
    const [port, pub] = process.argv.slice(1);
    (async () => {
      const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      if (!h.ok || !h.db) throw new Error("health not ok");
      // Socket.IO handshake with the public Origin, like a browser behind the tunnel
      const r = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: pub } });
      if (r.status !== 200) throw new Error("socket.io handshake " + r.status);
      const me = await fetch(`http://127.0.0.1:${port}/api/me`);
      if (me.status !== 200) throw new Error("/api/me " + me.status);
      console.log("   health:", JSON.stringify(h));
    })().catch((e) => { console.error("   " + e.message); process.exit(1); });' "$PORT" "$PUB" 2>/dev/null; then return 0; fi
done

  return 1
}

# BEGIN rollback
# --rollback: put back the newest /opt/camchat.bak-* (or ROLLBACK_TO=/opt/camchat.bak-...) and the database copy the
# upgrade took at the same moment ($DATA/upgrade-backups/camchat.db.pre-<same stamp>). Nothing is deleted: the current
# app moves to /opt/camchat.rolledback-<now>, the current database to $DATA/upgrade-backups/camchat.db.rolledback-<now>.
# --keep-db leaves the current database in place (code-only rollback). If the restored version fails its health check,
# everything is moved back the way it was.
do_rollback() {
  local keepdb="$1" target stamp now dbbak cur f
  now=$(date +%Y%m%d-%H%M%S)
  if [ -n "${ROLLBACK_TO:-}" ]; then target="$ROLLBACK_TO"
  else target=$(ls -1d "$APP".bak-* 2>/dev/null | LC_ALL=C sort | tail -1 || true); fi
  [ -n "$target" ] && [ -d "$target" ] || die "no backup folder $APP.bak-* to roll back to"
  [ -f "$target/package.json" ] || die "$target does not look like a camchat install (no package.json)"
  stamp=${target##*.bak-}
  dbbak="$DATA/upgrade-backups/camchat.db.pre-$stamp"
  cur="$APP.rolledback-$now"
  [ ! -e "$cur" ] || die "$cur already exists"
  say "Rolling back to $target"
  if [ -f "$target/PACKAGE.json" ]; then echo "   restores package $(sed -n 's/.*"sha256": *"\([0-9a-f]*\)".*/\1/p' "$target/PACKAGE.json" | cut -c1-12)"; fi
  if [ "$keepdb" = 1 ]; then echo "   keeping the current database (--keep-db)"; dbbak=""
  elif [ -f "$dbbak" ]; then echo "   database: restoring $dbbak (messages since then are kept in the moved-aside copy)"
  else echo "   no database copy for $stamp (upgrade predates DB backups); keeping the current database (migrations are additive)"; dbbak=""; fi
  systemctl stop "$UNIT"
  mv "$APP" "$cur"
  mv "$target" "$APP"
  if [ -n "$dbbak" ]; then
    install -d -o camchat -g camchat -m 750 "$DATA/upgrade-backups"
    for f in camchat.db camchat.db-wal camchat.db-shm; do
      if [ -e "$DATA/$f" ]; then mv "$DATA/$f" "$DATA/upgrade-backups/${f/camchat.db/camchat.db.rolledback-$now}"; fi
    done
    cp -a "$dbbak" "$DATA/camchat.db"
    chown camchat:camchat "$DATA/camchat.db"
  fi
  systemctl start "$UNIT"
  if health_ok; then
    say "Rolled back to $target"
    echo "   previous version kept at $cur"
    if [ -n "$dbbak" ]; then echo "   previous database kept at $DATA/upgrade-backups/camchat.db.rolledback-$now"; fi
    return 0
  fi
  say "Rolled-back version failed its health check - restoring what was running"
  systemctl stop "$UNIT" || true
  mv "$APP" "$target"; mv "$cur" "$APP"
  if [ -n "$dbbak" ]; then
    mv "$DATA/camchat.db" "$DATA/upgrade-backups/camchat.db.failedrollback-$now"
    for f in camchat.db camchat.db-wal camchat.db-shm; do
      if [ -e "$DATA/upgrade-backups/${f/camchat.db/camchat.db.rolledback-$now}" ]; then mv "$DATA/upgrade-backups/${f/camchat.db/camchat.db.rolledback-$now}" "$DATA/$f"; fi
    done
  fi
  systemctl start "$UNIT"
  die "rollback failed its health check; the previous version is running again"
}
# END rollback

MODE=upgrade; KEEPDB=0
for arg in "$@"; do case "$arg" in --rollback) MODE=rollback ;; --keep-db) KEEPDB=1 ;; *) die "unknown option $arg (use --rollback [--keep-db])" ;; esac; done

[ "$(id -u)" = 0 ] || die "run as root (sudo bash $0)"
id camchat >/dev/null 2>&1 || die "user camchat does not exist"
command -v node >/dev/null || die "node not found"
if [ "$MODE" = rollback ]; then do_rollback "$KEEPDB"; exit 0; fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' || die "Node >= 22.13 required (node:sqlite); found $(node -v)"
[ -f "$TARBALL" ] || die "missing $TARBALL"
if [ -f "$TARBALL.sha256" ]; then say "Verifying tarball checksum"; (cd "$(dirname "$TARBALL")" && sha256sum -c "$(basename "$TARBALL").sha256") || die "checksum mismatch"; fi

say "Checking the release signature"
check_signature "$TARBALL"

say "1/7 Extracting to staging dir $STAGE"
rm -rf "$STAGE" /tmp/camchat-extract.$$
mkdir -p /tmp/camchat-extract.$$
tar -xzf "$TARBALL" -C /tmp/camchat-extract.$$
[ -f /tmp/camchat-extract.$$/camchat/package.json ] || die "tarball does not contain camchat/package.json"
say "Checking the release approval marker (deploy lock)"
check_release /tmp/camchat-extract.$$/camchat
mv /tmp/camchat-extract.$$/camchat "$STAGE"
rm -rf /tmp/camchat-extract.$$
chown -R camchat:camchat "$STAGE"

say "2/7 npm ci + build as camchat (in staging; the running service is untouched)"
sudo -u camchat env HOME="$STAGE" npm_config_cache="$STAGE/.npm" npm_config_update_notifier=false \
  bash -c "cd '$STAGE' && npm ci --no-audit --no-fund && npm run build"
[ -f "$STAGE/dist/server/server/index.js" ] || die "build output missing"
PKG_SHA=$(sha256sum "$TARBALL" | awk '{print $1}')
printf '{\n  "sha256": "%s",\n  "installedAt": "%s"\n}\n' "$PKG_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/PACKAGE.json"
chown camchat:camchat "$STAGE/PACKAGE.json"
echo "   package sha256 $PKG_SHA"

say "3/7 Data dir $DATA (owned by camchat)"
install -d -o camchat -g camchat -m 750 "$DATA"
say "Refreshing app downloads in $DATA/downloads"
refresh_downloads "$STAGE" "$DATA" "$(dirname "$TARBALL")/camchat-downloads" camchat camchat

say "4/7 Environment file $ENVF"
touch "$ENVF"
cp -a "$ENVF" "$ENVF.bak-$TS"
add_env() { grep -qE "^[[:space:]]*$1=" "$ENVF" || { printf '%s=%s\n' "$1" "$2" >> "$ENVF"; echo "   added $1"; }; }
[ -n "$(tail -c1 "$ENVF")" ] && echo >> "$ENVF"
add_env DATA_DIR "$DATA"
add_env SESSION_SECRET "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
add_env PUBLIC_URL "$PUBLIC_URL_DEFAULT"
chown root:camchat "$ENVF"; chmod 640 "$ENVF"
echo "   (backup: $ENVF.bak-$TS; secrets not printed)"

say "5/7 systemd drop-in: allow writes to $DATA (unit has ProtectSystem=strict)"
mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/10-camchat-data.conf" <<CONF
# added by camchat-upgrade.sh
[Service]
ReadWritePaths=$DATA
CONF
systemctl daemon-reload

say "6/7 Swapping in the new version (backup of the old one: $BACKUP)"
systemctl stop "$UNIT"
install -d -o camchat -g camchat -m 750 "$DATA/upgrade-backups"
if [ -f "$DATA/camchat.db" ]; then
  # service is stopped, so a plain copy is consistent; fold the WAL in first if sqlite3 is around
  sudo -u camchat node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA wal_checkpoint(TRUNCATE)");d.close()' "$DATA/camchat.db" 2>/dev/null || true
  cp -a "$DATA/camchat.db" "$DATA/upgrade-backups/camchat.db.pre-$TS"
  for f in camchat.db-wal camchat.db-shm; do if [ -s "$DATA/$f" ]; then cp -a "$DATA/$f" "$DATA/upgrade-backups/${f/camchat.db/camchat.db.pre-$TS}"; fi; done
  echo "   database copied to $DATA/upgrade-backups/camchat.db.pre-$TS"
fi
mv "$APP" "$BACKUP"
mv "$STAGE" "$APP"

systemctl start "$UNIT"

say "7/7 Health check"
healthy=0; health_ok && healthy=1

if [ "$healthy" != 1 ]; then
  echo; journalctl -u "$UNIT" -n 40 --no-pager || true
  say "Health check FAILED - rolling back to $BACKUP"
  systemctl stop "$UNIT" || true
  rm -rf "$APP.failed-$TS"; mv "$APP" "$APP.failed-$TS"; mv "$BACKUP" "$APP"
  systemctl start "$UNIT"
  die "rolled back. Failed build kept at $APP.failed-$TS; env backup at $ENVF.bak-$TS (new env keys are harmless to v1)."
fi

ls -l "$DATA"
cat <<MSG

zeronoise is running.
  Rollback:  sudo bash /home/manager/camchat-upgrade.sh --rollback      (code + database as of this upgrade)
             sudo bash /home/manager/camchat-upgrade.sh --rollback --keep-db   (code only)
  Make yourself admin (register on the site first):
    sudo -u camchat env DATA_DIR=$DATA node $APP/scripts/make-admin.mjs <your-username>
  or add ADMIN_USERNAMES=<your-username> to $ENVF and: sudo systemctl restart $UNIT
MSG
