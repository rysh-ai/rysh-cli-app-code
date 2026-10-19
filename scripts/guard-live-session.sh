#!/bin/bash
# Refuse to stop a sidecar daemon that is serving a session full of live panes.
#
# WHY THIS EXISTS
#
# `make stop` matches daemons by this app's sidecar path
# ($(APP_ROOT)/sidecar/[r]ysh-). That is deliberately narrow — it never touches
# the user's own `rysh`/`ry` CLI sessions — but it is not narrow enough, because
# the founder's working session is spawned from exactly that binary. So a `make
# stop` or `make restart` run to rebuild the app also kills the session the
# fleets are living in, from the inside.
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
# one word away.

set -u

APP_ROOT="${APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# A daemon is "busy" above this many panes. A dev instance opens 1; the founder's
# session was at 54 when this was written. Anything in between is a judgement
# call the human should make, which is what the refusal asks for.
LIVE_PANE_LIMIT="${LIVE_PANE_LIMIT:-3}"

if [ "${FORCE:-}" = "1" ]; then
  exit 0
fi

pids=$(pgrep -f "$APP_ROOT/sidecar/[r]ysh-" 2>/dev/null)
[ -z "$pids" ] && exit 0

busy=""
for pid in $pids; do
  # Pane count via pty (CHR) descriptors: the daemon holds one master per pane,
  # whether or not an agent is running in it. Read from the OS rather than by
  # asking the daemon, because the guard has to work on a daemon that is wedged —
  # which is the case where someone is most likely to reach for `make stop`.
  panes=$(lsof -p "$pid" 2>/dev/null | grep -c CHR)
  [ "$panes" -le "$LIVE_PANE_LIMIT" ] && continue
  # The session name is the argument after `daemon` on the command line.
  session=$(ps -o command= -p "$pid" 2>/dev/null | sed -n 's/.* daemon \([^ ]*\).*/\1/p')
  busy="${busy}    pid ${pid}  session ${session:-?}  ${panes} panes"$'\n'
done

[ -z "$busy" ] && exit 0

cat >&2 <<EOF

REFUSING to stop: this app's sidecar is serving a session with live panes.

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
