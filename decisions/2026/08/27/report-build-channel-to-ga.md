# Report the build channel and commit to GA

## Context

Every build reported the bare `app_version` to GA4, so a `bun run dev` session, a canary
build and a stable install on the same version number were one undistinguishable row.
Canary never announces itself in the analytics data: the `+canary.<sha>` suffix lives only
in the published manifest and deliberately never enters the bundle's `version.json`,
because `dev3 doctor` compares bundle version against CLI version by string equality.

## Decision

`initAnalytics(appVersion, buildChannel)` takes the channel baked into the bundle — the
same value `main.tsx` already had from `getAppVersion` and used for the window title
prefix (`[DEV from src]` / `[CANARY]`).

**The channel rides in `app_version` itself**, via `analyticsVersion()`: `1.48.1` stays
`1.48.1` for a stable install, and a non-stable build becomes `dev-1.48.1-1716-1` or
`canary-1.48.1`. That placement is the load-bearing part — `app_version` is one of GA4's
own dimensions and appears in every report unaided, whereas a user property shows nothing
until someone registers it as a custom dimension in the property's admin. `build_channel`
and `build_commit` still ship as user properties for filtering once registered, but the
version string is what makes a dev build visible without any GA configuration at all.

The `-1716-1` tail is the dev3 task the build came out of, baked in at build time by
`scripts/generate-build-info.ts` as `BUILD_TASK_LABEL`: it resolves the worktree path
against the board's own `tasks.json`, read-only, and stays empty outside a dev3 worktree.
Several agents build from their own worktrees into one analytics property, so without it
every one of their dev builds is the same anonymous row.

`analyticsVersion` takes the label as a parameter defaulting to the baked-in constant, so
it stays pure — the constant differs between a worktree build and CI, and a test that
adapts to it proves nothing.

This string is for analytics only. The bundle's `version.json` keeps the bare version,
because `dev3 doctor` compares it against the CLI version by string equality.

## Risks

`app_version` values change shape for non-stable builds, so any saved GA report or
audience that matches the bare version exactly will stop matching dev and canary hits —
which is the intended effect, since those hits were polluting the stable numbers. Stable
installs are untouched. `build_commit` and the task label are a short git sha of a public
repository and a board sequence number: they identify the build, never the machine.

## Alternatives considered

- **Leave the channel only in a user property.** What was built first, and it is invisible
  in the reports until a custom dimension is registered — which is exactly the failure the
  change set out to fix.
- **Derive the channel from the version string coming out of the bundle.** Impossible by
  construction: the canary suffix is deliberately kept out of it, for `dev3 doctor`.
- **Resolve the task label at runtime instead of at build time.** The renderer has no cwd,
  and the host would need a new RPC for something the build step already knows.
- **A `?ga_debug=<tag>` flag routing a developer's own hits into GA4's DebugView.** Built,
  then removed as unnecessary: the payload is already readable in the browser's own
  inspector, and the flag was one more surface to maintain for a problem that did not
  need it.
