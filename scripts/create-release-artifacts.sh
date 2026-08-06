#!/bin/bash
set -euo pipefail

# Creates release artifacts for a given OS, architecture and update channel.
# Usage: ./scripts/create-release-artifacts.sh <os> <arch> <channel>
#   os:      macos or linux
#   arch:    arm64 or x64
#   channel: stable or unstable (must match the `electrobun build --env=` used)
# Outputs artifacts to ./artifacts-<os>-<arch>/
#
# Expects:
#   - ./build/<channel>-<os>-<arch>/ to contain the Electrobun build output
#   - ./artifacts/ may contain Electrobun's own artifacts (Case 1)
#   - `bun` on PATH (used only for JSON parsing, any arch works)
#
# This script is the SINGLE WRITER of the published `<prefix>-update.json`: it
# rewrites Electrobun's manifest wholesale, adding os/arch/changelog plus the `sha`
# and `buildOrder` fields the channel logic needs. A second writer would let the feed
# disagree with itself.

OS="${1:?Usage: $0 <os> <arch> <channel> (os: macos|linux, arch: arm64|x64, channel: stable|unstable)}"
ARCH="${2:?Usage: $0 <os> <arch> <channel> (os: macos|linux, arch: arm64|x64, channel: stable|unstable)}"
# CHANNEL is REQUIRED and deliberately NOT defaulted. A default would let a future
# caller publish unstable artifacts into the stable feed — every filename here is
# prefixed with it — and nothing would go red, because a missing argument would read
# as a valid choice.
CHANNEL="${3:?missing <channel> argument (stable|unstable). Refusing to guess: the channel prefixes every artifact name and the update manifest, so guessing it would publish one channel build into the other channel feed.}"
if [ "$CHANNEL" != "stable" ] && [ "$CHANNEL" != "unstable" ]; then
  echo "::error::unknown channel '${CHANNEL}' (expected stable|unstable). The channel must match the \`electrobun build --env=\` that produced ./build/, or the artifact names will not match what the updater fetches."
  exit 1
fi
APP_NAME="dev-3.0"
# Electrobun suffixes the app file name on every channel except stable
# (api/shared/naming.ts getAppFileName), and the Updater builds its download URL from
# that name via version.json. Get this wrong and the tarball is published under a name
# no client asks for.
if [ "$CHANNEL" = "stable" ]; then
  APP_FILE_NAME="${APP_NAME}"
else
  APP_FILE_NAME="${APP_NAME}-${CHANNEL}"
fi
BUILD_DIR="./build/${CHANNEL}-${OS}-${ARCH}"
PLATFORM_PREFIX="${CHANNEL}-${OS}-${ARCH}"
OUTPUT_DIR="./artifacts-${OS}-${ARCH}"
ZSTD="./node_modules/electrobun/dist-${OS}-${ARCH}/zig-zstd"

# Identity and ordering for the manifest. `sha` says WHICH COMMIT (the hourly unstable
# workflow compares it against main to decide whether to build at all); `buildOrder`
# says WHICH BUILD IS NEWER (clients on unstable compare it, because the unstable
# version string carries a +unstable.<sha> suffix that semver silently parses away).
# `buildOrder` is monotonic ONLY because main is squash-merged: linear history, +1 per
# merge. That is a property of how this repo lands PRs, not of git. See
# decisions/221-extract-reusable-release-build-workflows.md.
BUILD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
BUILD_ORDER=$(git rev-list --count HEAD 2>/dev/null || echo "0")
echo "Manifest identity: sha=${BUILD_SHA} buildOrder=${BUILD_ORDER}"

# Platform-specific settings
if [ "$OS" = "macos" ]; then
  APP_BUNDLE="${APP_FILE_NAME}.app"
  TAR_NAME="${APP_FILE_NAME}.app.tar"
  VERSION_JSON_SUBPATH="${APP_BUNDLE}/Contents/Resources/version.json"
else
  APP_BUNDLE="${APP_FILE_NAME}"
  TAR_NAME="${APP_FILE_NAME}.tar"
  # Linux bundle structure may vary; we'll use find as fallback
  VERSION_JSON_SUBPATH="${APP_BUNDLE}/resources/version.json"
fi

echo "=== Creating ${OS}-${ARCH} release artifacts ==="
echo "BUILD_DIR: ${BUILD_DIR}"
echo "OUTPUT_DIR: ${OUTPUT_DIR}"

mkdir -p "$OUTPUT_DIR"

# Compact "what's new" payload embedded into update.json for the update popover.
# build-update-changelog.ts prints `null` on any failure, so this is never fatal
# and an absent changelog just omits the popover's what's-new section.
CHANGELOG_JSON=$(bun scripts/build-update-changelog.ts 2>/dev/null || echo 'null')
echo "Update changelog payload: ${CHANGELOG_JSON}"

# Helper: create DMG with /Applications symlink (macOS only)
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

# Helper: find version.json in a recovered directory
find_version_json() {
  local SEARCH_DIR="$1"
  local EXPECTED="${SEARCH_DIR}/${VERSION_JSON_SUBPATH}"

  if [ -f "$EXPECTED" ]; then
    echo "$EXPECTED"
    return
  fi

  # Fallback: search for version.json anywhere in the recovered dir
  local FOUND
  FOUND=$(find "$SEARCH_DIR" -name "version.json" -type f 2>/dev/null | head -1)
  if [ -n "$FOUND" ]; then
    echo "::notice::version.json found at unexpected path: $FOUND"
    echo "$FOUND"
    return
  fi

  echo "::error::version.json not found in $SEARCH_DIR"
  return 1
}

# Electrobun may succeed fully and move artifacts to ./artifacts/,
# or it may crash after tarring and leave tar/tar.zst in the build dir.
# We handle both cases.

# Case 1: Electrobun succeeded and created its own artifacts
EBUN_TAR_ZST=""
EBUN_DMG=""
EBUN_UPDATE=""
EBUN_SETUP_TGZ=""
if [ -d ./artifacts ]; then
  EBUN_TAR_ZST=$(find ./artifacts -name "*.tar.zst" ! -name "*Setup*" 2>/dev/null | head -1)
  EBUN_DMG=$(find ./artifacts -name "*.dmg" 2>/dev/null | head -1)
  EBUN_UPDATE=$(find ./artifacts -name "update.json" -o -name "*-update.json" 2>/dev/null | head -1)
  EBUN_SETUP_TGZ=$(find ./artifacts -name "*Setup*.tar.gz" 2>/dev/null | head -1)
fi

if [ -n "$EBUN_TAR_ZST" ]; then
  echo "Electrobun created artifacts successfully, using them directly"
  ls -lh ./artifacts/

  cp "$EBUN_TAR_ZST" "${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_FILE_NAME}${TAR_NAME#${APP_FILE_NAME}}.zst"

  # Copy Linux installer tarball if present
  if [ -n "$EBUN_SETUP_TGZ" ] && [ "$OS" = "linux" ]; then
    cp "$EBUN_SETUP_TGZ" "${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_FILE_NAME}Setup.tar.gz"
  fi

  # Get version info from Electrobun's update.json or from the bundle
  if [ -n "$EBUN_UPDATE" ]; then
    HASH=$(bun -e "const j=await Bun.file('${EBUN_UPDATE}').json();console.log(j.hash)")
    VERSION=$(bun -e "const j=await Bun.file('${EBUN_UPDATE}').json();console.log(j.version)")
  else
    # Extract from tar.zst
    RECOVER_DIR="${BUILD_DIR}/recovered"
    mkdir -p "$RECOVER_DIR"
    tar -xf <(zstd -d "$EBUN_TAR_ZST" --stdout) -C "$RECOVER_DIR"
    VERSION_JSON=$(find_version_json "$RECOVER_DIR")
    HASH=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.hash)")
    VERSION=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.version)")
  fi
  echo "Bundle hash: $HASH, version: $VERSION"

  # Create update.json with platform prefix
  echo "{\"version\":\"${VERSION}\",\"hash\":\"${HASH}\",\"os\":\"${OS}\",\"arch\":\"${ARCH}\",\"sha\":\"${BUILD_SHA}\",\"buildOrder\":${BUILD_ORDER},\"changelog\":${CHANGELOG_JSON}}" \
    > "${OUTPUT_DIR}/${PLATFORM_PREFIX}-update.json"

  # macOS: create DMG
  if [ "$OS" = "macos" ]; then
    if [ -n "$EBUN_DMG" ]; then
      cp "$EBUN_DMG" "${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_NAME}.dmg"
    elif [ -d "${BUILD_DIR}/${APP_BUNDLE}" ]; then
      create_dmg "${BUILD_DIR}/${APP_BUNDLE}" "${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_NAME}.dmg" "${APP_NAME} ${VERSION}"
    fi
  fi

  # Clean Electrobun's output dir to avoid confusion for next build phase
  rm -rf ./artifacts

  echo "Final artifacts for ${OS}-${ARCH}:"
  ls -lh "${OUTPUT_DIR}/"
  exit 0
fi

# Case 2: Electrobun crashed — recover from tar in build dir
echo "Electrobun artifacts not found, recovering from build dir..."
TAR_ZST="${BUILD_DIR}/${TAR_NAME}.zst"
TAR="${BUILD_DIR}/${TAR_NAME}"
PARTIAL_APP_ZIP="${BUILD_DIR}/${APP_BUNDLE}.zip"

if [ ! -f "$TAR_ZST" ] && [ ! -f "$TAR" ]; then
  if [ "$OS" = "macos" ] && [ -f "$PARTIAL_APP_ZIP" ]; then
    echo "::error::Found ${PARTIAL_APP_ZIP} but no ${TAR_NAME}(.zst). Electrobun likely failed after packaging the app, for example during notarization. Check the earlier electrobun output for the real error."
    find "${BUILD_DIR}" -maxdepth 2 -type f 2>/dev/null || true
    exit 1
  fi

  echo "::error::Neither tar.zst nor tar found — build failed before tarring"
  find ./build -maxdepth 3 -type f 2>/dev/null || true
  exit 1
fi

# Compress tar if electrobun didn't get to it
if [ ! -f "$TAR_ZST" ] && [ -f "$TAR" ]; then
  "$ZSTD" "$TAR" -o "$TAR_ZST"
fi
cp "$EBUN_TAR_ZST" "${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_FILE_NAME}${TAR_NAME#${APP_FILE_NAME}}.zst"

# Extract to recover version.json and create platform-specific artifacts
RECOVER_DIR="${BUILD_DIR}/recovered"
mkdir -p "$RECOVER_DIR"
tar -xf "$TAR" -C "$RECOVER_DIR" 2>/dev/null || tar -xf <(zstd -d "$TAR_ZST" --stdout) -C "$RECOVER_DIR"

# Read version info
VERSION_JSON=$(find_version_json "$RECOVER_DIR")
HASH=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.hash)")
VERSION=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.version)")
echo "Bundle hash: $HASH, version: $VERSION"

# Create update.json
echo "{\"version\":\"${VERSION}\",\"hash\":\"${HASH}\",\"os\":\"${OS}\",\"arch\":\"${ARCH}\",\"sha\":\"${BUILD_SHA}\",\"buildOrder\":${BUILD_ORDER},\"changelog\":${CHANGELOG_JSON}}" \
  > "${OUTPUT_DIR}/${PLATFORM_PREFIX}-update.json"

# macOS: create DMG from recovered .app (with /Applications symlink)
if [ "$OS" = "macos" ] && [ -d "${RECOVER_DIR}/${APP_BUNDLE}" ]; then
  DMG_PATH="${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_NAME}.dmg"
  create_dmg "${RECOVER_DIR}/${APP_BUNDLE}" "$DMG_PATH" "${APP_NAME} ${VERSION}"
fi

echo "Artifacts for ${OS}-${ARCH} created:"
ls -lh "${OUTPUT_DIR}/"
