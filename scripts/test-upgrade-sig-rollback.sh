set -Eeuo pipefail
S=$(realpath "$1"); W=$(mktemp -d); cd "$W"
ext(){ sed -n "/^# BEGIN $1/,/^# END $1/p" "$S"; }
say(){ echo "== $*"; }; die(){ echo "DIE: $*"; exit 1; }
pass=0; fail=0; ok(){ if eval "$2"; then pass=$((pass+1)); else echo "FAIL: $1"; fail=$((fail+1)); fi; }
# ---- signature
eval "$(ext release_sig)"
echo hello > pkg.tgz
ssh-keygen -q -t ed25519 -N '' -C t -f key >/dev/null
ssh-keygen -q -t ed25519 -N '' -C t -f other >/dev/null
RELEASE_PUBKEY_FILE=$W/nokey.pub
ok "transition accepts unsigned" "(check_signature pkg.tgz) | grep -q TRANSITION"
RELEASE_PUBKEY_FILE=$W/key.pub
ok "unsigned refused with key" "! (check_signature pkg.tgz) 2>/dev/null"
ssh-keygen -q -Y sign -f key -n zeronoise-release pkg.tgz
ok "good sig accepted" "(check_signature pkg.tgz) | grep -q 'signature OK'"
cp pkg.tgz.sig good.sig; echo tamper >> pkg.tgz
ok "tampered refused" "! (check_signature pkg.tgz) 2>/dev/null"
echo hello > pkg.tgz; rm pkg.tgz.sig; ssh-keygen -q -Y sign -f other -n zeronoise-release pkg.tgz
ok "wrong key refused" "! (check_signature pkg.tgz) 2>/dev/null"
rm pkg.tgz.sig; ssh-keygen -q -Y sign -f key -n file pkg.tgz
ok "wrong namespace refused" "! (check_signature pkg.tgz) 2>/dev/null"
echo junk > bad.pub; RELEASE_PUBKEY_FILE=$W/bad.pub
ok "bad key file refused" "! (check_signature pkg.tgz) 2>/dev/null"
# ---- rollback (systemctl/chown/install mocked)
APP=$W/opt/camchat; DATA=$W/data; UNIT=x
systemctl(){ echo "systemctl $*" >> log; }; chown(){ :; }
install(){ while [ "$1" != "${1#-}" ]; do case $1 in -o|-g|-m) shift 2;; *) shift;; esac; done; mkdir -p "$@"; }
HEALTH=0; health_ok(){ return $HEALTH; }
eval "$(ext rollback)"
setup(){ rm -rf opt data log; mkdir -p opt data/upgrade-backups
  for v in 20261010-234939 20261014-230333; do mkdir -p $APP.bak-$v; echo "{}" > $APP.bak-$v/package.json; echo $v > $APP.bak-$v/ver; done
  mkdir -p $APP; echo '{}' > $APP/package.json; echo new > $APP/ver
  echo newdb > data/camchat.db; echo wal > data/camchat.db-wal; echo olddb > data/upgrade-backups/camchat.db.pre-20261014-230333; echo oldwal > data/upgrade-backups/camchat.db.pre-20261014-230333-wal; }
setup; (do_rollback 0) > out 2>&1
ok "rollback picks newest bak" "[ \"\$(cat $APP/ver)\" = 20261014-230333 ]"
ok "db restored" "[ \"\$(cat data/camchat.db)\" = olddb ]"
ok "current app kept" "[ \"\$(cat opt/camchat.rolledback-*/ver)\" = new ]"
ok "current db kept" "[ \"\$(cat data/upgrade-backups/camchat.db.rolledback-*[0-9])\" = newdb ] && [ -f data/upgrade-backups/camchat.db.rolledback-*-wal ]"
ok "db wal restored too" "[ \"\$(cat data/camchat.db-wal)\" = oldwal ]"
ok "db backup copied not moved" "[ -f data/upgrade-backups/camchat.db.pre-20261014-230333 ]"
ok "service stop/start" "grep -q 'stop x' log && grep -q 'start x' log"
ok "older bak untouched" "[ -d $APP.bak-20261010-234939 ]"
setup; (do_rollback 1) > out 2>&1
ok "keep-db code only" "[ \"\$(cat data/camchat.db)\" = newdb ] && [ \"\$(cat $APP/ver)\" = 20261014-230333 ]"
setup; ROLLBACK_TO=$APP.bak-20261010-234939 ; (do_rollback 0) > out 2>&1; unset ROLLBACK_TO
ok "explicit target w/o db backup keeps db" "[ \"\$(cat $APP/ver)\" = 20261010-234939 ] && [ \"\$(cat data/camchat.db)\" = newdb ] && grep -q 'no database copy' out"
setup; HEALTH=1; (do_rollback 0) > out 2>&1 || true; HEALTH=0
ok "failed health restores everything" "[ \"\$(cat $APP/ver)\" = new ] && [ \"\$(cat data/camchat.db)\" = newdb ] && [ "$(cat data/camchat.db-wal)" = wal ] && [ -d $APP.bak-20261014-230333 ] && [ -f data/upgrade-backups/camchat.db.pre-20261014-230333 ]"
rm -rf opt/camchat.bak-*; ok "no backup dies" "! (do_rollback 0) >/dev/null 2>&1"
echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
