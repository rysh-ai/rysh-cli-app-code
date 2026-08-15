#!/usr/bin/env bash
#
# verify-linux-firstrun.sh — launch the installed desktop app on a clean Linux
# with no rysh config at all, and drive it until a pane has run a command.
#
# Evidence for two boxes in docs/RELEASE-PLAN.md §6:
#
#   BOX 431  "First launch with no ~/.config/rysh/ present reaches a usable
#            state"  — RELEASE-PLAN F7 is the risk: the CLI expects an Anthropic
#            key in ~/.config/rysh/rysh.config.yaml, and if the app has no
#            in-app key flow then a download converts to a blank screen. So the
#            HOME here is empty and stays empty; the script fails if anything
#            pre-seeds it.
#
#   BOX 432  "A pane opens and runs a command" — asserted, not eyeballed. The
#            command writes a token to a file and the script greps for it, so
#            the proof is that the pane's PTY really executed something, not
#            that a screenshot looked plausible.
#
# HOW 432 IS DRIVEN, stated plainly because it bounds the claim: the app spawns
# the full rysh binary as a daemon (electron/sidecar.ts — `rysh daemon <session>`
# with RYSH_WEB_AUTO_START). The pane is created and driven through that same
# daemon, using the bundled binary as a CLI, which is the interface the app's own
# renderer is a client of. It does NOT synthesize clicks in the renderer. So a
# pass means "the app came up and its daemon opened a pane that ran a command",
# NOT "the pane UI is rendered correctly". A renderer check is a separate box.
#
# Usage:
#   scripts/verify/verify-linux-firstrun.sh [path/to/rysh-desktop_*.deb]
#
# KNOWN WALL ON APPLE SILICON: this needs to run the app, and the app is
# Electron, and Electron is Node/V8, and V8 does not survive QEMU user-mode
# emulation on this box — plain `node -e` produces no output for over two
# minutes and `npm install` dies with SIGTRAP (exit 133). Running this under
# --platform linux/amd64 on an M-series Mac is expected to hang or trap. It is
# written to be correct on real amd64 hardware; see
# docs/VERIFICATION-2026-08-13-linux.md.
#
set -euo pipefail

DEB="${1:-}"
if [[ -z "$DEB" ]]; then
  DEB="$(ls release/rysh-desktop_*.deb 2>/dev/null | head -1 || true)"
fi
[[ -n "$DEB" && -f "$DEB" ]] || { echo "FATAL: no .deb found; see verify-linux-deb.sh" >&2; exit 2; }
DEB_ABS="$(cd "$(dirname "$DEB")" && pwd)/$(basename "$DEB")"

# Two knobs so a slow machine is a longer wait rather than a false negative.
BOOT_TIMEOUT="${BOOT_TIMEOUT:-120}"
CMD_TIMEOUT="${CMD_TIMEOUT:-60}"

docker run --rm --platform linux/amd64 \
  -e BOOT_TIMEOUT="$BOOT_TIMEOUT" -e CMD_TIMEOUT="$CMD_TIMEOUT" \
  -v "$DEB_ABS":/pkg/app.deb:ro \
  ubuntu:22.04 bash -euo pipefail -c '
    fail=0
    ok()  { echo "OK   $*"; }
    bad() { echo "FAIL $*"; fail=1; }

    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    # xvfb supplies the display; the rest of the runtime comes from the
    # packageitself, which is part of what box 431 is testing.
    apt-get install -y -qq /pkg/app.deb xvfb procps curl >/tmp/install.log 2>&1 \
      || { echo "FAIL install failed:"; tail -20 /tmp/install.log; exit 1; }
    ok "package + xvfb installed"

    SIDE=$(find /opt -name rysh-linux-x64 -type f | head -1)
    APP=$(command -v rysh-desktop || true)
    [ -n "$SIDE" ] && [ -n "$APP" ] || { echo "FAIL app or sidecar missing"; exit 1; }

    # ---- BOX 431 setup: a genuinely fresh HOME -------------------------------
    export HOME=/root/fresh
    rm -rf "$HOME"; mkdir -p "$HOME"
    if [ -e "$HOME/.config/rysh" ]; then bad "HOME was pre-seeded — test is void"; exit 1; fi
    ok "clean HOME: no ~/.config/rysh, no ~/.rysh"

    # --no-sandbox: the Chromium sandbox needs privileges a default container
    # does not have. It changes nothing about first-run logic.
    echo "== launching: $APP --no-sandbox"
    xvfb-run -a "$APP" --no-sandbox --remote-debugging-port=9222 \
      > /tmp/app.log 2>&1 &
    APP_PID=$!

    # ---- BOX 431: did it reach a usable state? -------------------------------
    # "Usable" is asserted from three independent signals rather than a
    # screenshot: the process survives, the app spawned its daemon, and that
    # daemon answers HTTP. A blank-screen dead end fails the second and third.
    boot_ok=0
    for i in $(seq 1 "$BOOT_TIMEOUT"); do
      if ! kill -0 $APP_PID 2>/dev/null; then
        bad "app process exited during startup after ${i}s"
        echo "---- app log ----"; tail -40 /tmp/app.log; break
      fi
      if pgrep -f "rysh-linux-x64 daemon" >/dev/null 2>&1; then boot_ok=1; break; fi
      sleep 1
    done
    if [ "$boot_ok" = "1" ]; then
      ok "app spawned its sidecar daemon (pid $(pgrep -f "rysh-linux-x64 daemon" | head -1))"
    else
      bad "no sidecar daemon after ${BOOT_TIMEOUT}s"
      echo "---- app log ----"; tail -40 /tmp/app.log
    fi

    # The daemon advertises a web endpoint; the renderer is its client. If this
    # answers, the back half of the app is up regardless of what is painted.
    health=""
    for i in $(seq 1 30); do
      for p in $(seq 3000 3010); do
        if curl -fsS "http://127.0.0.1:$p/health" -o /tmp/health.json 2>/dev/null; then
          health="$p"; break 2
        fi
      done
      sleep 1
    done
    [ -n "$health" ] && ok "daemon web endpoint answering on :$health ($(head -c 80 /tmp/health.json))" \
                     || bad "no daemon web endpoint answered /health"

    # A renderer target existing proves a window with a document, not a crash.
    if curl -fsS http://127.0.0.1:9222/json/list -o /tmp/cdp.json 2>/dev/null; then
      ok "renderer target present: $(head -c 120 /tmp/cdp.json)"
    else
      bad "no CDP target — the renderer never came up"
    fi

    # First run must not have required a config file to get this far.
    [ -e "$HOME/.config/rysh/rysh.config.yaml" ] \
      && echo "     note: app created $HOME/.config/rysh/rysh.config.yaml" \
      || echo "     note: app reached this state with no rysh.config.yaml at all"

    # ---- BOX 432: open a pane, run a command, assert the output --------------
    SESS=$("$SIDE" list-sessions 2>/dev/null | awk "NR>1{print \$1; exit}")
    [ -n "${SESS:-}" ] && ok "session visible to the CLI: $SESS" || bad "no session listed"

    TOKEN="RYSH_T2_PANE_PROOF_$$"
    PROOF=/tmp/pane-proof.txt
    rm -f "$PROOF"
    if [ -n "${SESS:-}" ]; then
      # Ask the daemon for its pane; the app opens one at startup. Fall back to
      # creating one if the startup pane is not there yet.
      PANE=$("$SIDE" exec --session "$SESS" --json -- "##pane info" 2>/dev/null \
             | sed -n "s/.*\"pane_id\":\"\([^\"]*\)\".*/\1/p" | head -1 || true)
      echo "     pane id: ${PANE:-(none reported)}"
      # ##cmd runs the text in the pane PTY. Redirecting to a file makes the
      # assertion independent of terminal rendering and scrollback parsing.
      "$SIDE" exec --session "$SESS" -- "##cmd echo $TOKEN > $PROOF" >/tmp/cmd.log 2>&1 || true
      for i in $(seq 1 "$CMD_TIMEOUT"); do
        [ -s "$PROOF" ] && break
        sleep 1
      done
      if grep -q "$TOKEN" "$PROOF" 2>/dev/null; then
        ok "pane ran the command — $PROOF contains $TOKEN"
      else
        bad "pane did not run the command; no $TOKEN in $PROOF"
        echo "---- cmd log ----"; tail -20 /tmp/cmd.log
      fi
    fi

    kill $APP_PID 2>/dev/null || true
    echo
    if [ "$fail" = "0" ]; then
      echo "PASS — boxes 431 and 432 hold on this platform."
    else
      echo "FAIL — see above. An unchecked box reported honestly beats a ticked one."
    fi
    exit $fail
  '
