#!/usr/bin/env bash
# Rasterise the app and tray icons from their SVG sources in resources/.
#
# The SVGs are the source of truth; every PNG/ICNS/ICO below is generated and
# checked in so that CI (and `npm run package` on a machine without rsvg) never
# needs this script. Re-run it after editing any resources/*.svg.
#
# Requires: rsvg-convert (brew install librsvg), iconutil (macOS), magick
# (brew install imagemagick, only for the parked Windows .ico).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RES="$(dirname "$SCRIPT_DIR")/resources"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: $1 not found. $2" >&2
    exit 1
  }
}

need rsvg-convert "brew install librsvg"

# Render straight from the SVG at each target size rather than downscaling one
# big PNG — at 16px the difference between the two is the difference between a
# legible glyph and mush.
render() { # <svg> <size> <out>
  rsvg-convert -w "$2" -h "$2" "$1" -o "$3"
}

# ── macOS app icon (.icns) ───────────────────────────────────────────────────
echo "==> icon.icns"
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  render "$RES/icon.svg" "$size"           "$ICONSET/icon_${size}x${size}.png"
  render "$RES/icon.svg" "$((size * 2))"   "$ICONSET/icon_${size}x${size}@2x.png"
done
need iconutil "This script must run on macOS to build the .icns."
iconutil -c icns "$ICONSET" -o "$RES/icon.icns"
rm -rf "$(dirname "$ICONSET")"

# ── Linux app icon ───────────────────────────────────────────────────────────
# electron-builder wants a single PNG of at least 512x512 for AppImage/deb.
echo "==> icon.png"
render "$RES/icon.svg" 1024 "$RES/icon.png"

# ── Tray icons ───────────────────────────────────────────────────────────────
# macOS: "Template" suffix is the documented signal that the image should be
# recoloured by the system; Electron honours it, and we also set it explicitly
# in menuManager.ts so the behaviour does not hinge on a filename.
echo "==> tray icons"
render "$RES/tray-icon-template.svg" 16 "$RES/tray-iconTemplate.png"
render "$RES/tray-icon-template.svg" 32 "$RES/tray-iconTemplate@2x.png"
render "$RES/tray-icon-color.svg"    22 "$RES/tray-icon.png"
render "$RES/tray-icon-color.svg"    44 "$RES/tray-icon@2x.png"

# ── Windows icon (parked) ────────────────────────────────────────────────────
# Windows is not a shipping target — rysh-cli has PTYSupported=false there, so
# the app would launch and fail to open a single pane (see docs/RELEASE-PLAN.md).
# The .ico is generated anyway so that re-enabling the target is a one-line
# change in electron-builder.yml rather than an asset hunt.
if command -v magick >/dev/null 2>&1; then
  echo "==> icon.ico (parked target)"
  TMP="$(mktemp -d)"
  for size in 16 24 32 48 64 128 256; do
    render "$RES/icon.svg" "$size" "$TMP/$size.png"
  done
  magick "$TMP"/16.png "$TMP"/24.png "$TMP"/32.png "$TMP"/48.png \
         "$TMP"/64.png "$TMP"/128.png "$TMP"/256.png "$RES/icon.ico"
  rm -rf "$TMP"
else
  echo "==> skipping icon.ico (magick not installed)"
fi

echo ""
echo "==> Done."
ls -lh "$RES"/icon.icns "$RES"/icon.png "$RES"/icon.ico "$RES"/tray-icon*.png 2>/dev/null || true
