# Validate the project's configured compare ref

## Context
A project's `defaultCompareRef` (or the `origin/<base>` that `defaultCompareRefMode: "remote"` implies) was trusted as-is. A repo without that ref — `origin/master` where only `main` exists — then failed every branch-status poll, merge check and rebase, about every 90 s, forever, and the UI never said why.

## Decision
`git.resolveConfiguredCompareRef` (`src/bun/git.ts`) keeps a configured ref only when `refExists` finds it, otherwise returns the detected default (`resolveCompareRef`) and logs one warning per project and ref. The verdict is cached for 60 s, so a ref that a later fetch brings in is picked up. It is applied in `applyConfigCascade` (`src/bun/repo-config.ts`), so the renderer receives and labels the real ref, and again in the server-side `resolveCompareRef` (`rpc-handlers/git-operations.ts`) and `resolveBugHunterCompareRef` when the ref is the project's own. The stored config is not rewritten; Project Settings still shows what the user configured.

## Risks
The git bar can now compare against a ref other than the one in Project Settings, with only a log line explaining it. A configured ref that exists only after the first fetch resolves to the default for up to a minute.

## Alternatives considered
Validating every explicit ref, including the one a user picks per task with `vs … ▾`: rejected, because a rebase would then silently run against a different branch than the one chosen; that path keeps failing loudly instead. Rewriting `defaultCompareRef` in the stored config: rejected — it changes user state and other app versions read the same file.
