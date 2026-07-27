#!/usr/bin/env bash
# Cross-compile the full rysh binary as the sidecar for all target platforms.
# Usage: ./scripts/build-sidecar.sh [go-source-dir]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SIDECAR_DIR="$PROJECT_DIR/sidecar"

# Go source directory for the full rysh binary
GO_SRC="${1:-$PROJECT_DIR/../rysh-cli-code}"

mkdir -p "$SIDECAR_DIR"

echo "==> Building rysh sidecar binaries from: $GO_SRC"
echo "==> Output directory: $SIDECAR_DIR"
echo ""

# Build matrix: OS/ARCH/output-suffix
declare -a TARGETS=(
  "darwin:arm64:darwin-arm64"
  "darwin:amd64:darwin-x64"
  "linux:amd64:linux-x64"
  "linux:arm64:linux-arm64"
  "windows:amd64:win-x64.exe"
)

for target in "${TARGETS[@]}"; do
  IFS=':' read -r goos goarch suffix <<< "$target"
  output="$SIDECAR_DIR/rysh-$suffix"
  echo "  Building: GOOS=$goos GOARCH=$goarch → $output"
  (cd "$GO_SRC" && GOWORK=off GOOS="$goos" GOARCH="$goarch" go build -o "$output" .)
done

echo ""
echo "==> All sidecar binaries built successfully."
ls -lh "$SIDECAR_DIR"/rysh-*
