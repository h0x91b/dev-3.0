# Block launching dev3 from a read-only location on macOS

## Context
A user always opened dev3 straight from the DMG on her Desktop. macOS ran it from a hidden read-only App Translocation copy, so every in-app update downloaded and then could not install. `decisions/2026/11/04/macos-update-swap-preflight.md` made the update fail visibly; this record moves the catch to launch, before days of silent drift.

## Decision
`src/bun/launch-location.ts` `detectLaunchLocationIssue()` flags the running bundle when `macBundleReplaceBlocker()` (reused from updater.ts, not duplicated) refuses it — App Translocation, a read-only DMG, any unwritable folder. It never flags the `dev` channel, non-macOS, or a bundle already under `/Applications` or `~/Applications` (an unwritable install there, e.g. MDM-owned, gets nothing useful from "move to Applications"; the updater still explains it). `/Volumes/` alone is not a trigger: a writable external drive or sparse image updates fine, so `hdiutil info` is only used to name the case and find the volume to eject.

The renderer shows `LaunchLocationGate`: a blocking React alertdialog with no dismiss path, primary "Move to Applications", secondary "Quit", desktop only (`isRemote()` skips it). Move = `ditto` into a staging sibling, strip `com.apple.quarantine` (a quarantined copy would be translocated again), swap it in over an older copy (restoring it on failure; a newer copy is launched untouched so the shared `~/.dev3.0` is never downgraded), then a detached `/bin/sh` helper waits for this PID to exit, `open`s the new copy and `hdiutil detach`es the installer. It waits because a second instance launched while we still run would hand off to us. `open` hands the new copy launchd's environment, so an explicitly set `DEV3_HOME` / `TMUX_TMPDIR` is forwarded with `open --env` — otherwise a scoped instance would wake up on the real board. `DEV3_APPLICATIONS_DIR` redirects the destination for QA.

## Risks
Stripping quarantine skips Gatekeeper's first-launch prompt for the copy; it is the same signed bundle the user already approved by running it (LetsMove does the same). Finding the DMG behind a translocated copy is heuristic (a mounted image holding a same-named app); when it misses, the copy still succeeds and only the eject is skipped. Global app shortcuts still fire behind the gate, but nothing they open can rise above it.

## Alternatives considered
Manual instructions only — this user demonstrably did not know to drag the app into Applications, so it would stall the same way; kept only as the failure fallback. A non-blocking banner — ignorable, and the original failure was a quiet "Restarting…" ignored for days. Native `showMessageBox` — banned (remote mode, AGENTS.md).
