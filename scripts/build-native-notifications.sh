#!/bin/bash
# Build the macOS notification shim (src/native/macos/dev3-notifications.m)
# into dist/native/dev3-notifications.dylib.
#
# The shim owns UNUserNotificationCenter posting + the click delegate — see the
# header comment in the .m file and decisions/106-native-notification-click-shim.md.
#
# On Linux (and on macOS without clang) this produces an empty dist/native/ so
# the electrobun.config.ts copy rule always has a source; the app degrades to
# the focus-proxy fallback at runtime when the dylib is absent.
#
# Signing mirrors scripts/sign-cli-binaries.sh: ad-hoc by default (enough for
# AMFI on dev machines), Developer ID when ELECTROBUN_DEVELOPER_ID is set.

set -euo pipefail

OUT_DIR="dist/native"
OUT="${OUT_DIR}/dev3-notifications.dylib"
SRC="src/native/macos/dev3-notifications.m"

mkdir -p "$OUT_DIR"

if [ "$(uname)" != "Darwin" ]; then
  exit 0
fi

if ! command -v clang >/dev/null 2>&1; then
  echo "[build-native-notifications] clang not found — skipping (notification clicks fall back to focus-proxy)"
  exit 0
fi

# Universal binary: release artifacts ship both arm64 and x64 macOS builds.
clang -dynamiclib -fobjc-arc -O2 \
  -mmacosx-version-min=11.0 \
  -arch arm64 -arch x86_64 \
  -framework Foundation -framework UserNotifications \
  -o "$OUT" "$SRC"

if command -v codesign >/dev/null 2>&1; then
  codesign --remove-signature "$OUT" 2>/dev/null || true
  if [ -n "${ELECTROBUN_DEVELOPER_ID:-}" ]; then
    codesign --force --verbose --timestamp \
      --sign "$ELECTROBUN_DEVELOPER_ID" \
      --options runtime \
      "$OUT"
    echo "[build-native-notifications] Developer ID signed: $OUT"
  else
    codesign --force --sign - "$OUT"
    echo "[build-native-notifications] ad-hoc signed: $OUT"
  fi
fi

echo "[build-native-notifications] built: $OUT"
