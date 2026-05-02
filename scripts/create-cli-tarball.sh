#!/bin/bash
set -euo pipefail

# Creates a self-contained CLI tarball that can be extracted anywhere and run
# directly: `tar xzf dev3-cli-<os>-<arch>.tar.gz && ./dev3 remote`.
#
# Usage: ./scripts/create-cli-tarball.sh <os> <arch>
#   os:   macos or linux
#   arch: arm64 or x64
#
# Inputs:
#   ./dist/dev3, ./dist/dev3-server  — produced by `bun run build:cli`
#   ./dist/index.html, ./dist/assets — produced by `bunx vite build`
#
# Output: ./artifacts-<os>-<arch>/dev3-cli-<os>-<arch>.tar.gz
#
# Layout inside the tarball (extracts into the current dir):
#   ./dev3                ← compiled CLI (sibling-discovers ./dist/)
#   ./dev3-server         ← compiled headless server
#   ./dist/index.html     ← UI entry
#   ./dist/assets/...     ← UI assets

OS="${1:?Usage: $0 <os> <arch> (os: macos|linux, arch: arm64|x64)}"
ARCH="${2:?Usage: $0 <os> <arch> (os: macos|linux, arch: arm64|x64)}"
OUT_DIR="./artifacts-${OS}-${ARCH}"
TARBALL="${OUT_DIR}/dev3-cli-${OS}-${ARCH}.tar.gz"
STAGE_DIR="$(mktemp -d)"

echo "=== Creating CLI tarball for ${OS}-${ARCH} ==="

if [ ! -f ./dist/dev3 ] || [ ! -f ./dist/dev3-server ]; then
  echo "::error::dist/dev3 or dist/dev3-server missing — run \`bun run build:cli\` first"
  ls -lh ./dist 2>/dev/null || true
  exit 1
fi

if [ ! -f ./dist/index.html ]; then
  echo "::error::dist/index.html missing — run \`bunx vite build\` first"
  ls -lh ./dist 2>/dev/null || true
  exit 1
fi

mkdir -p "$OUT_DIR" "$STAGE_DIR/dist"

cp ./dist/dev3 "$STAGE_DIR/dev3"
cp ./dist/dev3-server "$STAGE_DIR/dev3-server"
chmod 0755 "$STAGE_DIR/dev3" "$STAGE_DIR/dev3-server"

cp ./dist/index.html "$STAGE_DIR/dist/"
[ -d ./dist/assets ] && cp -r ./dist/assets "$STAGE_DIR/dist/assets"

# Pack contents (no leading ./dev3-cli/ wrapper — extracts straight into CWD).
# Plain `tar czf` — works on both GNU tar (Linux) and BSD tar (macOS).
# We deliberately don't use --sort=name / --mtime / --owner / --group: they're
# GNU-only and macOS runners ship BSD tar. The Formula updater hashes the same
# tarball it just produced, so per-run reproducibility doesn't matter here.
tar -C "$STAGE_DIR" -czf "$TARBALL" .

ls -lh "$TARBALL"
echo "SHA-256: $(shasum -a 256 "$TARBALL" | awk '{print $1}')"
