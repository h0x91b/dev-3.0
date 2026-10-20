# Split oversized handler files behind their entry module

## Context

`src/bun/rpc-handlers/tmux-pty.ts` (4,148 lines) and `src/bun/cli-socket-server.ts` (2,752) were the two largest backend files, each mixing several domains, and both change often (64 and 87 commits in the 90 days before 2026-10-16). Seq 2166 measured them and moved the code without changing behaviour.

## Investigation

About twenty suites `vi.mock("../rpc-handlers/tmux-pty", …)` by that exact path, and `cli-socket-server-imports.test.ts` allowlists `tmux-pty` because that mock keeps its import graph from loading. Rewriting every consumer to import from the new files would have split each of those mocks into several and broken the allowlist's premise. `task-workspace-guard.test.ts` reads launcher bodies by file path, and `windows-ci-scope.ts` lists the files whose edits re-dispatch the Windows proof.

## Decision

The entry file stays and owns only the RPC handler object plus re-exports of its previous public names; the bodies live in `src/bun/rpc-handlers/tmux-pty/<domain>.ts`. `cli-socket-server.ts` follows the same rule: its single 73-command `handlers` object became one `Record<string, Handler>` per command namespace in `src/bun/cli-socket/*-commands.ts`, spread back into `handlers` (lookup is by key, so order is irrelevant), and its helpers moved to `cli-socket/task-resolution.ts`, `approvals.ts`, `notification-log.ts`, `pane-sessions.ts` and `shared.ts`. That is the same shape as `src/shared/types.ts` after Seq 2164, so consumers and mocks keep working unchanged. Shared task lookups (`findTaskAcrossProjects`, `wakeIfHibernated`, `markTerminalAttached`, the file-browser pane map) sit in `tmux-pty/task-state.ts` so the domain modules form an acyclic graph. The move was done by a script that copies every statement verbatim with its comments. A statement-multiset comparison against the original (tmux-pty: 123 of 123 statements; socket server: 54 statements plus 73 handler properties, all equal apart from added `export` keywords and one directory of path depth) and identical module export lists prove it. `cli-socket-server-imports.test.ts` now scans `cli-socket/*.ts` too, because the static domain imports moved there.

## Risks

Open PRs that edit the old file get rebase conflicts on moved code; re-apply the hunk to the file named in the new import list. A new file under `tmux-pty/` is already covered by the `tmux-pty/**` Windows-scope entry, but a new launcher must still be added to the guard test by hand.

## Alternatives considered

Rewriting all consumers and mocks to the new paths: much larger diff and many split mocks for no behaviour gain. Keeping one file per handler: too fine, it scatters the shared dev-server helpers across files.
