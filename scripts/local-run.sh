#!/usr/bin/env bash
#
# local-run.sh start|dev|stop|status — the dev-app lifecycle behind `make start`,
# `make dev`, `make stop`, `make restart` and `make status` (E12 order 30a,
# rr-msg-293). It starts, stops and reports ONLY what it recorded:
#
#   start   `npm run dev` in its OWN process group (set -m); the group id and its
#           leader's exact command line go to $RUN_DIR/dev.pgid
#   dev     the same, attached in the foreground (Ctrl+C works): its pid and
#           command line go to $RUN_DIR/dev.pid, then it execs npm run dev
#   stop    the recorded dev group/pid, then the sidecar daemons the app recorded
#           (its running-daemons.json registry, plus each daemon's own session
#           record <cwd>/.rysh/sessions/<name>.json) — each only after the identity
#           check below. Daemons get SIGTERM first (the session's KV flush runs on
#           SIGTERM; see the Makefile's stop note), SIGKILL only if one is wedged.
#   status  the same records, read-only
#
# THE IDENTITY CHECK, before any signal to a recorded target (E12 30a, lead batch 2 §3,
# rr-msg-310):
#   (a) kill -0 succeeds;
#   (b) its EXECUTABLE — never argv: on macOS ps comm=/command= print argv[0], which the
#       caller controls — read for that KNOWN pid: macOS, the first n line of
#       /usr/sbin/lsof -a -p <pid> -d txt -Fn; Linux, readlink /proc/<pid>/exe. It must
#       EQUAL the executable recorded at start (dev group/pid), or be a binary directly
#       inside this checkout's own sidecar dir, "$APP_ROOT/sidecar/rysh-*" (daemons;
#       APP_ROOT resolved with pwd -P). An empty or failed lookup FAILS CLOSED;
#   (c) for the dev group, ps -ww -o pgid= -p <pgid> is the recorded group itself.
# If any check fails, nothing is signalled: "stale/mismatch: skipped" with the pid only.
# Never pkill, pgrep, killall, a pattern, kill 0 or kill -1.
#
# LOCAL_RUN_SYSTEM_UTILS: every system tool this script calls (bare, or by the absolute
# path noted), by name. The static test (scripts/local/test-static-tools.sh) checks it.
# Reason (one, shared): POSIX text/file utilities: no network, no process control, act only on paths the script names
# (ps is used only for -ww -o pgid= of a known pid; lsof only as /usr/sbin/lsof -a -p <pid>
# -d txt -Fn of a known pid; both read, neither signals.)
LOCAL_RUN_SYSTEM_UTILS=(awk basename dirname head lsof mkdir ps readlink rm sed sleep sort tr)
# LOCAL_RUN_REAL_TOOLS: the one real tool outside that list, with its reason (as APP_REAL_TOOLS).
LOCAL_RUN_REAL_TOOLS=(uname)
LOCAL_RUN_REAL_TOOL_REASONS=("uname: read-only host info")
# LOCAL_RUN_LAUNCH: the dev app launcher — `make start`/`make dev` only; stop/status never run it.
LOCAL_RUN_LAUNCH=(npm)
#
# APP_ROOT is this script's own checkout (physical path). RUN_DIR is
# $APP_ROOT/.run (gitignored). The registry is the app's shared one, under the
# OS app-data dir ($HOME-based), exactly where electron/daemonRegistry.ts puts it.
set -uo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RUN_DIR="$APP_ROOT/.run"
SIDECAR_PREFIX="$APP_ROOT/sidecar/rysh-"
DEV_LOG="${DEV_LOG:-/tmp/rysh-app-dev.log}"
case "$(uname -s)" in
  Darwin) APPDATA="$HOME/Library/Application Support" ;;
  *)      APPDATA="${XDG_CONFIG_HOME:-$HOME/.config}" ;;
esac
REGISTRY="$APPDATA/rysh-cli-app-shared/running-daemons.json"
STOP_WAIT="${STOP_WAIT:-10}"   # seconds to wait after SIGTERM before SIGKILL

say() { printf '%s\n' "$*"; }

# exe_of <pid>: the EXECUTABLE of a KNOWN pid (empty when it cannot be read: fail closed)
OS_NAME="$(uname -s)"
exe_of() {
  if [[ "$OS_NAME" == Darwin ]]; then /usr/sbin/lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  else readlink "/proc/$1/exe" 2>/dev/null; fi
}
pgid_of() { ps -ww -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }
# owns_group <pid>: the pid leads its own process group (pgid == pid) — rr-msg-332's check
owns_group() { [[ -n "$1" && "$(pgid_of "$1")" == "$1" ]]; }

# ---- the dev app: recorded group (start) or pid (dev) ------------------------
# record file: line 1 = id, line 2 = its executable (exe_of) captured at start
read_record() { # <file> -> "id<TAB>command", or nothing
  [[ -f "$1" ]] || return 1
  local id cmd
  id="$(sed -n 1p "$1")"; cmd="$(sed -n 2p "$1")"
  [[ "$id" =~ ^[0-9]+$ && "$id" -gt 1 && -n "$cmd" ]] || return 1
  printf '%s\t%s\n' "$id" "$cmd"
}
# dev_alive <kind group|pid> <id> <recorded executable>: the identity check
dev_alive() {
  local kind="$1" id="$2" want="$3" exe
  kill -0 "$id" 2>/dev/null || return 1                        # (a) the leader/pid lives
  exe="$(exe_of "$id")"
  [[ -n "$exe" && "$exe" == "$want" ]] || return 2             # (b) exactly the recorded executable
  if [[ "$kind" == group ]]; then
    [[ "$(pgid_of "$id")" == "$id" ]] || return 3              # (c) it still leads the recorded group
  fi
  return 0
}
# capture <pid> <file>: wait (<= 5 s) until the pid has exec'd past its shell/env
# launcher, then record "pid + its executable"
capture() {
  local pid="$1" f="$2" c="" i=0
  while [[ "$i" -lt 50 ]]; do
    c="$(exe_of "$pid")"
    case "$(basename "${c:-x}")" in bash|sh|env|x) ;; *) break ;; esac
    sleep 0.1; i=$((i+1))
  done
  case "$(basename "${c:-x}")" in bash|sh|env|x) return 1 ;; esac
  printf '%s\n%s\n' "$pid" "$c" > "$f"
}

dev_running() { # prints what runs and returns 0 if the recorded dev app is alive and identified
  local r id cmd kind f
  for kind in group pid; do
    f="$RUN_DIR/dev.$([[ $kind == group ]] && echo pgid || echo pid)"
    r="$(read_record "$f")" || continue
    id="${r%%$'\t'*}"; cmd="${r#*$'\t'}"
    if dev_alive "$kind" "$id" "$cmd"; then printf '%s %s\n' "$kind" "$id"; return 0; fi
  done
  return 1
}

do_start() {
  mkdir -p "$RUN_DIR"
  if r="$(dev_running)"; then say "rysh app is already running (recorded $r) — use 'make restart' to relaunch."; return 0; fi
  say "Starting rysh app, detached in its own process group (logs: $DEV_LOG)..."
  set -m
  ( cd "$APP_ROOT" && exec npm run dev ) </dev/null > "$DEV_LOG" 2>&1 &
  local pg=$!
  set +m
  # rr-msg-332: VERIFY the group. Job control can fail to create one ("child setpgid … not
  # permitted"); then there is NO group of ours, and only the single pid is recorded and stopped.
  if owns_group "$pg"; then
    capture "$pg" "$RUN_DIR/dev.pgid" || { say "warning: could not record the dev group $pg"; return 1; }
    say "Started (process group $pg, verified and recorded in .run/dev.pgid). Follow logs: make logs   ·   Stop: make stop"
  else
    capture "$pg" "$RUN_DIR/dev.pid" || { say "warning: could not record the dev pid $pg"; return 1; }
    say "Started (pid $pg; NO own process group was created, so only that pid is recorded, in .run/dev.pid). Follow logs: make logs   ·   Stop: make stop"
  fi
}

do_dev() {
  mkdir -p "$RUN_DIR"
  # record this pid: after the exec below it IS npm run dev (same pid, same group)
  ( capture "$$" "$RUN_DIR/dev.pid" ) &
  cd "$APP_ROOT" && exec npm run dev
}

# stop_target <label> <kind group|pid> <id>: TERM, bounded wait, KILL — that target only
# still_ours <kind group|pid|daemon> <id> <recorded executable>: the identity check again,
# immediately before EACH signal (E12 order 30 item A addendum): dev group/pid by its recorded
# executable (+ pgid for a group), a daemon by its executable in this checkout's sidecar dir.
still_ours() { if [[ "$1" == daemon ]]; then daemon_identified "$2"; else dev_alive "$1" "$2" "$3"; fi; }
stop_target() { # <label> <kind group|pid|daemon> <id> [recorded executable]
  local label="$1" kind="$2" id="$3" want="${4:-}" t=0 tgt
  # a group target only for a group recorded AS one at start (verified then) that it still leads
  if [[ "$kind" == group ]] && owns_group "$id"; then tgt="-$id"; else tgt="$id"; fi
  if ! still_ours "$kind" "$id" "$want"; then say "  $label ($kind $id): stale/mismatch: skipped"; return 0; fi
  kill -TERM -- "$tgt" 2>/dev/null || true
  while [[ "$t" -lt "$STOP_WAIT" ]] && kill -0 -- "$tgt" 2>/dev/null; do sleep 1; t=$((t+1)); done
  if kill -0 -- "$tgt" 2>/dev/null; then
    if ! still_ours "$kind" "$id" "$want"; then say "  $label ($kind $id): identity changed after SIGTERM: SIGKILL skipped"; return 0; fi
    say "  $label ignored SIGTERM after ${STOP_WAIT}s — escalating to SIGKILL"
    kill -KILL -- "$tgt" 2>/dev/null || true
  fi
  say "  stopped $label (${kind/daemon/pid} $id)"
}

# daemon_pids: "pid" lines from the registry and each recorded daemon's session record
daemon_pids() {
  [[ -f "$REGISTRY" ]] || return 0
  awk '
    function val(line) { sub(/^[^:]*:[[:space:]]*/, "", line); sub(/,[[:space:]]*$/, "", line); gsub(/^"|"$/, "", line); return line }
    /"sessionName"[[:space:]]*:/ { s = val($0) }
    /"cwd"[[:space:]]*:/         { c = val($0) }
    /"pid"[[:space:]]*:/         { p = val($0) }
    /}/ { if (p != "") print p "\t" c "\t" s; p = ""; c = ""; s = "" }
  ' "$REGISTRY" | while IFS=$'\t' read -r p c s; do
    [[ "$p" =~ ^[0-9]+$ ]] && echo "$p"
    # the daemon's own session record, by its exact path (never a listing)
    if [[ -n "$c" && -n "$s" && -f "$c/.rysh/sessions/$s.json" ]]; then
      sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$c/.rysh/sessions/$s.json" | head -1
    fi
  done | awk '$1 > 1' | sort -un
}
daemon_identified() { # <pid>: the identity check for a pid read from a record
  local pid="$1" exe
  kill -0 "$pid" 2>/dev/null || return 1                       # (a)
  exe="$(exe_of "$pid")"                                       # (b) its executable, never argv
  case "$exe" in
    "$SIDECAR_PREFIX"*/*) return 2 ;;                          #     not directly in the sidecar dir
    "$SIDECAR_PREFIX"?*) return 0 ;;                           #     a binary in this checkout's sidecar dir
  esac
  return 2                                                     #     empty (lookup failed) or elsewhere: fail closed
}

do_stop() {
  say "Stopping rysh app..."
  local r id cmd kind f rc
  for kind in group pid; do
    f="$RUN_DIR/dev.$([[ $kind == group ]] && echo pgid || echo pid)"
    r="$(read_record "$f")" || continue
    id="${r%%$'\t'*}"; cmd="${r#*$'\t'}"
    dev_alive "$kind" "$id" "$cmd"; rc=$?
    if [[ "$rc" == 0 ]]; then stop_target "dev app" "$kind" "$id" "$cmd"
    else say "  dev app ($kind $id): stale/mismatch: skipped (check $rc)"; fi
    rm -f "$f"
  done
  local p n=0
  for p in $(daemon_pids); do
    daemon_identified "$p"; rc=$?
    if [[ "$rc" == 0 ]]; then stop_target "daemon" daemon "$p"; n=$((n+1))
    else say "  daemon pid $p: stale/mismatch: skipped (check $rc)"; fi
  done
  say "Stopped. ($n recorded daemon(s) signalled)"
}

do_status() {
  local r
  if r="$(dev_running)"; then say "dev app    : running (recorded $r)"; else say "dev app    : stopped"; fi
  local p n=0
  for p in $(daemon_pids); do daemon_identified "$p" && n=$((n+1)); done
  say "daemons    : $n running (recorded, identity-checked)"
}

case "${1:-}" in
  start)  do_start ;;
  dev)    do_dev ;;
  stop)   do_stop ;;
  status) do_status ;;
  *) echo "usage: $(basename "$0") start|dev|stop|status" >&2; exit 2 ;;
esac
