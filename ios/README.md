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
```

The `Dev3` Xcode scheme includes simulator UI coverage for manual pairing, validation, and the
connected shell. Camera scanning is device-only; Simulator deliberately points testers to the manual
route.

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
The connected Work and Projects surfaces remain intentionally small until their dedicated slices land.
