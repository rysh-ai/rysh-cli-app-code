#!/bin/sh
#
# rysh-desktop launcher (E-94). Installed by scripts/build/after-pack-linux-launcher.cjs
# as <app>/rysh-desktop, in front of the real Electron binary, which it moves to
# <app>/rysh-desktop.bin. Both Linux targets carry it:
#
#   .deb       /usr/bin/rysh-desktop -> /opt/Rysh/rysh-desktop (this) -> rysh-desktop.bin
#   AppImage   AppRun -> $APPDIR/rysh-desktop (this) -> rysh-desktop.bin
#
# Why it exists: on Ubuntu 23.10+ (kernel.apparmor_restrict_unprivileged_userns=1)
# Chromium's namespace sandbox is refused, and an AppImage cannot carry the
# setuid chrome-sandbox that is the fallback (it is mounted/extracted as the
# user). Chromium then aborts with a FATAL nobody can act on. This launcher sees
# that case coming and explains it instead. It never disables the sandbox: it
# only steps aside when the user passed --no-sandbox themselves.
#
# Exit status 78 (EX_CONFIG, sysexits.h) = "this system cannot run the sandbox
# for this package". Any other status comes from the app itself.
#
# Escape hatch: RYSH_SKIP_SANDBOX_CHECK=1 skips the check (it does NOT disable
# the sandbox) — for a user who has given the AppImage its own AppArmor profile.

HERE=$(dirname "$(readlink -f "$0")")
BIN="$HERE/rysh-desktop.bin"
EX_SANDBOX_UNAVAILABLE=78

# The .deb sets chrome-sandbox setuid root and ships an AppArmor profile, so the
# check is for AppImages only. AppRun's runtime exports APPIMAGE.
if [ -n "$APPIMAGE" ] && [ "$RYSH_SKIP_SANDBOX_CHECK" != "1" ]; then
  # RYSH_USERNS_RESTRICT_SYSCTL exists for scripts/verify/linux-launcher.test.ts;
  # it can only point the read elsewhere, never skip the sandbox.
  restricted=$(cat "${RYSH_USERNS_RESTRICT_SYSCTL:-/proc/sys/kernel/apparmor_restrict_unprivileged_userns}" 2>/dev/null)
  sandbox="$HERE/chrome-sandbox"
  suid_ok=0
  if [ -u "$sandbox" ] && [ "$(stat -c %u "$sandbox" 2>/dev/null)" = "0" ]; then suid_ok=1; fi
  user_no_sandbox=0
  # Stop at `--`, as Chromium does: the desktop entries pass `-- %U` (E-95), and
  # anything after it is a positional argument, not a switch.
  for a in "$@"; do
    [ "$a" = "--" ] && break
    [ "$a" = "--no-sandbox" ] && user_no_sandbox=1
  done

  if [ "$restricted" = "1" ] && [ "$suid_ok" = "0" ] && [ "$user_no_sandbox" = "0" ]; then
    # Last word goes to the kernel: if this user may create a user namespace
    # AND use capabilities inside it (what Chromium needs, and what the
    # restriction removes), something — e.g. an AppArmor profile the user
    # installed — already permits it, so launch normally.
    if command -v unshare >/dev/null 2>&1 && unshare --user --map-root-user --mount true 2>/dev/null; then
      :
    else
      msg="Rysh cannot start from this AppImage on this system.

This Linux restricts the user namespaces that the app's security sandbox needs (kernel.apparmor_restrict_unprivileged_userns=1, the default on Ubuntu 23.10 and later), and an AppImage cannot carry the helper that works around it.

Please install the .deb package from https://rysh.ai/download instead."
      echo "rysh-desktop: $msg" >&2
      echo "rysh-desktop: exiting with status $EX_SANDBOX_UNAVAILABLE (sandbox unavailable)" >&2
      # The AppImage runtime points LD_LIBRARY_PATH into the image; system
      # dialog tools must not load those libraries.
      if command -v zenity >/dev/null 2>&1; then
        echo "rysh-desktop: dialog: zenity" >&2
        LD_LIBRARY_PATH="" zenity --error --title="Rysh" --no-wrap --text="$msg" 2>/dev/null
      elif command -v kdialog >/dev/null 2>&1; then
        echo "rysh-desktop: dialog: kdialog" >&2
        LD_LIBRARY_PATH="" kdialog --title "Rysh" --error "$msg" 2>/dev/null
      elif command -v notify-send >/dev/null 2>&1; then
        echo "rysh-desktop: dialog: notify-send" >&2
        LD_LIBRARY_PATH="" notify-send --urgency=critical "Rysh cannot start" "$msg" 2>/dev/null
      else
        echo "rysh-desktop: dialog: none available (stderr only)" >&2
      fi
      exit $EX_SANDBOX_UNAVAILABLE
    fi
  fi
fi

exec "$BIN" "$@"
