/**
 * Typed tmux `-F` format declarations and the ONE parser for their output.
 *
 * Every format the app hands to tmux is declared here as an ordered, typed
 * field list; TmuxClient turns a declaration into the `-F` argument and parses
 * stdout back into typed rows. Convention: a single separator (TAB) across all
 * formats, replacing the space / `|` / `\x1f` conventions that used to coexist.
 *
 * Free-text fields (titles, names, commands) that may contain the separator
 * must be declared LAST via `.tail()` — the parser rejoins everything after
 * the fixed fields, so an embedded TAB cannot shift the typed columns. Only
 * one tail field per format, by construction.
 */

export const TMUX_FORMAT_SEPARATOR = "\t";

type FieldKind = "string" | "number" | "flag" | "tail";

interface FieldDef {
	key: string;
	variable: string;
	kind: FieldKind;
}

export interface TmuxFormat<T> {
	/** The `-F` argument: `#{a}\t#{b}\t…`. */
	readonly formatString: string;
	readonly fields: readonly FieldDef[];
	/** Parse one output line; null when it has fewer columns than declared. */
	parseLine(line: string): T | null;
	/** Parse full stdout: one row per non-empty line, malformed lines dropped. */
	parse(stdout: string): T[];
}

class TmuxFormatImpl<T> implements TmuxFormat<T> {
	readonly formatString: string;
	readonly fields: readonly FieldDef[];

	constructor(fields: readonly FieldDef[]) {
		this.fields = fields;
		this.formatString = fields.map((f) => `#{${f.variable}}`).join(TMUX_FORMAT_SEPARATOR);
	}

	parseLine(line: string): T | null {
		const parts = line.split(TMUX_FORMAT_SEPARATOR);
		if (parts.length < this.fields.length) return null;
		const row: Record<string, string | number | boolean> = {};
		for (let i = 0; i < this.fields.length; i++) {
			const field = this.fields[i];
			const raw = field.kind === "tail"
				? parts.slice(i).join(TMUX_FORMAT_SEPARATOR)
				: parts[i];
			switch (field.kind) {
				case "number": {
					const n = Number(raw);
					row[field.key] = Number.isNaN(n) ? 0 : n;
					break;
				}
				case "flag":
					row[field.key] = raw === "1";
					break;
				default:
					row[field.key] = raw;
			}
		}
		return row as T;
	}

	parse(stdout: string): T[] {
		const rows: T[] = [];
		for (const line of stdout.split("\n")) {
			// Only skip truly empty lines — trimming would eat the separator in
			// front of an EMPTY trailing field (e.g. an unset pane title) and
			// silently drop the whole row as "too few columns".
			if (!line) continue;
			const row = this.parseLine(line);
			if (row !== null) rows.push(row);
		}
		return rows;
	}
}

class TmuxFormatBuilder<T extends object> {
	private constructor(private readonly fields: FieldDef[]) {}

	static create(): TmuxFormatBuilder<object> {
		return new TmuxFormatBuilder([]);
	}

	private add<K extends string, V>(key: K, variable: string, kind: FieldKind): TmuxFormatBuilder<T & Record<K, V>> {
		if (this.fields.some((f) => f.kind === "tail")) {
			throw new Error(`tmux format: field "${key}" declared after a tail field`);
		}
		return new TmuxFormatBuilder<T & Record<K, V>>([...this.fields, { key, variable, kind }]);
	}

	string<K extends string>(key: K, variable: string): TmuxFormatBuilder<T & Record<K, string>> {
		return this.add<K, string>(key, variable, "string");
	}

	number<K extends string>(key: K, variable: string): TmuxFormatBuilder<T & Record<K, number>> {
		return this.add<K, number>(key, variable, "number");
	}

	/** tmux boolean flag variable — `"1"` parses to true, anything else false. */
	flag<K extends string>(key: K, variable: string): TmuxFormatBuilder<T & Record<K, boolean>> {
		return this.add<K, boolean>(key, variable, "flag");
	}

	/**
	 * Final free-text field — consumes the rest of the line, so an embedded
	 * separator in its value cannot shift the preceding typed columns.
	 */
	tail<K extends string>(key: K, variable: string): TmuxFormatBuilder<T & Record<K, string>> {
		return this.add<K, string>(key, variable, "tail");
	}

	build(): TmuxFormat<T> {
		return new TmuxFormatImpl<T>(this.fields);
	}
}

export function tmuxFormat(): TmuxFormatBuilder<object> {
	return TmuxFormatBuilder.create();
}

/** Extract the row type of a format declaration. */
export type TmuxFormatRow<F> = F extends TmuxFormat<infer T> ? T : never;

// ── Format declarations ─────────────────────────────────────────────

/** Bare pane id per line (`%N`). */
export const PANE_ID_FORMAT = tmuxFormat().string("paneId", "pane_id").build();

/** Pane id + root process pid — port/resource scanning. */
export const PANE_PID_FORMAT = tmuxFormat().number("panePid", "pane_pid").build();

/**
 * Server-wide pane pids (`list-panes -a`). Session name is free text set by
 * users' own tmux usage too, so it rides as the tail field.
 */
export const ALL_PANE_PIDS_FORMAT = tmuxFormat()
	.number("panePid", "pane_pid")
	.tail("sessionName", "session_name")
	.build();

/** Pane id + the command the pane was started with — viewer-pane discovery. */
export const PANE_START_COMMAND_FORMAT = tmuxFormat()
	.string("paneId", "pane_id")
	.tail("startCommand", "pane_start_command")
	.build();

/** Pane id + current foreground command — running-tool discovery (yazi). */
export const PANE_CURRENT_COMMAND_FORMAT = tmuxFormat()
	.string("paneId", "pane_id")
	.tail("currentCommand", "pane_current_command")
	.build();

/** Pane id + copy-mode flag — exit-copy-mode sweep. */
export const PANE_IN_MODE_FORMAT = tmuxFormat()
	.string("paneId", "pane_id")
	.flag("inMode", "pane_in_mode")
	.build();

/**
 * Window overview for the layout snapshot (`getTmuxLayout`). `window_layout`
 * never contains a tab (its grammar is digits/`,x{}[]`), so only the
 * free-text window name needs the tail slot.
 */
export const WINDOW_OVERVIEW_FORMAT = tmuxFormat()
	.number("index", "window_index")
	.flag("active", "window_active")
	.number("panes", "window_panes")
	.flag("zoomed", "window_zoomed_flag")
	.string("layout", "window_layout")
	.tail("name", "window_name")
	.build();

/** Per-pane geometry + command for the layout snapshot (`list-panes -s`). */
export const PANE_GEOMETRY_FORMAT = tmuxFormat()
	.number("windowIndex", "window_index")
	.string("paneId", "pane_id")
	.flag("active", "pane_active")
	.number("left", "pane_left")
	.number("top", "pane_top")
	.number("width", "pane_width")
	.number("height", "pane_height")
	.string("command", "pane_current_command")
	.tail("title", "pane_title")
	.build();

/**
 * Pane list for the narrow-viewport pane switcher. `pane_title` defaults to
 * the hostname, so `host_short` rides along to detect an unset title.
 */
export const PANE_SWITCHER_FORMAT = tmuxFormat()
	.string("paneId", "pane_id")
	.flag("active", "pane_active")
	.flag("zoomed", "window_zoomed_flag")
	.string("command", "pane_current_command")
	.string("hostShort", "host_short")
	.tail("title", "pane_title")
	.build();

/** Window list for the narrow-viewport window switcher. */
export const WINDOW_SWITCHER_FORMAT = tmuxFormat()
	.string("windowId", "window_id")
	.flag("active", "window_active")
	.tail("name", "window_name")
	.build();

/** Session overview for the tmux sessions screen. */
export const SESSION_OVERVIEW_FORMAT = tmuxFormat()
	.string("name", "session_name")
	.number("windowCount", "session_windows")
	.number("createdAt", "session_created")
	.tail("cwd", "pane_current_path")
	.build();

/** Status-bar reservation probe (`display-message`) for the layout snapshot. */
export const STATUS_GEOMETRY_FORMAT = tmuxFormat()
	.number("clientHeight", "client_height")
	.number("windowHeight", "window_height")
	.string("status", "status")
	.tail("statusPosition", "status-position")
	.build();

/**
 * Pane hit-testing data for the Alt/Option-click cursor-move gesture.
 * `pane_current_command` goes LAST so a (theoretical) separator in the
 * command name cannot shift the numeric fields.
 */
export const ALT_CLICK_PANE_FORMAT = tmuxFormat()
	.string("paneId", "pane_id")
	.flag("active", "pane_active")
	.number("left", "pane_left")
	.number("top", "pane_top")
	.number("width", "pane_width")
	.number("height", "pane_height")
	.flag("inMode", "pane_in_mode")
	.flag("dead", "pane_dead")
	.number("cursorX", "cursor_x")
	.number("cursorY", "cursor_y")
	.flag("zoomed", "window_zoomed_flag")
	.tail("command", "pane_current_command")
	.build();

// ── window_layout grammar ───────────────────────────────────────────

/**
 * Parse a tmux `window_layout` string into per-pane geometry, keyed by pane id
 * (`%N`). This is the source of truth for spatial layout: it is **zoom
 * independent** — a zoomed window still reports the real split here, whereas the
 * per-pane `pane_left/top/width/height` fields collapse the zoomed pane to the
 * full window and leave the others overlapping it.
 *
 * Layout grammar: `checksum,WxH,X,Y<tree>`, where a leaf cell is `WxH,X,Y,paneId`
 * and a container is `WxH,X,Y{…}` (left/right) or `WxH,X,Y[…]` (top/bottom).
 * Only leaves carry the 5th (paneId) field, so the regex below matches leaves
 * exclusively — a container's `{`/`[` separator stops the 5th group. The trailing
 * integer is the pane id number (the N in `%N`), verified against non-contiguous
 * ids (after a kill-pane). X/Y are absolute window coordinates.
 */
export function parseWindowLayout(layout: string): Map<string, { left: number; top: number; width: number; height: number }> {
	const map = new Map<string, { left: number; top: number; width: number; height: number }>();
	const re = /(\d+)x(\d+),(\d+),(\d+),(\d+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(layout)) !== null) {
		const [, w, h, x, y, id] = m;
		map.set(`%${id}`, { left: Number(x), top: Number(y), width: Number(w), height: Number(h) });
	}
	return map;
}
