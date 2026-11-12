# happy-dom observers died on garbage collection: pin a fixed release

## Context

Two renderer tests failed intermittently under load and passed alone: `TaskArtifactViewer.test.tsx > a saved Follow dev3 tracks the app theme as it changes` and `AttentionView.test.tsx > moves a quiet task into Stalled on the tick, with no board change`. Both timed out at ~1000 ms, the `waitFor` deadline, not the test timeout. CI did not show them because `test-retry.ts` retries three times there.

## Investigation

Diagnostics added to the failing tests showed the DOM was right and an observer had gone silent. In AttentionView the view was on screen by ~40 ms, but RTL's `waitFor` observer on `document` fired once at ~20 ms and never again. Its 50 ms polling `setInterval` is faked by that test, so nothing re-checked. In the Follow test a probe observer saw the `data-theme` change at 0.5 ms, but the viewer's own observer never posted the new theme.

The cause is in happy-dom 20.9.0. `MutationObserverListener` registered its delivery callback as `new WeakRef((record) => this.report(record))` and held the arrow function nowhere else. After any GC, `deref()` returns `undefined` and the observer drops every record without an error. GC timing follows load and allocation, which explains the load dependence. The heavy TaskArtifactViewer file (large srcdoc strings) occasionally failed alone. happy-dom 20.11.2 keeps the callback in a private field.

## Decision

Pin `happy-dom` to `20.14.6`, the latest 20.x. `src/mainview/__tests__/happy-dom-observer-gc.test.ts` forces a GC through `v8.setFlagsFromString("--expose-gc")` and asserts that an observer still delivers. It fails 3/3 on 20.9.0 and passes on 20.14.6. In the AttentionView test the view is now awaited with `vi.waitFor`, which polls on vitest's unfaked timers, instead of `findByTestId`, whose polling the test's own fake `setInterval` disabled.

## Risks

- A future happy-dom bump could reintroduce a weakly held callback. The GC test catches that.
- `--expose-gc` is set at runtime in one test worker. It only exposes `gc()` and does not change GC behaviour for other files.
- Earlier "stall of unknown origin" flakes (`decisions/2026/07/25/tick-bounded-waiter-for-component-boots.md`) may share this cause. That is unproven, so that record stands.

## Alternatives considered

- **Raise the `waitFor` timeout or add retries**: the observer stays dead, so a longer wait cannot succeed.
- **Patch happy-dom locally (`bun patch`)**: upstream already fixed it within the same major version, so a patch would only add maintenance.
- **happy-dom 21**: a major bump with wider behaviour risk, and it is not needed for this fix.
