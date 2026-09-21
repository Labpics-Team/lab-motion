#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: reject-symlinks.sh <tree> [tree...]" >&2
  exit 2
fi

for root in "$@"; do
  if [ ! -d "$root" ]; then
    echo "scan tree is not a directory: $root" >&2
    exit 2
  fi
  link="$(find "$root" -path "$root/.git" -prune -o -type l -print -quit)"
  if [ -n "$link" ]; then
    relative="${link#"$root/"}"
    echo "symbolic link is not admitted to host filesystem scan: $relative" >&2
    exit 1
  fi
done
