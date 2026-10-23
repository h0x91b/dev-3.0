import type { TaskPaneBackendKind } from "../task-panes";
import type { PortInfo, ResourceUsage } from "./system-resources";

// ---- Task dev server ----

/**
 * One declared dev server of a task: its identity, whether it is up, and the
 * ports and processes that belong to IT rather than to the task as a whole.
 */
export interface DevServerEntry {
	/** `dev` for the server `devScript` declares, else its key in `devServers`. */
	name: string;
	/** Display label for panes and the UI. */
	title: string;
	/** True for the server backed by `devScript` — the one an unnamed command means. */
	isDefault: boolean;
	running: boolean;
	/** tmux only — empty on a native task, whose dev server runs in its pane. */
	devSessionName: string;
	viewerPaneId: string | null;
	panePids: number[];
	/** This server's named ports and the pool port each resolved to. */
	namedPorts: Record<string, number>;
	/**
	 * Listening ports bound by processes inside the dev-server tmux session's
	 * own process tree (empty when stopped). Unlike `ports` (whole task session,
	 * cached), this is a live scan scoped to the dev server — the readiness
	 * signal `dev3 dev-server start --wait` polls for, which prefers an entry on
	 * an `assignedPorts` port and only falls back to the others after a grace
	 * window.
	 */
	devPorts: PortInfo[];
	/**
	 * Assigned pool ports that started LISTENing after this dev server launched,
	 * bound by a process outside its tree — i.e. published on its behalf. Every
	 * containerised devScript lands here: the container runtime's daemon owns
	 * the published socket, never the pane. Counts as ready for `--wait`.
	 */
	publishedPorts: PortInfo[];
	/**
	 * Assigned pool ports bound by a process OUTSIDE the dev-server tree that
	 * was ALREADY listening before this dev server started (or is listening
	 * while it is stopped) — a real squatter that will make the devScript
	 * crash-loop on bind. Surfaced so it is visible at start/status instead of
	 * only as a downstream 502.
	 */
	portConflicts: PortInfo[];
	/**
	 * Names of the caller-supplied variables this dev server was started with
	 * (`dev3 dev-server start --env KEY=VALUE`), sorted. **Names only, never
	 * values** — a value can be a token, and this status is printed by the CLI,
	 * pushed to the renderer and written to logs. Empty for an ordinary start.
	 */
	extraEnvKeys: string[];
	/**
	 * Arguments appended to this server's script by the last start
	 * (`dev3 dev-server start -- --own-db`), in full: unlike env they are shown,
	 * so a secret belongs in `--env`. Empty for an ordinary start.
	 */
	scriptArgs: string[];
	/**
	 * Where THIS server's output is mirrored as plain text
	 * (`<taskDir>/logs/dev-server.log`, or `dev-server-<name>.log`) — the file
	 * `dev3 dev-server logs` reads and an agent greps instead of attaching to a
	 * pane. Null when the task has no worktree to hang it off. The file itself may
	 * not exist yet: capture starts with the server.
	 */
	logPath: string | null;
	resourceUsage?: ResourceUsage;
}

/**
 * Every dev server of one task. A task can declare several, so this is an
 * envelope: the facts that belong to the task live here, and the per-server
 * facts live in {@link DevServerEntry}.
 */
export interface DevServerStatus {
	projectId: string;
	taskId: string;
	/** True when at least one declared server is up. */
	running: boolean;
	/** True when the task declares any dev server at all. */
	hasDevScript: boolean;
	worktreePath: string | null;
	tmuxSocket: string;
	/** tmux only — empty on a native task, which has no tmux session of any kind. */
	taskSessionName: string;
	/** Which terminal backend hosts these dev servers. */
	backend: TaskPaneBackendKind;
	/** Every pool port of the task: the positional block first, then the named ones. */
	assignedPorts: number[];
	/** The task's named ports and the pool port each resolved to — every server gets all of them. */
	namedPorts: Record<string, number>;
	/** Ports detected across the whole task session, ascending by port. */
	ports: PortInfo[];
	/** One entry per declared server, in declaration order (`dev` first). */
	servers: DevServerEntry[];
	/** Config mistakes in the declaration (duplicate port, `dev` declared twice). */
	configErrors: string[];
	/**
	 * Set only when the live state could not be read because tmux itself failed
	 * to launch (e.g. macOS Full Disk Access lost). When present, `running` and
	 * every tmux-derived field are unknown, not authoritative — the CLI renders
	 * "unknown" plus this actionable diagnostic instead of hard-crashing on a raw
	 * `posix_spawn ENOENT`. Additive/optional: older backends never send it and
	 * older CLIs ignore it, so it doesn't affect the frozen on-disk layout.
	 */
	tmuxError?: string;
}

/**
 * The board's view of a dev server — the few facts a Kanban card can act on,
 * broadcast for every active task. Deliberately NOT {@link DevServerStatus}:
 * that one is a per-task on-demand read (tmux + lsof + process tree) sized for
 * the inspector, far too heavy to push for a whole board every poll cycle.
 */
export interface DevServerSummary {
	taskId: string;
	/** No dev script resolved for this task's branch → the card shows no control. */
	hasDevScript: boolean;
	/** True when at least one declared server is up. */
	running: boolean;
	/** Ports the dev servers are serving on, ascending. Empty while they boot. */
	ports: number[];
	/**
	 * Assigned pool ports held by a foreign process while the dev server is down
	 * — the devScript will crash-loop on bind if started. Ascending.
	 */
	conflictPorts: number[];
	/** How many dev servers this task declares. */
	declaredCount: number;
	/** How many of them are up. */
	runningCount: number;
	/** Per-server state, in declaration order — what the card's pill counts and opens. */
	servers: DevServerSummaryEntry[];
}

/** One server's line in a board summary: enough to show a dot and open a port. */
export interface DevServerSummaryEntry {
	name: string;
	isDefault: boolean;
	running: boolean;
	/** Ports this server is serving on, ascending. */
	ports: number[];
}
