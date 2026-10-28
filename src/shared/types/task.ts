import type { TaskOrigin } from "./task-origin";
import type { TerminalBackendIdentity } from "../terminal-backend-identity";
import type { AccountPickReason } from "../account-routing";
import type { ReviewComment } from "../review";
import type { TaskStatus } from "./task-status";
import type { TaskPriority } from "./task-priority";
import type { TaskType } from "./task-type";
import type { Project } from "./project";
import type { ScheduledLaunch } from "./agent-launch";
import type { ScheduledMessage } from "./scheduled-messages";
import type { KeepAliveState } from "./keep-alive";
import type { PrWatch } from "../pr-watch";
import type { LiveArtifact, SharedArtifact, SharedImage } from "./shared-media";
import type { ScriptPlacement } from "./package-scripts";
import type { MergeCompletionPromptState, PreparingStage, TaskSessionState } from "./task-lifecycle";
import type { TaskHistoryEntry } from "./task-display";
import type { TaskMovement, TaskNote } from "./task-notes";
import type { ReviewedPullRequest, TaskPRStatusCache, TaskPullRequestRecord } from "./pull-requests";

// ---- Task relations ----

/** Relation kinds reserved for the task-linking foundation. */
export const TASK_RELATION_TYPES = ["blocked-by", "relates-to"] as const;

export type TaskRelationType = (typeof TASK_RELATION_TYPES)[number];

/** A typed link from a source task to a target task in the shared task store. */
export interface TaskRelation {
	type: TaskRelationType;
	taskId: string;
}

/**
 * Compact git-diff stats captured for a task. For completed/cancelled git tasks
 * this is captured ONCE at completion time (in `moveTask`, before the worktree is
 * destroyed) and persisted on the task so the Productivity dashboard can sum
 * "lines changed" after the worktree is gone. `capturedAt` is the ISO time of
 * capture. Absent on tasks completed before this tracking shipped (worktree gone)
 * and on virtual (Operations) tasks (no git).
 */
export interface CompletedDiffStats {
	files: number;
	insertions: number;
	deletions: number;
	capturedAt: string;
}

/**
 * Persisted lifecycle runtime hint. The actor verifies this against worktree and
 * tmux reality at boot; it is never treated as authoritative on its own.
 */
export interface TaskRuntimeState {
	runtime: "idle" | "preparing" | "running" | "tearing-down";
	stage?: string;
	runId?: string;
	updatedAt: number;
}

/** One configured clone path that failed to copy into the worktree. */
export interface CloneFailure {
	/** The path as configured, relative to the project root. */
	path: string;
	/** Last stderr line plus the failing command's exit code. */
	error: string;
}

export interface Task {
	id: string;
	seq: number;
	projectId: string;
	title: string;
	description: string;
	/**
	 * Short, clean one-paragraph summary written by the agent.
	 * Surfaced in the hover-preview popover above the terminal snapshot so
	 * the user can re-enter focus fast after a long break. `description` is
	 * the raw original user request and must NOT be used as a substitute.
	 * When `userOverview` is set, it takes precedence for display — agents
	 * keep writing here freely, but the user won't see it until they revert.
	 */
	overview?: string | null;
	/**
	 * User-edited overview that OVERRIDES the agent-written `overview` in
	 * every display surface. Set when the user saves a manual edit through
	 * the UI pencil editor; cleared only when the user explicitly reverts
	 * to the AI version. Agents never read or write this field directly.
	 */
	userOverview?: string | null;
	customTitle?: string | null;
	/**
	 * True only when the user typed/edited the title through the UI (Create
	 * Task modal or inline rename). Titles set by an agent through
	 * `dev3 task update --title` leave this flag at `false`. The user-edited
	 * marker shown to agents and the CLI overwrite-guard both key off this
	 * flag — NOT off `customTitle != null` — so agent-set titles can still
	 * be re-rewritten by later agents while a real user-typed title is
	 * preserved for the entire task lifetime.
	 */
	titleEditedByUser?: boolean;
	status: TaskStatus;
	/**
	 * Task importance {@link TaskPriority}, `P0` (highest) … `P4` (lowest). The
	 * topmost sort key on the board and sidebar (strict bands). Shared across a
	 * whole variant group. Absent only in-memory before the load-time migration
	 * runs; treat a missing value as {@link DEFAULT_PRIORITY} via {@link priorityRank}.
	 */
	priority?: TaskPriority;
	baseBranch: string;
	worktreePath: string | null;
	branchName: string | null;
	/** Sticky identity of the GitHub pull request detected for this task. */
	prNumber?: number | null;
	prUrl?: string | null;
	/** Last rich status fetched for the task's associated GitHub pull request. */
	prStatusCache?: TaskPRStatusCache | null;
	/**
	 * Every pull request this task has had, oldest first. The current one is still
	 * `prNumber`; the rest are finished PRs a follow-up replaced. A separate
	 * top-level field because older app versions rewrite the PR fields above.
	 */
	pullRequests?: TaskPullRequestRecord[] | null;
	/**
	 * The pull request a review (foreign-code) task reviews, resolved from
	 * `existingBranch` at creation or lazily for tasks created before this field.
	 * Absent on every other task and on older records.
	 */
	reviewedPr?: ReviewedPullRequest | null;
	groupId: string | null;
	variantIndex: number | null;
	/** Future-facing links to other tasks; the data layer fills [] for legacy records on load. */
	relations?: TaskRelation[];
	agentId: string | null;
	configId: string | null;
	/**
	 * Managed agent account this task's agent launched under (agent account
	 * switcher). Absent → the registry default (the preselect); `null` →
	 * explicitly the system login (~/.claude / ~/.codex); a string → that managed
	 * account. Persisted so Retry and session recovery re-launch on the same
	 * account. See decisions/2026/07/12/per-launch-agent-account-selection.md.
	 * `"auto"` (AUTO_ACCOUNT_ID) only until the first launch replaces it with the
	 * account the usage-balanced router picked.
	 */
	accountId?: string | null;
	/** Why Auto chose `accountId`, recorded at the launch that routed it. */
	accountPick?: { reason: AccountPickReason; at: string } | null;
	createdAt: string;
	updatedAt: string;
	movedAt?: string;
	/**
	 * Start of the current delivery cycle: set on the first `in-progress` move
	 * and reset when a completed/cancelled task is reopened. Used to measure the
	 * time until the next completion without reconstructing history.
	 */
	lifecycleStartedAt?: string;
	/**
	 * When the last run in this worktree ended (reset, completion, "start fresh").
	 * A Codex conversation found by scanning must start after it. Only ever
	 * raised; older app versions ignore it.
	 */
	codexScanFloorAt?: string | null;
	/**
	 * Legacy manual position inside a column. Nothing reads or writes it any more —
	 * in-column order is derived from priority + the activity clock (see
	 * sortTasks.ts). Declared only so older values already sitting in `tasks.json`
	 * survive a load/save round-trip instead of being stripped for versions of the
	 * app that still read them (frozen on-disk layout, AGENTS.md).
	 */
	columnOrder?: number;
	tmuxSocket?: string | null;
	/**
	 * Which backend runs this task's PRIMARY terminal. Absent means the legacy
	 * effective backend (tmux) and MUST stay absent — the data layer never
	 * backfills it. Read it through the codec in
	 * `src/shared/terminal-backend-identity` (see decision 165); project and
	 * dev-server terminals are not covered by this field yet.
	 */
	terminalBackend?: TerminalBackendIdentity;
	labelIds?: string[];
	existingBranch?: string | null;
	notes?: TaskNote[];
	/**
	 * The user's review of what the agent produced: comments anchored to diff
	 * lines or artifact elements, with the agent's replies. Shared by every viewer
	 * and by `dev3 review`; capped by {@link MAX_REVIEW_COMMENTS_KEPT}. See
	 * `src/shared/review.ts`.
	 */
	review?: ReviewComment[];
	customColumnId?: string | null;
	/**
	 * Append-only log of the task's title/overview as they changed over time.
	 * Written automatically by the data layer whenever the *effective*
	 * (displayed) title or overview changes — and seeded once at creation. Each
	 * entry is a full snapshot of both values, so it is self-contained. Not
	 * surfaced in the UI yet; kept for a future history view and for search.
	 */
	history?: TaskHistoryEntry[];
	/**
	 * Append-only log of the task's moves across board columns, capped at
	 * {@link MAX_TASK_MOVEMENTS_KEPT}. Written by the data layer on creation and
	 * on every rendered-column change; read by `dev3 events --kind move`. Absent
	 * on every task that existed before this shipped — that history is gone and
	 * is never reconstructed, because nothing on disk retained it.
	 */
	movements?: TaskMovement[];
	/**
	 * How many movements the {@link MAX_TASK_MOVEMENTS_KEPT} cap has evicted from
	 * this task. Kept so a feed can say a cursor's answer is incomplete instead of
	 * presenting a trimmed log as the whole history.
	 */
	movementsDropped?: number;
	/** True while the worktree is being created (heavy I/O in progress). */
	preparing?: boolean;
	/** Current preparation stage shown while the task is still being set up. */
	preparingStage?: PreparingStage | null;
	/** Compact 0-100 progress value for the current preparation stage. */
	preparingProgress?: number | null;
	/** ISO timestamp when preparation started. Used to detect stuck clones. */
	preparingStartedAt?: string | null;
	/**
	 * Last worktree/PTY preparation failure. Persisted on the reverted To Do task
	 * so launch feedback survives a missed push/toast; cleared by the next launch.
	 */
	preparationError?: string | null;
	/**
	 * Exit code of a `setupScript` that failed during launch, reported by the
	 * setup wrapper itself (the script runs inside the pane, so bun cannot see
	 * its result). Cleared by the next launch, by re-running setup, and by the
	 * user dismissing the notice.
	 */
	setupFailedExitCode?: number | null;
	/**
	 * Whether the agent was already running when that setup failed. A `parallel`
	 * tmux launch splits the agent pane BEFORE setup, so the failure finds a live
	 * agent; `blocking` and native launches gate the agent behind setup, so it
	 * never started. The two need opposite offers — restarting the session is
	 * recovery in one case and destruction of a working agent in the other.
	 */
	setupFailedAgentRunning?: boolean | null;
	/**
	 * Clone paths whose source existed but did not reach the worktree. Cloning runs
	 * before the agent launches, so the agent already read (or failed to read) these
	 * files by the time anyone looks — the list is persisted rather than pushed so
	 * the notice survives a closed window. Missing sources are skipped silently and
	 * never land here. Cleared by the next launch and by dismissing the notice.
	 */
	cloneFailures?: CloneFailure[] | null;
	/** Additive lifecycle runtime hint; older app versions ignore this field. */
	runtimeState?: TaskRuntimeState;
	/**
	 * True while a terminal move (→ completed/cancelled) is tearing the task down
	 * server-side: destroying the tmux session, running the cleanup script, and
	 * removing the git worktree. This window can last many seconds and is the
	 * "opposite" of {@link preparing} — the card shows a muted "shutting down"
	 * state and is not openable (there is nothing left to open).
	 *
	 * TRANSIENT — decorated only onto the pushed task snapshot at teardown start
	 * and cleared by the terminal `taskUpdated` push. It is **never persisted**
	 * (unlike `preparing`): the data layer must not receive it, so a crash
	 * mid-teardown or an app reload can never leave a task stuck "shutting down".
	 */
	shuttingDown?: boolean;
	/** When true, native macOS notifications fire on status changes. */
	watched?: boolean;
	/** When true, merge detection reports the merge without suggesting completion. */
	manualCompletion?: boolean;
	/** Persisted agent session state for recovery after tmux/app crash. */
	sessionState?: TaskSessionState | null;
	/**
	 * Last merge-completion prompt shown for this task. The fingerprint tracks
	 * the task branch state, so dismissing the prompt suppresses repeats until
	 * the branch changes.
	 */
	mergeCompletionPrompt?: MergeCompletionPromptState | null;
	/**
	 * True while a task created via the "Scratch Task" button still has no
	 * initial prompt. The `description` holds only a `Scratch — HH:mm`
	 * placeholder used for the title; at launch time the agent receives an
	 * empty prompt instead of the placeholder. Editing in a meaningful
	 * description or title converts it into a normal task and clears this flag.
	 */
	scratch?: boolean;
	/**
	 * True while the task is an unfinished draft parked in To Do by "Save as
	 * draft". A draft is explicitly not ready: every activation path refuses it
	 * (the lifecycle machine rejects the move, see {@link DRAFT_TASK_ACTIVATION_ERROR}),
	 * and clicking its card reopens the New Task popup prefilled. Cleared only by
	 * an explicit save with a non-empty description; the transition is one-way.
	 * Absent/false on every pre-existing task, so older app versions reading the
	 * same `tasks.json` simply see an ordinary To Do task.
	 */
	draft?: boolean;
	/**
	 * True while the task is hibernated: its agent, tmux session and dev server
	 * were killed to reclaim memory, while the worktree, branch, uncommitted
	 * changes, notes and PR state stay untouched. A property of the task, not a
	 * column and not a runtime phase — the task keeps its column, sorts below
	 * every live P4 ({@link taskSortRank}) and refuses column changes
	 * ({@link HIBERNATED_TASK_MOVE_ERROR}) until an explicit wake. Absent/false on
	 * every pre-existing task, so older app versions see an ordinary task.
	 */
	hibernated?: boolean;
	/** Hidden from the Active Tasks sidebar only, group-wide; nothing else reads it.
	 *  Absent/false on every pre-existing task, so older app versions see an
	 *  ordinary task. */
	hidden?: boolean;
	/**
	 * True when the task exists to look at code the local user did not write —
	 * it was started on a remote/fork ref (a pull request, a colleague's branch).
	 * A property of the task, not a column and not a runtime phase: it forbids
	 * nothing, blocks no transition and makes nothing read-only. It states whose
	 * code this is, and it gates one thing — dev3 ignores that branch's committed
	 * command-bearing config (`setupScript`, `devScript`, `cleanupScript`, `env`,
	 * `builtinColumnAgents`) and skips agent trust / `.mcp.json` pre-approval,
	 * using the project's own checkout instead (see decision
	 * `trust-the-branch-not-the-project`).
	 *
	 * Set automatically at creation from the branch the task starts on; the user
	 * owns it and may clear it to run that branch's config deliberately — that is
	 * their call to make, with a warning, not ours to refuse. Absent/false on
	 * every pre-existing task, so older app versions see an ordinary task.
	 */
	foreignCode?: boolean;
	/** Role brief injected at creation; cleanup and coordinator tasks always complete manually. */
	taskType?: TaskType | null;
	/**
	 * "Keep alive" — the user asked dev3 to auto-revive this task's agent when its
	 * conversation dies (process exited, usage/rate limit, network/proxy error). A
	 * property of the task in the {@link Task.draft}/{@link Task.hibernated} class:
	 * never a column, a kind, or an action, and inert on its own — only the bun
	 * watchdog scheduler reads it, only for a task whose agent should be running,
	 * and never for a hibernated one. Absent/null on every pre-existing task.
	 * See {@link KeepAliveState}.
	 */
	keepAlive?: KeepAliveState | null;
	/**
	 * The Claude Code session this task was imported from, for a task created by
	 * the conversation import. Nothing about the task behaves differently
	 * afterwards — this is the key that keeps a second import from offering the
	 * same conversation again, and it is never rewritten once set (an import is a
	 * snapshot, and the description belongs to the user from then on).
	 */
	importedSessionId?: string | null;
	/**
	 * For tasks in a virtual ("Operations") project only: the user-chosen fixed
	 * working folder picked at creation (e.g. `~/Downloads`). When absent, the
	 * operation uses a managed temp dir under `~/.dev3.0/ops/<slug>/<taskId>/work`.
	 * On activation this resolves into `worktreePath`; on delete a managed dir is
	 * removed but a fixed folder is never auto-removed. Ignored for git projects.
	 */
	opsWorkDir?: string | null;
	/** Last-launch timestamps (ISO) per package.json script — used to sort the Scripts dropdown. */
	scriptLastRunAt?: Record<string, string>;
	/** Last-used placement per package.json script — pre-selects it in the placement picker. */
	scriptLastPlacement?: Record<string, ScriptPlacement>;
	/**
	 * Git-diff stats captured at completion time (before the worktree is removed),
	 * used by the Productivity dashboard to sum "lines changed" historically. Only
	 * set for non-virtual tasks that had a worktree when completed/cancelled.
	 * See {@link CompletedDiffStats}.
	 */
	completedDiffStats?: CompletedDiffStats | null;
	/**
	 * Images the agent surfaced to the human via `dev3 show-image`, oldest→newest.
	 * Displayed in the TaskImageViewer lightbox. Uncapped — every image the task
	 * shared is kept; the copied files live in the project worktree
	 * `shared-images/` dir and die with the worktree. See {@link SharedImage}.
	 */
	sharedImages?: SharedImage[];
	/**
	 * Video clips the agent surfaced via `dev3 show-media`, oldest→newest. A field
	 * of their own so older app versions, which read every `sharedImages` entry's
	 * bytes, never see them; read every list through {@link taskSharedMedia}.
	 */
	sharedVideos?: SharedImage[];
	/**
	 * Audio tracks the agent surfaced via `dev3 show-media`, oldest→newest. Not in
	 * `sharedVideos`: versions that know that field treat any non-`video/*` entry
	 * as an image and would read a whole track over RPC.
	 */
	sharedAudio?: SharedImage[];
	/**
	 * HTML artifacts an agent surfaced via `dev3 show-artifact`, oldest→newest.
	 * Each artifact is stored in its own additive `shared-artifacts/<id>/`
	 * directory together with any `--assets` files and an optional ZIP bundle.
	 */
	sharedArtifacts?: SharedArtifact[];
	/** The task's one Live Artifact (`dev3 live publish` / `adopt`); see {@link LiveArtifact}. */
	liveArtifact?: LiveArtifact;
	/**
	 * Set when the task was created by a scheduled Automation fire (or its
	 * "Run now" action). Drives the clock provenance glyph on the task card and
	 * links the task back to its automation's run history.
	 */
	automationId?: string | null;
	/**
	 * Who created the task — see {@link TaskOrigin}. Set once at creation and
	 * never by an update; absent means the user. Read through `taskOrigin()`.
	 */
	origin?: TaskOrigin;
	/**
	 * Deferred launch ("Start in…"). Set from the Launch modal when the user
	 * schedules the spawn instead of firing it immediately. Only meaningful on
	 * a `todo` task; the bun scheduled-launch scheduler fires the stored
	 * variants when `at` passes (late fires catch up after app restart) and
	 * the field disappears together with the consumed source task. Cancelled
	 * by setting it back to null.
	 */
	scheduledLaunch?: ScheduledLaunch | null;
	/**
	 * Pending scheduled messages ("Send later") — one-shot texts queued to this
	 * task's live agent/pane, delivered by the bun scheduled-message scheduler
	 * when each item's `at` passes. Unlike {@link Task.scheduledLaunch} this is a
	 * queue; items are removed on delivery, cancel, or an unresolvable target
	 * (drop-with-notice). Explicitly NOT designed to survive a tmux-server / host
	 * restart. Shares the task-card deferred-timer chip slot with
	 * `scheduledLaunch` — the two never coexist (`todo` vs a live-agent task).
	 * See {@link ScheduledMessage}.
	 */
	scheduledMessages?: ScheduledMessage[] | null;
	/**
	 * `dev3 pr watch` subscriptions: the app messages the agent once when the
	 * watched PR event happens, then removes the watch. At most one per kind.
	 */
	prWatches?: PrWatch[] | null;
	/**
	 * Cumulative wall-clock time (ms) the task has spent in each status,
	 * finalized on every status transition (see `applyTaskUpdate` in data.ts).
	 * The *current* status's live portion is NOT included until the task leaves
	 * it — consumers add `now - statusEnteredAt` for live totals. Absent on tasks
	 * created before time tracking shipped (their split is unknown, but total
	 * lifetime is still derivable from `createdAt` → `movedAt`). Lifetime totals
	 * only — they cannot be placed in a reporting period; the Productivity
	 * dashboard clips {@link Task.movements} instead.
	 */
	statusDurations?: Partial<Record<TaskStatus, number>>;
	/**
	 * ISO time the task entered its CURRENT status. Seeded to `createdAt` at
	 * creation and reset on every status change (not on custom-column-only moves,
	 * which keep the same status). Used with {@link Task.statusDurations} to
	 * credit the live portion of the current status. Absent on legacy tasks.
	 */
	statusEnteredAt?: string;
	/**
	 * Cumulative real UI attention time (ms) — the seconds this task was the
	 * on-screen ("active context") task while the app window was foregrounded and
	 * the user was not idle. Accumulated by the backend focus tracker
	 * (`src/bun/focus-tracker.ts`) and flushed periodically. This is the "your
	 * time" / focus-time metric on the Productivity dashboard — distinct from the
	 * wall-clock a task sits in a user-owned status. Absent/0 on legacy tasks.
	 */
	focusMs?: number;
	/**
	 * The same attention split by clock hour: key = {@link focusHourKey} (whole
	 * hours since the Unix epoch, UTC), value = ms credited in that hour. Lets the
	 * dashboard place focus in a reporting period. Written alongside `focusMs`
	 * since it shipped; `focusMs − Σ focusByHour` is attention with no recorded
	 * time (older builds, legacy tasks) and is never spread across periods.
	 */
	focusByHour?: Record<string, number>;
}

export const FOCUS_HOUR_MS = 3_600_000;

/** Bucket key of {@link Task.focusByHour} for an instant. */
export function focusHourKey(ms: number): string {
	return String(Math.floor(ms / FOCUS_HOUR_MS));
}

/** Split the interval [startMs, endMs) into per-hour ms, keyed like {@link Task.focusByHour}. */
export function splitIntervalByHour(startMs: number, endMs: number): Record<string, number> {
	const out: Record<string, number> = {};
	let cursor = startMs;
	while (cursor < endMs) {
		const hourEnd = (Math.floor(cursor / FOCUS_HOUR_MS) + 1) * FOCUS_HOUR_MS;
		const sliceEnd = Math.min(hourEnd, endMs);
		const key = focusHourKey(cursor);
		out[key] = (out[key] ?? 0) + (sliceEnd - cursor);
		cursor = sliceEnd;
	}
	return out;
}

/**
 * Statuses whose wall-clock counts as "agent time" on the Productivity
 * dashboard — the agent is doing work (coding) or an AI is reviewing it.
 */
export const AGENT_TIME_STATUSES: readonly TaskStatus[] = ["in-progress", "review-by-ai"];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "cancelled"];

/**
 * The branch a task's changes should be *compared against* — the base for the
 * branch diff, ahead/behind status, and rebase/merge targets.
 *
 * Normally this is `task.baseBranch` (falling back to the project's default
 * base). PR-review and other "existing branch" tasks are the exception:
 * `deriveTaskBaseBranch` stores their checkout ref as `baseBranch`. The local
 * branch may have the same name, or a fork-qualified checkout ref such as
 * `contributor/feature` may become local branch `feature`. Comparing either
 * checkout shape against HEAD is trivially empty. Fall back to the project's
 * real base branch so diff, commit count, and branch status show the task's
 * actual changes. A variant branch intentionally differs from its source
 * `existingBranch`, so it keeps that source as its comparison base.
 */
export function resolveTaskCompareBaseBranch(
	task: Pick<Task, "baseBranch" | "branchName" | "existingBranch">,
	project: Pick<Project, "defaultBaseBranch">,
): string {
	const projectBase = project.defaultBaseBranch || "main";
	const stored = task.baseBranch || projectBase;
	const existingBranch = task.existingBranch?.trim()
		.replace(/^refs\/remotes\//, "")
		.replace(/^origin\//, "");
	const existingBranchResolvesToTaskBranch = Boolean(
		task.branchName
		&& existingBranch
		&& (
			existingBranch === task.branchName
			|| existingBranch.endsWith(`/${task.branchName}`)
		),
	);
	if (
		(task.branchName && stored === task.branchName)
		|| (existingBranchResolvesToTaskBranch && stored === existingBranch)
	) {
		return projectBase;
	}
	return stored;
}
