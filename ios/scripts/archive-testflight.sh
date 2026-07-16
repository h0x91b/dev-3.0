#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  TEAM_ID=ABCDE12345 \
  BUNDLE_ID=com.example.dev3 \
  MARKETING_VERSION=1.0.0 \
  BUILD_NUMBER=1 \
  ./scripts/archive-testflight.sh MODE [--allow-provisioning-updates]

Modes:
  --validate-only        Generate the project and build Release for Simulator without signing.
  --archive              Create a signed App Store archive without exporting it.
  --archive-and-export   Create the archive and export a local App Store Connect IPA.

Optional environment:
  OUTPUT_DIR             Artifact directory. Defaults to build/testflight/<version>-<build>.

The script never uploads to App Store Connect. The provisioning flag is opt-in because it allows
Xcode to contact Apple and update signing assets for an account already configured in Xcode.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

require_environment() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "$name is required."
}

assert_build_setting() {
  local name="$1"
  local expected="$2"
  local actual

  actual="$({
    printf '%s\n' "$BUILD_SETTINGS"
  } | awk -F ' = ' -v name="$name" '
    {
      key = $1
      sub(/^[[:space:]]+/, "", key)
      if (key == name) {
        print $2
        exit
      }
    }
  ')"

  [[ "$actual" == "$expected" ]] || fail "$name resolved to '$actual', expected '$expected'."
}

assert_plist_value() {
  local plist="$1"
  local key="$2"
  local expected="$3"
  local actual

  actual="$(plutil -extract "$key" raw -o - "$plist")"
  [[ "$actual" == "$expected" ]] || fail "$key in $plist is '$actual', expected '$expected'."
}

write_export_options() {
  plutil -create xml1 "$EXPORT_OPTIONS_PATH"
  plutil -insert destination -string export "$EXPORT_OPTIONS_PATH"
  plutil -insert distributionBundleIdentifier -string "$BUNDLE_ID" "$EXPORT_OPTIONS_PATH"
  plutil -insert manageAppVersionAndBuildNumber -bool false "$EXPORT_OPTIONS_PATH"
  plutil -insert method -string app-store-connect "$EXPORT_OPTIONS_PATH"
  plutil -insert signingStyle -string automatic "$EXPORT_OPTIONS_PATH"
  plutil -insert stripSwiftSymbols -bool true "$EXPORT_OPTIONS_PATH"
  plutil -insert teamID -string "$TEAM_ID" "$EXPORT_OPTIONS_PATH"
  plutil -insert uploadSymbols -bool true "$EXPORT_OPTIONS_PATH"
  plutil -lint "$EXPORT_OPTIONS_PATH" >/dev/null
}

assert_signed_entitlements() {
  local app_path="$1"
  local entitlements_path="$2"
  local application_identifier
  local keychain_group
  local signed_team_identifier

  codesign --verify --strict "$app_path" || fail "Archive signature verification failed."
  codesign -d --entitlements :- "$app_path" >"$entitlements_path" 2>/dev/null ||
    fail "Could not read entitlements from the signed archive."
  plutil -lint "$entitlements_path" >/dev/null || fail "Archived entitlements are not a valid plist."

  signed_team_identifier="$(
    /usr/libexec/PlistBuddy -c 'Print :com.apple.developer.team-identifier' "$entitlements_path"
  )" || fail "Signed archive has no team identifier entitlement."
  application_identifier="$(
    plutil -extract application-identifier raw -o - "$entitlements_path"
  )" || fail "Signed archive has no application identifier entitlement."
  keychain_group="$(
    plutil -extract keychain-access-groups.0 raw -o - "$entitlements_path"
  )" || fail "Signed archive has no default Keychain access group."

  [[ "$signed_team_identifier" == "$TEAM_ID" ]] ||
    fail "Signed team '$signed_team_identifier' does not match TEAM_ID '$TEAM_ID'."
  [[ "$application_identifier" == *."$BUNDLE_ID" ]] ||
    fail "Application identifier '$application_identifier' does not end in '.$BUNDLE_ID'."
  [[ "$keychain_group" == "$application_identifier" ]] ||
    fail "Default Keychain group '$keychain_group' does not match '$application_identifier'."
}

MODE="${1:-}"
shift || true

case "$MODE" in
  --validate-only | --archive | --archive-and-export) ;;
  --help | -h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    fail "Choose exactly one mode."
    ;;
esac

ALLOW_PROVISIONING_UPDATES=false
while (($#)); do
  case "$1" in
    --allow-provisioning-updates)
      ALLOW_PROVISIONING_UPDATES=true
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "Unknown option: $1"
      ;;
  esac
  shift
done

if [[ "$MODE" == "--validate-only" && "$ALLOW_PROVISIONING_UPDATES" == true ]]; then
  fail "--allow-provisioning-updates cannot be used with --validate-only."
fi

require_environment TEAM_ID
require_environment BUNDLE_ID
require_environment MARKETING_VERSION
require_environment BUILD_NUMBER

[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || fail "TEAM_ID must be a 10-character Apple team identifier."
[[ "$BUNDLE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$ ]] ||
  fail "BUNDLE_ID must be an explicit reverse-DNS identifier without wildcards."
[[ "$MARKETING_VERSION" =~ ^[1-9][0-9]*(\.[0-9]+){0,2}$ ]] ||
  fail "MARKETING_VERSION must contain one to three numeric components and start above zero."
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] || fail "BUILD_NUMBER must be a positive integer."

require_command xcodegen
require_command xcodebuild
require_command plutil

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$IOS_ROOT/build/testflight/$MARKETING_VERSION-$BUILD_NUMBER}"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

PROJECT_DIR="$OUTPUT_DIR/generated-project"
PROJECT_PATH="$PROJECT_DIR/Dev3.xcodeproj"
DERIVED_DATA_PATH="$OUTPUT_DIR/DerivedData"
ARCHIVE_PATH="$OUTPUT_DIR/Dev3.xcarchive"
EXPORT_PATH="$OUTPUT_DIR/export"
EXPORT_OPTIONS_PATH="$OUTPUT_DIR/ExportOptions.plist"

mkdir -p "$PROJECT_DIR"
printf 'Generating Xcode project in %s\n' "$PROJECT_DIR"
xcodegen generate \
  --spec "$IOS_ROOT/project.yml" \
  --project "$PROJECT_DIR" \
  --project-root "$IOS_ROOT"

BUILD_OVERRIDES=(
  "DEVELOPMENT_TEAM=$TEAM_ID"
  "PRODUCT_BUNDLE_IDENTIFIER=$BUNDLE_ID"
  "MARKETING_VERSION=$MARKETING_VERSION"
  "CURRENT_PROJECT_VERSION=$BUILD_NUMBER"
  "INFOPLIST_FILE=$IOS_ROOT/App/Info.plist"
  "CODE_SIGN_ENTITLEMENTS=$IOS_ROOT/Config/Dev3.entitlements"
)

BUILD_SETTINGS="$(xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme Dev3 \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -showBuildSettings \
  "${BUILD_OVERRIDES[@]}")"

assert_build_setting DEVELOPMENT_TEAM "$TEAM_ID"
assert_build_setting PRODUCT_BUNDLE_IDENTIFIER "$BUNDLE_ID"
assert_build_setting MARKETING_VERSION "$MARKETING_VERSION"
assert_build_setting CURRENT_PROJECT_VERSION "$BUILD_NUMBER"
assert_build_setting INFOPLIST_FILE "$IOS_ROOT/App/Info.plist"
assert_build_setting CODE_SIGN_ENTITLEMENTS "$IOS_ROOT/Config/Dev3.entitlements"
printf 'Validated team, bundle, marketing version, and build number overrides.\n'

if [[ "$MODE" == "--validate-only" ]]; then
  xcodebuild \
    -project "$PROJECT_PATH" \
    -scheme Dev3 \
    -configuration Release \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$DERIVED_DATA_PATH" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    "${BUILD_OVERRIDES[@]}" \
    build

  BUILT_INFO_PLIST="$DERIVED_DATA_PATH/Build/Products/Release-iphonesimulator/dev3.app/Info.plist"
  [[ -f "$BUILT_INFO_PLIST" ]] || fail "Built Info.plist not found at $BUILT_INFO_PLIST."
  assert_plist_value "$BUILT_INFO_PLIST" CFBundleIdentifier "$BUNDLE_ID"
  assert_plist_value "$BUILT_INFO_PLIST" CFBundleShortVersionString "$MARKETING_VERSION"
  assert_plist_value "$BUILT_INFO_PLIST" CFBundleVersion "$BUILD_NUMBER"
  write_export_options
  assert_plist_value "$EXPORT_OPTIONS_PATH" destination export
  assert_plist_value "$EXPORT_OPTIONS_PATH" distributionBundleIdentifier "$BUNDLE_ID"
  assert_plist_value "$EXPORT_OPTIONS_PATH" manageAppVersionAndBuildNumber false
  assert_plist_value "$EXPORT_OPTIONS_PATH" method app-store-connect
  assert_plist_value "$EXPORT_OPTIONS_PATH" teamID "$TEAM_ID"
  printf 'Unsigned Release validation succeeded. No Apple credentials or signing assets were used.\n'
  exit 0
fi

require_command codesign

[[ ! -e "$ARCHIVE_PATH" ]] ||
  fail "Archive already exists at $ARCHIVE_PATH. Use a new BUILD_NUMBER or OUTPUT_DIR."

PROVISIONING_FLAGS=()
if [[ "$ALLOW_PROVISIONING_UPDATES" == true ]]; then
  PROVISIONING_FLAGS+=("-allowProvisioningUpdates")
fi

xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme Dev3 \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -archivePath "$ARCHIVE_PATH" \
  "${PROVISIONING_FLAGS[@]}" \
  "${BUILD_OVERRIDES[@]}" \
  CODE_SIGN_STYLE=Automatic \
  archive

ARCHIVED_INFO_PLIST="$ARCHIVE_PATH/Products/Applications/dev3.app/Info.plist"
ARCHIVED_APP="$ARCHIVE_PATH/Products/Applications/dev3.app"
ARCHIVED_ENTITLEMENTS_PATH="$OUTPUT_DIR/ArchivedEntitlements.plist"
[[ -f "$ARCHIVED_INFO_PLIST" ]] || fail "Archived Info.plist not found at $ARCHIVED_INFO_PLIST."
assert_plist_value "$ARCHIVED_INFO_PLIST" CFBundleIdentifier "$BUNDLE_ID"
assert_plist_value "$ARCHIVED_INFO_PLIST" CFBundleShortVersionString "$MARKETING_VERSION"
assert_plist_value "$ARCHIVED_INFO_PLIST" CFBundleVersion "$BUILD_NUMBER"
assert_signed_entitlements "$ARCHIVED_APP" "$ARCHIVED_ENTITLEMENTS_PATH"
printf 'Archive created at %s\n' "$ARCHIVE_PATH"

if [[ "$MODE" == "--archive" ]]; then
  exit 0
fi

[[ ! -e "$EXPORT_PATH" ]] ||
  fail "Export already exists at $EXPORT_PATH. Use a new BUILD_NUMBER or OUTPUT_DIR."

write_export_options

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS_PATH" \
  "${PROVISIONING_FLAGS[@]}"

IPA_PATH="$(find "$EXPORT_PATH" -maxdepth 1 -type f -name '*.ipa' -print -quit)"
[[ -n "$IPA_PATH" ]] || fail "No IPA was exported to $EXPORT_PATH."
printf 'App Store Connect IPA exported locally at %s\n' "$IPA_PATH"
printf 'Nothing was uploaded. Use Xcode Organizer or Transporter after reviewing the archive.\n'
