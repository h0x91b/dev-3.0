# Restart the model proxy with backoff instead of bundling its datasheets

## Context
On a fresh data dir the pinned sidecar (bifrost v1.6.10) downloads its pricing and model-parameters datasheets from getbifrost.ai before it serves `/health`, and exits if either download fails. A 503 there broke 12 of 148 canary runs and would equally break a user's first launch. The app gave a start 20s, and the Intel macOS runner needs 17-29s even when the download works.

## Investigation
Source read at `transports/v1.6.10`, `framework/modelcatalog`:
- The startup fetch retries 4 times within about 7s, then gives up.
- With rows already in its DB, the sidecar boots at once and refreshes in the background, so only an empty data dir depends on the network.

Measured: shipping the three datasheets inside the app cut a fresh boot from 14s to 7s. The cost was about 33 MB more in the app, plus data frozen at build time. That approach got as far as PR 2417's first head.

## Decision
The user chose fresh upstream data, and nothing more inside the app. When a start fails, `model-sidecar.ts` schedules a new start through `scheduleRestart`, after 5s and doubling up to a 120s cap (`restartBackoffMs`), until the sidecar comes up. Stop, restart and quit cancel the timer (`cancelScheduledRestart`), and the panel shows "Stop retrying" for the whole cycle, the attempt in flight included (`restart` without `inMs` while `starting`). A stop cuts an in-flight start short (`startAborted` kills the spawned process) instead of waiting out up to 4 × 45s. A build that ships no binary, or a catalog with no provider, never schedules one; a timer that fires after the catalog was emptied drops itself. Saving the catalog while a restart is queued restarts at once (`modelCatalogSave`), because the save may be the fix.

`ModelSidecarStatus.restart` carries the attempt number and the milliseconds left until the next try (a duration, not an epoch, so a remote browser's clock skew cannot shift it), so the API models panel shows "trying again in Ns (attempt k)" above the process's own last output, and every scheduled restart is logged. `READY_TIMEOUT_MS` goes from 20s to 45s, so a slow but healthy first boot is not mistaken for a failure.

The release smoke does the same in miniature. It reboots at most 3 times, 30s apart, and only when the sidecar's output names a datasheet download failure (`network-retry.ts` patterns). Its deadline is 60s on Intel macOS.

## Risks
- During a long upstream outage a fresh install's proxy stays down until upstream recovers. This is visible in the panel and in the log, and the user accepted it.
- A permanent failure, such as a broken provider config, is retried every 2 minutes for as long as the app runs. Each try costs one short-lived process.
- A crash after a successful start is not restarted automatically; that behaviour is unchanged.
- A sidecar that hangs rather than exits now holds a routed agent launch for up to 4 × 45s = 180s (was 80s), still under the 360s RPC timeout. One that exits on a 503 still fails fast.

## Alternatives considered
- Bundle the datasheets: rejected. It grows the app and freezes the data.
- dev3 pre-fetches the datasheets into its own cache with retries and points the sidecar at the local copy: it would also give a last-good fallback, but the user preferred the smaller change.
- Only raise the deadline: a 503 never ends inside any deadline.
