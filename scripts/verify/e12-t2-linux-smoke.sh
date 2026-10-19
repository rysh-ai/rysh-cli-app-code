#!/usr/bin/env bash
#
# e12-t2-linux-smoke.sh — run the RELEASED Linux desktop artifact on a real
# x86-64 machine and check the two T2 boxes (E12; docs/RELEASE-PLAN.md §6):
#
#   BOX 2  first launch with no ~/.config/rysh reaches a usable state
#   BOX 3  a pane opens and runs a command
#
# Runs natively on the runner (ubuntu-22.04, x86-64), not in an emulated
# container: Electron is V8 and V8 does not survive QEMU on Apple Silicon, which
# is why verify-linux-firstrun.sh could never be run from the Mac.
#
# Usage: e12-t2-linux-smoke.sh <label> <out-dir> <app-cmd> [app-args...]
#   label    deb | appimage   (names the files in out-dir)
#   app-cmd  the installed binary, or the AppImage
#
# HOW BOX 3 IS DRIVEN — this bounds the claim, so it is stated up front.
# electron/main.ts boots a fresh instance with NO daemon ("Boot policy: a fresh
# instance starts with NO daemon and an empty (welcome) screen"); the daemon is
# started only when a workspace is opened, and opening one goes through a native
# folder dialog that cannot be clicked headless. The app's OTHER entry to the
# same code path is its relaunch path: WorkspaceManager.getLast() reads
# userData/workspaces.json and main.ts calls adoptOrStart() -> SidecarManager
# .start(). This script writes that file (the same shape the app itself saves)
# and relaunches, so the daemon is spawned by the app, from the app's bundled
# binary, with the app's env. The command is then sent into the session with
# that same bundled binary used as a CLI — the daemon is what the renderer is a
# client of. A pass therefore means "the app started its daemon and a pane in it
# ran a command"; it does NOT mean the pane UI was clicked or rendered.
#
# Every box prints CHECKED or FAILED with the evidence; the script exits
# non-zero if any box failed, so the job goes red.
set -uo pipefail

LABEL="$1"; OUT="$2"; shift 2
APP=("$@")
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
SESSION=e12smoke
BOOT_WAIT="${BOOT_WAIT:-40}"
fail=0

say()   { echo "[$LABEL] $*"; }
box()   { echo "[$LABEL] BOX $1: $2 [mode: ${MODE:-sandbox}] — $3" | tee -a "$OUT/boxes.txt"; [ "$2" = CHECKED ] || fail=1; }

shot() {
  import -window root "$OUT/$LABEL-$1.png" 2>>"$OUT/$LABEL-import.err" \
    && say "screenshot: $LABEL-$1.png" || say "screenshot FAILED ($1)"
}

# CDP: the renderer's visible text. Node 22's global WebSocket, no deps.
renderer_text() {
  node -e '
    (async () => {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      const page = list.find(t => t.type === "page") || list[0];
      if (!page) { console.log("NO-PAGE-TARGET " + JSON.stringify(list)); process.exit(3); }
      console.log("target: " + page.title + " | " + page.url);
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
        params: { expression: "document.body ? document.body.innerText.slice(0, 600) : \"<no body>\"", returnByValue: true } }));
      ws.onmessage = (m) => { const r = JSON.parse(m.data); if (r.id === 1) {
        console.log("innerText: " + JSON.stringify(r.result?.result?.value)); ws.close(); process.exit(0); } };
      setTimeout(() => { console.log("CDP-TIMEOUT"); process.exit(4); }, 10000);
    })().catch(e => { console.log("CDP-ERROR " + e); process.exit(5); });
  ' 2>&1
}

# launch <tag> [extra args] — sets APP_PID, logs to $OUT/$LABEL-<tag>.log
launch() {
  local tag="$1"; shift
  # setsid: own process group, so stop_app can kill the whole tree. The
  # AppImage runtime is a parent of Electron, and killing only it left Electron
  # alive in run 3 (see stop_app).
  setsid "${APP[@]}" --remote-debugging-port=9222 "$@" >"$OUT/$LABEL-$tag.log" 2>&1 &
  APP_PID=$!
  say "launched pid $APP_PID: ${APP[*]} --remote-debugging-port=9222 $*"
}

stop_app() {
  say "processes before stop:"; ps -eo pid,pgid,ppid,args | grep -iE 'rysh|appimage|electron' | grep -v grep | cut -c1-200 | sed "s/^/[$LABEL]   /"
  kill -TERM -- "-$APP_PID" 2>/dev/null
  for _ in $(seq 1 15); do pgrep -g "$APP_PID" >/dev/null || break; sleep 1; done
  kill -KILL -- "-$APP_PID" 2>/dev/null
  # the daemon is spawned detached and is meant to outlive the app; reap it so
  # the next launch starts clean (this is the runner, not anyone's session)
  pkill -f "rysh-linux-x64 daemon" 2>/dev/null
  sleep 2
  say "processes after stop:"; ps -eo pid,pgid,ppid,args | grep -iE 'rysh|appimage|electron' | grep -v grep | cut -c1-200 | sed "s/^/[$LABEL]   /"
}

# ---------------------------------------------------------------- BOX 2
say "inherited XDG env: $(env | grep '^XDG_' | tr '\n' ' ')"
export HOME; HOME="$(mktemp -d)"
# Run 2 showed the profile landing in /home/runner/.config/rysh-cli-app, not
# under the fresh HOME — Electron resolves its profile from XDG_CONFIG_HOME (if the runner exports one; printed above) or the passwd home, not $HOME alone.
# Point every XDG dir into the fresh HOME so each artifact gets a
# genuinely empty profile — otherwise the second artifact inherits the first's
# workspaces.json and its "first launch" is not one (that happened in run 2).
export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache" XDG_DATA_HOME="$HOME/.local/share"
say "fresh HOME=$HOME  XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
if [ -e "$HOME/.config/rysh" ] || [ -n "$(ls -A "$XDG_CONFIG_HOME" 2>/dev/null)" ]; then
  box 2 FAILED "config dir pre-seeded — test void"; exit 1
fi
say "asserted: $HOME/.config/rysh does not exist and $XDG_CONFIG_HOME is empty"

MARKER="$OUT/$LABEL-launch.marker"; touch "$MARKER"; sleep 1
SANDBOX_ARGS=()
MODE=sandbox
say "kernel.apparmor_restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>&1)"
say "kernel.unprivileged_userns_clone=$(sysctl -n kernel.unprivileged_userns_clone 2>&1)"
launch first
# Watch for death across the WHOLE boot wait, not just the first seconds: in
# run 37132439021 the 24.04 AppImage died after the old 8 s window, so the
# --no-sandbox retry never fired and both boxes went unmeasured.
died=""
for i in $(seq 1 $((BOOT_WAIT + 8))); do
  kill -0 "$APP_PID" 2>/dev/null || { died=$i; break; }
  sleep 1
done
if [ "$LABEL" = deb ]; then CS=/opt/Rysh/chrome-sandbox; else CS="$(ls -d /tmp/appimage_extracted_*/chrome-sandbox 2>/dev/null | head -1)"; fi
say "chrome-sandbox: $(stat -c '%A %U %n' "$CS" 2>&1)"
if [ -n "$died" ]; then
  # Any death on the sandboxed launch: keep the verbatim error, then retry with
  # --no-sandbox so Box 2/3 are still measured — and say which mode they ran in.
  wait "$APP_PID" 2>/dev/null; rc=$?
  say "app (sandboxed launch) died after ${died}s, exit=$rc$([ $rc -gt 128 ] && echo " (signal $((rc - 128)))") — verbatim log (non-extraction lines):"
  grep -vh '^/tmp/appimage_extracted_' "$OUT/$LABEL-first.log" | head -40 | sed "s/^/[$LABEL]   /"
  say "last 3 raw log lines:"; tail -3 "$OUT/$LABEL-first.log" | sed "s/^/[$LABEL]   /"
  say "kernel AppArmor denials:"; sudo dmesg 2>/dev/null | grep -iE 'apparmor="DENIED"|userns' | tail -5 | sed "s/^/[$LABEL]   /"
  {
    echo "[$LABEL] FINDING: sandboxed launch DIED after ${died}s (exit=$rc); kernel.apparmor_restrict_unprivileged_userns=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>&1)"
    grep -hiE 'sandbox|namespace|FATAL' "$OUT/$LABEL-first.log" | head -5 | sed "s/^/[$LABEL]   verbatim: /"
  } | tee -a "$OUT/boxes.txt"
  SANDBOX_ARGS=(--no-sandbox)
  MODE=no-sandbox
  launch first-nosandbox "${SANDBOX_ARGS[@]}"
  sleep "$BOOT_WAIT"
fi
say "launch mode for the boxes: $MODE"

if kill -0 "$APP_PID" 2>/dev/null; then alive=1; say "pid $APP_PID alive after ~$((BOOT_WAIT + 8))s"; else alive=0; say "pid $APP_PID DEAD"; fi
shot box2
say "renderer (CDP):"; RT="$(renderer_text)"; echo "$RT" | sed "s/^/[$LABEL]   /" | tee "$OUT/$LABEL-box2-renderer.txt"
say "created under \$HOME (depth 3):"; (cd "$HOME" && find . -maxdepth 3 2>/dev/null | sort) | sed "s/^/[$LABEL]   /" | tee "$OUT/$LABEL-box2-config-tree.txt"
say "app log (first 40 non-extraction lines):"; grep -vh '^/tmp/appimage_extracted_' "$OUT/$LABEL-first"*.log | head -40 | sed "s/^/[$LABEL]   /"

# A first launch must land on the empty screen. Anything else (e.g. a reopened
# workspace) means the profile was not fresh, and the box is not proven.
if [ "$alive" = 1 ] && echo "$RT" | grep -q 'No workspace loaded' && echo "$RT" | grep -q 'Open Workspace'; then
  box 2 CHECKED "process alive and renderer shows the first-run screen: $(echo "$RT" | grep '^innerText' | cut -c1-200)"
else
  box 2 FAILED "alive=$alive; renderer: $(echo "$RT" | tr '\n' ' ' | cut -c1-300)"
fi

stop_app
# userData dir — found, not assumed. Run 1 showed nothing under $HOME/.config,
# so search the filesystem for Chromium's "Local State" written since launch.
say "files the app wrote since launch (Local State / Preferences / window-state):"
find / -xdev \( -path /proc -o -path /sys \) -prune -o \
  \( -name 'Local State' -o -name 'Preferences' -o -name 'window-state.json' -o -name 'workspaces.json' \) \
  -newer "$MARKER" -print 2>/dev/null | sed "s/^/[$LABEL]   /" | tee "$OUT/$LABEL-userdata-candidates.txt"
LS="$(find / -xdev \( -path /proc -o -path /sys \) -prune -o -name 'Local State' -newer "$MARKER" -print 2>/dev/null | head -1)"
USERDATA=""; [ -n "$LS" ] && USERDATA="$(dirname "$LS")"
say "userData resolved to: ${USERDATA:-<none>}"
if [ -n "$USERDATA" ] && [ "${USERDATA#"$HOME"/}" = "$USERDATA" ]; then
  box 2 FAILED "userData is outside the fresh HOME ($USERDATA) — profile not isolated, first launch not proven"
fi

# ---------------------------------------------------------------- BOX 3
if [ -z "$USERDATA" ] || [ ! -d "$USERDATA" ]; then
  box 3 FAILED "cannot locate the app's userData dir to seed the reopen path"
  exit $fail
fi

WS="$HOME/e12ws"; mkdir -p "$WS"
cat >"$WS/rysh.config.yaml" <<EOF
rysh:
  session_name: "$SESSION"
nats:
  mode: "embedded"
EOF
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cat >"$USERDATA/workspaces.json" <<EOF
{"recent":[{"path":"$WS","name":"e12ws","lastOpened":"$NOW","lastSession":"$SESSION"}],"last":"$WS"}
EOF
say "seeded $USERDATA/workspaces.json -> $WS (session $SESSION)"

launch reopen "${SANDBOX_ARGS[@]}"
started=""
for _ in $(seq 1 60); do
  if grep -q 'Reopened last workspace' "$OUT/$LABEL-reopen.log"; then started=1; break; fi
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 1
done
say "app log, sidecar/main lines:"; grep -E '^\[(main|sidecar)' "$OUT/$LABEL-reopen.log" | head -30 | sed "s/^/[$LABEL]   /"

DPID="$(pgrep -f "rysh-linux-x64 daemon $SESSION" | head -1)"
if [ -z "$started" ] || [ -z "$DPID" ]; then
  shot box3
  box 3 FAILED "app did not start its daemon (reopened=${started:-no}, daemon pid=${DPID:-none})"
  tail -40 "$OUT/$LABEL-reopen.log" | sed "s/^/[$LABEL]   /"
  stop_app; exit $fail
fi
SIDE="$(readlink -f "/proc/$DPID/exe")"
say "daemon pid $DPID, exe $SIDE (spawned by the app)"
say "daemon cmdline: $(tr '\0' ' ' </proc/"$DPID"/cmdline)"
PORT="$(grep -oE 'web port: [0-9]+' "$OUT/$LABEL-reopen.log" | head -1 | grep -oE '[0-9]+')"
say "health: $(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health") on :$PORT"

cd "$WS"
say "list-sessions:"; "$SIDE" list-sessions 2>&1 | sed "s/^/[$LABEL]   /"
TOKEN="E12_T2_OK_\$((6*7))"   # the shell must evaluate this to ..._42
PROOF="$WS/pane-proof.txt"
say "\$ rysh exec --session $SESSION -- '##cmd ws echo $TOKEN > $PROOF'"
"$SIDE" exec --session "$SESSION" -- "##cmd ws echo $TOKEN > $PROOF" 2>&1 | sed "s/^/[$LABEL]   /"
echo "[$LABEL]   exit=${PIPESTATUS[0]}"
for _ in $(seq 1 30); do [ -s "$PROOF" ] && break; sleep 1; done
if [ ! -s "$PROOF" ]; then
  say "##cmd produced nothing; trying: rysh send $SESSION '<cmd>' --mode shell"
  "$SIDE" send "$SESSION" "echo $TOKEN > $PROOF" --mode shell 2>&1 | sed "s/^/[$LABEL]   /"
  echo "[$LABEL]   exit=${PIPESTATUS[0]}"
  for _ in $(seq 1 30); do [ -s "$PROOF" ] && break; sleep 1; done
fi
sleep 3; shot box3
say "renderer after command (CDP):"; renderer_text | sed "s/^/[$LABEL]   /" | tee "$OUT/$LABEL-box3-renderer.txt"
if grep -qx 'E12_T2_OK_42' "$PROOF" 2>/dev/null; then
  box 3 CHECKED "$PROOF contains '$(cat "$PROOF")' — a shell in a pane of the app-started daemon evaluated \$((6*7))"
else
  box 3 FAILED "no E12_T2_OK_42 in $PROOF (content: '$(cat "$PROOF" 2>/dev/null)')"
fi
stop_app
exit $fail
