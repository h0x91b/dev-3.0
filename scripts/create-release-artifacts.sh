#!/bin/bash
set -euo pipefail

# Creates release artifacts for a given OS, architecture and update channel.
# Usage: ./scripts/create-release-artifacts.sh <os> <arch> <channel>
#   os:      macos, linux or win
#   arch:    arm64 or x64
#   channel: stable or canary (must match the `electrobun build --env=` used)
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

OS="${1:?Usage: $0 <os> <arch> <channel> (os: macos|linux|win, arch: arm64|x64, channel: stable|canary)}"
ARCH="${2:?Usage: $0 <os> <arch> <channel> (os: macos|linux|win, arch: arm64|x64, channel: stable|canary)}"
# OS IS VALIDATED, and `win` is the whole reason. It is the token getPlatformPrefix() in
# src/bun/updater.ts builds the feed URL from, so `windows` — the obvious thing to type, and
# what every runner label and workflow filename says — would produce a perfectly well-formed
# `canary-windows-x64-update.json` that no client ever asks for, with the run green and the
# bucket looking populated. Before this guard the unknown OS just fell into the linux branch.
if [ "$OS" != "macos" ] && [ "$OS" != "linux" ] && [ "$OS" != "win" ]; then
  echo "::error::unknown os '${OS}' (expected macos|linux|win). This token names electrobun's build folder AND the published manifest key the in-app updater fetches (getPlatformPrefix in src/bun/updater.ts) — Windows is 'win', never 'windows'."
  exit 1
fi
# CHANNEL is REQUIRED and deliberately NOT defaulted. A default would let a future
# caller publish canary artifacts into the stable feed — every filename here is
# prefixed with it — and nothing would go red, because a missing argument would read
# as a valid choice.
CHANNEL="${3:?missing <channel> argument (stable|canary). Refusing to guess: the channel prefixes every artifact name and the update manifest, so guessing it would publish one channel build into the other channel feed.}"
if [ "$CHANNEL" != "stable" ] && [ "$CHANNEL" != "canary" ]; then
  echo "::error::unknown channel '${CHANNEL}' (expected stable|canary). The channel must match the \`electrobun build --env=\` that produced ./build/, or the artifact names will not match what the updater fetches."
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
if [ "$OS" = "win" ]; then
  ZSTD="${ZSTD}.exe"
fi

# Identity and ordering for the manifest. `sha` says WHICH COMMIT (the hourly canary
# workflow compares it against main to decide whether to build at all); `buildOrder`
# says WHICH BUILD IS NEWER (clients on canary compare it, because the canary
# version string carries a +canary.<sha> suffix that semver silently parses away).
# `buildOrder` is monotonic ONLY because main is squash-merged: linear history, +1 per
# merge. That is a property of how this repo lands PRs, not of git. See
# decisions/2026/08/06/extract-reusable-release-build-workflows.md.
BUILD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
BUILD_ORDER=$(git rev-list --count HEAD 2>/dev/null || echo "0")
SHORT_SHA="${BUILD_SHA:0:8}"
echo "Manifest identity: sha=${BUILD_SHA} buildOrder=${BUILD_ORDER}"

# THE PUBLISHED VERSION IS NOT ALWAYS THE BUNDLE'S VERSION, AND CANARY IS WHY.
#
# Canary builds from `main` with no tag, so every one of them reports the last RELEASE's
# version: the user is offered "v1.42.3", the popover says "what's new in v1.42.3", and a
# build off main is wearing a stable release's name. The `+canary.<sha>` suffix is what
# tells the two apart, and THIS IS ITS ONLY PRODUCER — `canaryDisplayVersion()` shipped
# with a unit test and no caller, so the suffix existed in the tests and never in the feed.
#
# It is computed from the shared helper, not re-spelled here, because the app parses it
# back with the inverse function in the same module.
#
# IT MUST NEVER ENTER version.json: `dev3 doctor` compares the bundle version with the CLI
# version by STRING EQUALITY, so a suffixed bundle reports a spurious mismatch on every
# canary install. Nothing here can — that file is electrobun's and is already sealed inside
# the tarball by the time this script runs.
publish_version() {
  if [ "$CHANNEL" != "canary" ]; then
    echo "$1"
    return
  fi
  # Values go through the ENVIRONMENT, never string-interpolated into the -e source, and
  # the module is addressed relative to THIS SCRIPT rather than the cwd: the release jobs
  # run from the repo root, the tests run it from a temp dir.
  BUNDLE_VERSION="$1" SHORT_SHA="$SHORT_SHA" bun -e "
    const { canaryDisplayVersion } = await import('$(cd "$(dirname "$0")/.." && pwd)/src/shared/update-channel.ts');
    console.log(canaryDisplayVersion(process.env.BUNDLE_VERSION, process.env.SHORT_SHA));
  "
}

# THE CHEAP HALF OF THE CHANNEL CHECK, and it runs on every path.
# electrobun names its build folder after the channel, so `./build/dev-*` existing while
# `./build/<channel>-*` does not is the exact fingerprint of a SILENT degradation: it gates
# `--env` on an allowlist and falls back to "dev" outside it, without failing. This check
# EARNED ITS KEEP: it is what caught `--env=unstable` degrading on every single run, while
# three guards asserting a vendored patch stayed green — they described a source file the
# build never executes. Without it the degradation surfaces later as "build failed before
# tarring", which sends the operator to debug the wrong thing.
if [ ! -d "$BUILD_DIR" ] && [ -d "./build/dev-${OS}-${ARCH}" ]; then
  echo "::error::expected ${BUILD_DIR} but found ./build/dev-${OS}-${ARCH} — electrobun REJECTED --env=${CHANNEL} and silently fell back to a dev build."
  echo "::error::'${CHANNEL}' is not in electrobun's --env allowlist on the installed version. Fix: check that allowlist in the installed dependency (do NOT patch its src/cli/index.ts — the CLI that runs is a compiled binary downloaded by bin/electrobun.cjs, so that file is never executed), and publish only channels it admits natively."
  exit 1
fi

# Platform-specific settings
if [ "$OS" = "macos" ]; then
  APP_BUNDLE="${APP_FILE_NAME}.app"
  TAR_NAME="${APP_FILE_NAME}.app.tar"
  VERSION_JSON_SUBPATH="${APP_BUNDLE}/Contents/Resources/version.json"
elif [ "$OS" = "win" ]; then
  # Same flat bundle shape as Linux, but capital-R `Resources` — measured off the tree the
  # launch proof extracted on run 31257371545 (`dev-3.0-canary/bin/launcher.exe`,
  # `dev-3.0-canary/Resources/app/...`). find_version_json's fallback covers a layout change.
  APP_BUNDLE="${APP_FILE_NAME}"
  TAR_NAME="${APP_FILE_NAME}.tar"
  VERSION_JSON_SUBPATH="${APP_BUNDLE}/Resources/version.json"
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

# Helper: find version.json in a recovered directory.
#
# THIS FUNCTION'S STDOUT IS ITS RETURN VALUE — callers do `X=$(find_version_json ...)`.
# Every human-readable line therefore goes to STDERR. A `::notice::` on stdout is captured
# INTO the path, and the next `bun -e "Bun.file('<two lines>')"` dies with "Unterminated
# string literal", which is how the fallback branch below sat dead: the notice appeared in
# the log, so it looked exercised.
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
    echo "::notice::version.json found at unexpected path: $FOUND" >&2
    echo "$FOUND"
    return
  fi

  echo "::error::version.json not found in $SEARCH_DIR" >&2
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
  PUBLISH_VERSION=$(publish_version "$VERSION")
  echo "Bundle hash: $HASH, version: $VERSION, published as: $PUBLISH_VERSION"

  # Create update.json with platform prefix
  echo "{\"version\":\"${PUBLISH_VERSION}\",\"hash\":\"${HASH}\",\"os\":\"${OS}\",\"arch\":\"${ARCH}\",\"sha\":\"${BUILD_SHA}\",\"buildOrder\":${BUILD_ORDER},\"changelog\":${CHANGELOG_JSON}}" \
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

# Compress tar if electrobun didn't get to it. `zig-zstd` REQUIRES the `compress`
# subcommand and `-i` for the input; called as `zig-zstd <in> -o <out>` it exits with
# `error: InvalidArgs`, which is how this branch sat dead from PR #12 (2026-03-01) until a
# test finally entered it — it is reachable only when electrobun dies between writing the
# tar and compressing it.
if [ ! -f "$TAR_ZST" ] && [ -f "$TAR" ]; then
  "$ZSTD" compress -i "$TAR" -o "$TAR_ZST" --no-timing
fi
cp "$TAR_ZST" "${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_FILE_NAME}${TAR_NAME#${APP_FILE_NAME}}.zst"

# Extract to recover version.json and create platform-specific artifacts
RECOVER_DIR="${BUILD_DIR}/recovered"
mkdir -p "$RECOVER_DIR"
tar -xf "$TAR" -C "$RECOVER_DIR" 2>/dev/null || tar -xf <(zstd -d "$TAR_ZST" --stdout) -C "$RECOVER_DIR"

# Read version info
VERSION_JSON=$(find_version_json "$RECOVER_DIR")
HASH=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.hash)")
VERSION=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.version)")
echo "Bundle hash: $HASH, version: $VERSION"

# THE BUILT ARTIFACT MUST AGREE WITH THE CHANNEL WE ARE PUBLISHING IT AS.
# electrobun gates `--env` on an allowlist and falls back to "dev" SILENTLY outside it. If a
# future upgrade drops a channel from that list, the build still succeeds, produces a DEV
# bundle, and without this check it would be published under that channel's names: it would
# poll the wrong feed and never update again, with nothing in any log saying so.
BUNDLE_CHANNEL=$(bun -e "const j=await Bun.file('${VERSION_JSON}').json();console.log(j.channel)")
if [ "$BUNDLE_CHANNEL" != "$CHANNEL" ]; then
  echo "::error::bundle was built for channel '${BUNDLE_CHANNEL}' but is being published as '${CHANNEL}'"
  echo "::error::'${BUNDLE_CHANNEL}' = 'dev' means electrobun REJECTED --env=${CHANNEL} and silently degraded. Likely cause: an electrobun upgrade removed '${CHANNEL}' from its --env allowlist. Fix: publish only channels the installed version admits natively — patching its src/cli/index.ts does nothing, because the CLI that runs is a compiled binary downloaded by bin/electrobun.cjs."
  exit 1
fi

# Create update.json
PUBLISH_VERSION=$(publish_version "$VERSION")
echo "Published version: ${PUBLISH_VERSION} (bundle stays ${VERSION})"
echo "{\"version\":\"${PUBLISH_VERSION}\",\"hash\":\"${HASH}\",\"os\":\"${OS}\",\"arch\":\"${ARCH}\",\"sha\":\"${BUILD_SHA}\",\"buildOrder\":${BUILD_ORDER},\"changelog\":${CHANGELOG_JSON}}" \
  > "${OUTPUT_DIR}/${PLATFORM_PREFIX}-update.json"

# macOS: create DMG from recovered .app (with /Applications symlink)
if [ "$OS" = "macos" ] && [ -d "${RECOVER_DIR}/${APP_BUNDLE}" ]; then
  DMG_PATH="${OUTPUT_DIR}/${PLATFORM_PREFIX}-${APP_NAME}.dmg"
  create_dmg "${RECOVER_DIR}/${APP_BUNDLE}" "$DMG_PATH" "${APP_NAME} ${VERSION}"
fi

echo "Artifacts for ${OS}-${ARCH} created:"
ls -lh "${OUTPUT_DIR}/"
