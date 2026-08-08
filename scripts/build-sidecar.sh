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

# Build matrix: OS/ARCH/output-suffix.
#
# windows/amd64 is deliberately absent: rysh's PTY layer is a stub on native
# Windows (rysh-cli internal/platform/pty_windows.go sets PTYSupported=false),
# so that binary links and runs and then fails to open a single pane. Windows
# is not a shipping target — see docs/RELEASE-PLAN.md.
#
# linux/arm64 is built for completeness but electron-builder.yml ships x64
# AppImage/deb only.
declare -a TARGETS=(
  "darwin:arm64:darwin-arm64"
  "darwin:amd64:darwin-x64"
  "linux:amd64:linux-x64"
  "linux:arm64:linux-arm64"
)

# Strip DWARF + symbol table; the sidecar is the biggest thing in the bundle and
# nothing reads its symbols. Go panics keep their stack traces regardless.
LDFLAGS="-s -w"

for target in "${TARGETS[@]}"; do
  IFS=':' read -r goos goarch suffix <<< "$target"
  output="$SIDECAR_DIR/rysh-$suffix"
  echo "  Building: GOOS=$goos GOARCH=$goarch → $output"
  (cd "$GO_SRC" && GOWORK=off GOOS="$goos" GOARCH="$goarch" go build -ldflags="$LDFLAGS" -o "$output" ./cmd/rysh)
done

echo ""
echo "==> All sidecar binaries built successfully."
ls -lh "$SIDECAR_DIR"/rysh-*
