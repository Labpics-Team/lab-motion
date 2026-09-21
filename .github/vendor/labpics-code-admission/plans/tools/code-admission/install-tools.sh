#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: install-tools.sh <destination> [all|ast-grep]" >&2
  exit 2
fi
selection="${2:-all}"
case "$selection" in all|ast-grep) ;; *) echo "unsupported tool selection" >&2; exit 2 ;; esac
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "code-admission tool bundle currently requires Linux x86_64" >&2
  exit 2
fi
for command in curl unzip sha256sum; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 2; }
done
if [ "$selection" = all ]; then
  command -v tar >/dev/null || { echo "missing required command: tar" >&2; exit 2; }
fi

destination="$1"
mkdir -p "$destination"
work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

AST_GREP_VERSION="0.45.0"
AST_GREP_SHA256="78931ae35ebac33d9a72b3aecea3e3d62d6e5b0b718ac8bbedfbe69d68421e41"
AST_GREP_URL="https://github.com/ast-grep/ast-grep/releases/download/${AST_GREP_VERSION}/app-x86_64-unknown-linux-gnu.zip"
TRIVY_VERSION="0.74.0"
TRIVY_SHA256="2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a"
TRIVY_URL="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"

download_verified() {
  local url="$1" expected="$2" output="$3"
  curl --fail --location --silent --show-error --retry 3 --retry-all-errors "$url" --output "$output"
  printf '%s  %s\n' "$expected" "$output" | sha256sum --check --status || {
    echo "checksum mismatch for $url" >&2
    exit 2
  }
}

download_verified "$AST_GREP_URL" "$AST_GREP_SHA256" "$work/ast-grep.zip"
unzip -q "$work/ast-grep.zip" -d "$work/ast-grep"
ast_binary="$(find "$work/ast-grep" -type f -name ast-grep -print -quit)"
if [ -z "$ast_binary" ]; then
  echo "ast-grep binary missing from verified archive" >&2
  exit 2
fi
install -m 0755 "$ast_binary" "$destination/ast-grep"
"$destination/ast-grep" --version
if [ "$selection" = ast-grep ]; then exit 0; fi

download_verified "$TRIVY_URL" "$TRIVY_SHA256" "$work/trivy.tar.gz"
tar -xzf "$work/trivy.tar.gz" -C "$work"
if [ ! -f "$work/trivy" ]; then
  echo "Trivy binary missing from verified archive" >&2
  exit 2
fi
install -m 0755 "$work/trivy" "$destination/trivy"
"$destination/trivy" --version
