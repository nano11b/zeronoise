#!/usr/bin/env bash
# Set TikTok Login Kit on the Debian host. Run on the server:
#   sudo bash tiktok-env.sh
# Idempotent. Never prints the client secret. Restores /etc/camchat.env if the health check fails.
set -Eeuo pipefail

ENVF=${ENVF:-/etc/camchat.env}
UNIT=${UNIT:-camchat.service}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3000/api/health}

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root: sudo bash tiktok-env.sh" >&2
  exit 1
fi
[[ -f "$ENVF" ]] || { echo "Missing $ENVF" >&2; exit 1; }

ts=$(date +%Y%m%d-%H%M%S)
backup="${ENVF}.bak-tiktok-${ts}"
cp -a "$ENVF" "$backup"
chmod 600 "$backup"

current_key=$(grep -E '^TIKTOK_CLIENT_KEY=' "$ENVF" | tail -1 | cut -d= -f2- || true)
current_secret=$(grep -E '^TIKTOK_CLIENT_SECRET=' "$ENVF" | tail -1 | cut -d= -f2- || true)

if [[ -n "$current_key" ]]; then
  read -r -p "TIKTOK_CLIENT_KEY (Enter keeps the current key): " KEY
  if [[ -z "$KEY" ]]; then KEY=$current_key; fi
else
  while true; do
    read -r -p "TIKTOK_CLIENT_KEY: " KEY
    [[ -n "$KEY" ]] && break
    echo "A client key is required." >&2
  done
fi

if [[ -n "$current_secret" ]]; then
  read -r -s -p "TIKTOK_CLIENT_SECRET (hidden, Enter keeps the current secret): " SECRET
  printf '\n' >&2
  if [[ -z "$SECRET" ]]; then SECRET=$current_secret; fi
else
  while true; do
    read -r -s -p "TIKTOK_CLIENT_SECRET (hidden): " SECRET
    printf '\n' >&2
    [[ -n "$SECRET" ]] && break
    echo "A client secret is required." >&2
  done
fi

set_kv() {
  local file=$1 key=$2 val=$3 tmp
  tmp=$(mktemp)
  if grep -qE "^${key}=" "$file"; then
    awk -v k="$key" -v v="$val" 'BEGIN { FS = "=" } $1 == k { print k "=" v; next } { print }' "$file" > "$tmp"
  else
    cp "$file" "$tmp"
    printf '\n%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

set_kv "$ENVF" TIKTOK_CLIENT_KEY "$KEY"
set_kv "$ENVF" TIKTOK_CLIENT_SECRET "$SECRET"
chmod 600 "$ENVF"
unset SECRET current_secret KEY current_key

restore() {
  echo "Health check failed. Restoring $backup" >&2
  cp -a "$backup" "$ENVF"
  chmod 600 "$ENVF"
  systemctl restart "$UNIT" || true
  exit 1
}

systemctl restart "$UNIT" || restore
ok=0
body=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  body=$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)
  if printf '%s' "$body" | grep -q '"ok":true' && printf '%s' "$body" | grep -q '"tiktok":true'; then
    ok=1
    break
  fi
  sleep 1
done
[[ $ok -eq 1 ]] || restore

tiktok_flag=$(printf '%s' "$body" | sed -n 's/.*"tiktok":\([^,}]*\).*/\1/p')
echo "tiktok=${tiktok_flag}"
echo "Backup kept at $backup"
