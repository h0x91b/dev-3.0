#!/bin/bash
# Sign the locally-built CLI binaries on macOS.
#
# Why: `bun build --compile` produces a Mach-O with an embedded payload that
# Apple's `codesign` rejects with "invalid or unsupported format for signature".
# On macOS Sequoia (24+) AMFI then SIGKILLs unsigned binaries even when run
# locally — the symptom is `[1] killed ./dist/dev3` with no output.
# The fix is to first strip the bun-emitted pseudo-blob with
# `codesign --remove-signature`, then sign the clean Mach-O.
#
# Default mode is an ad-hoc signature — enough to satisfy AMFI for local
# testing on the dev machine. When `ELECTROBUN_DEVELOPER_ID` is present
# (release CI), sign the CLI binary with the real Developer ID before
# Electrobun copies it into the app bundle.
#
# No-op on Linux/Windows/CI without macOS — they don't need a signature.

set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  exit 0
fi

if ! command -v codesign >/dev/null 2>&1; then
  echo "[sign-cli-binaries] codesign not found — skipping (only needed on macOS dev machines)"
  exit 0
fi

sign_one() {
  local bin="$1"
  if [ ! -f "$bin" ]; then
    return 0
  fi

  # Strip any pre-existing pseudo-blob from bun's output before re-signing.
  codesign --remove-signature "$bin" 2>/dev/null || true

  if [ -n "${ELECTROBUN_DEVELOPER_ID:-}" ]; then
    codesign --force --verbose --timestamp \
      --sign "$ELECTROBUN_DEVELOPER_ID" \
      --options runtime \
      "$bin"
    echo "[sign-cli-binaries] Developer ID signed: $bin"
    return 0
  fi

  codesign --force --sign - "$bin"
  echo "[sign-cli-binaries] ad-hoc signed: $bin"
}

sign_one dist/dev3
# Bundled tmux helper (staged by scripts/stage-bundled-tmux.sh) must carry its
# signature BEFORE electrobun signs/notarizes the outer app bundle.
sign_one dist/tmux/tmux
