#!/usr/bin/env bash
#
# verify-linux-deb.sh — install the desktop .deb on a clean Ubuntu 22.04 and
# assert it is actually usable.
#
# This is the evidence for docs/RELEASE-PLAN.md §6, ".deb installs on Ubuntu
# 22.04". That box needs no display, no Apple certificate and no R2 secret,
# which is why it is the first one worth doing: U-3 and U-4 gate publishing and
# signing, not building and checking.
#
# It installs with `apt-get install ./file.deb` rather than `dpkg -i` on
# purpose. dpkg -i unpacks and leaves dependencies unresolved, so it passes on a
# package whose Depends are wrong; apt resolves them, so a bad dependency list
# fails here instead of on a user's machine. The container starts with no
# Electron runtime libraries at all, so every library the app needs must come
# from the package's own metadata.
#
# Usage:
#   scripts/verify/verify-linux-deb.sh [path/to/rysh-desktop_*.deb]
#
# Requires Docker with linux/amd64 support (emulation is fine — see CAVEATS in
# docs/VERIFICATION-2026-08-13-linux.md). Exits non-zero on the first failed
# assertion, and prints every assertion either way.
#
set -euo pipefail

DEB="${1:-}"
if [[ -z "$DEB" ]]; then
  DEB="$(ls release/rysh-desktop_*.deb 2>/dev/null | head -1 || true)"
fi
if [[ -z "$DEB" || ! -f "$DEB" ]]; then
  echo "FATAL: no .deb found. Pass one, or build it with" >&2
  echo "       scripts/verify/build-linux-deb.sh (do NOT build it on macOS —" >&2
  echo "       electron-builder writes a corrupt archive there)." >&2
  exit 2
fi

# A macOS-built .deb is a 96-byte BSD ar stub that dpkg cannot read. Catching it
# here turns a confusing in-container failure into a one-line explanation.
if [[ "$(wc -c < "$DEB")" -lt 10000 ]]; then
  echo "FATAL: $DEB is $(wc -c < "$DEB") bytes — that is the corrupt macOS-built" >&2
  echo "       package, not a real one. Build it on Linux." >&2
  exit 2
fi

echo "verifying: $DEB"
DEB_ABS="$(cd "$(dirname "$DEB")" && pwd)/$(basename "$DEB")"

# Whether the x86-64 payload can actually RUN here, which is a different
# question from whether the package installs. On Apple Silicon the container is
# QEMU-emulated: dpkg and coreutils work, but the Go sidecar dies with
# "qemu: uncaught target signal 11 (Segmentation fault)". Assertions that need
# to execute the payload are therefore SKIPPED on an emulated host and the run
# reports PARTIAL, never PASS. Silently passing them would be a false tick, and
# silently failing them would blame the package for the emulator.
#
# Detecting it is not as simple as `uname -m`. On this Mac `uname -m` prints
# x86_64 and `sysctl -n hw.machine` prints x86_64 while the CPU is an Apple M1:
# the shell is running translated under Rosetta 2, and the translation is
# invisible to both. Trusting uname here reported EMULATED=0, which would have
# run the payload assertions, watched QEMU segfault, and blamed the package for
# the emulator. hw.optional.arm64 reports the silicon regardless of Rosetta.
EMULATED=0
if [[ "$(uname -s)" == "Darwin" ]]; then
  [[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" == "1" ]] && EMULATED=1
elif [[ "$(uname -m)" != "x86_64" ]]; then
  EMULATED=1
fi

docker run --rm --platform linux/amd64 \
  -e EMULATED="$EMULATED" \
  -v "$DEB_ABS":/pkg/app.deb:ro \
  ubuntu:22.04 bash -euo pipefail -c '
    fail=0
    skipped=0
    ok()   { echo "OK   $*"; }
    bad()  { echo "FAIL $*"; fail=1; }
    skip() { echo "SKIP $* — emulated host cannot execute the x86-64 payload"; skipped=1; }

    echo "== container arch: $(uname -m)   ubuntu: $(. /etc/os-release; echo $VERSION_ID)   emulated: ${EMULATED:-0}"

    export DEBIAN_FRONTEND=noninteractive
    # The real test: apt must resolve every dependency the package declares.
    # Retried because archive.ubuntu.com intermittently answers 400 on
    # individual files, and a flaky mirror must not be read as a bad package —
    # that is the same error as blaming the package for the emulator.
    installed=0
    for attempt in 1 2 3; do
      apt-get update -qq >/dev/null 2>&1 || true
      if apt-get install -y -qq /pkg/app.deb > /tmp/install.log 2>&1; then
        installed=1; break
      fi
      echo "     apt attempt $attempt failed: $(grep -m1 "^E:" /tmp/install.log || echo "see log")"
      sleep 5
    done
    if [ "$installed" != "1" ]; then
      echo "FAIL install failed after 3 attempts:"; tail -30 /tmp/install.log; exit 1
    fi
    ok "apt-get install resolved all declared dependencies"

    # Read the installed package record once and pick fields out of it.
    # dpkg-query -f is avoided on purpose: its format strings use ${Status},
    # which the surrounding shell expands before dpkg ever sees it (and under
    # `set -u` that is an "unbound variable" abort, not a silent empty string).
    dpkg -s rysh-desktop > /tmp/pkg.txt 2>/dev/null || echo "" > /tmp/pkg.txt
    field() { sed -n "s/^$1: //p" /tmp/pkg.txt | head -1; }

    # dpkg agrees it is installed, not merely unpacked.
    st=$(field Status); st=${st:-missing}
    [ "$st" = "install ok installed" ] && ok "dpkg status: $st" || bad "dpkg status: $st"

    # Metadata a public package is judged by.
    arch=$(field Architecture)
    ver=$(field Version)
    maint=$(field Maintainer)
    home=$(field Homepage)
    [ "$arch" = "amd64" ] && ok "architecture: $arch" || bad "architecture: $arch (expected amd64)"
    ok "version: $ver"
    ok "maintainer: $maint"
    echo "     homepage: ${home:-(none)}"

    # The launcher must not collide with the CLI: rysh-cli installs
    # /usr/local/bin/rysh, and electron-builder.yml sets executableName
    # rysh-desktop precisely so the desktop package cannot shadow it.
    if [ -x /usr/bin/rysh-desktop ] || [ -L /usr/bin/rysh-desktop ]; then
      ok "launcher on PATH: $(readlink -f /usr/bin/rysh-desktop)"
    else
      bad "no /usr/bin/rysh-desktop launcher"
    fi
    if [ -e /usr/bin/rysh ] || [ -e /usr/local/bin/rysh ]; then
      bad "package claims the CLI name \"rysh\" — it would shadow rysh-cli on PATH"
    else
      ok "package does not claim the CLI name \"rysh\""
    fi

    # A .desktop entry is what makes it launchable from a desktop environment.
    if ls /usr/share/applications/*rysh* >/dev/null 2>&1; then
      ok "desktop entry: $(ls /usr/share/applications/*rysh*)"
    else
      bad "no .desktop entry installed"
    fi

    # The bundled daemon. This is the whole product: the Electron shell is a
    # client of this binary, so a package that installs without it is useless.
    SIDE=$(find /opt -name "rysh-linux-x64" -type f 2>/dev/null | head -1)
    if [ -n "$SIDE" ]; then
      ok "sidecar present: $SIDE ($(du -h "$SIDE" | cut -f1))"
    else
      bad "sidecar rysh-linux-x64 not found under /opt"
      exit 1
    fi

    # It is a static CGO_ENABLED=0 binary, so it must run on a bare Ubuntu with
    # no extra libraries. Running it proves the shipped daemon is not merely
    # present but executable on the target.
    if [ "${EMULATED:-0}" = "1" ]; then
      skip "sidecar --version"
      # Still worth asserting what CAN be checked without executing it: that the
      # file is an x86-64 ELF and not, say, a wrong-arch binary silently copied
      # in by a broken ${arch} substitution.
      apt-get install -y -qq file >/dev/null 2>&1 || true
      desc=$(file -b "$SIDE" 2>/dev/null || echo unknown)
      case "$desc" in
        *"ELF 64-bit"*x86-64*) ok "sidecar is an x86-64 ELF: $desc" ;;
        *)                     bad "sidecar is not an x86-64 ELF: $desc" ;;
      esac
    else
      if out=$("$SIDE" --version 2>&1); then
        ok "sidecar runs: $out"
      else
        bad "sidecar --version failed: $out"
      fi

      # Ties this package to E-49: the pin was v0.2.3, whose daemon has no board
      # command at all. If someone reverts the pin, this is how they find out.
      if "$SIDE" board --help >/tmp/board.log 2>&1 || ! grep -qi "unknown command" /tmp/board.log; then
        ok "sidecar knows the board command (pin is not back at v0.2.3)"
      else
        bad "sidecar does not know board: $(head -1 /tmp/board.log)"
      fi
    fi

    # Nothing that leaks state or bloat should be inside a public package.
    if [ -e "$(dirname "$SIDE")/.rysh" ]; then
      bad ".rysh runtime state directory shipped inside the package"
    else
      ok "no .rysh state directory in the package"
    fi
    if ls "$(dirname "$SIDE")"/*.bak* >/dev/null 2>&1; then
      bad "stale *.bak* sidecar shipped"
    else
      ok "no stale *.bak* files"
    fi
    n=$(ls -1 "$(dirname "$SIDE")" | wc -l)
    [ "$n" = "1" ] && ok "exactly one sidecar shipped" || bad "expected 1 sidecar, found $n"

    echo
    if [ "$fail" != "0" ]; then
      echo "FAIL — see above."
    elif [ "$skipped" = "1" ]; then
      echo "PARTIAL — the .deb installs on Ubuntu 22.04 and its contents are correct,"
      echo "but the payload was never executed here. Re-run on real x86-64 hardware"
      echo "before calling the box checked."
    else
      echo "PASS — the .deb installs and is usable on Ubuntu 22.04."
    fi
    exit $fail
  '
