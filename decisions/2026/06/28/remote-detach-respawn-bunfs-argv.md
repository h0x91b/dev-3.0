# 087 — `dev3 remote` detached respawn must drop bun's `/$bunfs/root` argv entry

## Context

After the single-binary merge (#744), `dev3 remote` backgrounds by default by
re-spawning itself (`process.execPath`) with `--no-detach`. On the **compiled**
binary this died immediately with `error: Unknown command: /$bunfs/root/dev3`
and the background server never came up. It worked in dev (`bun run`), so tests
and local dev never caught it — only the shipped binary was broken.

## Investigation

A bun-compiled standalone binary always has `process.argv = [execPath,
"/$bunfs/root/<entry>", ...userArgs]` — bun injects the virtual bundle entry as
argv[1] itself. The old code built the child args from `process.argv.slice(1)`,
which re-included `/$bunfs/root/dev3`. When that array is handed to
`spawn(execPath, …)`, bun re-injects its own `/$bunfs/root/dev3` at the child's
argv[1], so our copy shifted to argv[2] = `main()`'s `rawArgs[0]`, parsed as the
command. In dev, argv[1] is the real `main.ts` path, which bun legitimately needs
as its first arg, so dev kept working.

## Decision

`computeDetachedChildArgs(argv, execPath)` in `src/cli/commands/remote.ts` now
returns the *user-facing* args only (`argv.slice(2)`, matching what `main()`
parses), appending a single `--no-detach`. In dev (execPath ends with `bun`) it
prepends `argv[1]` (the entry script bun needs); for the compiled binary it does
not. Unit-tested for both argv shapes in `remote.test.ts`.

## Risks

`argv.slice(2)` assumes user args always start at index 2, which holds for both
runtimes (and mirrors `main()`'s own `process.argv.slice(2)`). If a future
launcher changes the argv layout, this and `main()` must move in lockstep.

## Alternatives considered

Stripping any token matching `/^\/\$bunfs\//` from the args — rejected as a
fragile heuristic against an internal bun path format; slicing to the known
user-arg boundary is exact and matches how `main()` already parses argv.
