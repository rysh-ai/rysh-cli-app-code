#!/bin/bash
#
# .deb postinst for rysh-desktop (E-92). Replaces electron-builder 25.1.8's
# templates/linux/after-install.tpl, so it keeps everything that one does
# (update-alternatives link, mime + desktop databases) and changes how the
# Chromium sandbox is set up.
#
# Why the default is wrong on Ubuntu 24.04: it decides between the SUID helper
# and user namespaces with `unshare --user true` — but postinst runs as ROOT,
# and AppArmor's kernel.apparmor_restrict_unprivileged_userns=1 only restricts
# UNprivileged users. The probe succeeds, chrome-sandbox is left 0755, and the
# app then dies for every normal user with "The SUID sandbox helper binary was
# found, but is not configured correctly" (exit 133; run 37132842420).
#
# The fix, the same two layers Chrome and VS Code ship:
#   1. an AppArmor profile that grants this binary `userns`, so the namespace
#      sandbox works on 24.04 (skipped where AppArmor or abi/4.0 is absent,
#      e.g. 22.04, which does not need it);
#   2. chrome-sandbox root:root 4755 unconditionally, so the SUID sandbox is a
#      working fallback wherever namespaces are still refused.
# Neither path disables the sandbox.
#
# NOTE: electron-builder substitutes dollar-brace macros (executable, sanitizedProductName, …) in this file and aborts on
# unknown ones, so shell variables here are written without braces.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Layer 2 — SUID fallback. dpkg unpacks the file as root already; set both so a
# repacked or hand-installed tree cannot leave it user-owned.
chown root:root '/opt/${sanitizedProductName}/chrome-sandbox' || true
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

# Layer 1 — AppArmor profile (Ubuntu 23.10+). Dry-run parse first: 22.04's
# AppArmor has no abi/4.0 and would reject the profile, and there the app runs
# fine without one, so skip rather than fail the install.
APPARMOR_SRC='/opt/${sanitizedProductName}/resources/apparmor-profile'
APPARMOR_DST='/etc/apparmor.d/${executable}'
if hash apparmor_parser 2>/dev/null && [ -f "$APPARMOR_SRC" ] && [ -d /etc/apparmor.d ]; then
    if apparmor_parser --skip-kernel-load --debug "$APPARMOR_SRC" >/dev/null 2>&1; then
        cp -f "$APPARMOR_SRC" "$APPARMOR_DST"
        # Do not load into the kernel from a chroot (image builds); the profile
        # is picked up at next boot there.
        if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } && [ -d /sys/kernel/security/apparmor ]; then
            apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_DST" || true
        fi
    else
        echo "rysh-desktop: this AppArmor does not support the bundled profile (abi/4.0); skipping it"
    fi
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
