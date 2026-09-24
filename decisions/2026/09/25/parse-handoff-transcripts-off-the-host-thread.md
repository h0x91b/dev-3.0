# Parse handoff transcripts off the host thread

## Context

Opening + Agent always asks `previewTaskHandoff` for the "Continue this task's conversation" line. It read and parsed every Claude/Codex transcript of the worktree with `readFileSync` on the Bun host thread, which also serves every RPC and the PTY WebSocket, and kept all of them to use only the newest. Long Codex rollouts reach hundreds of MB, and the parsed model costs roughly 2.5–8× the file size (a 769 MB rollout measured 6.2 GB RSS). Terminals and every request stalled until it finished, and reopening the dialog queued another full parse.

## Investigation

A throwaway HOME with a 300 MB rollout reproduced a host event-loop block of 200–270 ms (5 sessions: 620 ms, 3.2 GB; three queued opens: 1.6 s, 6.4 GB) on a 128 GB machine. The reported one-minute freeze on another machine is consistent with the same path under memory pressure, but was not observed there. Full write-up: Seq1994 report.

## Decision

`newestWorktreeConversation` (`src/bun/conversation-parse.ts`) orders candidates by `stat` and parses newest-first until one parses, so a handoff reads one file. `executeHandoffJob` (`conversation-handoff-job.ts`) does discovery, parse and render; `runHandoffJob` (`conversation-handoff-runner.ts`) runs it in a one-shot `node:worker_threads` worker bundled by `scripts/build-cli.ts` to `dist/workers` and copied as `workers` beside `views`. `previewTaskHandoff` caches by the newest file's path/size/mtime and shares one in-flight scan per worktree; `prepareTaskHandoff` renders through the same worker. The worker is terminated after each job so its heap is returned.

## Risks

Memory for one whole file is not bounded: a multi-GB rollout still peaks at several GB inside the worker, and swap can still slow the machine, though the app stays responsive. If the bundle is missing (a build that skipped `build:cli`, a headless layout without `dist/workers`), the runner logs once and parses inline — newest-only, but on the host thread again. Headless and Windows packaging were not run.

## Alternatives considered

Newest-only on the host thread alone still blocks for about a second on a 700 MB session. A streaming turn counter would bound memory but duplicates `assembleTurns` semantics and could disagree with the retelling. Computing the preview only when the box is ticked changes the dialog's behaviour and needs a UX decision. Loading the worker from TypeScript source like `freeze-diagnostics` is impossible here: the parser imports half of `src/shared`, and a packaged app has no repository to resolve them from.
