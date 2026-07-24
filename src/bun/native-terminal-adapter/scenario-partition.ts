/**
 * How the native single-view adapter partitions the shared parity corpus
 * (seq 1254). This is the explicit, enforced record of which scenarios run
 * against native now and which are intentionally deferred — no scenario is ever
 * silently skipped (a unit test proves the partition covers the whole corpus).
 *
 * The single-view tracer runs every `live` scenario whose executable check stays
 * within ONE view. The four `live` scenarios whose shared checks create a SECOND
 * view (they call `splitView`) are deferred to the multi-view layout work
 * (LAY-003/LAY-004); `pure` scenarios are backend-neutral and run unchanged;
 * `gap` scenarios remain documented, not driven (as in the tmux runner).
 */

/** `live` scenarios the native single-view adapter runs today. */
export const NATIVE_SINGLE_VIEW_LIVE_SCENARIOS = [
	"create.session-cwd-env",
	"create.stable-logical-id",
	"attach.read-current-and-subsequent-output",
	"attach.missing-session-is-clean",
	"input.keys-reach-process",
	"capture.content-and-ordering",
	"reconnect.session-survives-detach",
	"high-output.lossless-ordered",
	"exit.process-exit-ends-view",
	"cleanup.retry-is-idempotent",
] as const;

/**
 * `live` scenarios deferred to LAY-003/LAY-004: each shared check opens a SECOND
 * view via `splitView`, which the single-view tracer does not implement. The
 * single-view slices of their intent are still covered:
 *  - `cleanup.removes-session` → removal proved by `cleanup.retry-is-idempotent`;
 *  - `capture.dead-view-is-clean` → single-view exit proved by
 *    `exit.process-exit-ends-view` and a focused adapter test.
 */
export const NATIVE_DEFERRED_MULTI_VIEW_SCENARIOS = [
	"split.adds-second-view",
	"focus.exactly-one-active-view",
	"capture.dead-view-is-clean",
	"cleanup.removes-session",
] as const;

/** `pure` scenarios run backend-neutrally (no runner needed). */
export const NATIVE_PURE_SCENARIOS = ["resize.min-across-clients", "resize.invalid-is-ignored"] as const;

/** `gap` scenarios: documented in the corpus, not driven here (same as tmux). */
export const NATIVE_GAP_SCENARIOS = [
	"attach.duplicate-attach-does-not-disrupt",
	"exit.status-code-propagates",
	"cleanup.reaps-owned-process-tree",
] as const;
