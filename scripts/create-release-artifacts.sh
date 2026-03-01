#!/bin/bash
set -euo pipefail

# Creates release artifacts for a given architecture.
# Usage: ./scripts/create-release-artifacts.sh <arch>
#   arch: arm64 or x64
# Outputs artifacts to ./artifacts-<arch>/
#
# Expects:
#   - ./build/stable-macos-<arch>/ to contain the Electrobun build output
#   - ./artifacts/ may contain Electrobun's own artifacts (Case 1)
#   - `bun` on PATH (used only for JSON parsing, any arch works)

ARCH="${1:?Usage: $0 <arch> (arm64|x64)}"
APP_NAME="dev-3.0"
BUILD_DIR="./build/stable-macos-${ARCH}"
PLATFORM_PREFIX="stable-macos-${ARCH}"
OUTPUT_DIR="./artifacts-${ARCH}"
ZSTD="./node_modules/electrobun/dist-macos-${ARCH}/zig-zstd"

echo "=== Creating ${ARCH} release artifacts ==="
echo "BUILD_DIR: ${BUILD_DIR}"
echo "OUTPUT_DIR: ${OUTPUT_DIR}"

mkdir -p "$OUTPUT_DIR"

# Helper: create DMG with /Applications symlink
create_dmg() {
  local APP_PATH="$1"
  local DMG_OUT="$2"
  local VOL_NAME="$3"

  # Unmount any leftover volume from previous runs
  hdiutil detach "/Volumes/${VOL_NAME}" -force 2>/dev/null || true
  hdiutil detach "/Volumes/${APP_NAME}" -force 2>/dev/null || true

  # Stage .app + Applications symlink
  local STAGE_DIR
  STAGE_DIR=$(mktemp -d)
  cp -R "$APP_PATH" "$STAGE_DIR/"
  ln -s /Applications "$STAGE_DIR/Applications"

  hdiutil create -volname "$VOL_NAME" -srcfolder "$STAGE_DIR" \
    -ov -format UDZO "$DMG_OUT"

  rm -rf "$STAGE_DIR"
  hdiutil detach "/Volumes/${VOL_NAME}" -force 2>/dev/null || true
}

# Electrobun may succeed fully and move artifacts to ./artifacts/,
# or it may crash after tarring and leave tar/tar.zst in the build dir.
# We handle both cases.

# Case 1: Electrobun succeeded and created its own artifacts
EBUN_TAR_ZST=$(find ./artifacts -name "*.app.tar.zst" 2>/dev/null | head -1)
EBUN_DMG=$(find ./artifacts -name "*.dmg" 2>/dev/null | head -1)
EBUN_UPDATE=$(find ./artifacts -name "update.json" -o -name "*-update.json" 2>/dev/null | head -1)

if [ -n "$EBUN_TAR_ZST" ]; then
  echo "Electrobun created artifacts successfully, using them directly"
  ls -lh ./artifacts/

  cp "$EBUN_TAR_ZST" "${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_NAME}.app.tar.zst"

  # Get version info from Electrobun's update.json or from the .app
  if [ -n "$EBUN_UPDATE" ]; then
    HASH=$(bun -e "const j=await Bun.file('${EBUN_UPDATE}').json();console.log(j.hash)")
    VERSION=$(bun -e "const j=await Bun.file('${EBUN_UPDATE}').json();console.log(j.version)")
  else
    # Extract from tar.zst
    RECOVER_DIR="${BUILD_DIR}/recovered"
    mkdir -p "$RECOVER_DIR"
    tar -xf <(zstd -d "$EBUN_TAR_ZST" --stdout) -C "$RECOVER_DIR"
    VERSION_JSON="${RECOVER_DIR}/${APP_NAME}.app/Contents/Resources/version.json"
    HASH=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.hash)")
    VERSION=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.version)")
  fi
  echo "Bundle hash: $HASH, version: $VERSION"

  # Create update.json with platform prefix
  echo "{\"version\":\"${VERSION}\",\"hash\":\"${HASH}\",\"os\":\"macos\",\"arch\":\"${ARCH}\"}" \
    > "${OUTPUT_DIR}/${PLATFORM_PREFIX}-update.json"

  # Use Electrobun's DMG or create one with /Applications symlink
  if [ -n "$EBUN_DMG" ]; then
    cp "$EBUN_DMG" "${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_NAME}.dmg"
  elif [ -d "${BUILD_DIR}/${APP_NAME}.app" ]; then
    create_dmg "${BUILD_DIR}/${APP_NAME}.app" "${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_NAME}.dmg" "${APP_NAME} ${VERSION}"
  fi

  # Clean Electrobun's output dir to avoid confusion for next build phase
  rm -rf ./artifacts

  echo "Final artifacts for ${ARCH}:"
  ls -lh "${OUTPUT_DIR}/"
  exit 0
fi

# Case 2: Electrobun crashed — recover from tar in build dir
echo "Electrobun artifacts not found, recovering from build dir..."
TAR_ZST="${BUILD_DIR}/${APP_NAME}.app.tar.zst"
TAR="${BUILD_DIR}/${APP_NAME}.app.tar"

if [ ! -f "$TAR_ZST" ] && [ ! -f "$TAR" ]; then
  echo "::error::Neither tar.zst nor tar found — build failed before tarring"
  find ./build -maxdepth 3 -type f 2>/dev/null || true
  exit 1
fi

# Compress tar if electrobun didn't get to it
if [ ! -f "$TAR_ZST" ] && [ -f "$TAR" ]; then
  "$ZSTD" "$TAR" -o "$TAR_ZST"
fi
cp "$TAR_ZST" "${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_NAME}.app.tar.zst"

# Extract .app from tar to recover version.json and create DMG
RECOVER_DIR="${BUILD_DIR}/recovered"
mkdir -p "$RECOVER_DIR"
tar -xf "$TAR" -C "$RECOVER_DIR" 2>/dev/null || tar -xf <(zstd -d "$TAR_ZST" --stdout) -C "$RECOVER_DIR"

# Read version info
VERSION_JSON="${RECOVER_DIR}/${APP_NAME}.app/Contents/Resources/version.json"
HASH=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.hash)")
VERSION=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.version)")
echo "Bundle hash: $HASH, version: $VERSION"

# Create update.json
echo "{\"version\":\"${VERSION}\",\"hash\":\"${HASH}\",\"os\":\"macos\",\"arch\":\"${ARCH}\"}" \
  > "${OUTPUT_DIR}/${PLATFORM_PREFIX}-update.json"

# Create DMG from recovered .app (with /Applications symlink)
DMG_PATH="${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_NAME}.dmg"
create_dmg "${RECOVER_DIR}/${APP_NAME}.app" "$DMG_PATH" "${APP_NAME} ${VERSION}"

echo "Artifacts for ${ARCH} created:"
ls -lh "${OUTPUT_DIR}/"
