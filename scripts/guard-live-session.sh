#!/bin/bash
# Refuse to stop a sidecar daemon that is serving a session full of live panes.
#
# WHY THIS EXISTS
#
# `make stop` stops the sidecar daemons this app recorded (scripts/local-run.sh).
# The founder's working session can be one of them: it is spawned from exactly
# this app's sidecar binary. So a `make stop` or `make restart` run to rebuild the
# app can kill the session the fleets are living in, from the inside.
#
# This is not hypothetical and it is not rare. Agent transcripts on this machine
# record 51 executed `make stop` / `make restart` calls across 16 different
# agent sessions between 2026-08-12 and 2026-08-15 — every one of them, when run
# from the main rysh-cli-app checkout, a SIGTERM to a daemon carrying dozens of
# agent panes. That is the largest single source of the "the daemon keeps
# restarting and I don't know why" report: the supervisor logs a bare
# `code=0`/`SIGKILL` and nothing anywhere records who asked.
#
# It also explains why the restarts looked causeless. An agent rebuilding the
# desktop app has no reason to think it is touching the founder's session, and
# the Makefile gave it no way to find out. (A known backlog item, F-50, is
# the same shape one layer down: an agent inside a pane killed the NATS bus its
# own session was riding on.)
#
# WHAT IT DOES NOT DO
#
# It does not protect a normal dev loop. A freshly started dev session has one
# or two panes and passes silently. The guard trips only when the daemon is
# carrying real work, which is exactly when a stop is a surprise rather than a
# step. FORCE=1 always proceeds, because "I really do mean this one" has to stay
# one word away (the existing override, kept exactly; since E12 order 30 item A its
# use is logged on stderr). It never signals anything.
#
# HOW IT FINDS DAEMONS (E12 order 30 item A; no pattern lookup)
#
# Candidates are exactly the daemons `make stop` could stop: the pids in the app's
# running-daemons.json registry, plus each recorded daemon's own session record
# (<cwd>/.rysh/sessions/<name>.json, read by its exact path). For each candidate:
#   - dead (kill -0 fails)                              -> dropped;
#   - alive, EXECUTABLE read and inside this checkout's
#     physical sidecar/ dir                             -> ours: count its panes;
#   - alive, EXECUTABLE read and anywhere else          -> not ours: dropped;
#   - alive, executable NOT readable (empty/failed)     -> UNVERIFIED: REFUSE.
# The executable is the first n line of /usr/sbin/lsof -a -p <pid> -d txt -Fn on
# macOS, readlink /proc/<pid>/exe on Linux — never argv (ps comm=/command= print
# argv[0], which the caller controls). A guard fails closed by REFUSING the stop:
# an unreadable pid, or an unreadable pane count for one of ours, blocks it,
# naming the pid only.
#
# GUARD_SYSTEM_UTILS: every system tool this script calls (bare, or by the absolute
# path noted), by name. The static test (scripts/local/test-static-tools.sh) checks it.
# Reason (one, shared): POSIX text/file utilities: no network, no process control, act only on paths the script names
# (lsof is used only as /usr/sbin/lsof -a -p <pid> ... of a known pid; it reads, never signals.)
GUARD_SYSTEM_UTILS=(awk basename cat dirname grep head lsof readlink sed)
# GUARD_REAL_TOOLS: the one real tool outside that list, with its reason (as APP_REAL_TOOLS).
GUARD_REAL_TOOLS=(uname)
GUARD_REAL_TOOL_REASONS=("uname: read-only host info")

set -u

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SIDECAR_DIR="$APP_ROOT/sidecar"
# A daemon is "busy" above this many panes. A dev instance opens 1; the founder's
# session was at 54 when this was written. Anything in between is a judgement
# call the human should make, which is what the refusal asks for.
LIVE_PANE_LIMIT="${LIVE_PANE_LIMIT:-3}"
case "$(uname -s)" in
  Darwin) OS_NAME=Darwin; APPDATA="$HOME/Library/Application Support" ;;
  *)      OS_NAME=other;  APPDATA="${XDG_CONFIG_HOME:-$HOME/.config}" ;;
esac
REGISTRY="$APPDATA/rysh-cli-app-shared/running-daemons.json"

if [ "${FORCE:-}" = "1" ]; then
  echo "guard-live-session: FORCE=1 set — live-session check skipped" >&2
  exit 0
fi

# exe_of <pid>: the EXECUTABLE of a known pid; empty when it cannot be read
exe_of() {
  if [ "$OS_NAME" = Darwin ]; then /usr/sbin/lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  else readlink "/proc/$1/exe" 2>/dev/null; fi
}

# candidates: "pid<TAB>session" from the registry and each recorded daemon's session record
candidates() {
  [ -f "$REGISTRY" ] || return 0
  awk '
    function val(line) { sub(/^[^:]*:[[:space:]]*/, "", line); sub(/,[[:space:]]*$/, "", line); gsub(/^"|"$/, "", line); return line }
    /"sessionName"[[:space:]]*:/ { s = val($0) }
    /"cwd"[[:space:]]*:/         { c = val($0) }
    /"pid"[[:space:]]*:/         { p = val($0) }
    /}/ { if (p != "") print p "\t" c "\t" s; p = ""; c = ""; s = "" }
  ' "$REGISTRY" | while IFS=$'\t' read -r p c s; do
    case "$p" in ''|*[!0-9]*) ;; *) printf '%s\t%s\n' "$p" "$s" ;; esac
    if [ -n "$c" ] && [ -n "$s" ] && [ -f "$c/.rysh/sessions/$s.json" ]; then
      sp="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$c/.rysh/sessions/$s.json" | head -1)"
      [ -n "$sp" ] && printf '%s\t%s\n' "$sp" "$s"
    fi
  done | awk -F'\t' '$1 > 1 && !seen[$1]++'
}

busy=""
while IFS=$'\t' read -r pid session; do
  [ -n "$pid" ] || continue
  kill -0 "$pid" 2>/dev/null || continue                       # dead: dropped
  exe="$(exe_of "$pid")"
  if [ -z "$exe" ]; then                                       # alive but unverifiable: refuse
    busy="${busy}    pid ${pid}  session ${session:-?}  executable unreadable (cannot verify; refusing)"$'\n'
    continue
  fi
  case "$exe" in
    "$SIDECAR_DIR"/*/*) continue ;;                            # not directly in sidecar/: not ours
    "$SIDECAR_DIR"/?*) ;;                                      # ours
    *) continue ;;                                             # elsewhere: not ours
  esac
  # Pane count via pty (CHR) descriptors: the daemon holds one master per pane,
  # whether or not an agent is running in it. Read from the OS rather than by
  # asking the daemon, because the guard has to work on a daemon that is wedged —
  # which is the case where someone is most likely to reach for `make stop`.
  fds="$(/usr/sbin/lsof -p "$pid" 2>/dev/null)"
  if [ -z "$fds" ]; then                                       # ours, pane count unreadable: refuse
    busy="${busy}    pid ${pid}  session ${session:-?}  pane count unreadable (refusing)"$'\n'
    continue
  fi
  panes=$(printf '%s\n' "$fds" | grep -c CHR)
  [ "$panes" -le "$LIVE_PANE_LIMIT" ] && continue
  busy="${busy}    pid ${pid}  session ${session:-?}  ${panes} panes"$'\n'
done < <(candidates)

[ -z "$busy" ] && exit 0

cat >&2 <<EOF

REFUSING to stop: this app's sidecar is serving a session with live panes
(or a recorded daemon could not be verified).

$busy
Stopping it kills that session and every agent in it. If you are rebuilding the
app, you are almost certainly not trying to do that — see the note at the top of
$(basename "${BASH_SOURCE[0]}").

  - Rebuilding the sidecar?   make build-sidecar   (does not touch the daemon)
  - Only need the UI back?    restart the renderer, not the daemon
  - Working on the app?       do it in a worktree; its APP_ROOT differs, so
                              stop/restart there never match this daemon
  - Really mean it?           FORCE=1 make stop

EOF
exit 1
