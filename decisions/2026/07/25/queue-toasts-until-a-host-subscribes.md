# 167 — Queue toasts until a host subscribes

## Context

`App.test.tsx` failed roughly 4 times per 100 file runs on unchanged code, always in a
test that dispatches a synthetic `rpc:*` event right after `renderApp()`: the
shared-image toast navigation (blocked PR #1118), the New Task modal, the
branch-merged completion popup, the preparation-failure toast. Every failure looked
like a slow machine (a `findBy*` giving up at its 1000 ms timeout, or the 5 s test
timeout) so a rerun always "fixed" it. It never reproduced on an idle machine — 190
clean runs, including 450 repeats of the exact failing assertion, were green.

## Investigation

Reproduced by starving the CPU (16 busy loops) while looping the file: 4 failures in
100 runs, in three different tests. Instrumenting `emit()` caught the mechanism:

    [dbg emit] {"message":"Couldn't prepare ...","suppressed":false,"listeners":0}

The toast *was* raised and thrown away. `ToastHost` subscribes from a passive effect,
and `emit()` dropped any entry that arrived while `listeners` was empty ("no host
mounted → silently drop"). App's own window listener was already attached, so a push
message handled in that window vanished with no trace — permanently, which is why the
polling `findBy*` never recovered and the failure read as a timeout.

## Decision

1. `emit()` (`src/mainview/toast.tsx`) now queues into the existing `pendingEntries`
   buffer when no host is subscribed, bounded to `MAX_PENDING_ENTRIES`, and
   `flushPendingEntries()` hands the queue to a host as it subscribes. This also fixes
   the production case: a toast raised before the first `ToastHost` effect flush used
   to be lost. `_resetPendingToastsForTests()` drops the queue from a global
   `afterEach` in `src/mainview/test-setup.ts` so no test leaks toasts into the next.
2. `renderApp()` in `src/mainview/__tests__/App.test.tsx` drains React's passive
   effects (`await act(async () => {})`) after a screen testid appears. A testid is
   visible at commit time, which can precede the effects that register App's window
   listeners.
3. The branch-merged test's inner `waitFor` dropped from 5000 ms to 3000 ms so it can
   no longer collide with the 5 s test timeout — a real failure now reports the missing
   element and a DOM dump instead of "Test timed out in 5000ms".

## Risks

Queued toasts are delivered to the next host that subscribes, so a toast raised long
before any host mounts now shows up late rather than never. The `MAX_PENDING_ENTRIES`
bound and the per-test reset keep that window small; in the app there is exactly one
host, mounted for its whole lifetime.

## Alternatives considered

- Bumping the `findBy*`/test timeouts: hides the drop instead of fixing it, and the
  entry is gone forever, so no timeout is large enough.
- Making `ToastHost` subscribe from `useLayoutEffect`: narrows the window but does not
  close it (the host still is not mounted during the very first render pass) and pulls
  toast delivery into the commit phase.
- Asserting the subscription inside `renderApp()`: needs a test-only export of
  `listeners.size` and still leaves the production drop in place.
