#!/bin/bash
# Apply an ad-hoc codesign to the locally-built CLI binaries on macOS.
#
# Why: `bun build --compile` produces a Mach-O with an embedded payload that
# Apple's `codesign` rejects with "invalid or unsupported format for signature".
# On macOS Sequoia (24+) AMFI then SIGKILLs unsigned binaries even when run
# locally — the symptom is `[1] killed ./dist/dev3` with no output.
# The fix is to first strip the bun-emitted pseudo-blob with
# `codesign --remove-signature`, then ad-hoc sign with `codesign --sign -`.
#
# This is an ad-hoc signature only — enough to satisfy AMFI for local
# testing on the dev machine. Release builds are signed with a real Developer
# ID via the Electrobun bundle pipeline (see electrobun.config.ts).
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
  # Strip any pre-existing pseudo-blob from bun's output. Both stdout and
  # stderr noise are silenced; the rebind below is what matters.
  codesign --remove-signature "$bin" 2>/dev/null || true
  codesign --force --sign - "$bin" 2>/dev/null
  echo "[sign-cli-binaries] ad-hoc signed: $bin"
}

sign_one dist/dev3
sign_one dist/dev3-server
