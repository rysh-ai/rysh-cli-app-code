#!/usr/bin/env bash
# lib-t2-box2.sh — the BOX 2 verdict of e12-t2-linux-smoke.sh, as a function so it can be
# tested without launching the app (scripts/verify/t2-box2.test.ts).
#
#   t2_box2_verdict <alive 0|1> <renderer text (CDP)> <fresh HOME>
#     prints "CHECKED <evidence>" or "FAILED <evidence>"; returns 0 / 1.
#
# First-run state since E-90 (founder ruling R8, faad2e7, 2026-10-08): with no last and no
# recent workspace, the app creates ~/rysh-workspace and opens it, so a pane works with no
# CLI and no dialog. The box therefore requires all three:
#   - the process is alive;
#   - the renderer's workspace label is rysh-workspace ("ws:" then the name — the
#     innerText is JSON-quoted, so the newline between them is a literal \n);
#   - <fresh HOME>/rysh-workspace exists: the app made it under the empty HOME the box
#     set up, which is what proves this was a first launch and not a reopened profile.
# The old welcome screen ("No workspace loaded") on a first run now means E-90 did not
# happen, so it FAILS (it was the pass condition before E-90).
t2_box2_verdict() {
  local alive="$1" rt="$2" home="$3"
  local text; text="$(echo "$rt" | grep '^innerText' | cut -c1-200)"
  if [ "$alive" != 1 ]; then
    echo "FAILED alive=$alive; renderer: $(echo "$rt" | tr '\n' ' ' | cut -c1-300)"; return 1
  fi
  if echo "$rt" | grep -q 'No workspace loaded'; then
    echo "FAILED welcome screen on a first run: E-90 (open ~/rysh-workspace) did not happen; $text"; return 1
  fi
  if ! echo "$rt" | grep -qF 'ws:\nrysh-workspace\n'; then
    echo "FAILED renderer does not show the default workspace rysh-workspace (a reopened profile?); $text"; return 1
  fi
  if [ -z "$home" ] || [ ! -d "$home/rysh-workspace" ]; then
    echo "FAILED renderer shows rysh-workspace but $home/rysh-workspace was not created under the fresh HOME; $text"; return 1
  fi
  echo "CHECKED process alive; E-90 first run: created and opened $home/rysh-workspace; $text"
  return 0
}
