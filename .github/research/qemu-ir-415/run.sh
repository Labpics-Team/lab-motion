#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
RESULT_DIR="$ROOT/qemu-ir-415-result"
export RESULT_DIR
mkdir -p "$RESULT_DIR"

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  qemu-user gcc pkg-config libglib2.0-dev libpixman-1-dev zlib1g-dev \
  ninja-build python3-venv curl xz-utils

QEMU_BIN="$(command -v qemu-x86_64)"
"$QEMU_BIN" --version | tee "$RESULT_DIR/qemu-package-version.txt"

if ! "$QEMU_BIN" -help 2>&1 | grep -q -- '-plugin'; then
  echo 'Ubuntu qemu-user lacks plugin support; building exact upstream QEMU 8.2.2 linux-user with plugins.'
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
    https://download.qemu.org/qemu-8.2.2.tar.xz \
    -o /tmp/qemu-8.2.2.tar.xz
  sha256sum /tmp/qemu-8.2.2.tar.xz | tee "$RESULT_DIR/qemu-source-sha256.txt"
  rm -rf /tmp/qemu-8.2.2
  tar -C /tmp -xf /tmp/qemu-8.2.2.tar.xz
  pushd /tmp/qemu-8.2.2 >/dev/null
  ./configure \
    --target-list=x86_64-linux-user \
    --enable-plugins \
    --disable-docs \
    --disable-tools \
    --disable-system \
    --disable-werror
  ninja -C build qemu-x86_64
  QEMU_BIN=/tmp/qemu-8.2.2/build/qemu-x86_64
  popd >/dev/null
fi

"$QEMU_BIN" --version | tee "$RESULT_DIR/qemu-version.txt"
"$QEMU_BIN" -help 2>&1 | grep -q -- '-plugin'

QEMU_SOURCE=/tmp/qemu-8.2.2
if [ ! -f "$QEMU_SOURCE/include/qemu/qemu-plugin.h" ]; then
  mkdir -p /tmp/qemu-include
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
    https://raw.githubusercontent.com/qemu/qemu/v8.2.2/include/qemu/qemu-plugin.h \
    -o /tmp/qemu-include/qemu-plugin.h
  QEMU_INCLUDE=/tmp/qemu-include
else
  QEMU_INCLUDE="$QEMU_SOURCE/include/qemu"
fi

gcc -O2 -shared -fPIC -fvisibility=hidden \
  $(pkg-config --cflags glib-2.0) -I"$QEMU_INCLUDE" \
  .github/research/qemu-ir-415/plugin.c -o /tmp/lm-qemu-plugin.so
NODE_ROOT="$(dirname "$(dirname "$(command -v node)")")"
test -f "$NODE_ROOT/include/node/node_api.h"
gcc -O2 -shared -fPIC -I"$NODE_ROOT/include/node" \
  .github/research/qemu-ir-415/marker.c -o /tmp/lm-marker.node

pnpm install --frozen-lockfile
git worktree add --detach /tmp/lm-base fe11daa407de396fad952be7679650f63dabd4dd
git worktree add --detach /tmp/lm-candidate df7aaced646116f34135083dbfbf62ee40265657
pnpm exec esbuild /tmp/lm-base/src/animate/channels.ts \
  --bundle --platform=node --format=esm --target=node24 --outfile=/tmp/lm-base.mjs
pnpm exec esbuild /tmp/lm-candidate/src/animate/channels.ts \
  --bundle --platform=node --format=esm --target=node24 --outfile=/tmp/lm-candidate.mjs
sha256sum /tmp/lm-base.mjs /tmp/lm-candidate.mjs /tmp/lm-qemu-plugin.so /tmp/lm-marker.node \
  .github/research/qemu-ir-415/harness.mjs \
  .github/research/qemu-ir-415/evaluate.py | tee "$RESULT_DIR/hashes.txt"

printf 'side\tcase\tmode\trep\tcount\tchecksum\tstatusBefore\tstatusAfter\n' > "$RESULT_DIR/counts.tsv"
: > "$RESULT_DIR/raw.log"
export LM_QEMU_MARKER=/tmp/lm-marker.node

run_one() {
  local side="$1" case_name="$2" mode="$3" rep="$4" bundle="$5"
  echo "=== side=$side case=$case_name mode=$mode rep=$rep ===" | tee -a "$RESULT_DIR/raw.log"
  set +e
  out=$(timeout 180s "$QEMU_BIN" -cpu max -d plugin -plugin file=/tmp/lm-qemu-plugin.so \
    "$(command -v node)" \
    --allow-natives-syntax --single-threaded --predictable \
    --no-concurrent-recompilation --random-seed=20260916 \
    .github/research/qemu-ir-415/harness.mjs "$bundle" "$case_name" "$mode" 2>&1)
  rc=$?
  set -e
  printf '%s\n' "$out" | tee -a "$RESULT_DIR/raw.log"
  if [ "$rc" -ne 0 ]; then
    echo "execution rc=$rc side=$side case=$case_name mode=$mode rep=$rep" > "$RESULT_DIR/acquisition_failure.txt"
    return 1
  fi
  count=$(printf '%s\n' "$out" | sed -n 's/.*QEMU_IR vcpu=[0-9][0-9]* count=\([0-9][0-9]*\).*/\1/p')
  line=$(printf '%s\n' "$out" | grep '^HARNESS ' || true)
  if [ "$(printf '%s\n' "$count" | sed '/^$/d' | wc -l)" -ne 1 ] || [ -z "$line" ]; then
    echo "missing/duplicate receipt side=$side case=$case_name mode=$mode rep=$rep" > "$RESULT_DIR/acquisition_failure.txt"
    return 1
  fi
  checksum=$(printf '%s\n' "$line" | sed -n 's/.*checksum=\([^ ]*\).*/\1/p')
  before=$(printf '%s\n' "$line" | sed -n 's/.*statusBefore=\([^ ]*\).*/\1/p')
  after=$(printf '%s\n' "$line" | sed -n 's/.*statusAfter=\([^ ]*\).*/\1/p')
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$side" "$case_name" "$mode" "$rep" "$count" "$checksum" "$before" "$after" >> "$RESULT_DIR/counts.tsv"
}

acquire_ok=1
run_one candidate settled-single floor 1 /tmp/lm-candidate.mjs || acquire_ok=0
if [ "$acquire_ok" -eq 1 ]; then run_one candidate settled-single floor 2 /tmp/lm-candidate.mjs || acquire_ok=0; fi

if [ "$acquire_ok" -eq 1 ]; then
  for case_name in settled-single all-seven live-single; do
    for rep in 1 2 3 4; do
      run_one base "$case_name" product "$rep" /tmp/lm-base.mjs || { acquire_ok=0; break 2; }
      run_one candidate "$case_name" product "$rep" /tmp/lm-candidate.mjs || { acquire_ok=0; break 2; }
    done
    for rep in 1 2; do
      run_one candidate "$case_name" positive "$rep" /tmp/lm-candidate.mjs || { acquire_ok=0; break 2; }
    done
  done
fi

if [ "$acquire_ok" -eq 0 ]; then
  REASON="$(cat "$RESULT_DIR/acquisition_failure.txt")" python3 -c 'import json,os; r={"verdict":"BLOCKED_UNPROVEN","execution_failure":os.environ["REASON"]}; open(os.environ["RESULT_DIR"]+"/result.json","w").write(json.dumps(r,indent=2,sort_keys=True)+"\n"); print(json.dumps(r,indent=2,sort_keys=True))'
else
  (cd "$RESULT_DIR" && python3 "$ROOT/.github/research/qemu-ir-415/evaluate.py" counts.tsv) || true
fi

{
  echo "base=fe11daa407de396fad952be7679650f63dabd4dd"
  echo "candidate=df7aaced646116f34135083dbfbf62ee40265657"
  echo "carrier=$(git rev-parse HEAD)"
  echo "node=$(node --version)"
  echo "pnpm=$(pnpm --version)"
  echo "kernel=$(uname -srvmo)"
  echo "cpu=$(grep -m1 'model name' /proc/cpuinfo || true)"
  "$QEMU_BIN" --version | head -1
} | tee "$RESULT_DIR/environment.txt"

(cd "$RESULT_DIR" && sha256sum result.json counts.tsv raw.log environment.txt hashes.txt qemu-version.txt | tee receipt-sha256.txt)
cat "$RESULT_DIR/result.json"
