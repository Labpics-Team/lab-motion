#!/usr/bin/env bash
set -euo pipefail

# The preregistered QEMU observation is already complete and immutable in
# run 35139687946 / job 104940797740. Never reacquire it after observation.
# This carrier phase closes only the remaining deterministic size Pareto axis.
exec bash .github/research/qemu-ir-415/size-proof.sh
