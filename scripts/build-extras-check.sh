#!/bin/bash
# assembles scripts/extras-check.mjs from the shared harness + scripts/extras/*.mjs (one file per feature)
cd "$(dirname "$0")"
{ cat extras/_head.mjs; for f in extras/[0-9]*.mjs; do cat "$f"; done; cat extras/_tail.mjs; } > extras-check.mjs
