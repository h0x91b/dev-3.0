/**
 * Backend-neutral terminal parity corpus (MIG-001, seq 1250).
 *
 * This is the FROZEN, data-driven description of the externally visible
 * terminal behaviors dev3 must preserve when the tmux backend is eventually
 * replaced by a native `Bun.Terminal` host. Every scenario is written in
 * product vocabulary — session, view, input, focus, capture — and carries NO
 * tmux command vocabulary: no argv flags, no format-variable strings, no
 * `dev3-*` names, no `%N` pane ids. The concrete tmux mapping lives only in
 * {@link ./tmux-runner.ts}; a future native runner implements the same
 * {@link ./runner.ts} `ParityRunner` shape and reuses this corpus unchanged.
 *
 * The corpus is intentionally NOT a production `TerminalBackend` interface and
 * introduces no backend seam, selection, or persisted identity. It is a test
 * artifact: the classification here (required vs intentional difference, how a
 * behavior is verified, which roadmap items it protects) is the contract, and
 * {@link ./checks.ts} turns each verifiable scenario into an executable check.
 *
 * See `README.md` in this directory and `scenario-roadmap-map.md` for the
 * scenario→roadmap mapping.
 */

/** The compact backend-neutral vocabulary. One entry per user-observable verb. */
export const SCENARIO_CATEGORIES = [
	"create",
	"attach",
	"input",
	"resize",
	"split",
	"focus",
	"capture",
	"reconnect",
	"high-output",
	"exit",
	"cleanup",
] as const;
export type ScenarioCategory = (typeof SCENARIO_CATEGORIES)[number];

/**
 * Roadmap items (from the seq 1141 plan) a scenario protects. Kept as a closed
 * set so the mapping test can prove every referenced id is a real roadmap item
 * and every scenario protects at least one.
 */
export const ROADMAP_ITEMS = [
	"MIG-001", // the parity corpus itself
	"MIG-002", // product-level backend contract after the native adapter exists
	"MIG-003", // backend identity as backward-compatible data
	"MIG-004", // native session creation is explicitly opt-in, single owner
	"MIG-005", // safe rollback (stop native, then create tmux; no live transfer)
	"MIG-006", // tmux failure isolation
	"HOST-004", // no duplicate hosts / duplicate attaches
	"HOST-005", // multi-client semantics (one writer, observers)
	"HOST-006", // survive app restarts and upgrades (reconnect)
	"LAY-003", // logical pane ids map to native host panes across remounts
	"LAY-004", // reproduce product layout behavior (split/focus/close/active)
	"LAY-005", // shared vs client-local state
	"LAY-007", // desktop/browser/narrow rendering must not destabilize others
	"STATE-006", // stream sequencing and resynchronization
	"STATE-007", // backpressure and memory budgets
	"STATE-008", // restore required terminal features (capture, search, …)
	"INT-001", // task/project/variant terminals (create/attach/switch/restore/close)
	"INT-002", // agent control plane (split/run/focus/capture/status)
	"INT-003", // task lifecycle cleanup (stop only owned trees)
	"INT-004", // project scripts and dev servers (backend-neutral execution)
	"INT-005", // CLI lifecycle (status/attach/detach/stop/split/focus/resize/capture)
	"INT-007", // process tools (port scan, resource monitor, exit handling)
	"CUT-001", // native and tmux contract tests side by side, record differences
	"CUT-004", // stop creating new tmux sessions; existing stay readable
] as const;
export type RoadmapItem = (typeof ROADMAP_ITEMS)[number];

/**
 * How the current tmux runner proves (or cannot prove) a scenario:
 * - `live`  — driven end-to-end against a real tmux server through TmuxClient.
 * - `pure`  — driven through an existing product-level pure function (no tmux).
 * - `gap`   — cannot be expressed here without production changes or a real
 *             attached Bun PTY; documented rather than silently skipped, per the
 *             MIG-001 isolation rule.
 */
export type VerificationMode = "live" | "pure" | "gap";

/**
 * Whether a native backend MUST match the tmux-observed behavior (`required`),
 * or is deliberately free to differ because the tmux behavior is a backend
 * quirk (`intentional-difference`). Separating these keeps the native path from
 * being forced to emulate tmux artifacts.
 */
export type ParityLevel = "required" | "intentional-difference";

export type ScenarioPlatform = "any" | "posix" | "windows";

export interface ParityScenario {
	/** Stable logical id — never renumbered; keys the executable checks. */
	readonly id: string;
	readonly category: ScenarioCategory;
	/** `positive` = happy path; `negative` = an error/edge input must be handled. */
	readonly kind: "positive" | "negative";
	readonly title: string;
	/** Backend-neutral description of the behavior under test. */
	readonly intent: string;
	/** Backend-neutral, observable assertions — no tmux vocabulary. */
	readonly observables: readonly string[];
	readonly parity: { level: ParityLevel; note?: string };
	readonly verification: { mode: VerificationMode; note?: string };
	readonly platform: ScenarioPlatform;
	/** Roadmap items this scenario protects (≥1). */
	readonly protects: readonly RoadmapItem[];
}

/**
 * tmux behaviors a native backend is explicitly NOT required to reproduce.
 * Referenced by scenarios via `parity.note` prose; catalogued here so the
 * intentional differences live in one auditable place (CUT-001).
 */
export interface IntentionalDifference {
	readonly id: string;
	readonly title: string;
	/** What tmux does today. */
	readonly tmuxBehavior: string;
	/** What a native backend may do instead, and why that is acceptable. */
	readonly nativeMayInstead: string;
	readonly protects: readonly RoadmapItem[];
}

export const INTENTIONAL_DIFFERENCES: readonly IntentionalDifference[] = [
	{
		id: "id-format",
		title: "Session / view id string format",
		tmuxBehavior: "Sessions are named `dev3-<short>` and views are addressed as `%N` pane ids.",
		nativeMayInstead:
			"A native host uses its own stable session/view id scheme. Only id STABILITY across a session's life and across reconnect is required — never the tmux string shape.",
		protects: ["MIG-003", "LAY-003"],
	},
	{
		id: "output-batching",
		title: "PTY output batching cadence",
		tmuxBehavior: "dev3 coalesces PTY output to the renderer at ~60fps (16ms) to survive agent output storms.",
		nativeMayInstead:
			"A native host may batch on a different cadence or per its own transport. The required contract is lossless, ordered delivery — not the 16ms window.",
		protects: ["STATE-006", "STATE-007"],
	},
	{
		id: "resize-negotiation",
		title: "Multi-client resize negotiation and same-size redraw",
		tmuxBehavior:
			"tmux clamps a shared session to the min cols/rows across all attached clients (larger viewers letterbox), and dev3 adds a one-row jiggle to force a redraw on a same-size reconnect.",
		nativeMayInstead:
			"A native host defines its own multi-client sizing under the writer-owns-resize rule (HOST-005) and need not reproduce the jiggle workaround.",
		protects: ["HOST-005", "LAY-005", "LAY-007"],
	},
	{
		id: "multi-writer",
		title: "Concurrent writer semantics",
		tmuxBehavior: "tmux admits every attached client as a writer (last write wins); there is no single-writer lock.",
		nativeMayInstead:
			"A native host enforces exactly one writer plus observers (HOST-005). This is a DELIBERATE improvement, so parity here means 'native is stricter', not 'native matches tmux'.",
		protects: ["HOST-004", "HOST-005"],
	},
	{
		id: "search-via-copy-mode",
		title: "In-terminal search mechanism",
		tmuxBehavior:
			"Terminal search (⌘F) drives tmux copy-mode; the reported match count goes stale after a miss (consumers gate on a separate 'present' flag).",
		nativeMayInstead:
			"A native host implements search over its own screen model (STATE-008) with no copy-mode and no stale-count quirk.",
		protects: ["STATE-008"],
	},
	{
		id: "status-bar-reservation",
		title: "Status-bar row reservation for layout math",
		tmuxBehavior: "Pane geometry excludes the tmux status bar row; dev3 measures the reserved rows to align the renderer overlay.",
		nativeMayInstead: "A native host has no status bar; its layout geometry needs no such reservation.",
		protects: ["LAY-004", "LAY-007"],
	},
	{
		id: "view-title-hostname-default",
		title: "Default view title",
		tmuxBehavior: "An untitled pane's title defaults to the machine hostname.",
		nativeMayInstead: "A native host may leave an untitled view's title empty; only explicitly set titles are a required contract.",
		protects: ["LAY-004"],
	},
] as const;

/**
 * The corpus. Ordered by category for readability; ids (not order) are the
 * stable keys. Every SCENARIO_CATEGORIES verb appears at least once, and the
 * five required negatives (missing session, duplicate attach, invalid resize,
 * dead view, cleanup retry) are present.
 */
export const PARITY_CORPUS: readonly ParityScenario[] = [
	// ── create ──────────────────────────────────────────────────────────
	{
		id: "create.session-cwd-env",
		category: "create",
		kind: "positive",
		title: "Create a session with a command, cwd and environment",
		intent:
			"Starting a terminal session runs the requested command in the requested working directory with the requested environment variables visible to the process.",
		observables: [
			"After create, the session is present.",
			"The session's process observes the requested working directory.",
			"The session's process observes each requested environment variable.",
		],
		parity: { level: "required" },
		verification: { mode: "live" },
		platform: "any",
		protects: ["INT-001", "INT-004", "MIG-004"],
	},
	{
		id: "create.stable-logical-id",
		category: "create",
		kind: "positive",
		title: "A created session has a stable logical id",
		intent:
			"A session is addressable by a stable logical id for its whole life; the id does not change while the session lives.",
		observables: [
			"Two lookups of the same session return the same logical id.",
			"The session's first view has a stable logical id.",
		],
		parity: {
			level: "required",
			note: "Only id stability is required; the tmux `dev3-*` / `%N` string shape is intentional-difference `id-format`.",
		},
		verification: { mode: "live" },
		platform: "any",
		protects: ["MIG-003", "LAY-003", "INT-001"],
	},
	// ── attach ──────────────────────────────────────────────────────────
	{
		id: "attach.read-current-and-subsequent-output",
		category: "attach",
		kind: "positive",
		title: "Attaching yields current and subsequent output",
		intent:
			"An owner can attach to a live session and read what the process has already produced plus what it produces afterwards.",
		observables: [
			"Attaching to a live session succeeds.",
			"A capture after attach contains output produced before the attach.",
			"Input sent after attach is reflected in a later capture.",
		],
		parity: { level: "required" },
		verification: {
			mode: "live",
			note: "Verified through detached-session presence + capture + input round-trip (no live client stream); the interactive PTY fan-out path is exercised by pty-server tests.",
		},
		platform: "any",
		protects: ["INT-001", "INT-002", "HOST-005"],
	},
	{
		id: "attach.missing-session-is-clean",
		category: "attach",
		kind: "negative",
		title: "Attaching to a missing session fails cleanly",
		intent:
			"Attaching to or reading a session that does not exist reports absence without crashing the caller.",
		observables: [
			"A presence check for an unknown session returns false.",
			"A read of an unknown session raises a typed, catchable error (or an empty result) — never an uncaught crash.",
		],
		parity: { level: "required" },
		verification: { mode: "live" },
		platform: "any",
		protects: ["MIG-006", "INT-005"],
	},
	{
		id: "attach.duplicate-attach-does-not-disrupt",
		category: "attach",
		kind: "negative",
		title: "A second attach does not disrupt the first",
		intent:
			"A second client attaching to a live session must not error or tear down the first client's view of the session.",
		observables: [
			"After a second attach, the session and its views are still present.",
			"The native contract additionally requires the second attach to be an OBSERVER (one writer only) — see the intentional difference.",
		],
		parity: {
			level: "intentional-difference",
			note:
				"tmux admits multiple writers (`multi-writer`); the native single-writer/observer rule (HOST-005) is stricter. The tmux runner can only prove 'no disruption', not the writer lock.",
		},
		verification: {
			mode: "gap",
			note: "Single-writer/observer semantics belong to the native session registry (HOST-004/HOST-005); tmux has no writer lock to assert against here.",
		},
		platform: "any",
		protects: ["HOST-004", "HOST-005"],
	},
	// ── input ───────────────────────────────────────────────────────────
	{
		id: "input.keys-reach-process",
		category: "input",
		kind: "positive",
		title: "Input reaches the process in the focused view",
		intent: "Keystrokes delivered to a view are received by that view's process.",
		observables: [
			"After sending a line of input to a view, a later capture of that view shows the process reacted to it.",
		],
		parity: { level: "required" },
		verification: { mode: "live" },
		platform: "any",
		protects: ["INT-002", "INT-005", "HOST-005"],
	},
	// ── resize ──────────────────────────────────────────────────────────
	{
		id: "resize.min-across-clients",
		category: "resize",
		kind: "positive",
		title: "Shared size is negotiated across clients",
		intent:
			"When several clients view one session at different sizes, the applied geometry is the smallest cols and smallest rows independently, so the smallest viewer fits and larger viewers letterbox.",
		observables: [
			"Given several client sizes, the negotiated size is the per-axis minimum of the positive sizes.",
			"Clients that have not reported a size yet do not shrink the result.",
		],
		parity: {
			level: "intentional-difference",
			note:
				"The min-across-clients letterbox model is tmux's (`resize-negotiation`). Native negotiates under writer-owns-resize (HOST-005). The pure negotiator is still captured because it is the current product contract.",
		},
		verification: { mode: "pure", note: "Driven through the product pure helper `smallestClientSize` — no tmux, no PTY." },
		platform: "any",
		protects: ["HOST-005", "LAY-005", "LAY-007"],
	},
	{
		id: "resize.invalid-is-ignored",
		category: "resize",
		kind: "negative",
		title: "An invalid resize is ignored",
		intent: "A resize request with a non-positive or malformed size does not change the applied geometry.",
		observables: [
			"A resize report with zero/negative dimensions does not contribute to the negotiated size.",
			"A malformed resize report parses to nothing and is dropped (the last valid size is retained).",
		],
		parity: { level: "required" },
		verification: {
			mode: "pure",
			note: "Driven through the product pure helpers `smallestClientSize` and `parseResizeSequence`.",
		},
		platform: "any",
		protects: ["HOST-005", "LAY-007"],
	},
	// ── split ───────────────────────────────────────────────────────────
	{
		id: "split.adds-second-view",
		category: "split",
		kind: "positive",
		title: "Splitting adds a second view with its own id",
		intent:
			"Splitting a session's view creates a second view that runs its own command and carries a distinct stable logical id, in the requested working directory.",
		observables: [
			"After a split, the session has exactly two views.",
			"The new view has a stable logical id distinct from the first.",
			"The new view's process observes the requested working directory.",
		],
		parity: { level: "required" },
		verification: { mode: "live" },
		platform: "any",
		protects: ["LAY-004", "INT-001", "INT-002", "MIG-004"],
	},
	// ── focus ───────────────────────────────────────────────────────────
	{
		id: "focus.exactly-one-active-view",
		category: "focus",
		kind: "positive",
		title: "Focusing selects exactly one active view",
		intent: "After focusing a view, exactly one view is active and it is the requested one.",
		observables: [
			"After focusing a specific view, that view is reported active.",
			"Exactly one view in the session is active.",
		],
		parity: { level: "required" },
		verification: { mode: "live" },
		platform: "any",
		protects: ["LAY-004", "LAY-005", "INT-002"],
	},
	// ── capture ─────────────────────────────────────────────────────────
	{
		id: "capture.content-and-ordering",
		category: "capture",
		kind: "positive",
		title: "Capture returns content in order",
		intent: "Capturing a view returns the text the process produced, in the order it was produced.",
		observables: [
			"A capture contains every line the process printed.",
			"The captured lines appear in the order they were printed.",
		],
		parity: { level: "required" },
		verification: { mode: "live" },
		platform: "any",
		protects: ["STATE-008", "INT-002", "INT-007"],
	},
	{
		id: "capture.dead-view-is-clean",
		category: "capture",
		kind: "negative",
		title: "Operating on a dead view is handled",
		intent:
			"Reading or operating on a view whose process already exited does not crash the caller; the view is reported gone or dead.",
		observables: [
			"After a view's process exits and the view is gone, a presence/list check reflects its absence.",
			"A best-effort operation on the gone view resolves quietly instead of crashing.",
		],
		parity: { level: "required" },
		verification: { mode: "live" },
		platform: "any",
		protects: ["INT-003", "STATE-008"],
	},
	// ── reconnect ───────────────────────────────────────────────────────
	{
		id: "reconnect.session-survives-detach",
		category: "reconnect",
		kind: "positive",
		title: "A session survives with no attached client and rediscovers",
		intent:
			"A session keeps running while no client is attached; a fresh controller process rediscovers the same session, the same view ids, and the preserved content.",
		observables: [
			"With no client attached, the session is still present.",
			"A fresh controller sees the same session and the same view ids.",
			"Content produced before detach is still capturable after rediscovery.",
		],
		parity: {
			level: "required",
			note: "Content-fidelity DEPTH of a native reconnect (alt-screen, cursor, modes) is proved by the native journal/replay work (STATE-*); here we require session/view/id survival + captured content.",
		},
		verification: { mode: "live" },
		platform: "any",
		protects: ["HOST-006", "LAY-003", "STATE-006", "INT-001"],
	},
	// ── high-output ─────────────────────────────────────────────────────
	{
		id: "high-output.lossless-ordered",
		category: "high-output",
		kind: "positive",
		title: "A large output burst is captured losslessly and in order",
		intent: "A process that emits a large, fast burst of output loses nothing; captured history is complete and ordered.",
		observables: [
			"After a burst of N distinct lines, all N lines are present in the captured history.",
			"The captured burst lines are in the order they were produced.",
		],
		parity: {
			level: "required",
			note: "Completeness + ordering are required; the delivery CADENCE (16ms batching) is intentional-difference `output-batching`.",
		},
		verification: { mode: "live" },
		platform: "any",
		protects: ["STATE-006", "STATE-007", "INT-002"],
	},
	// ── exit ────────────────────────────────────────────────────────────
	{
		id: "exit.process-exit-ends-view",
		category: "exit",
		kind: "positive",
		title: "A process exit ends its view",
		intent: "When the process in a view exits, the view is torn down and its absence is observable to the owner.",
		observables: [
			"After the only view's process exits, the session (with no remaining views) is no longer present.",
		],
		parity: {
			level: "required",
			note:
				"Exit STATUS-CODE propagation to the owner is required for INT-003/INT-007 but rides the PTY client-exit path (`onPtyDied`), so it is recorded as a gap here.",
		},
		verification: { mode: "live" },
		platform: "any",
		protects: ["INT-003", "INT-007", "STATE-008"],
	},
	{
		id: "exit.status-code-propagates",
		category: "exit",
		kind: "positive",
		title: "A view's exit status reaches the owner",
		intent: "The numeric exit status of a view's process is reported to the owner so lifecycle and cleanup can react to it.",
		observables: [
			"When a view's process exits with a specific code, the owner can observe that code.",
		],
		parity: { level: "required" },
		verification: {
			mode: "gap",
			note:
				"In production the exit code arrives via the attached Bun PTY's `proc.exited` (`onPtyDied`), not TmuxClient. Asserting it live needs a real attached PTY / a new typed dead-pane-status boundary — out of scope for MIG-001.",
		},
		platform: "any",
		protects: ["INT-003", "INT-007"],
	},
	// ── cleanup ─────────────────────────────────────────────────────────
	{
		id: "cleanup.removes-session",
		category: "cleanup",
		kind: "positive",
		title: "Cleanup removes the session and its views",
		intent: "Cleaning up a session ends it: the session and all its views are gone afterward.",
		observables: [
			"After cleanup, the session is no longer present.",
			"After cleanup, none of the session's views are listable.",
		],
		parity: { level: "required" },
		verification: { mode: "live" },
		platform: "any",
		protects: ["INT-003", "MIG-006", "CUT-004"],
	},
	{
		id: "cleanup.reaps-owned-process-tree",
		category: "cleanup",
		kind: "positive",
		title: "Cleanup reaps the owned descendant process tree",
		intent:
			"Cleaning up a session terminates the whole process tree it owns — not just the foreground process — before the workspace is removed.",
		observables: [
			"After cleanup, descendant processes the session spawned are no longer running.",
		],
		parity: {
			level: "required",
			note:
				"This is a REQUIRED contract the current tmux backend does NOT satisfy on its own — tmux only signals the foreground process, so dev3 layers an explicit process-tree reaper above TmuxClient (decision 092/095).",
		},
		verification: {
			mode: "gap",
			note:
				"The reaper lives in `port-scanner`/`process-reaper` above TmuxClient and needs a real spawned tree; MIG-001 stays inside typed boundaries, so this is documented, not driven.",
		},
		platform: "posix",
		protects: ["INT-003", "INT-007", "MIG-006"],
	},
	{
		id: "cleanup.retry-is-idempotent",
		category: "cleanup",
		kind: "negative",
		title: "Cleaning up an already-clean session is idempotent",
		intent: "Cleaning up a session that is already gone succeeds quietly; a strict teardown of a missing session reports absence.",
		observables: [
			"A best-effort cleanup of an already-removed session resolves without error.",
			"A strict cleanup of a missing session raises a typed, catchable error.",
		],
		parity: { level: "required" },
		verification: { mode: "live" },
		platform: "any",
		protects: ["INT-003", "MIG-006"],
	},
];

/** Lookup a scenario by id (throws on an unknown id — ids are the stable keys). */
export function getScenario(id: string): ParityScenario {
	const found = PARITY_CORPUS.find((s) => s.id === id);
	if (!found) throw new Error(`Unknown parity scenario id: ${id}`);
	return found;
}
