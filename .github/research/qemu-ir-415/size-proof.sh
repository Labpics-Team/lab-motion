#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
RESULT_DIR="$ROOT/qemu-ir-415-result"
BASE=/tmp/lm-size-base
CAND=/tmp/lm-size-candidate
mkdir -p "$RESULT_DIR"
rm -rf "$BASE" "$CAND"

git worktree add --detach "$BASE" fe11daa407de396fad952be7679650f63dabd4dd
git worktree add --detach "$CAND" df7aaced646116f34135083dbfbf62ee40265657

for tree in "$BASE" "$CAND"; do
  pnpm --dir "$tree" install --frozen-lockfile
  pnpm --dir "$tree" build
  (cd "$tree" && node scripts/size-gate.mjs | tee size-gate-output.txt)
done

node .github/research/qemu-ir-415/size-compare.mjs "$BASE" "$CAND" "$RESULT_DIR/result.json" | tee "$RESULT_DIR/result.stdout.json"
cp "$BASE/size-gate-output.txt" "$RESULT_DIR/base-size-gate.txt"
cp "$CAND/size-gate-output.txt" "$RESULT_DIR/candidate-size-gate.txt"

{
  echo "base=fe11daa407de396fad952be7679650f63dabd4dd"
  echo "candidate=df7aaced646116f34135083dbfbf62ee40265657"
  echo "carrier=$(git rev-parse HEAD)"
  echo "node=$(node --version)"
  echo "pnpm=$(pnpm --version)"
  echo "kernel=$(uname -srvmo)"
} | tee "$RESULT_DIR/environment.txt"

sha256sum \
  "$RESULT_DIR/result.json" \
  "$RESULT_DIR/base-size-gate.txt" \
  "$RESULT_DIR/candidate-size-gate.txt" \
  "$RESULT_DIR/environment.txt" \
  | tee "$RESULT_DIR/receipt-sha256.txt"

cat "$RESULT_DIR/result.json"
