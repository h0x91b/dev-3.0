# Native pollers read pane records, not recovery

## Context
Native-terminal tasks have no tmux session and no `session.proc`, so the port scanner, the dev-server board read and the resource monitor saw nothing of them. The native read that already existed (`auxPaneAlive`, `nativeAuxPaneShellPid`) runs full ownership recovery (`ps` checks plus a disk reconcile) per call, far too heavy for tickers that fire every 10 seconds per task.

## Decision
Pollers read only the on-disk records, through `nativeTaskPaneRecords` / `nativeTaskIdsOnDisk` (`native-task-panes.ts` → `terminal-backend/native-backend.ts`), injected into `port-scanner.ts` via `setNativePaneRecordsReader` (`native-scan-readers.ts`, registered in `index.ts` and `headless-entry.ts`) so the scanner stays free of `native-*` imports. A pane is live when the shared `ps` tree shows its recorded shell as a child of its recorded host (`nativeTaskPaneRoots`). Bound native sessions and on-disk native tasks with a live pane are polled, so an aux pane that outlives the primary shell keeps its ports. An empty process table skips the cycle, and win32 (no `ps`/`lsof`) skips native scanning.

## Risks
The parent/child check does not prove ownership: after a pid reuse a recycled host pid could adopt an unrelated process as the "shell". The record's start signatures are what recovery uses to rule that out, and the pollers do not check them. The consequence is a wrong port or CPU figure on a card until the stale record is cleaned, never a kill or a write. Records are read each tick, so a large number of native tasks costs file reads, not spawns.

## Alternatives considered
Running recovery (`readPaneSet`) from the pollers: rejected, it spawns `ps` per pane and reconciles disk state from a read-only loop. Importing the registry into `port-scanner.ts` and extending the isolation allowlists: rejected, it breaks the single-seam rule. Probing `ps` for the host command line instead of reading records: rejected, per-tick parsing of every command line and no pane-to-task link.
