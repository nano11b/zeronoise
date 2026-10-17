#!/usr/bin/env bash
# Turn on encryption of two-factor (TOTP) secrets. Run on the server:
#   sudo bash /opt/camchat/deploy/secret-key-env.sh
# Generates CAMCHAT_SECRET_KEY on this machine (openssl, 48 random bytes) and adds it to /etc/camchat.env if it
# is not there yet. Never prints the key. Backs up the env file, restarts the service and checks health; restores
# the backup if the health check fails. Idempotent: an existing key is never replaced (that would make the
# secrets already sealed with it unreadable).
set -Eeuo pipefail
ENVF=${ENVF:-/etc/camchat.env}
UNIT=${UNIT:-camchat.service}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3000/api/health}
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "Run as root: sudo bash secret-key-env.sh" >&2; exit 1; fi
[[ -f "$ENVF" ]] || { echo "Missing $ENVF" >&2; exit 1; }
if grep -qE '^CAMCHAT_SECRET_KEY=.{32,}' "$ENVF"; then echo "CAMCHAT_SECRET_KEY is already set in $ENVF; nothing to do."; exit 0; fi
if grep -qE '^CAMCHAT_SECRET_KEY=' "$ENVF"; then echo "CAMCHAT_SECRET_KEY exists but is shorter than 32 characters. Fix it by hand (it may already protect secrets)." >&2; exit 1; fi
ts=$(date +%Y%m%d-%H%M%S)
backup="${ENVF}.bak-secretkey-${ts}"
cp -a "$ENVF" "$backup"; chmod 600 "$backup"
key=$(openssl rand -base64 48 | tr -d '\n')
umask 077
printf '\n# at-rest encryption of two-factor secrets (added %s). Keep a copy: without it they cannot be read.\nCAMCHAT_SECRET_KEY=%s\n' "$ts" "$key" >> "$ENVF"
unset key
chmod 600 "$ENVF"
systemctl restart "$UNIT"
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Key added and $UNIT restarted. Secrets are sealed at startup; check the admin panel > Security."
    echo "Backup of the previous env file: $backup"
    journalctl -u "$UNIT" -n 50 --no-pager 2>/dev/null | grep -E '\[2fa\]' || true
    exit 0
  fi
  sleep 1
done
echo "Health check failed; restoring $backup" >&2
cp -a "$backup" "$ENVF"; systemctl restart "$UNIT"; exit 1
