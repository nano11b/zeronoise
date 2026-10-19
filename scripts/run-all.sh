#!/bin/bash
# batch H9: the full suite in parallel lanes (servers pick free ports; the one fixed-port pair,
# signaling + browser-test on :3000, stays in one lane). Prints per-suite wall time.
#   scripts/run-all.sh <log dir> [shots dir for batch-c/d] [shots dir for batch-g/h] [shots dir for batch-w] [shots dir for webhooks] [shots dir for msgcolor2 + later suites]
# Env: VQ_TURN / VQ_TURN_USER / VQ_TURN_PASS, SIG_TURN (TURN url for the signaling server), OSC_PATH (openssl-with-sig dir).
set -u
cd "$(dirname "$0")/.."
L=${1:?log dir}; CD=${2:-$L/batch-cd}; GH=${3:-$L/batch-gh}; W=${4:-$L/batch-w}; WH=${5:-$L/webhooks}; MC2=${6:-$WH}
mkdir -p "$L" "$L/pwa" "$L/ui"
S=$L/summary.txt; : > "$S"
export ONBOARDING_SINCE=${ONBOARDING_SINCE:-4102444800000}
run() { local name=$1; shift; local t0=$SECONDS; timeout 1500 "$@" > "$L/$name.log" 2>&1; local rc=$?
  echo "$name exit $rc ($((SECONDS - t0))s) : $(grep -E '[0-9]+ passed|views checked' "$L/$name.log" | tail -1)" >> "$S"; }
T0=$SECONDS
run build npm run -s build
run typecheck npm run -s typecheck
laneA() { run api node scripts/test-api.mjs; SKEW_DB=1 run api-skew node scripts/test-api.mjs
  run bot-joins node scripts/test-bot-joins.mjs; run native npx tsx scripts/test-native-handoff.mjs
  PATH=${OSC_PATH:-/tmp/osc/usr/bin}:$PATH run sig-rollback bash scripts/test-upgrade-sig-rollback.sh deploy/camchat-upgrade.sh
  run markdown node scripts/test-markdown.mjs; run vq node scripts/test-vq.mjs; }
laneB() { local D; D=$(mktemp -d)
  TURN_URLS="${SIG_TURN:-turn:127.0.0.1:3479?transport=udp}" TURN_USER=u TURN_PASS=p NODE_ENV=production PORT=3000 HOST=127.0.0.1 DATA_DIR=$D BACKUP_DISABLED=1 node dist/server/server/index.js > "$L/sig-server.log" 2>&1 &
  local SP=$!; for _ in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:3000/api/status && break; sleep 0.2; done
  run signaling node scripts/test-signaling.mjs http://127.0.0.1:3000
  run browser-test node scripts/browser-test.mjs http://127.0.0.1:3000 "$L/browser-test.png" "$L/browser-admin.png"
  kill $SP 2>/dev/null
  run ui-check node scripts/ui-check.mjs --shots "$L/ui"; run pwa-check node scripts/pwa-check.mjs --shots "$L/pwa"; }
laneC() { run vq-browser node scripts/vq-browser.mjs; run voice-browser node scripts/voice-browser.mjs
  run profile-menu node scripts/profile-menu-check.mjs "$L/profile-menu"; run batch-a node scripts/batch-a-check.mjs "$L/batch-a"
  run batch-b node scripts/batch-b-check.mjs "$L/batch-b"; run batch-c node scripts/batch-c-check.mjs "$CD"; run batch-d node scripts/batch-d-check.mjs "$CD"; }
laneD() { run batch-e node scripts/batch-e-check.mjs "$L/batch-e"; run batch-f node scripts/batch-f-check.mjs "$L/batch-f"
  run batch-g node scripts/batch-g-check.mjs "$GH"; run batch-h node scripts/batch-h-check.mjs "$GH"
  A11Y_SHOTS="$GH" run a11y node scripts/a11y-check.mjs "$L/a11y"; run secretbox node scripts/secretbox-check.mjs "$L/secretbox"; run alerts node scripts/alerts-check.mjs "$L/alerts"; }
laneE() { run batch-w node scripts/batch-w-check.mjs "$W"; }  # batch W: whispers (own lane; ~2 min)
laneF() { run webhooks node scripts/webhook-check.mjs "$WH"; run people node scripts/people-check.mjs "$WH"; run msgcolor2 node scripts/msgcolor2-check.mjs "$MC2"; }  # room webhooks + batch X people list (own lane; ~2 min)
laneA & laneB & laneC & laneD & laneE & laneF & wait
echo "ALLDONE in $((SECONDS - T0))s" >> "$S"
grep -q "exit [1-9]" "$S" && exit 1 || exit 0
