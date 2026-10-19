// electron-builder afterPack hook (E-94): put resources/linux/launcher.sh in
// front of the Linux Electron binary.
//
// Why a hook and not a custom AppRun: electron-builder 25.1.8 has no option for
// one. Its AppImage target runs app-builder, which generates AppRun from a
// built-in template; app-builder's own --template flag is reachable only through
// the CUSTOM_APP_BUILDER_PATH env var, which the release workflow would have to
// set — and electron-builder 26 drops app-builder for AppImage entirely. AppRun
// always ends in `exec "$APPDIR/<executableName>"`, so owning that file is the
// one interception point that holds across both versions and needs no workflow
// change.
//
// afterPack runs once per platform/arch, on the unpacked dir every Linux target
// is built from, so the .deb gets the launcher too. It is a pass-through there
// (the check only runs inside an AppImage), and the .deb's AppArmor profile
// attaches to the real binary, rysh-desktop.bin.
const fs = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return

  const exe = context.packager.executableName
  const appBin = path.join(context.appOutDir, exe)
  const realBin = `${appBin}.bin`
  const launcher = path.join(context.packager.info.projectDir, 'resources', 'linux', 'launcher.sh')

  // Idempotent: a re-run on an already-wrapped dir must not wrap the launcher.
  if (!fs.existsSync(realBin)) fs.renameSync(appBin, realBin)
  fs.copyFileSync(launcher, appBin)
  fs.chmodSync(appBin, 0o755)
  console.log(`  • E-94 launcher installed  ${appBin} -> ${path.basename(realBin)}`)
}
