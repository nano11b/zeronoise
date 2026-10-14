#!/usr/bin/env bash
# zeronoise upgrade for the Debian server (systemd camchat.service, user camchat, /opt/camchat).
# Run as root:   ssh -t manager@10.0.10.55 'sudo bash /home/manager/camchat-upgrade.sh'
# Expects /home/manager/camchat.tar.gz (top-level folder "camchat/"), optionally with camchat.tar.gz.sha256.
# Optional Windows build: put zeronoise-1.2.1-setup.exe and zeronoise-1.2.1-win.zip, or their .part00, part01, ...
# in /home/manager/camchat-downloads/. The script checks the sha256 shipped in the tarball, then copies
# the whole file to /var/lib/camchat/downloads. Files already there are never deleted.
# Safe to re-run. Builds in a staging dir first; on a failed health check it rolls back automatically.
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

[ "$(id -u)" = 0 ] || die "run as root (sudo bash $0)"
[ -f "$TARBALL" ] || die "missing $TARBALL"
id camchat >/dev/null 2>&1 || die "user camchat does not exist"
command -v node >/dev/null || die "node not found"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' || die "Node >= 22.13 required (node:sqlite); found $(node -v)"
if [ -f "$TARBALL.sha256" ]; then say "Verifying tarball checksum"; (cd "$(dirname "$TARBALL")" && sha256sum -c "$(basename "$TARBALL").sha256") || die "checksum mismatch"; fi

say "1/7 Extracting to staging dir $STAGE"
rm -rf "$STAGE" /tmp/camchat-extract.$$
mkdir -p /tmp/camchat-extract.$$
tar -xzf "$TARBALL" -C /tmp/camchat-extract.$$
[ -f /tmp/camchat-extract.$$/camchat/package.json ] || die "tarball does not contain camchat/package.json"
mv /tmp/camchat-extract.$$/camchat "$STAGE"
rm -rf /tmp/camchat-extract.$$
chown -R camchat:camchat "$STAGE"

say "2/7 npm ci + build as camchat (in staging; the running service is untouched)"
sudo -u camchat env HOME="$STAGE" npm_config_cache="$STAGE/.npm" npm_config_update_notifier=false \
  bash -c "cd '$STAGE' && npm ci --no-audit --no-fund && npm run build"
[ -f "$STAGE/dist/server/server/index.js" ] || die "build output missing"

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
mv "$APP" "$BACKUP"
mv "$STAGE" "$APP"

systemctl start "$UNIT"

say "7/7 Health check"
PORT=$(systemctl show "$UNIT" -p Environment --value | tr ' ' '\n' | sed -n 's/^PORT=//p'); PORT=${PORT:-3000}
PUB=$(sed -n 's/^PUBLIC_URL=//p' "$ENVF" | tail -1); PUB=${PUB:-$PUBLIC_URL_DEFAULT}
healthy=0
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
    })().catch((e) => { console.error("   " + e.message); process.exit(1); });' "$PORT" "$PUB" 2>/dev/null; then healthy=1; break; fi
done

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
  Rollback:  sudo systemctl stop $UNIT && sudo mv $APP $APP.v2 && sudo mv $BACKUP $APP && sudo systemctl start $UNIT
  Make yourself admin (register on the site first):
    sudo -u camchat env DATA_DIR=$DATA node $APP/scripts/make-admin.mjs <your-username>
  or add ADMIN_USERNAMES=<your-username> to $ENVF and: sudo systemctl restart $UNIT
  Old backups can be removed later: sudo rm -rf /opt/camchat.bak-*
MSG
