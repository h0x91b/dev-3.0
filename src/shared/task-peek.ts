/**
 * The coordinator-facing contract of `dev3 peek` — a read-only glance at
 * another task's terminal (seq 1410).
 *
 * Peek answers five questions and nothing else: what the agent was last doing,
 * whether output is still moving, whether it is waiting for input, which pane
 * matters, and how old the observation is. It never focuses, writes, or takes
 * ownership, and it deliberately does NOT classify the peer's state — the
 * caller reads the tail and decides, because agent prompt shapes change often
 * and a wrong label is worse than no label.
 *
 * Types and rendering live here (shared, pure) so the socket payload and the
 * CLI output can never drift apart.
 */

/**
 * Precision of a pane's `lastOutputAt`. `native` gives per-pane times (each
 * pane is its own session with its own persisted snapshot); tmux has NO
 * per-pane activity variable (verified against a live tmux 3.6a: only
 * `#{window_activity}` exists), so its number describes the whole window.
 */
export type PeekFreshnessGranularity = "pane" | "window";

/** Which terminal backend answered. */
export type PeekBackend = "tmux" | "native";

/**
 * Why there is nothing (or less than asked) to show. Kept a discriminated value
 * rather than prose so a caller can tell the three apart — conflating them is the
 * expensive mistake peek exists to avoid:
 *  - `no-session`     — the task has no terminal at all (draft, hibernated, idle).
 *  - `read-failed`    — a terminal may well be running; WE could not read it.
 *  - `pane-not-found` — the session is fine, the requested pane does not exist.
 */
export type PeekUnavailableKind = "no-session" | "read-failed" | "pane-not-found";

export interface PeekUnavailable {
	kind: PeekUnavailableKind;
	detail: string;
}

export interface PeekPane {
	/** 1-based, the number `--pane N` accepts and the summary prints. */
	index: number;
	/** Backend pane id (`%17` on tmux, `pane-2` on native); also accepted by `--pane`. */
	paneId: string;
	/** Foreground command or pane title — how the reader tells panes apart. */
	label: string;
	alive: boolean;
	focused: boolean;
	/** ISO time of the last output, or null when the backend cannot say. */
	lastOutputAt: string | null;
	/** Age at `observedAt`, so a JSON consumer needs no second clock. Null with `lastOutputAt`. */
	lastOutputAgeMs: number | null;
	granularity: PeekFreshnessGranularity;
}

export interface PeekTail {
	paneIndex: number;
	paneId: string;
	/** How many lines the text actually holds (≤ the requested budget). */
	lines: number;
	text: string;
}

export interface TaskPeekSnapshot {
	taskId: string;
	seq: number | null;
	title: string;
	status: string;
	backend: PeekBackend;
	/** When peek queried the backend — the age of the observation itself. */
	observedAt: string;
	/** False for an idle, hibernated, draft, or finished task, and when the read failed. */
	sessionPresent: boolean;
	/** Set whenever something is missing — no session, a failed read, or an unknown pane. */
	unavailable: PeekUnavailable | null;
	panes: PeekPane[];
	tail: PeekTail | null;
}

/** Default tail budget: the whole visible screen of any realistic pane, plus history. */
export const PEEK_DEFAULT_LINES = 120;
/** Hard cap, so one glance cannot flood a coordinator's context with logs. */
export const PEEK_MAX_LINES = 1000;

// ── Text helpers ─────────────────────────────────────────────────────────────

/**
 * Strip terminal escape sequences so the tail reads as plain text: OSC and
 * DCS-family strings, CSI sequences, other two-char escapes, then any leftover
 * control byte. Tabs and newlines survive — they carry layout the reader needs.
 */
export function stripTerminalEscapes(text: string): string {
	return text
		// OSC: ESC ] ... BEL or ESC backslash
		.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
		// DCS / SOS / PM / APC: ESC P|X|^|_ ... ESC backslash
		.replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, "")
		// CSI: ESC [ params intermediates final
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		// Any other two-char escape (charset selection, keypad mode, ESC 7/8, ...)
		.replace(/\u001b[@-Z\\-_0-9<=>]/g, "")
		// Leftover control bytes, keeping TAB (09) and LF (0a)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Last `limit` lines, with trailing blank lines dropped so the tail ends on content. */
export function tailLines(text: string, limit: number): string {
	const lines = stripTerminalEscapes(text).split("\n");
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === "") end--;
	const kept = lines.slice(0, end);
	return kept.slice(Math.max(0, kept.length - limit)).join("\n");
}

/** Clamp a requested line budget into the supported range. */
export function clampPeekLines(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested)) return PEEK_DEFAULT_LINES;
	return Math.min(PEEK_MAX_LINES, Math.max(1, Math.floor(requested)));
}

// ── Pane selection ───────────────────────────────────────────────────────────

/**
 * Resolve a `--pane` value against a pane list. Accepts the 1-based index the
 * summary prints and the raw backend pane id, because an agent that copied an
 * id out of the output should not be punished with a usage error. Returns null
 * when nothing matches; undefined selector means "the focused pane".
 */
export function selectPeekPane(panes: readonly PeekPane[], selector?: string | number): PeekPane | null {
	if (panes.length === 0) return null;
	if (selector === undefined || selector === "") {
		return panes.find((p) => p.focused) ?? panes[0];
	}
	const raw = String(selector).trim();
	if (/^\d+$/.test(raw)) {
		const byIndex = panes.find((p) => p.index === Number(raw));
		if (byIndex) return byIndex;
	}
	return panes.find((p) => p.paneId === raw) ?? null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Whole seconds, then minutes, then hours — a coordinator reads coarse ages fine. */
export function formatAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function unavailableLine(unavailable: PeekUnavailable): string {
	switch (unavailable.kind) {
		case "no-session":
			return `no terminal session — ${unavailable.detail}`;
		case "read-failed":
			// Never "it is quiet": we do not know whether it is quiet.
			return `could not read the terminal — ${unavailable.detail}. This says nothing about whether the task is working.`;
		case "pane-not-found":
			return `no such pane — ${unavailable.detail}. The pane summary above is still accurate.`;
	}
}

function paneLine(pane: PeekPane, nowMs: number): string {
	const label = pane.label || "(no command)";
	const liveness = pane.alive ? "alive" : "dead";
	const focus = pane.focused ? ", focused" : "";
	const freshness = pane.lastOutputAt === null
		? "last output unknown"
		: `last output ${formatAge(nowMs - Date.parse(pane.lastOutputAt))}`;
	const precision = pane.granularity === "window" ? " (window-level)" : "";
	return `pane ${pane.index}  ${label}  ${liveness}${focus}  ${freshness}${precision}`;
}

/**
 * Render a snapshot for a human or an agent reading a terminal. `now` is
 * injected so the output is deterministic in tests.
 */
export function renderTaskPeek(snapshot: TaskPeekSnapshot, now: Date): string {
	const nowMs = now.getTime();
	const seq = snapshot.seq === null ? snapshot.taskId.slice(0, 8) : String(snapshot.seq);
	const out: string[] = [];

	const paneCount = snapshot.panes.length === 1 ? "1 pane" : `${snapshot.panes.length} panes`;
	out.push(
		`Task ${seq} · ${snapshot.title} · ${snapshot.status} · backend=${snapshot.backend} · ${paneCount}`,
	);
	out.push(`observed ${formatAge(nowMs - Date.parse(snapshot.observedAt))}`);

	if (snapshot.unavailable && snapshot.unavailable.kind !== "pane-not-found") {
		out.push("");
		out.push(unavailableLine(snapshot.unavailable));
		return `${out.join("\n")}\n`;
	}

	out.push("");
	for (const pane of snapshot.panes) out.push(paneLine(pane, nowMs));

	if (snapshot.panes.some((p) => p.granularity === "window")) {
		out.push("");
		out.push("note: this backend reports activity per window, not per pane — the times above cover the whole window.");
	}

	if (snapshot.unavailable?.kind === "pane-not-found") {
		out.push("");
		out.push(unavailableLine(snapshot.unavailable));
	}

	if (snapshot.tail) {
		out.push("");
		out.push(`--- pane ${snapshot.tail.paneIndex} (${snapshot.tail.paneId}), last ${snapshot.tail.lines} lines ---`);
		out.push(snapshot.tail.text);
	}

	return `${out.join("\n")}\n`;
}
