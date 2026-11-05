# Pre-flight the macOS bundle swap and treat a returning applyUpdate as a failure

## Context
A user stayed on 1.52.0 for days: the popover said "ready to install" and then hung on "Restarting…", across reboots. The feed was fine (every manifest and bundle verified). Reproduced by running 1.52.0's own bun binary against Electrobun 1.18.1's `Updater`: the swap works in a writable location, but in a read-only mount it fails with EROFS, and in a bundle with one unwritable directory it fails with EACCES.

## Investigation
Electrobun's macOS `applyUpdate` is `rmSync(runningBundle) + renameSync(extracted, runningBundle)` inside a try/catch that only emits an `error` status (stdout) and **returns**. dev3 never subscribed to the status feed, so the RPC resolved `{ restarting: true }` and the UI waited forever, and nothing reached `~/.dev3.0/logs`. Worse, `rmSync` deletes every entry it can before it hits the locked one: in the EACCES repro `Contents/MacOS` was gone, so the app could no longer start.

## Decision
`src/bun/updater.ts`: `macBundleReplaceBlocker()` refuses before the repair download when the bundle is under `/AppTranslocation/`, or when its parent or any directory inside it is not writable. After `Updater.applyUpdate()` returns, `describeReturnedApply()` turns the status history into a thrown error, which the Restart button already shows as a toast. `attachUpdaterStatusLog()` writes every Electrobun status into the dev3 log.

## Risks
`access(W_OK)` can miss an immutable flag (`chflags uchg`) or an MDM rule; those still fail inside Electrobun, but now visibly. Clients that are already stuck run their old updater and must be reinstalled by hand — nothing on the feed side can unstick them.

## Alternatives considered
Replacing Electrobun's macOS swap with our own (as on Windows) — larger, and the pre-flight already prevents the destructive case. Patching Electrobun to throw — a dependency patch every bump would have to carry, and it still would not prevent the partial delete.
