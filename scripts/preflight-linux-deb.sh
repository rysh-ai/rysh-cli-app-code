#!/usr/bin/env bash
#
# preflight-linux-deb.sh — refuse the .deb target when `ar` cannot build one.
#
# THE DEFECT THIS EXISTS FOR (E-53). `make package-linux` on macOS emits
# `rysh-desktop_<version>_amd64.deb` at 96 BYTES and EXITS 0. electron-builder
# shells out to `ar`; macOS supplies BSD ar; the archive that comes back holds
# only `__.SYMDEF SORTED` and none of the payload. It is not a build failure —
# it is a correctly-named empty package, so anyone cutting or verifying a
# release from a Mac would ship it. CI never caught it because the Linux job
# runs on ubuntu-latest, where `ar` is GNU. The entire defect is the exit 0;
# this script's only job is to turn that into a loud non-zero.
#
# WHY IT TESTS THE TOOL AND NOT THE OS. A Mac with GNU binutils on PATH can
# build a correct .deb, and refusing by `uname` would block it for no reason —
# while some future runner without GNU ar would sail straight through an
# OS-name check. So the capability is measured directly:
#
#   GNU ar : `ar --version` exits 0 and prints "GNU ar (GNU Binutils…)" on STDOUT
#   BSD ar : `ar --version` exits 1 and prints a usage block on STDERR
#
# Hence stderr is discarded below: BSD ar's usage text must not be mistaken for
# a version string. This is also why the check cannot fire on ubuntu-latest,
# which is a hard constraint — a guard that breaks the release path to fix a
# local footgun is a worse bug than the one it fixes.
#
# SCOPE — WHICH TARGET. This refuses ONLY the deb target. The AppImage produced
# by the same macOS build is genuine (E-53 measured it: 101 MB x86-64 ELF), so
# Linux packaging is not disabled wholesale — `make package-linux-appimage`
# builds it on this machine and deliberately does not consult this script.
#
# SCOPE — WHICH ENTRY POINTS (extended; it was the Makefile alone until W4).
# Two local routes reach the deb target and BOTH now run this first:
#
#   make package-linux    → runs this, then `npm run make:linux`
#   npm run make:linux    → `./scripts/preflight-linux-deb.sh && electron-builder --linux`
#
# The npm script was the gap. E-53's danger is that anyone verifying or cutting
# a release from a Mac ships the 96-byte package, and such a person is at least
# as likely to type `npm run make:linux` as to use the Makefile — so guarding
# one entry point left the defect reachable by the more obvious route. Guarding
# the npm script means the Makefile now runs this twice on that path; it is
# idempotent and costs one `ar --version`, and the redundancy is deliberate so
# neither entry point depends on the other keeping the guard.
#
# NOT guarded, on purpose: `npm run package` ("electron-builder", no target
# flags) builds whatever the host targets, so putting a Linux-deb guard in
# front of it would refuse ordinary macOS builds on a Mac — a guard that breaks
# a working path to fix a footgun, which is the failure this header warns
# against two paragraphs up.
#
# CI IS UNAFFECTED BY ALL OF THIS. `.github/workflows/electron-build.yml` runs
# `npx electron-builder --<platform> … --publish never` directly — never via the
# Makefile and never via `npm run make:linux` — so nothing added at either entry
# point can reach the release path.
#
# Usage:
#   scripts/preflight-linux-deb.sh     # exit 0 = deb target is safe to run
#
set -euo pipefail

AR_PATH="$(command -v ar 2>/dev/null || true)"

if [[ -z "$AR_PATH" ]]; then
  cat >&2 <<'EOF'
FATAL: no `ar` on PATH — the .deb target cannot be built here.

electron-builder builds the .deb by shelling out to `ar`. Without it the target
either fails late or produces something that is not a package.

Install GNU binutils, or build the .deb on Linux:
    scripts/verify/build-linux-deb.sh
EOF
  exit 1
fi

# stderr discarded on purpose: BSD ar writes a usage block there and exits 1.
AR_VERSION_LINE="$(ar --version 2>/dev/null | head -1 || true)"

if [[ "$AR_VERSION_LINE" == *GNU* ]]; then
  echo "preflight: GNU ar at ${AR_PATH} (${AR_VERSION_LINE}) — .deb target OK"
  exit 0
fi

cat >&2 <<EOF
FATAL: ${AR_PATH} is not GNU ar — REFUSING the .deb target.

This is the guard for E-53. Building the .deb with a non-GNU ar does NOT fail:
it writes a 96-byte archive containing only \`__.SYMDEF SORTED\`, names it
exactly like the real artifact, and exits 0. A release cut or verified from
this machine would ship an empty package that looks entirely correct.

  ar on PATH : ${AR_PATH}
  reports    : ${AR_VERSION_LINE:-<no version string; BSD ar exits 1 with usage on stderr>}
  wanted     : a version line containing "GNU"

Two ways forward, neither of which needs this check to be bypassed:

  1. Build the .deb on Linux, which is what a release does anyway:
         scripts/verify/build-linux-deb.sh
     (a native-arch container — packaging copies files and writes metadata, it
     does not execute the x86-64 payload)

  2. Build only the AppImage here. The AppImage from a macOS build is genuine,
     so this is a real artifact and not a workaround:
         make package-linux-appimage

Installing GNU binutils so \`ar\` reports GNU also clears this check.
EOF
exit 1
