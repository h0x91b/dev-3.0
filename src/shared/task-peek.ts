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
import { formatTaskRef } from "./task-refs";

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

/**
 * A backend that publishes no screen at all. It is still a `read-failed` — we
 * genuinely did not read the terminal, and that must never read as "quiet" —
 * but it is the one miss a caller can explain in plain words instead of showing
 * the backend's own token, so the two sides share one spelling of it here.
 */
export const CAPTURE_NOT_ENABLED = "not-enabled";

/** The one place a capture miss is turned into `detail` prose. */
export function captureMissDetail(availability: string, reason: string): string {
	return `${availability}: ${reason}`;
}

/** True when the backend answered "I publish no screen", not "the read broke". */
export function isCaptureUnsupported(miss: PeekUnavailable): boolean {
	return miss.kind === "read-failed" && miss.detail.startsWith(`${CAPTURE_NOT_ENABLED}: `);
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

/**
 * Track the faint/dim (SGR 2) intensity across one `\u001b[…m` sequence. Faint is
 * turned on by parameter 2 and off by 0 (reset all), an empty parameter list (also
 * reset all), or 22 (normal intensity). Extended-colour introducers `38;5;n`,
 * `38;2;r;g;b` (and the `48`/`58` variants) carry sub-parameters that must be
 * skipped, or a truecolour value like `38;2;…` would be misread as "faint on".
 */
function sgrFaintState(params: string, prev: boolean): boolean {
	if (params === "") return false;
	const tokens = params.split(";").map((t) => (t === "" ? 0 : Number(t)));
	let faint = prev;
	for (let i = 0; i < tokens.length; i++) {
		const n = tokens[i];
		if (n === 38 || n === 48 || n === 58) {
			const mode = tokens[i + 1];
			i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			continue;
		}
		if (n === 2) faint = true;
		else if (n === 0 || n === 22) faint = false;
	}
	return faint;
}

/** Prompt glyphs that begin an agent's input line — Claude Code's `❯`, Codex's `›`. */
const PROMPT_GLYPHS = new Set(["❯", "›"]);

/**
 * Is this row the agent's input line? True when its first visible glyph (past
 * leading colour codes and spaces) is a prompt marker. Only such a row carries a
 * ghost, so only such a row is edited.
 */
function isPromptRow(row: string): boolean {
	const visible = stripTerminalEscapes(row).replace(/^\s+/, "");
	return visible.length > 0 && PROMPT_GLYPHS.has(visible[0]);
}

/**
 * Remove the faint (SGR 2) text an agent's TUI shows AFTER the prompt glyph on its
 * input line — Claude Code's dimmed ghost autosuggestion (the previous input echoed
 * back into an EMPTY box) and Codex's `Ask Codex to do anything` placeholder. Peek
 * used to capture without colour, so that ghost reached a coordinator as plain
 * `❯ push it and open the PR` and read as a real unsent message; the coordinator
 * then reported "typed but not sent, press Enter" for a message that had already
 * landed. Peek now captures with colour and runs this first, so the ghost is
 * dropped before {@link stripTerminalEscapes} discards the colour it rode in on.
 *
 * The drop is scoped to the prompt line ON PURPOSE. Faint is not only used for
 * ghosts: Codex renders real content faint (ratatui `DIM` = SGR 2) — tool output,
 * the `Worked for … · HH:MM` line a coordinator reads to know a turn finished — and
 * Claude Code dims a file read's line-number gutter. Dropping every faint run swept
 * those away too. So faint is removed only on a row whose first glyph is a prompt
 * marker, and only after that glyph; the glyph itself, and every other row, are kept.
 * Newlines and tabs always survive. On text with no colour (the native backend's
 * plain-text capture, or `dev3 pane logs`) it is a no-op.
 *
 * To LABEL the ghost instead of dropping it (an easy flip, see the decision record),
 * accumulate the dropped run and re-emit it wrapped instead of discarding it.
 */
export function dropFaintText(text: string): string {
	let faint = false;
	const rows = text.split("\n").map((row) => {
		const editable = isPromptRow(row);
		let out = "";
		let passedGlyph = false;
		let i = 0;
		while (i < row.length) {
			const ch = row[i];
			if (ch === "\u001b" && row[i + 1] === "[") {
				const sgr = /^\u001b\[([0-9;]*)m/.exec(row.slice(i));
				if (sgr) {
					faint = sgrFaintState(sgr[1], faint);
					out += sgr[0];
					i += sgr[0].length;
					continue;
				}
				const csi = /^\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(row.slice(i));
				if (csi) {
					out += csi[0];
					i += csi[0].length;
					continue;
				}
			}
			// Keep everything up to and including the glyph; drop only faint glyphs after it.
			const dropped = editable && passedGlyph && faint && ch !== "\t";
			if (!dropped) out += ch;
			if (editable && PROMPT_GLYPHS.has(ch)) passedGlyph = true;
			i++;
		}
		return out;
	});
	return rows.join("\n");
}

/**
 * Last `limit` lines plus how many there were, with trailing blank lines dropped
 * so the tail ends on content. The one implementation both surfaces read through:
 * `dev3 peek` wants the text, `dev3 pane logs` also wants the count.
 */
export function tailLinesWithCount(text: string, limit: number): { lines: string[]; totalLines: number } {
	const lines = stripTerminalEscapes(text).split("\n");
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === "") end--;
	const kept = lines.slice(0, end);
	return { lines: kept.slice(Math.max(0, kept.length - limit)), totalLines: kept.length };
}

/** Last `limit` lines, with trailing blank lines dropped so the tail ends on content. */
export function tailLines(text: string, limit: number): string {
	return tailLinesWithCount(text, limit).lines.join("\n");
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
	const seq = snapshot.seq === null ? `Task ${snapshot.taskId.slice(0, 8)}` : formatTaskRef(snapshot.seq);
	const out: string[] = [];

	const paneCount = snapshot.panes.length === 1 ? "1 pane" : `${snapshot.panes.length} panes`;
	out.push(
		`${seq} · ${snapshot.title} · ${snapshot.status} · backend=${snapshot.backend} · ${paneCount}`,
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
