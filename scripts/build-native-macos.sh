#!/bin/bash
# Build the macOS native shims in src/native/macos/ into dist/native/*.dylib:
#   • dev3-notifications — UNUserNotificationCenter posting + click delegate
#     (decisions/2026/07/05/native-notification-click-shim.md);
#   • dev3-window-menu   — registers the Window menu as NSApp.windowsMenu
#     (decisions/2026/10/06/register-native-windows-menu.md).
#
# On Linux (and on macOS without clang) this produces an empty dist/native/ so
# the electrobun.config.ts copy rule always has a source; each shim's loader
# degrades gracefully when its dylib is absent.
#
# Signing mirrors scripts/sign-cli-binaries.sh: ad-hoc by default (enough for
# AMFI on dev machines), Developer ID when ELECTROBUN_DEVELOPER_ID is set.

set -euo pipefail

OUT_DIR="dist/native"
mkdir -p "$OUT_DIR"

if [ "$(uname)" != "Darwin" ]; then
  exit 0
fi

if ! command -v clang >/dev/null 2>&1; then
  echo "[build-native-macos] clang not found — skipping (no click callback, no native Window menu items)"
  exit 0
fi

build_shim() {
  local name="$1" frameworks="$2"
  local src="src/native/macos/${name}.m"
  local out="${OUT_DIR}/${name}.dylib"

  # Universal binary: release artifacts ship both arm64 and x64 macOS builds.
  # shellcheck disable=SC2086
  clang -dynamiclib -fobjc-arc -O2 \
    -mmacosx-version-min=11.0 \
    -arch arm64 -arch x86_64 \
    $frameworks \
    -o "$out" "$src"

  if command -v codesign >/dev/null 2>&1; then
    codesign --remove-signature "$out" 2>/dev/null || true
    if [ -n "${ELECTROBUN_DEVELOPER_ID:-}" ]; then
      codesign --force --verbose --timestamp \
        --sign "$ELECTROBUN_DEVELOPER_ID" \
        --options runtime \
        "$out"
      echo "[build-native-macos] Developer ID signed: $out"
    else
      codesign --force --sign - "$out"
      echo "[build-native-macos] ad-hoc signed: $out"
    fi
  fi

  echo "[build-native-macos] built: $out"
}

build_shim dev3-notifications "-framework Foundation -framework UserNotifications"
build_shim dev3-window-menu "-framework AppKit"
