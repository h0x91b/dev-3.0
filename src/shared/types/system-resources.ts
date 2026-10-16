// ---- Listening ports ----

export interface PortInfo {
	port: number;
	pid: number;
	processName: string; // "node", "bun", "python3"
}

// ---- Exposed ports (Cloudflare tunnels for dev servers) ----

export type ExposedPortKind = "quick" | "shared";

/**
 * A dev-server port (or group of ports) being shared publicly through a
 * Cloudflare quick-tunnel. `kind: "quick"` is one cloudflared per port
 * → its own random `*.trycloudflare.com` URL. `kind: "shared"` is one
 * cloudflared shared between multiple ports of the same task — those ports
 * are reached via `<url>/p/<port>/...` on the headless server which proxies
 * the request to localhost:<port>. Shared mode lets a frontend and backend
 * talk to each other via relative URLs (no CORS, no hardcoded URLs).
 *
 * State is runtime-only — never persists to tasks.json. Tunnels are torn
 * down on explicit stop, after two consecutive port-scan misses (~20 s),
 * on task removal, and on app shutdown.
 */
export interface ExposedPort {
	taskId: string;
	kind: ExposedPortKind;
	/**
	 * For `quick`, exactly one element — the dev-server port. For `shared`,
	 * the full set of ports reachable through this tunnel.
	 */
	ports: number[];
	url: string | null;
	state: "starting" | "connected" | "failed";
	startedAt: number;
}

// ---- Resource usage ----

export interface ResourceUsage {
	cpu: number;
	rss: number;
}

// ---- System memory (header headroom widget) ----

/**
 * The OS's own verdict on memory scarcity — NOT a percentage threshold we
 * invented. Kept separate from `headroom` on purpose: headroom is a quantity
 * ("can I start another task?"), pressure is a signal ("is the machine hurting?").
 */
export type MemoryPressure = "normal" | "warn" | "critical";

/** Heaviest memory consumers, grouped per application rather than per process. */
export interface MemoryConsumerGroup {
	/** Display name — macOS `.app` bundle name, else executable basename. */
	name: string;
	/** Summed resident memory across the group's processes, in bytes. */
	rss: number;
	/** How many processes the group contains (why one app holds 9 GB). */
	processCount: number;
	/** Executable path of the group's heaviest process. */
	path: string;
	/** Full command line of the heaviest process, length-capped. */
	cmdline: string;
}

export interface MemoryTaskConsumer {
	/** Short task id (first 8 chars), matching `resourceUsageUpdated`. Always set. */
	shortId: string;
	/**
	 * Full task id, or null when the task could not be resolved (its board entry
	 * is gone but its tmux session is still alive). Navigation needs the full id,
	 * so a null here means the row shows its number but is not clickable.
	 */
	taskId: string | null;
	title: string;
	projectId: string;
	rss: number;
}

/**
 * Processes still running inside one finished task's worktree — the app's own
 * leak, grouped per task so the breakdown can name who left them behind.
 */
export interface WorktreeOrphanGroup {
	/** First 8 chars of the task id, read off the worktree path. */
	shortId: string;
	/** Null when no task record survives — the number is still real. */
	taskId: string | null;
	title: string;
	projectId: string;
	/** Command line of the group's root process, for the row's tooltip. */
	command: string;
	pids: number[];
	processCount: number;
	rss: number;
}

export interface SystemMemorySnapshot {
	/** Bytes still available — the number the header pill shows. */
	headroom: number;
	/** Bytes in use, defined to match the OS's own activity monitor. */
	used: number;
	total: number;
	/** Reclaimable file cache: neither used nor free. Shown for honesty. */
	cached: number;
	pressure: MemoryPressure;
	/** True when `pressure` came from a fallback heuristic, not the OS. */
	pressureEstimated: boolean;
	swapUsed: number;
	swapTotal: number;
	/** The swap-out counter moved since the previous sample. */
	swapping: boolean;
	/** Heaviest consumers OUTSIDE dev3 — the comparison that ends the argument. */
	topConsumers: MemoryConsumerGroup[];
	/** The dev3 application process tree itself, separate from its agents. */
	appRss: number;
	/** Tasks with a live tmux session. */
	activeTaskCount: number;
	/**
	 * UPPER BOUND on task memory: shared pages (runtimes, shared libraries) are
	 * counted once per process, so this overstates. Deliberately the least
	 * flattering available figure — labelled as approximate in the UI.
	 */
	tasksRssApprox: number;
	topTasks: MemoryTaskConsumer[];
	/** Median task RSS, or null with no active tasks — never a guessed stand-in. */
	medianTaskRss: number | null;
}
