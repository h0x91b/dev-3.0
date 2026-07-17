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
  --archive              Create an unsigned device archive for Xcode Organizer distribution.
  --archive-and-export   Create the device archive and export a signed App Store Connect IPA.

Optional environment:
  OUTPUT_DIR             Artifact directory. Defaults to build/testflight/<version>-<build>.

The script never uploads to App Store Connect. Device archives are intentionally unsigned so teams
without registered development devices can reach Xcode's cloud-managed distribution signing during
export. The provisioning flag is opt-in because export may update App IDs, certificates, or profiles.
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

  actual="$(plutil -extract "$key" raw -o - "$plist" 2>/dev/null)" ||
    fail "Could not read $key from $plist."
  [[ "$actual" == "$expected" ]] || fail "$key in $plist is '$actual', expected '$expected'."
}

assert_privacy_api_reason() {
  local manifest_path="$1"
  local expected_type="$2"
  local expected_reason="$3"
  local api_index=0
  local actual_type
  local reason_index
  local actual_reason

  while actual_type="$(
    plutil -extract "NSPrivacyAccessedAPITypes.$api_index.NSPrivacyAccessedAPIType" raw -o - \
      "$manifest_path" 2>/dev/null
  )"; do
    if [[ "$actual_type" == "$expected_type" ]]; then
      reason_index=0
      while actual_reason="$(
        plutil -extract \
          "NSPrivacyAccessedAPITypes.$api_index.NSPrivacyAccessedAPITypeReasons.$reason_index" \
          raw -o - "$manifest_path" 2>/dev/null
      )"; do
        if [[ "$actual_reason" == "$expected_reason" ]]; then
          return 0
        fi
        ((reason_index += 1))
      done
      fail "Privacy manifest API type '$expected_type' does not declare reason '$expected_reason': $manifest_path."
    fi
    ((api_index += 1))
  done

  fail "Privacy manifest does not declare API type '$expected_type': $manifest_path."
}

assert_privacy_manifest() {
  local app_path="$1"
  local manifest_path="$app_path/PrivacyInfo.xcprivacy"

  [[ -f "$manifest_path" ]] ||
    fail "Privacy manifest was not embedded at $manifest_path. Check the app resources build phase."
  plutil -lint "$manifest_path" >/dev/null ||
    fail "Embedded privacy manifest is not a valid plist: $manifest_path."
  assert_privacy_api_reason \
    "$manifest_path" NSPrivacyAccessedAPICategoryUserDefaults CA92.1
  assert_privacy_api_reason \
    "$manifest_path" NSPrivacyAccessedAPICategoryFileTimestamp C617.1
  printf 'Validated embedded UserDefaults and file-timestamp privacy declarations at %s\n' \
    "$manifest_path"
}

write_export_options() {
  plutil -create xml1 "$EXPORT_OPTIONS_PATH" || fail "Could not create $EXPORT_OPTIONS_PATH."
  plutil -insert destination -string export "$EXPORT_OPTIONS_PATH" ||
    fail "Could not set the export destination."
  plutil -insert distributionBundleIdentifier -string "$BUNDLE_ID" "$EXPORT_OPTIONS_PATH" ||
    fail "Could not set the export bundle identifier."
  plutil -insert manageAppVersionAndBuildNumber -bool false "$EXPORT_OPTIONS_PATH" ||
    fail "Could not disable automatic build-number management."
  plutil -insert method -string app-store-connect "$EXPORT_OPTIONS_PATH" ||
    fail "Could not set the App Store Connect export method."
  plutil -insert signingStyle -string automatic "$EXPORT_OPTIONS_PATH" ||
    fail "Could not enable automatic distribution signing."
  plutil -insert stripSwiftSymbols -bool true "$EXPORT_OPTIONS_PATH" ||
    fail "Could not enable Swift-symbol stripping."
  plutil -insert teamID -string "$TEAM_ID" "$EXPORT_OPTIONS_PATH" ||
    fail "Could not set the export team."
  plutil -insert uploadSymbols -bool true "$EXPORT_OPTIONS_PATH" ||
    fail "Could not enable symbol inclusion."
  plutil -lint "$EXPORT_OPTIONS_PATH" >/dev/null ||
    fail "Generated export options are not a valid plist."
}

assert_device_binary() {
  local app_path="$1"
  local info_plist="$app_path/Info.plist"
  local executable_name
  local executable_path
  local platform_name
  local architectures

  executable_name="$(plutil -extract CFBundleExecutable raw -o - "$info_plist" 2>/dev/null)" ||
    fail "Could not read CFBundleExecutable from $info_plist."
  [[ -n "$executable_name" && "$executable_name" != */* && "$executable_name" != . &&
    "$executable_name" != .. ]] || fail "Unsafe CFBundleExecutable '$executable_name'."
  executable_path="$app_path/$executable_name"
  [[ -f "$executable_path" && -x "$executable_path" ]] ||
    fail "Executable app binary not found at $executable_path."
  platform_name="$(plutil -extract DTPlatformName raw -o - "$info_plist" 2>/dev/null)" ||
    fail "Could not read DTPlatformName from $info_plist."
  architectures="$(lipo -archs "$executable_path" 2>/dev/null)" ||
    fail "Could not read architectures from $executable_path."

  [[ "$platform_name" == iphoneos ]] ||
    fail "DTPlatformName is '$platform_name', expected 'iphoneos'."
  [[ "$architectures" == arm64 ]] ||
    fail "Device executable architectures are '$architectures', expected exactly 'arm64'."
}

assert_unsigned_archive() {
  local app_path="$1"

  if codesign --verify --strict "$app_path" >/dev/null 2>&1; then
    fail "Device archive is unexpectedly signed; distribution signing must happen during export."
  fi
}

assert_signed_entitlements() {
  local app_path="$1"
  local entitlements_path="$2"
  local profile_path="$3"
  local application_identifier
  local explicit_keychain_group
  local get_task_allow
  local beta_reports_active
  local signed_team_identifier

  codesign --verify --deep --strict "$app_path" || fail "Exported app signature verification failed."
  codesign -d --entitlements :- "$app_path" >"$entitlements_path" 2>/dev/null ||
    fail "Could not read entitlements from the signed export."
  plutil -lint "$entitlements_path" >/dev/null ||
    fail "Exported entitlements are not a valid plist."

  signed_team_identifier="$(
    /usr/libexec/PlistBuddy -c 'Print :com.apple.developer.team-identifier' "$entitlements_path"
  )" 2>/dev/null || fail "Signed export has no team identifier entitlement."
  application_identifier="$(
    plutil -extract application-identifier raw -o - "$entitlements_path" 2>/dev/null
  )" || fail "Signed export has no application identifier entitlement."
  get_task_allow="$(
    plutil -extract get-task-allow raw -o - "$entitlements_path" 2>/dev/null
  )" || fail "Signed export has no get-task-allow entitlement."
  beta_reports_active="$(
    plutil -extract beta-reports-active raw -o - "$entitlements_path" 2>/dev/null
  )" || fail "Signed export has no beta-reports-active entitlement."

  [[ "$signed_team_identifier" == "$TEAM_ID" ]] ||
    fail "Signed team '$signed_team_identifier' does not match TEAM_ID '$TEAM_ID'."
  [[ "$application_identifier" == "$TEAM_ID.$BUNDLE_ID" ]] ||
    fail "Application identifier '$application_identifier' does not match '$TEAM_ID.$BUNDLE_ID'."
  [[ "$get_task_allow" == false ]] ||
    fail "get-task-allow is '$get_task_allow', expected false for App Store distribution."
  [[ "$beta_reports_active" == true ]] ||
    fail "beta-reports-active is '$beta_reports_active', expected true for TestFlight."

  if explicit_keychain_group="$(
    plutil -extract keychain-access-groups.0 raw -o - "$entitlements_path" 2>/dev/null
  )"; then
    [[ "$explicit_keychain_group" == "$application_identifier" ]] ||
      fail "Explicit Keychain group '$explicit_keychain_group' does not match '$application_identifier'."
    if plutil -extract keychain-access-groups.1 raw -o - "$entitlements_path" >/dev/null 2>&1; then
      fail "Signed export contains more than one Keychain access group."
    fi
  fi

  [[ -f "$app_path/embedded.mobileprovision" ]] ||
    fail "Signed export has no embedded Store provisioning profile."

  security cms -D -i "$app_path/embedded.mobileprovision" >"$profile_path" 2>/dev/null ||
    fail "Could not decode the embedded Store provisioning profile."
  plutil -lint "$profile_path" >/dev/null ||
    fail "Embedded Store provisioning profile is not a valid plist."
  assert_store_profile "$profile_path" "$application_identifier"
}

assert_store_profile() {
  local profile_path="$1"
  local application_identifier="$2"
  local profile_name
  local profile_group
  local profile_group_index=0
  local profile_allows_default=false

  assert_plistbuddy_value "$profile_path" TeamIdentifier:0 "$TEAM_ID"
  assert_plistbuddy_value \
    "$profile_path" Entitlements:application-identifier "$application_identifier"
  assert_plistbuddy_value "$profile_path" Entitlements:get-task-allow false
  assert_plistbuddy_value "$profile_path" Entitlements:beta-reports-active true

  profile_name="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$profile_path" 2>/dev/null)" ||
    fail "Embedded provisioning profile has no name."
  [[ "$profile_name" == "iOS Team Store Provisioning Profile:"* ]] ||
    fail "Embedded profile '$profile_name' is not an Xcode-managed Store profile."

  while profile_group="$(
    /usr/libexec/PlistBuddy \
      -c "Print :Entitlements:keychain-access-groups:$profile_group_index" \
      "$profile_path" 2>/dev/null
  )"; do
    if [[ "$profile_group" == "$application_identifier" ]]; then
      profile_allows_default=true
      break
    fi
    if [[ "$profile_group" == *\* ]]; then
      local profile_group_prefix="${profile_group%\*}"
      if [[ "$profile_group_prefix" != *\** &&
        "$application_identifier" == "$profile_group_prefix"* ]]; then
        profile_allows_default=true
        break
      fi
    fi
    profile_group_index=$((profile_group_index + 1))
  done

  [[ "$profile_allows_default" == true ]] ||
    fail "Store profile Keychain groups do not permit default group '$application_identifier'."
}

assert_safe_ipa() {
  local ipa_path="$1"
  local entry
  local entry_count=0

  unzip -tqq "$ipa_path" >/dev/null || fail "Exported IPA is not a valid ZIP archive: $ipa_path."
  while IFS= read -r entry; do
    entry_count=$((entry_count + 1))
    case "$entry" in
      /* | [A-Za-z]:* | *\\*) fail "IPA contains an unsafe path: $entry." ;;
    esac
    case "/$entry/" in
      *'/../'* | *'/./'*) fail "IPA contains an unsafe path component: $entry." ;;
    esac
  done < <(unzip -Z1 "$ipa_path")
  ((entry_count > 0)) || fail "Exported IPA is empty: $ipa_path."

  if zipinfo -l "$ipa_path" | awk '
    substr($1, 1, 1) == "l" { found = 1 }
    END { exit found ? 0 : 1 }
  '; then
    fail "Exported IPA contains a symbolic link and will not be expanded."
  fi
}

assert_plistbuddy_value() {
  local plist="$1"
  local key_path="$2"
  local expected="$3"
  local actual

  actual="$(/usr/libexec/PlistBuddy -c "Print :$key_path" "$plist" 2>/dev/null)" ||
    fail "Could not read $key_path from $plist."
  [[ "$actual" == "$expected" ]] ||
    fail "$key_path in $plist is '$actual', expected '$expected'."
}

assert_distribution_summary() {
  local summary_path="$1"
  local ipa_name="$2"
  local app_name="$3"
  local summary_root

  [[ "$ipa_name" != *:* && "$ipa_name" != *$'\n'* ]] ||
    fail "Unsafe IPA filename in distribution summary: $ipa_name."
  plutil -lint "$summary_path" >/dev/null ||
    fail "Distribution summary is not a valid plist: $summary_path."
  summary_root="$ipa_name:0"
  assert_plistbuddy_value "$summary_path" "$summary_root:name" "$app_name"
  assert_plistbuddy_value "$summary_path" "$summary_root:architectures:0" arm64
  assert_plistbuddy_value "$summary_path" "$summary_root:buildNumber" "$BUILD_NUMBER"
  assert_plistbuddy_value "$summary_path" "$summary_root:versionNumber" "$MARKETING_VERSION"
  assert_plistbuddy_value "$summary_path" "$summary_root:team:id" "$TEAM_ID"
  assert_plistbuddy_value \
    "$summary_path" "$summary_root:certificate:type" "Cloud Managed Apple Distribution"
  assert_plistbuddy_value \
    "$summary_path" "$summary_root:entitlements:application-identifier" "$TEAM_ID.$BUNDLE_ID"
  assert_plistbuddy_value \
    "$summary_path" "$summary_root:entitlements:com.apple.developer.team-identifier" "$TEAM_ID"
  assert_plistbuddy_value "$summary_path" "$summary_root:entitlements:get-task-allow" false
  assert_plistbuddy_value "$summary_path" "$summary_root:entitlements:beta-reports-active" true

  if /usr/libexec/PlistBuddy -c "Print :$ipa_name:1" "$summary_path" >/dev/null 2>&1; then
    fail "Distribution summary contains more than one record for $ipa_name."
  fi
  if /usr/libexec/PlistBuddy \
    -c "Print :$summary_root:architectures:1" "$summary_path" >/dev/null 2>&1; then
    fail "Distribution summary contains more than one architecture for $ipa_name."
  fi
}

protect_packaging_log() {
  if [[ -n "${PACKAGING_LOG:-}" && -f "$PACKAGING_LOG" ]]; then
    chmod 600 "$PACKAGING_LOG" || fail "Could not protect Xcode's packaging log."
  fi
}

protect_packaging_log_best_effort() {
  if [[ -n "${PACKAGING_LOG:-}" && -f "$PACKAGING_LOG" ]]; then
    chmod 600 "$PACKAGING_LOG" 2>/dev/null || true
  fi
  if [[ -n "${DECODED_PROFILE_PATH:-}" && -f "$DECODED_PROFILE_PATH" ]]; then
    rm -f "$DECODED_PROFILE_PATH" 2>/dev/null || true
  fi
}

assert_matching_dsym() {
  local app_path="$1"
  local dsym_path="$2"
  local executable_name
  local app_uuid
  local dsym_uuid

  executable_name="$(plutil -extract CFBundleExecutable raw -o - "$app_path/Info.plist" 2>/dev/null)" ||
    fail "Could not read the exported app executable name."
  [[ -f "$dsym_path/Contents/Resources/DWARF/$executable_name" ]] ||
    fail "Archive dSYM executable not found for $executable_name."
  app_uuid="$(dwarfdump --uuid "$app_path/$executable_name" | awk '/UUID:/{print $2}')" ||
    fail "Could not read the exported app UUID."
  dsym_uuid="$(
    dwarfdump --uuid "$dsym_path/Contents/Resources/DWARF/$executable_name" | awk '/UUID:/{print $2}'
  )" || fail "Could not read the archive dSYM UUID."
  [[ -n "$app_uuid" && "$app_uuid" == "$dsym_uuid" ]] ||
    fail "Exported app UUID '$app_uuid' does not match archive dSYM UUID '$dsym_uuid'."
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
  assert_privacy_manifest "$(dirname "$BUILT_INFO_PLIST")"
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
require_command ditto
require_command dwarfdump
require_command lipo
require_command security
require_command unzip
require_command zipinfo

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
  "${BUILD_OVERRIDES[@]}" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  archive

ARCHIVED_INFO_PLIST="$ARCHIVE_PATH/Products/Applications/dev3.app/Info.plist"
ARCHIVED_APP="$ARCHIVE_PATH/Products/Applications/dev3.app"
[[ -f "$ARCHIVED_INFO_PLIST" ]] || fail "Archived Info.plist not found at $ARCHIVED_INFO_PLIST."
assert_plist_value "$ARCHIVED_INFO_PLIST" CFBundleIdentifier "$BUNDLE_ID"
assert_plist_value "$ARCHIVED_INFO_PLIST" CFBundleShortVersionString "$MARKETING_VERSION"
assert_plist_value "$ARCHIVED_INFO_PLIST" CFBundleVersion "$BUILD_NUMBER"
assert_privacy_manifest "$ARCHIVED_APP"
assert_device_binary "$ARCHIVED_APP"
assert_unsigned_archive "$ARCHIVED_APP"
printf 'Unsigned device archive created at %s\n' "$ARCHIVE_PATH"

if [[ "$MODE" == "--archive" ]]; then
  printf 'Open this archive in Xcode Organizer to apply distribution signing and upload.\n'
  exit 0
fi

[[ ! -e "$EXPORT_PATH" ]] ||
  fail "Export already exists at $EXPORT_PATH. Use a new BUILD_NUMBER or OUTPUT_DIR."

write_export_options

PACKAGING_LOG="$EXPORT_PATH/Packaging.log"
trap protect_packaging_log_best_effort EXIT
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS_PATH" \
  "${PROVISIONING_FLAGS[@]}"

protect_packaging_log

shopt -s nullglob
IPA_PATHS=("$EXPORT_PATH"/*.ipa)
shopt -u nullglob
[[ "${#IPA_PATHS[@]}" == 1 ]] ||
  fail "Expected exactly one IPA in $EXPORT_PATH, found ${#IPA_PATHS[@]}."
IPA_PATH="${IPA_PATHS[0]}"
assert_safe_ipa "$IPA_PATH"

EXPANDED_IPA_PATH="$OUTPUT_DIR/expanded-ipa"
[[ ! -e "$EXPANDED_IPA_PATH" ]] ||
  fail "Expanded IPA already exists at $EXPANDED_IPA_PATH. Use a new BUILD_NUMBER or OUTPUT_DIR."
mkdir -p "$EXPANDED_IPA_PATH"
ditto -x -k "$IPA_PATH" "$EXPANDED_IPA_PATH"

[[ -d "$EXPANDED_IPA_PATH/Payload" ]] || fail "Exported IPA has no Payload directory."
shopt -s nullglob
EXPORTED_APP_PATHS=("$EXPANDED_IPA_PATH"/Payload/*.app)
shopt -u nullglob
[[ "${#EXPORTED_APP_PATHS[@]}" == 1 && -d "${EXPORTED_APP_PATHS[0]}" ]] ||
  fail "Expected exactly one top-level app in the IPA, found ${#EXPORTED_APP_PATHS[@]}."
EXPORTED_APP="${EXPORTED_APP_PATHS[0]}"
EXPORTED_INFO_PLIST="$EXPORTED_APP/Info.plist"
EXPORTED_ENTITLEMENTS_PATH="$OUTPUT_DIR/ExportedEntitlements.plist"
DISTRIBUTION_SUMMARY_PATH="$EXPORT_PATH/DistributionSummary.plist"
DECODED_PROFILE_PATH="$(mktemp "${TMPDIR:-/tmp}/dev3-testflight-profile.XXXXXX")" ||
  fail "Could not create a temporary provisioning-profile plist."

assert_plist_value "$EXPORTED_INFO_PLIST" CFBundleIdentifier "$BUNDLE_ID"
assert_plist_value "$EXPORTED_INFO_PLIST" CFBundleShortVersionString "$MARKETING_VERSION"
assert_plist_value "$EXPORTED_INFO_PLIST" CFBundleVersion "$BUILD_NUMBER"
assert_privacy_manifest "$EXPORTED_APP"
assert_device_binary "$EXPORTED_APP"
assert_signed_entitlements \
  "$EXPORTED_APP" "$EXPORTED_ENTITLEMENTS_PATH" "$DECODED_PROFILE_PATH"
assert_distribution_summary \
  "$DISTRIBUTION_SUMMARY_PATH" "$(basename "$IPA_PATH")" "$(basename "$EXPORTED_APP")"
assert_matching_dsym "$EXPORTED_APP" "$ARCHIVE_PATH/dSYMs/dev3.app.dSYM"

rm -f "$PACKAGING_LOG" "$DECODED_PROFILE_PATH"
trap - EXIT
printf 'App Store Connect IPA exported locally at %s\n' "$IPA_PATH"
printf 'Validated cloud Apple Distribution signing, release entitlements, platform, and dSYM.\n'
printf 'Nothing was uploaded. Use Xcode Organizer or Transporter after reviewing the archive.\n'
