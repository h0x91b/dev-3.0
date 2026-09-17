# Freeze diagnostics is a setting, not an env var

## Context

Local freeze diagnostics shipped behind `DEV3_DEBUG=1` (`decisions/2026/09/16/observe-freezes-outside-the-host-loop.md`). A GUI app started from Finder or the Dock does not inherit a login-shell profile the way a terminal launch does, so the switch was both hard to find and unreliable in exactly the situation it exists for: the app is already misbehaving and the user wants evidence now, not after editing `~/.zshrc` and relaunching.

## Investigation

The collector was created once at module scope in `index.ts` and gated on the environment, so activation could only happen at launch. Nothing else in the feature needed the variable: the renderer heartbeat and the window events are sent unconditionally, and `recordFreezeDiagnostic` is already a no-op while no worker is attached. `shell-env.ts` also carried a carve-out letting this one `DEV3_*` name through the otherwise blocked prefix — that existed only to feed this gate.

## Decision

`GlobalSettings.freezeDiagnosticsEnabled` (default off, only an explicit `true` stored) drives it. `freeze-diagnostics.ts` splits into `configureFreezeDiagnostics` (remembers the packaged worker path) and `applyFreezeDiagnosticsSetting(enabled, platform)`, which starts or stops the worker idempotently; `index.ts` applies the saved value at startup via `loadSettingsSync`, and `saveGlobalSettings` applies it again whenever the stored value changes, so a toggle takes effect in the running app in both directions. `getFreezeDiagnosticsStatus` reports `supported`/`running`/`directory` from the host, which is what lets the row in Settings → System → Advanced Experience state the truth on Linux, Windows and in a remote browser. The `DEV3_DEBUG` gate and the `shell-env.ts` carve-out are gone; the CLI's unrelated `DEV3_DEBUG` socket diagnostics are untouched.

## Risks

Stopping the collector leaves already-written journals and samples on disk; they expire through the existing five-session rotation rather than being deleted, which is deliberate — the evidence usually outlives the switch. Off/on within one session opens a new journal and resets the three-samples-per-run budget, so a user toggling repeatedly can take more samples than one launch used to allow; each one is still bounded in time and size. A remote browser can flip a switch that affects the host machine, the same as every other global setting.

## Alternatives considered

Keeping the variable and adding a UI mirror would have left two sources of truth and the same Finder problem. A restart-required setting was rejected because a diagnostic you cannot arm while the app is misbehaving is worth little. A separate Settings section was rejected over reusing Advanced Experience, which already groups opt-in behaviour that states its own limitations.
