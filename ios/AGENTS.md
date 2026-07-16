# iOS agent instructions

The repository-level `AGENTS.md` applies here. These rules narrow the native iOS workflow.

## Project definition

- `project.yml` is the only Xcode project definition. Never hand-edit or commit `Dev3.xcodeproj`.
- Keep the application target thin. Reusable logic belongs in `Packages/Dev3Kit`, terminal code in
  `Packages/Dev3TerminalKit`, and shared visual code in `Packages/Dev3UI`.
- Target iOS 17 or newer and Swift 6 with complete strict concurrency checking.
- Prefer SwiftUI observation and environment APIs. Do not introduce view models solely to mirror view state.

## Verification workflow

Run these commands from `ios/` before committing native changes:

```bash
xcodegen generate
swiftformat --lint .
swiftlint lint --strict --config .swiftlint.yml
for package in Packages/Dev3Kit Packages/Dev3TerminalKit Packages/Dev3UI; do
  swift test --package-path "$package"
done
```

Use XcodeBuildMCP for simulator verification:

1. `build_run_sim` with project `Dev3.xcodeproj`, scheme `Dev3`, and an available iPhone simulator.
2. `screenshot` and `snapshot_ui` after launch. Check the visible result and accessibility tree.
3. Exercise the changed flow with UI automation.
4. `test_sim` for the `Dev3` scheme.

Every interactive control needs a stable `accessibilityIdentifier`. Verify light and dark appearances,
Dynamic Type, loading/empty/error states when applicable, and the simulator console before review.

## Dependencies and generated files

- SwiftTerm is consumed only through the `Dev3TerminalKit` package.
- The bundled JetBrains Mono Nerd Font must remain a TTF or OTF with its license files.
- Do not commit `.build`, `DerivedData`, result bundles, or generated Xcode project files.
