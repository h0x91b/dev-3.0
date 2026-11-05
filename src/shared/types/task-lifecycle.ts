import type { AgentFamily } from "./coding-agents";

export interface MergeCompletionPromptState {
	fingerprint: string;
	promptedAt: string;
	dismissedAt?: string | null;
	precise: boolean;
}

export type PreparingStage =
	| "resolving-config"
	| "fetching-origin"
	| "creating-worktree"
	| "applying-sparse-checkout"
	| "cloning-shared-paths"
	| "launching-pty";

export const PREPARING_STAGE_PROGRESS: Record<PreparingStage, number> = {
	"resolving-config": 8,
	"fetching-origin": 24,
	"creating-worktree": 48,
	"applying-sparse-checkout": 62,
	"cloning-shared-paths": 82,
	"launching-pty": 94,
};

export function getPreparingStageProgress(stage: PreparingStage): number {
	return PREPARING_STAGE_PROGRESS[stage];
}

/**
 * If a task spends longer than this on `fetching-origin`, the renderer shows
 * a stuck-preparation popover anchored to the task card pointing macOS users
 * at Full Disk Access (the most common cause of git/tmux child processes
 * silently losing access to .git/worktrees/).
 *
 * Default 60 s. Overridable at app launch via `DEV3_STUCK_PREP_THRESHOLD_SEC`
 * (resolved server-side and pushed to the renderer via
 * `getStuckPreparationThresholdMs` RPC).
 */
export const STUCK_PREPARATION_FETCH_THRESHOLD_MS = 60 * 1000;

/** The launch attribution of one "+ Agent" or bug-hunter pane on a native task. */
export type NativeAgentAttribution = Pick<PaneSessionEntry, "agentCmd" | "agentId" | "configId" | "accountId" | "agentFamily">;

export interface NativeTaskAgent extends NativeAgentAttribution {
	paneId: string;
}

/** Per-pane session info for recovery. */
export interface PaneSessionEntry {
	/** tmux pane ID (e.g. "%0", "%5") — stable within a tmux server lifetime, unique across sessions. */
	paneId?: string | null;
	/** The resolved agent base command (e.g. "claude", "/usr/local/bin/codex"). */
	agentCmd: string;
	/** Resumable agent session ID for this pane. For agents that pre-assign at
	 *  launch (Claude/Cursor `--session-id`/`--resume`, Gemini `--session-id`) this
	 *  is set immediately — Claude's then follows `/clear` and `/resume` through its
	 *  prompt hook; for Codex — which has no launch-time flag — it is filled
	 *  in post-hoc from the lifecycle hook once the session exists, and omp the
	 *  same way from its status extension (see cli-socket-server
	 *  `capturePaneSession`). Null until known / for agents
	 *  that support neither (OpenCode), which fall back to resume-last. */
	sessionId: string | null;
	/** Agent ID used at launch time. */
	agentId: string | null;
	/** Agent config ID used at launch time. */
	configId: string | null;
	/** Managed agent account used at launch time — re-injected on resume so a
	 *  recovered session keeps running under the same account (absent → default). */
	accountId?: string | null;
	/** The agent CLI this pane runs, snapshotted at launch. Resume paths hold only
	 *  a pane, and `agentCmd` alone cannot identify a differently named binary —
	 *  without this a wrapper resumed as an unknown CLI, i.e. as a fresh launch
	 *  carrying the task description. Absent on panes stored by older versions,
	 *  which fall back to the command-name guess. */
	agentFamily?: AgentFamily | null;
	/** For a pane whose conversation started in ANOTHER directory: the directory it
	 *  started in. Its transcript stays in that directory's store forever — a resume
	 *  appends to the original file and only stamps the new cwd into new records — so
	 *  recovery must look there, not in the task's own worktree store. Absent on every
	 *  pane whose session began where the task lives. */
	sessionOriginCwd?: string | null;
	/** Saved for a later resume while no live pane runs it — a task woken with a
	 *  plain shell. The pane reconciler never adopts or drops a parked entry; a
	 *  resume of this pane clears the flag. */
	parked?: boolean;
}

/** Captured session state for agent recovery after tmux death / app restart. */
export interface TaskSessionState {
	/** Panes in order — index 0 is the main pane, rest are extra agent panes. */
	panes: PaneSessionEntry[];
}
