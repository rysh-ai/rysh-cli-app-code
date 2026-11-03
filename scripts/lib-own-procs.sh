# lib-own-procs.sh — sourced, never run. Signal a process ONLY while it is still the one we
# started (E12 order 30 item A addendum; rr-msg-310 identity rule).
#
# A pid number is reused once its process has exited and been reaped, so `kill -0 <pid>`
# alone proves nothing about WHICH process now holds it. Every caller therefore:
#   1. own_record <pid>  right after starting it: stores its EXECUTABLE (macOS: first n
#      line of /usr/sbin/lsof -a -p <pid> -d txt -Fn; Linux: readlink /proc/<pid>/exe —
#      never argv) and its pgid in $OWN_REC (a file the caller names, in its own scratch);
#   2. own_signal <TERM|KILL> <pid> [group]  to stop it: sends the signal only if the pid is
#      recorded, alive, and its executable AND pgid still equal the recorded values;
#      otherwise it skips, sends nothing, and logs the pid. Every send and skip is logged
#      ("own: sent …" / "own: skipped …") on stdout;
#      GROUP signals (rr-msg-332): own_record also records whether the pid LEADS ITS OWN
#      group (pgid == pid at record time; job control can fail to create one — "child
#      setpgid … Operation not permitted"). A group signal is sent only when that recorded
#      flag is 1 AND it still leads the group (own_owns_group); otherwise ONLY the single
#      pid is signalled, and that fallback is logged. Never a group id we did not create;
#   3. own_forget <pid>  as soon as the pid is stopped and reaped (so it can never be
#      signalled again);
#   4. own_cleanup  at exit: own_signal KILL to whatever is still recorded, then forgets it.
# An unreadable identity fails closed: nothing is recorded or sent.
#
# OWN_SYSTEM_UTILS: the system tools this file calls (bare, or by the absolute path noted).
# Reason (one, shared): POSIX text/file utilities: no network, no process control, act only on paths the script names
# (lsof only as /usr/sbin/lsof -a -p <pid> -d txt -Fn of a known pid; ps only as ps -ww -o pgid= -p <pid>.)
OWN_SYSTEM_UTILS=(awk basename cut head lsof mv ps readlink sed sleep tr)
OWN_REAL_TOOLS=(uname)
OWN_REAL_TOOL_REASONS=("uname: read-only host info")

own_exe() { # <pid> -> its executable, empty when unreadable
  if [[ "$(uname -s)" == Darwin ]]; then /usr/sbin/lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  else readlink "/proc/$1/exe" 2>/dev/null; fi
}
own_pgid() { ps -ww -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }

own_record() { # <pid> [--now]: store "pid<TAB>exe<TAB>pgid" in $OWN_REC; refuse if unreadable.
  # Without --now it first waits (<= 2 s) until the pid has exec'd past a launcher
  # (bash/sh/env/dash, or setsid, which execs its command), so the executable recorded is the
  # program itself.
  local pid="$1" now="${2:-}" exe pg i=0
  exe="$(own_exe "$pid")"
  if [[ "$now" != --now ]]; then
    while [[ "$i" -lt 20 ]]; do
      case "$(basename "${exe:-bash}")" in bash|sh|env|dash|setsid) ;; *) break ;; esac
      sleep 0.1; i=$((i + 1)); exe="$(own_exe "$pid")"
    done
  fi
  pg="$(own_pgid "$pid")"
  if [[ -z "${OWN_REC:-}" || -z "$exe" || -z "$pg" ]]; then echo "own: pid $pid NOT recorded (identity unreadable)"; return 1; fi
  own_forget "$pid"
  printf '%s\t%s\t%s\t%s\n' "$pid" "$exe" "$pg" "$([[ "$pg" == "$pid" ]] && echo 1 || echo 0)" >> "$OWN_REC"
}
own_owns_group() { # <pid>: the RECORDED owns-group flag is 1 and the pid still leads its group
  local pid="$1" rec
  [[ -n "${OWN_REC:-}" && -f "$OWN_REC" ]] || return 1
  rec="$(awk -F'\t' -v p="$pid" '$1 == p' "$OWN_REC" | head -1)"
  [[ "$(printf '%s\n' "$rec" | cut -f4)" == 1 && "$(own_pgid "$pid")" == "$pid" ]]
}
own_forget() { # <pid>: drop it from $OWN_REC
  local pid="$1"
  [[ -n "${OWN_REC:-}" && -f "$OWN_REC" ]] || return 0
  awk -F'\t' -v p="$pid" '$1 != p' "$OWN_REC" > "$OWN_REC.new" && mv "$OWN_REC.new" "$OWN_REC"
}
own_identity_ok() { # <pid>: recorded, alive, same executable AND same pgid as recorded
  local pid="$1" rec
  [[ -n "${OWN_REC:-}" && -f "$OWN_REC" ]] || return 1
  rec="$(awk -F'\t' -v p="$pid" '$1 == p' "$OWN_REC" | head -1)"
  [[ -n "$rec" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ "$(own_exe "$pid")" == "$(printf '%s\n' "$rec" | cut -f2)" ]] || return 1
  [[ "$(own_pgid "$pid")" == "$(printf '%s\n' "$rec" | cut -f3)" ]] || return 1
}
own_signal() { # <TERM|KILL> <pid> [group]: signal it (or the group it leads) only if still ours
  local sig="$1" pid="$2" grp="${3:-}" tgt
  if ! own_identity_ok "$pid"; then echo "own: skipped pid $pid (not recorded, gone, or identity changed)"; return 1; fi
  tgt="$pid"
  if [[ -n "$grp" ]]; then
    if own_owns_group "$pid"; then tgt="-$pid"
    else echo "own: pid $pid owns no process group of ours; signalling the pid only"; grp=""; fi
  fi
  case "$sig" in
    TERM) kill -TERM -- "$tgt" 2>/dev/null ;;
    KILL) kill -KILL -- "$tgt" 2>/dev/null ;;
    *) echo "own: refused signal '$sig' (TERM or KILL only)"; return 1 ;;
  esac
  echo "own: sent SIG$sig to ${grp:+group }$pid"
}
own_cleanup() { # at exit: KILL whatever is still recorded (each identity-checked), then forget it
  local pid
  [[ -n "${OWN_REC:-}" && -f "$OWN_REC" ]] || return 0
  for pid in $(cut -f1 "$OWN_REC"); do own_signal KILL "$pid"; own_forget "$pid"; done
}
