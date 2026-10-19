#!/bin/bash
#
# .deb postrm for rysh-desktop (E-92). Replaces electron-builder 25.1.8's
# templates/linux/after-remove.tpl (kept below) and also removes the AppArmor
# profile after-install.tpl may have installed.
#
# NOTE: electron-builder substitutes dollar-brace macros (executable, sanitizedProductName, …) in this file and aborts on
# unknown ones, so shell variables here are written without braces.

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# The profile only goes on a real removal; on "upgrade" the new postinst
# replaces it, and unloading in between would leave the new binary unconfined
# by the userns rule for no reason.
case "$1" in
    remove|purge)
        APPARMOR_DST='/etc/apparmor.d/${executable}'
        if [ -f "$APPARMOR_DST" ]; then
            if hash apparmor_parser 2>/dev/null && [ -d /sys/kernel/security/apparmor ]; then
                apparmor_parser --remove "$APPARMOR_DST" >/dev/null 2>&1 || true
            fi
            rm -f "$APPARMOR_DST"
        fi
        ;;
esac
