/**
 * Pure logic for the Alt/Option-click "move the shell cursor" gesture.
 *
 * dev3's tmux runs with `mouse on`, which keeps SGR mouse tracking enabled on
 * the OUTER terminal for the whole session — so the renderer cannot tell a
 * plain shell pane from a mouse-owning TUI (Claude Code, vim, htop) by looking
 * at `hasMouseTracking()` (verified empirically: tmux emits \x1b[?1000h/1002h/
 * 1006h on attach; see decision 093). The gate therefore lives here, on the
 * backend, where tmux can be asked what actually runs in the clicked pane.
 *
 * The flow (handler `tmuxAltClickMoveCursor` in rpc-handlers/tmux-pty.ts):
 *   1. list-panes of the session's current window → parseAltClickPanes()
 *   2. hit-test the clicked cell → findAltClickPane()
 *   3. eligibility: plain shell, not copy-mode, not dead → altClickIneligibleReason()
 *   4. same-row + clamp to the line's text + delta → computeAltClickKeys()
 *   5. select-pane + send-keys Left/Right × count
 *
 * Everything in this module is pure and unit-tested; the handler only does
 * the tmux I/O around it.
 */

export interface AltClickPane {
	paneId: string;
	active: boolean;
	/** Pane geometry in window cells, 0-based (tmux #{pane_left}/#{pane_top}). */
	left: number;
	top: number;
	width: number;
	height: number;
	/** Pane is in a tmux mode (copy-mode) — arrows would move the mode cursor. */
	inMode: boolean;
	dead: boolean;
	/** Cursor position, pane-relative, 0-based (tmux #{cursor_x}/#{cursor_y}). */
	cursorX: number;
	cursorY: number;
	/** Foreground process name (tmux #{pane_current_command}). */
	command: string;
	/** Window is zoomed — only the active pane is visible (full-window). */
	zoomed: boolean;
}

/**
 * tmux list-panes -F format consumed by parseAltClickPanes().
 * pane_current_command goes LAST so a (theoretical) tab in the command name
 * cannot shift the numeric fields.
 */
export const ALT_CLICK_PANE_FORMAT = [
	"#{pane_id}",
	"#{pane_active}",
	"#{pane_left}",
	"#{pane_top}",
	"#{pane_width}",
	"#{pane_height}",
	"#{pane_in_mode}",
	"#{pane_dead}",
	"#{cursor_x}",
	"#{cursor_y}",
	"#{window_zoomed_flag}",
	"#{pane_current_command}",
].join("\t");

export function parseAltClickPanes(stdout: string): AltClickPane[] {
	return stdout
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.flatMap((line) => {
			const parts = line.split("\t");
			if (parts.length < 12) return [];
			const [paneId, active, left, top, width, height, inMode, dead, cursorX, cursorY, zoomed, ...cmd] = parts;
			if (!paneId.startsWith("%")) return [];
			return [{
				paneId,
				active: active === "1",
				left: Number(left) || 0,
				top: Number(top) || 0,
				width: Number(width) || 0,
				height: Number(height) || 0,
				inMode: inMode === "1",
				dead: dead === "1",
				cursorX: Number(cursorX) || 0,
				cursorY: Number(cursorY) || 0,
				command: cmd.join("\t"),
				zoomed: zoomed === "1",
			}];
		});
}

/**
 * Interactive shells whose line editor (readline/ZLE) moves on plain arrow
 * keys. Anything else — TUIs (claude/node, vim, htop), pagers (less, man),
 * remote sessions (ssh), REPLs — is left alone.
 */
const SHELL_COMMANDS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh"]);

export function isShellCommand(command: string): boolean {
	// Login shells may report with a leading dash (-zsh).
	return SHELL_COMMANDS.has(command.replace(/^-/, "").toLowerCase());
}

/**
 * Find the pane containing the clicked window cell (0-based). Cells on pane
 * borders or the status line belong to no pane → null. When the window is
 * zoomed only the active pane is visible (full-window), so hidden panes'
 * stale geometry must not win the hit-test.
 */
export function findAltClickPane(panes: AltClickPane[], x0: number, y0: number): AltClickPane | null {
	const zoomed = panes.some((p) => p.zoomed);
	const candidates = zoomed ? panes.filter((p) => p.active) : panes;
	return candidates.find(
		(p) =>
			!p.dead &&
			x0 >= p.left &&
			x0 < p.left + p.width &&
			y0 >= p.top &&
			y0 < p.top + p.height,
	) ?? null;
}

/** Why this pane must not receive a cursor move, or null when it is eligible. */
export function altClickIneligibleReason(pane: AltClickPane): string | null {
	if (pane.dead) return "pane is dead";
	if (pane.inMode) return "pane is in copy-mode";
	if (!isShellCommand(pane.command)) return `not a shell (${pane.command})`;
	return null;
}

/**
 * Compute the arrow keys that walk the shell cursor to the clicked cell.
 *
 * - Cross-row clicks return null: in a shell Up/Down means history, not
 *   motion, and wrapped-line row deltas are ambiguous.
 * - The target column is clamped to the row's text length so clicking in the
 *   blank area right of the input lands exactly at end-of-line instead of
 *   spraying extra Rights (which e.g. zsh-autosuggestions would interpret as
 *   "accept suggestion").
 * - `rowText` length is measured in code units — wide glyphs (CJK, emoji) on
 *   the line skew the clamp by their extra columns. Accepted v1 limitation.
 */
export function computeAltClickKeys(
	pane: AltClickPane,
	x0: number,
	y0: number,
	rowText: string,
): { key: "Left" | "Right"; count: number } | null {
	if (y0 - pane.top !== pane.cursorY) return null;
	const lineLen = rowText.replace(/\s+$/, "").length;
	const targetX = Math.min(x0 - pane.left, lineLen);
	const delta = targetX - pane.cursorX;
	if (delta === 0) return null;
	return {
		key: delta > 0 ? "Right" : "Left",
		count: Math.min(Math.abs(delta), Math.max(1, pane.width)),
	};
}
