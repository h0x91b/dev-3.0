# dev3 for iOS

The native companion app targets iOS 17 and uses Swift 6 strict concurrency. XcodeGen generates the
thin app target, while reusable code lives in three local Swift packages.

## Requirements

- Xcode 26 or newer with an iOS simulator runtime
- XcodeGen 2.45 or newer
- SwiftFormat
- SwiftLint
- XcodeBuildMCP for agent-driven simulator QA

## Generate and build

```bash
cd ios
xcodegen generate
xcodebuild \
  -project Dev3.xcodeproj \
  -scheme Dev3 \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

`Dev3.xcodeproj` is generated and ignored. Change `project.yml`, then regenerate it.

## TestFlight archive and export

The release script requires the Apple team, explicit bundle ID, marketing version, and a build number
on every run. The checked-in `com.ittaiz.dev3` identifier remains a local development default; it is
not treated as the App Store identifier. Start with the unsigned path to
verify the generated project, Release build, and embedded version metadata without an Apple account:

```bash
cd ios
TEAM_ID=ABCDE12345 \
BUNDLE_ID=com.example.dev3 \
MARKETING_VERSION=1.0.0 \
BUILD_NUMBER=1 \
./scripts/archive-testflight.sh --validate-only
```

After the Apple account setup below, replace the example values and create either an Organizer-ready
archive or an archive plus a local App Store Connect IPA:

```bash
TEAM_ID=ABCDE12345 \
BUNDLE_ID=com.example.dev3 \
MARKETING_VERSION=1.0.0 \
BUILD_NUMBER=1 \
./scripts/archive-testflight.sh --archive

# Or export the IPA locally as well. This still does not upload anything.
TEAM_ID=ABCDE12345 \
BUNDLE_ID=com.example.dev3 \
MARKETING_VERSION=1.0.0 \
BUILD_NUMBER=1 \
./scripts/archive-testflight.sh --archive-and-export
```

Artifacts are written to `build/testflight/<version>-<build>/`. Existing archives and exports are
never overwritten. If Xcode is already signed in but needs permission to fetch or update provisioning
assets, explicitly add `--allow-provisioning-updates`; the script never enables it by default.

`--validate-only` deliberately disables code signing. It validates compilation and metadata, but an
unsigned Simulator app has no signed `application-identifier` or `keychain-access-groups` entitlement
and therefore cannot validate Keychain persistence across relaunches or reboots. After a signed
archive, the script verifies the signature and fails unless the archived entitlements contain the
requested team, the explicit bundle ID, and its default Keychain access group. The account-backed
archive step is still required before treating secure credential persistence as release-validated.

### Apple-account handoff

These steps require the Apple Developer Program account owner or a teammate with the listed role:

1. The Account Holder must keep the team enrolled in the
   [Apple Developer Program](https://developer.apple.com/programs/) and accept Apple's latest
   developer agreement. Without active membership, Xcode cannot create a TestFlight archive.
2. In Apple Developer **Certificates, Identifiers & Profiles**, an Account Holder or Admin must
   [register an explicit App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id)
   whose bundle ID exactly matches `BUNDLE_ID`.
3. In App Store Connect **Apps**, an Account Holder, Admin, or App Manager must
   [create the app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
   with that same bundle ID. Record the ten-character Team ID from the developer account's
   **Membership details** and choose a new build number for each upload.
4. In Xcode, open **Xcode → Settings → Accounts**, add the Apple Account, and select the intended team.
   When Apple requests two-factor authentication, approve the sign-in on a trusted device and enter
   its six-digit code. Do not put an Apple password or app-specific password in this script.
5. Run `--archive` or `--archive-and-export`. If automatic signing reports that a certificate or
   profile is unavailable, let the Account Holder/Admin create the distribution asset or deliberately
   rerun with `--allow-provisioning-updates` after confirming the team shown by Xcode.
6. Open the generated archive once, for example with
   `open build/testflight/1.0.0-1/Dev3.xcarchive`. In Xcode, choose
   **Window → Organizer → Archives**, select **Dev3**, then
   **Distribute App → TestFlight & App Store → Upload**. Confirm the displayed team, bundle ID, version,
   and build before upload. A user with Account Holder, Admin, App Manager, or Developer role can
   [upload the build](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/).
   The script itself never uploads.
7. In App Store Connect, open **Apps → the app → TestFlight** and wait for processing to complete.
   If the build shows **Missing Compliance**, open the build and
   [provide export-compliance information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds).
   Review the app's actual encryption use and answer the questions; this repository deliberately does
   not claim an exemption in `Info.plist` without the account owner's confirmation.
8. Add internal testers when the processed build is ready. External testing additionally requires
   TestFlight test information and Apple's TestFlight App Review before external testers can install.

## Test and lint

```bash
cd ios
swiftformat --lint .
swiftlint lint --strict --config .swiftlint.yml

for package in Packages/Dev3Kit Packages/Dev3TerminalKit Packages/Dev3UI; do
  swift test --package-path "$package"
done

xcodegen generate
SIMULATOR_UDID="$(./scripts/select-test-simulator.sh)"
xcodebuild \
  -project Dev3.xcodeproj \
  -scheme Dev3 \
  -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  CODE_SIGNING_ALLOWED=NO \
  test
```

The simulator selector deterministically picks the alphabetically first available iPhone on the
newest installed iOS runtime. The `Dev3` Xcode scheme runs both app-target XCTest/Swift Testing suites
and simulator UI coverage for manual pairing, validation, and the connected shell. The live runtime UI
test skips unless its integration environment is configured. Camera scanning is device-only;
Simulator deliberately points testers to the manual route. The current app-target CI baseline is 45
tests discovered: 44 pass and the opt-in live integration test skips without its environment.

## Live pairing integration

The integration test is opt-in and never writes to Keychain. Start a local remote server with a static
development code from the repository root:

```bash
dev3 remote --no-tunnel --static-code ios-test-code --port 4242
```

In another terminal, exchange the native iOS credential and roll it once through `/auth/refresh`:

```bash
DEV3_INTEGRATION_ORIGIN=http://127.0.0.1:4242 \
DEV3_INTEGRATION_CODE=ios-test-code \
swift test --package-path ios/Packages/Dev3Kit \
  --filter SessionLiveIntegrationTests
```

For an end-to-end Simulator check, run the app, choose **Enter address manually**, enter the same
origin and code, name the instance, then tap **Connect**. The Work tab should report **Connected to
dev3** and the chosen name. Use a fresh static code or restart the server if the server configuration
does not allow code reuse.

## Package boundaries

- `Dev3Kit`: connection, RPC, PTY, model, and store primitives.
- `Dev3TerminalKit`: SwiftTerm integration and terminal interaction behavior.
- `Dev3UI`: design tokens and reusable SwiftUI components.

Pairing, secure session rotation, saved-instance selection, and Bonjour reconnection are functional.
Work and Projects support readiness and project navigation, task creation and actions, live terminals,
Task Info, review details, shared media, notifications, and native completion approval.
