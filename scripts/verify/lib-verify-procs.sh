# lib-verify-procs.sh — sourced, never run. Liveness and stop by a RECORDED pid for the
# scripts/verify/ release checks (E12 order 30, the rest): no pattern lookup or pattern kill.
# Source scripts/lib-own-procs.sh first and set OWN_REC; every signal goes through own_signal.
#
# Where the daemon pid comes from: the app records each daemon it spawns, once that daemon is
# healthy, in <appData>/rysh-cli-app-shared/running-daemons.json (electron/sidecar.ts start()
# -> registry.record; daemonRegistry.ts writes JSON.stringify(records, null, 2), one key per
# line). The verify scripts give the app a fresh HOME, so the file is FOUND under that HOME,
# never assumed, and every record in it is a daemon this run's app spawned.
#
# Tested by scripts/local/test-verify-procs.sh (the verify scripts themselves need a Linux
# x86-64 runner).

# registry_file <home>: the one running-daemons.json under <home>; rc 1 (nothing printed) if
# there is none, or more than one (ambiguous: fail closed).
registry_file() {
  local f
  f="$(find "$1" -path '*/rysh-cli-app-shared/running-daemons.json' -type f 2>/dev/null)"
  [ -n "$f" ] || return 1
  [ "$(printf '%s\n' "$f" | wc -l | tr -d ' ')" = 1 ] || return 1
  printf '%s\n' "$f"
}

# registry_pids <file>: "pid<TAB>session" for every record, in file order. The same field
# reader as guard-live-session.sh candidates(). A pid that is not a number above 1 is dropped.
registry_pids() {
  [ -f "$1" ] || return 1
  awk '
    function val(line) { sub(/^[^:]*:[[:space:]]*/, "", line); sub(/,[[:space:]]*$/, "", line); gsub(/^"|"$/, "", line); return line }
    /"sessionName"[[:space:]]*:/ { s = val($0) }
    /"pid"[[:space:]]*:/         { p = val($0) }
    /}/ { if (p ~ /^[0-9]+$/ && p + 0 > 1) print p "\t" s; p = ""; s = "" }
  ' "$1"
}

# registry_pid <file> <session|*>: the pid recorded for <session>, or for the ONLY record when
# <session> is '*'. rc 1, nothing printed, unless exactly one record matches.
registry_pid() {
  local out
  out="$(registry_pids "$1" | awk -F'\t' -v want="$2" 'want == "*" || $2 == want { print $1 }')" || return 1
  [ -n "$out" ] && [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] || return 1
  printf '%s\n' "$out"
}

# wait_registry_pid <home> <session|*> <seconds> [app pid]: wait until the app has recorded the
# daemon; print its pid. rc 1 on timeout; rc 2 at once when the app pid (if given) is gone.
wait_registry_pid() {
  local home="$1" sess="$2" n="$3" app="${4:-}" i=0 f p
  while [ "$i" -lt "$n" ]; do
    if f="$(registry_file "$home")" && p="$(registry_pid "$f" "$sess")"; then printf '%s\n' "$p"; return 0; fi
    if [ -n "$app" ] && ! kill -0 "$app" 2>/dev/null; then return 2; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

# daemon_record <pid> <exe>: own_record the pid only if its EXECUTABLE (never argv) is <exe>,
# an absolute path or a basename. Otherwise nothing is recorded and rc is 1.
daemon_record() {
  local pid="$1" want="$2" exe
  exe="$(own_exe "$pid")"
  [ -n "$exe" ] || { echo "verify: pid $pid NOT recorded (executable unreadable or gone)"; return 1; }
  case "$want" in
    /*) [ "$exe" = "$want" ] ;;
    *)  [ "$(basename "$exe")" = "$want" ] ;;
  esac || { echo "verify: pid $pid NOT recorded (executable $exe is not $want)"; return 1; }
  own_record "$pid" --now
}

# stop_own <pid> [group] [seconds]: SIGTERM the recorded pid (its group, if it leads one we
# recorded), wait up to <seconds> (default 10), then SIGKILL what is left, and forget it. Every
# signal goes through own_signal, so a pid that is not recorded, gone or changed is skipped
# (rc 1, nothing sent). Group members left behind after their leader exited are not signalled.
stop_own() {
  local pid="$1" grp="${2:-}" n="${3:-10}" i=0
  own_signal TERM "$pid" "$grp" || return 1
  while [ "$i" -lt "$n" ]; do
    if [ -n "$grp" ]; then kill -0 -- "-$pid" 2>/dev/null || break
    else kill -0 "$pid" 2>/dev/null || break; fi
    sleep 1; i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then own_signal KILL "$pid" "$grp" || true; fi
  if [ -n "$grp" ] && ! kill -0 "$pid" 2>/dev/null && kill -0 -- "-$pid" 2>/dev/null; then
    echo "verify: group $pid still has members after its leader exited; they are not signalled"
  fi
  own_forget "$pid"
}
