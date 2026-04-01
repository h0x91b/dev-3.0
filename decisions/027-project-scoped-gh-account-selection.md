## Context

`gh` keeps one active account per host globally, but dev-3.0 can run GitHub-backed features for multiple projects in the same app session. A naive `gh auth switch --user ...` before each PR query or PR action would make projects fight over the global active account.

## Investigation

`gh auth status --json hosts` exposes every authenticated account, including which one is active. `gh auth token --hostname <host> --user <login>` returns the token for a specific account without mutating the global `gh` state.

## Decision

Project-specific GitHub account selection is stored on the `Project` object in [src/shared/types.ts](/Users/arsenyp/.dev3.0/worktrees/Users-arsenyp-Desktop-src-shared-dev-3.0/63321948/worktree/src/shared/types.ts) and edited in [src/mainview/components/ProjectSettings.tsx](/Users/arsenyp/.dev3.0/worktrees/Users-arsenyp-Desktop-src-shared-dev-3.0/63321948/worktree/src/mainview/components/ProjectSettings.tsx). All internal `gh` invocations now go through [src/bun/github.ts](/Users/arsenyp/.dev3.0/worktrees/Users-arsenyp-Desktop-src-shared-dev-3.0/63321948/worktree/src/bun/github.ts), which resolves the selected account and injects its token per command instead of calling `gh auth switch`.

## Risks

This depends on `gh auth token --user` continuing to work for stored credentials on the local machine. If a saved project account disappears from `gh`, GitHub features fail until the user reselects an available account in Project Settings.

## Alternatives considered

Using global `gh auth switch` was rejected because background PR polling and user-triggered PR actions could race across projects. Reading tokens directly from `gh` config files or keychains was rejected because it is more fragile and more invasive than using the supported CLI surface.
