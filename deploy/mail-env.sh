#!/usr/bin/env bash
# Set Resend mail on the Debian host. Run on the server:
#   sudo bash mail-env.sh
# Idempotent. Never prints the API key. Restores /etc/camchat.env if health check fails.
set -Eeuo pipefail

ENVF=${ENVF:-/etc/camchat.env}
UNIT=${UNIT:-camchat.service}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3000/api/health}
DEFAULT_FROM='zeronoise <no-reply@mail.nano11bravo.com>'

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root: sudo bash mail-env.sh" >&2
  exit 1
fi
[[ -f "$ENVF" ]] || { echo "Missing $ENVF" >&2; exit 1; }

ts=$(date +%Y%m%d-%H%M%S)
backup="${ENVF}.bak-mail-${ts}"
cp -a "$ENVF" "$backup"
chmod 600 "$backup"

current_key=$(grep -E '^RESEND_API_KEY=' "$ENVF" | tail -1 | cut -d= -f2- || true)
current_from=$(grep -E '^MAIL_FROM=' "$ENVF" | tail -1 | cut -d= -f2- || true)
current_flag=$(grep -E '^EMAIL_VERIFY_REQUIRED=' "$ENVF" | tail -1 | cut -d= -f2- || true)

if [[ -n "$current_key" ]]; then
  read -r -s -p "RESEND_API_KEY (hidden, Enter keeps the current key): " KEY
  printf '\n' >&2
  if [[ -z "$KEY" ]]; then KEY=$current_key; fi
else
  while true; do
    read -r -s -p "RESEND_API_KEY (hidden): " KEY
    printf '\n' >&2
    [[ -n "$KEY" ]] && break
    echo "A key is required." >&2
  done
fi

read -r -p "MAIL_FROM [${current_from:-$DEFAULT_FROM}]: " FROM
FROM=${FROM:-${current_from:-$DEFAULT_FROM}}

default_yn=N
[[ "$current_flag" == "1" || "$current_flag" == "true" ]] && default_yn=Y
read -r -p "Require a confirmed email before rooms? [${default_yn}]: " YN
YN=${YN:-$default_yn}
case "$YN" in
  y|Y|yes|YES|1) FLAG=1 ;;
  *) FLAG=0 ;;
esac

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

set_kv "$ENVF" RESEND_API_KEY "$KEY"
set_kv "$ENVF" MAIL_FROM "$FROM"
set_kv "$ENVF" EMAIL_VERIFY_REQUIRED "$FLAG"
chmod 600 "$ENVF"
unset KEY current_key

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
  if printf '%s' "$body" | grep -q '"ok":true' && printf '%s' "$body" | grep -q '"mail":true'; then
    ok=1
    break
  fi
  sleep 1
done
[[ $ok -eq 1 ]] || restore

mail_flag=$(printf '%s' "$body" | sed -n 's/.*"mail":\([^,}]*\).*/\1/p')
verify_flag=$(printf '%s' "$body" | sed -n 's/.*"emailVerifyRequired":\([^,}]*\).*/\1/p')
echo "mail=${mail_flag} emailVerifyRequired=${verify_flag}"
echo "Backup kept at $backup"
