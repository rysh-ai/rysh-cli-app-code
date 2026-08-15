#!/usr/bin/env bash
#
# build-linux-deb.sh — package the Linux .deb on Linux, from this Mac.
#
# `make package-linux` runs electron-builder on the host. On macOS that emits a
# CORRUPT .deb and exits 0: electron-builder shells out to `ar`, macOS supplies
# BSD ar, and the result is a 96-byte archive holding only a symbol table. It is
# named exactly like the real artifact. Anyone verifying a release from a Mac
# would ship or test that file believing it was a package.
#
# So the packaging step runs in a Linux container instead. NOT an emulated
# linux/amd64 one, which is the obvious choice and does not work here: Node
# crashes under QEMU on Apple Silicon (exit 133, SIGTRAP — see
# Dockerfile.deb-build for the measurements). The container is native-arch and
# cross-packages the x64 artifact, which is sound because packaging copies files
# and writes metadata rather than executing the payload.
#
# Prerequisites (this script does not do them, on purpose — they are the app's
# normal build, not verification scaffolding):
#   make build-sidecar-linux    # sidecar/rysh-linux-x64
#   npm run build               # dist/
#
# Usage:
#   scripts/verify/build-linux-deb.sh          # -> release/rysh-desktop_*.deb
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

[[ -d dist ]]                    || { echo "FATAL: dist/ missing — run 'npm run build'" >&2; exit 2; }
[[ -f sidecar/rysh-linux-x64 ]]  || { echo "FATAL: sidecar/rysh-linux-x64 missing — run 'make build-sidecar-linux'" >&2; exit 2; }

IMAGE=rysh-deb-build:t2
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> building $IMAGE"
  docker build -f scripts/verify/Dockerfile.deb-build -t "$IMAGE" scripts/verify/
fi

mkdir -p release
CACHE="${TMPDIR:-/tmp}/rysh-eb-cache"; mkdir -p "$CACHE"

# electron-builder normally reads the Electron version out of the installed
# node_modules. Only dist/, sidecar/ and resources/ are copied into the
# container (node_modules is a 695 MB host-arch tree with nothing the packaging
# step needs), so the version is read HERE, from the electron the lockfile
# actually installed, and passed in. Reading it beats hardcoding: a hardcoded
# number would silently package a different runtime than the one npm resolved.
ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null || true)"
[[ -n "$ELECTRON_VERSION" ]] || { echo "FATAL: cannot read node_modules/electron version — run 'npm ci'" >&2; exit 2; }
echo "==> electron ${ELECTRON_VERSION} (from the installed node_modules)"

# The project is copied to /build inside the container rather than built in
# place, for two reasons. It keeps root-owned artifacts out of the worktree, and
# it lets us hand electron-builder the one thing it cannot find here: a .git
# DIRECTORY. electron-builder derives the deb's Homepage field from the origin
# remote, and package.json declares neither `homepage` nor `repository`. In a
# git WORKTREE, .git is a file, the lookup fails, and the deb target aborts with
# "Please specify project homepage". CI never sees this because
# actions/checkout@v4 leaves a real .git directory behind.
#
# Reproducing that remote here means the package metadata is derived exactly as
# CI derives it, rather than from a value invented by this script.
docker run --rm \
  -e ELECTRON_VERSION="$ELECTRON_VERSION" \
  -v "$PWD":/src:ro \
  -v "$PWD/release":/out \
  -v "$CACHE":/root/.cache \
  "$IMAGE" bash -euo pipefail -c '
    mkdir -p /build && cd /build
    cp -a /src/package.json /src/electron-builder.yml /build/
    cp -a /src/dist /src/sidecar /src/resources /build/
    git init -q . && git remote add origin https://github.com/rysh-ai/rysh-cli-app.git
    electron-builder --linux deb --x64 --publish never \
      -c.electronVersion="$ELECTRON_VERSION"
    cp -v /build/release/*.deb /out/
  '

echo
ls -lh release/*.deb
echo "==> verify it with: scripts/verify/verify-linux-deb.sh"
