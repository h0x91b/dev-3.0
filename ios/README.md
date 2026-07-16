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
