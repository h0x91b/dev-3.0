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

## Simulator quick-connect (DEBUG only)

The Simulator's accessibility tree is not exposed to UI-automation tools, and its keyboard is awkward,
so pairing by hand is painful. DEBUG builds (never Release/TestFlight) read launch **env vars** that
skip pairing and jump straight to a screen under test — pair the sim once, iterate fast, no TestFlight:

- `DEV3_AUTOPAIR_ORIGIN`, `DEV3_AUTOPAIR_TOKEN`, `DEV3_AUTOPAIR_INSTANCE`, `DEV3_AUTOPAIR_NAME` — seed a
  paired server into the Keychain on launch so the app auto-connects. Mint a token against the shared
  secret (`initSecret(); createSessionToken("ios")`) or exchange a `--static-code` server's code.
- `DEV3_AUTOOPEN_PROJECT`, `DEV3_AUTOOPEN_TASK` — once connected and the task has loaded, open its
  terminal automatically.

Point `DEV3_AUTOPAIR_ORIGIN` at the **instance that owns the task's PTY session** (the running desktop /
`bun run dev` server) — a *different* `dev3 remote` instance returns "Unknown session" for a task it did
not spawn. Wiring lives in `App/Dev3App.swift` behind `#if DEBUG`.

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

The device-archive path also works without an Apple account, distribution certificate, provisioning
profile, or registered physical device. It creates an unsigned `iphoneos`/arm64 archive and validates
its metadata, executable, and privacy manifest. This is an inspection artifact; its intentionally empty
team and signing identity make it unsuitable for Organizer distribution:

```bash
TEAM_ID=ABCDE12345 \
BUNDLE_ID=com.example.dev3 \
MARKETING_VERSION=1.0.0 \
BUILD_NUMBER=1 \
./scripts/archive-testflight.sh --archive
```

After the Apple account setup below, choose one release path. Export a cloud-signed IPA when you want
to review the exact artifact and upload it separately with Transporter. `destination=export` prevents
this command from uploading:

```bash
TEAM_ID=ABCDE12345 \
BUNDLE_ID=com.example.dev3 \
MARKETING_VERSION=1.0.0 \
BUILD_NUMBER=1 \
./scripts/archive-testflight.sh --archive-and-export --allow-provisioning-updates
```

Or explicitly ask Xcode to cloud-sign and upload the build directly. This is the only script mode that
transfers a build to App Store Connect, and it does not produce a local IPA:

```bash
TEAM_ID=ABCDE12345 \
BUNDLE_ID=com.example.dev3 \
MARKETING_VERSION=1.0.0 \
BUILD_NUMBER=1 \
./scripts/archive-testflight.sh --archive-and-upload --allow-provisioning-updates
```

`--allow-provisioning-updates` acknowledges that Xcode may create or update the App ID, cloud-managed
distribution certificate, or Store profile. Artifacts are written to
`build/testflight/<version>-<build>/`, and existing archives and distribution outputs are never
overwritten. The local export path safely expands and validates exactly one IPA and app, its cloud
Apple Distribution signature, exact team and application identifier, Store entitlements, effective
default Keychain group, device platform, arm64 executable, privacy declarations, and matching dSYM.
Xcode's account/session `Packaging.log` is protected during failure handling and removed after success;
the decoded profile copy used by local validation is temporary and removed on every exit path.

The account owner confirmed that the app implements none of Apple's listed encryption algorithms. It
uses only Apple-provided HTTPS/WSS/TLS and Keychain services, so `Info.plist` declares
`ITSAppUsesNonExemptEncryption=false`. Every script mode validates that declaration in the checked-in
metadata and its built product before it can finish; local export also revalidates the signed app.

`--validate-only` deliberately disables code signing. It validates compilation and metadata, but an
unsigned Simulator app has no signed `application-identifier` or `keychain-access-groups` entitlement
and therefore cannot validate Keychain persistence across relaunches or reboots. The unsigned device
archive is likewise an inspection artifact, not an installable build; distribution signing is applied
only to the exported IPA. With the empty source entitlements, Xcode 26 omits an explicit
`keychain-access-groups` entry from the signed app and the platform uses the app identifier as its
effective default group. Export validation accepts that omission and rejects any explicit group other
than the exact `TEAM_ID.BUNDLE_ID`, while also requiring `get-task-allow=false` and
`beta-reports-active=true`.

### Apple-account handoff

These steps require the Apple Developer Program account owner or a teammate with the listed role:

1. The Account Holder must keep the team enrolled in the
   [Apple Developer Program](https://developer.apple.com/programs/) and accept Apple's latest
   developer agreement. Without active membership, Xcode cannot sign a TestFlight build for distribution.
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
5. Choose either `--archive-and-export --allow-provisioning-updates` for a validated local IPA or
   `--archive-and-upload --allow-provisioning-updates` for an explicit direct upload. Xcode can
   cloud-sign the unsigned intermediate, so no physical iOS device or local Apple Distribution
   identity is required. Confirm the requested team before allowing Xcode to create or refresh
   developer-portal signing assets.
6. For the export path, inspect `export/dev3.ipa`, then deliver that IPA with Transporter. For the
   direct path, successful script completion means Xcode sent the build to App Store Connect. Confirm
   the team, bundle ID, version, and build before either upload. A user with Account Holder, Admin,
   App Manager, or Developer role can
   [upload the build](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/).
   No script mode other than `--archive-and-upload` uploads.
7. In App Store Connect, open **Apps → the app → TestFlight** and wait for processing to complete.
   The checked-in export-compliance declaration should let builds advance without a per-build Missing
   Compliance gate. Reassess and update it before release if the app begins implementing encryption.
8. **Every new build must be distributed to the Internal group explicitly — a fresh upload does NOT
   auto-appear in the TestFlight app.** After processing, open **App Store Connect → dev3 Beta →
   TestFlight → Build Activity → the specific build (e.g. `1.0.0 (4)`) → Add Groups → Internal**
   (the App Store Connect iOS app works too). Only then does the build show up in testers' TestFlight
   app as an available install/update. External testing additionally requires TestFlight test
   information and Apple's TestFlight App Review before external testers can install.

The initial `1.0.0 (1)` upload is **Ready to Test**, assigned to the **Internal** group, and the account
owner has been invited as an internal tester. It predates the QR-pairing fixes in decisions 145 and 146,
so upload the next build from `7468daf6` or later before the release smoke test.

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
Simulator deliberately points testers to the manual route. The current app-target CI baseline is 52
tests discovered: 51 pass and the opt-in live integration test skips without its environment.

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
