#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
RESULT_DIR="$ROOT/qemu-ir-415-result"
BASE=/tmp/lm-size-base
CAND=/tmp/lm-size-candidate
BASE_SHA=fe11daa407de396fad952be7679650f63dabd4dd
CANDIDATE_SHA=df7aaced646116f34135083dbfbf62ee40265657
mkdir -p "$RESULT_DIR"
rm -rf "$BASE" "$CAND"

git worktree add --detach "$BASE" "$BASE_SHA"
git worktree add --detach "$CAND" "$CANDIDATE_SHA"

# Frozen proof contract: candidate did not alter package/toolchain or the size
# oracle. Any drift here would make an A/B comparison ambiguous, so fail closed.
cmp "$BASE/package.json" "$CAND/package.json"
cmp "$BASE/pnpm-lock.yaml" "$CAND/pnpm-lock.yaml"
cmp "$BASE/scripts/size-gate.mjs" "$CAND/scripts/size-gate.mjs"
cmp "$BASE/scripts/compression-oracle.mjs" "$CAND/scripts/compression-oracle.mjs"

for tree in "$BASE" "$CAND"; do
  pnpm --dir "$tree" install --frozen-lockfile
  pnpm --dir "$tree" build
  (cd "$tree" && node scripts/size-gate.mjs > size-gate-output.txt)
  (cd "$tree" && find dist -type f -print0 | sort -z | xargs -0 sha256sum) > "${tree}-dist-first.sha256"
done

node .github/research/qemu-ir-415/size-compare.mjs \
  "$BASE" "$CAND" "$RESULT_DIR/result.json" \
  > "$RESULT_DIR/result.stdout.json"
cp "$BASE/size-gate-output.txt" "$RESULT_DIR/base-size-gate.txt"
cp "$CAND/size-gate-output.txt" "$RESULT_DIR/candidate-size-gate.txt"
cp "${BASE}-dist-first.sha256" "$RESULT_DIR/base-dist-first.sha256"
cp "${CAND}-dist-first.sha256" "$RESULT_DIR/candidate-dist-first.sha256"

# Deterministic rerun from clean build outputs. The result JSON and every dist
# byte must reproduce exactly; otherwise the proof is UNPROVEN rather than GO.
for tree in "$BASE" "$CAND"; do
  rm -rf "$tree/dist"
  pnpm --dir "$tree" build
  (cd "$tree" && node scripts/size-gate.mjs > size-gate-output-rerun.txt)
  (cd "$tree" && find dist -type f -print0 | sort -z | xargs -0 sha256sum) > "${tree}-dist-rerun.sha256"
done
node .github/research/qemu-ir-415/size-compare.mjs \
  "$BASE" "$CAND" "$RESULT_DIR/result-rerun.json" \
  > "$RESULT_DIR/result-rerun.stdout.json"

cmp "$RESULT_DIR/result.json" "$RESULT_DIR/result-rerun.json"
cmp "$BASE/size-gate-output.txt" "$BASE/size-gate-output-rerun.txt"
cmp "$CAND/size-gate-output.txt" "$CAND/size-gate-output-rerun.txt"
cmp "${BASE}-dist-first.sha256" "${BASE}-dist-rerun.sha256"
cmp "${CAND}-dist-first.sha256" "${CAND}-dist-rerun.sha256"
cp "${BASE}-dist-rerun.sha256" "$RESULT_DIR/base-dist-rerun.sha256"
cp "${CAND}-dist-rerun.sha256" "$RESULT_DIR/candidate-dist-rerun.sha256"

{
  echo "base=$BASE_SHA"
  echo "candidate=$CANDIDATE_SHA"
  echo "carrier=$(git rev-parse HEAD)"
  echo "node=$(node --version)"
  echo "pnpm=$(pnpm --version)"
  echo "kernel=$(uname -srvmo)"
  echo "package_contract=identical"
  echo "size_oracle_contract=identical"
  echo "deterministic_rerun=exact"
} | tee "$RESULT_DIR/environment.txt"

sha256sum \
  "$RESULT_DIR/result.json" \
  "$RESULT_DIR/result-rerun.json" \
  "$RESULT_DIR/base-size-gate.txt" \
  "$RESULT_DIR/candidate-size-gate.txt" \
  "$RESULT_DIR/base-dist-first.sha256" \
  "$RESULT_DIR/candidate-dist-first.sha256" \
  "$RESULT_DIR/base-dist-rerun.sha256" \
  "$RESULT_DIR/candidate-dist-rerun.sha256" \
  "$RESULT_DIR/environment.txt" \
  | tee "$RESULT_DIR/receipt-sha256.txt"

cat "$RESULT_DIR/result.json"
node -e "const r=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')); if(r.verdict!=='ADMITTED_SIZE_PARETO') process.exit(2)" "$RESULT_DIR/result.json"
