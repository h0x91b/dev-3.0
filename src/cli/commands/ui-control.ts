import { sendRequest } from "../socket-client";
import { exitError, exitUsage, printDetail } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import type { TmuxLayout, TmuxPaneInfo } from "../../shared/types";

const NOTIFY_MAX_LEN = 500;

/**
 * `dev3 notify "message"` — surface an in-app toast (default) or a native OS
 * notification (`--desktop`) in the running app. When a task is in context the
 * toast/notification is clickable and lands the user on that task.
 */
export async function handleNotify(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "level", "desktop", "message"]);

	const message = (args.positional[0] ?? args.flags.message ?? "").toString().trim();
	if (!message) {
		exitUsage('Usage: dev3 notify "message" [--level info|success|error] [--desktop]');
	}
	if (message.length > NOTIFY_MAX_LEN) {
		exitUsage(`Message too long (${message.length} chars). Keep it under ${NOTIFY_MAX_LEN} characters.`);
	}

	const level = (args.flags.level ?? "info").toLowerCase();
	if (level !== "info" && level !== "success" && level !== "error") {
		exitUsage(`Invalid --level "${level}". Use info, success, or error.`);
	}

	// `--desktop` is a boolean flag (no value or any value except an explicit "false").
	const desktop = "desktop" in args.flags && args.flags.desktop !== "false";

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	const params: Record<string, unknown> = { message, level };
	if (desktop) params.desktop = true;

	if (rawTaskId) {
		params.taskId = expandShortId(rawTaskId, context);
		const projectId = resolveProjectId(args.flags.project, context);
		if (projectId) params.projectId = projectId;
	} else if (desktop) {
		exitUsage("--desktop needs a task — run inside a worktree or pass --task <id>.");
	}

	const resp = await sendRequest(socketPath, "ui.notify", params);
	if (!resp.ok) exitError(resp.error || "Failed to send notification");

	const data = resp.data as { delivered: boolean; mode: string };
	if (!data.delivered) {
		process.stdout.write("App is running but has no open window — nothing was shown.\n");
		return;
	}
	process.stdout.write(`${data.mode === "desktop" ? "Desktop notification" : "Toast"} sent.\n`);
}

/**
 * `dev3 attention "reason"` — light the red attention badge on a task card, with
 * an optional hoverable reason. Same visual surface as the terminal bell.
 */
export async function handleAttention(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, ["task", "task-id", "project", "reason"]);

	const reason = (args.positional[0] ?? args.flags.reason ?? "").toString().trim();
	if (reason.length > NOTIFY_MAX_LEN) {
		exitUsage(`Reason too long (${reason.length} chars). Keep it under ${NOTIFY_MAX_LEN} characters.`);
	}

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) {
		exitUsage("No task in context. Run inside a worktree or pass --task <id> / --task-id <id>.");
	}

	const params: Record<string, unknown> = { taskId: expandShortId(rawTaskId, context), reason };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "ui.attention", params);
	if (!resp.ok) exitError(resp.error || "Failed to raise attention");

	const data = resp.data as { delivered: boolean; taskId: string };
	if (!data.delivered) {
		process.stdout.write("App is running but has no open window — badge not shown.\n");
		return;
	}
	process.stdout.write(`Attention badge raised on task ${data.taskId.slice(0, 8)}.\n`);
}

interface UiStateResponse {
	appRunning: boolean;
	foreground: boolean;
	activeProjectId: string | null;
	activeTaskId: string | null;
	userIdleSeconds: number | null;
	tmux: TmuxLayout | null;
}

/** Human-friendly idle time, e.g. "active (3s idle)", "idle 12m", "unknown". */
function formatIdle(seconds: number | null): string {
	if (seconds == null) return "unknown";
	if (seconds < 60) return `active (${seconds}s idle)`;
	if (seconds < 3600) return `idle ${Math.round(seconds / 60)}m`;
	return `idle ${Math.round(seconds / 3600)}h`;
}

/**
 * Render the active window's panes as a small ASCII box map, scaled to fit a
 * fixed canvas. Geometry comes from tmux pane_left/top/width/height (char cells).
 */
function renderPaneMap(panes: TmuxPaneInfo[]): string[] {
	if (panes.length === 0) return [];
	const winW = Math.max(...panes.map((p) => p.left + p.width));
	const winH = Math.max(...panes.map((p) => p.top + p.height));
	if (winW <= 0 || winH <= 0) return [];

	const COLS = Math.min(winW, 54);
	const ROWS = Math.min(Math.max(Math.round(winH * (COLS / winW) * 0.5), 6), 18);
	const sx = COLS / winW;
	const sy = ROWS / winH;
	const grid: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));

	const put = (x: number, y: number, ch: string) => {
		if (y >= 0 && y < ROWS && x >= 0 && x < COLS) grid[y][x] = ch;
	};

	for (const p of panes) {
		const x0 = Math.min(Math.round(p.left * sx), COLS - 1);
		const y0 = Math.min(Math.round(p.top * sy), ROWS - 1);
		const x1 = Math.min(Math.round((p.left + p.width) * sx) - 1, COLS - 1);
		const y1 = Math.min(Math.round((p.top + p.height) * sy) - 1, ROWS - 1);
		if (x1 <= x0 || y1 <= y0) continue;

		for (let x = x0; x <= x1; x++) {
			put(x, y0, "─");
			put(x, y1, "─");
		}
		for (let y = y0; y <= y1; y++) {
			put(x0, y, "│");
			put(x1, y, "│");
		}
		put(x0, y0, "┌");
		put(x1, y0, "┐");
		put(x0, y1, "└");
		put(x1, y1, "┘");

		const label = `${p.active ? "*" : ""}${p.command || p.paneId}`;
		const maxLen = x1 - x0 - 1;
		if (maxLen > 0) {
			const text = label.slice(0, maxLen);
			for (let i = 0; i < text.length; i++) put(x0 + 1 + i, y0 + 1, text[i]);
		}
	}

	return grid.map((row) => row.join("").replace(/\s+$/, ""));
}

function printTmuxSection(layout: TmuxLayout): void {
	process.stdout.write(`\ntmux  ${layout.sessionName}`);
	if (!layout.exists) {
		process.stdout.write("  (no session)\n");
		return;
	}
	process.stdout.write(`  (${layout.windows.length} window(s), ${layout.panes.length} pane(s))\n`);

	const activeWindow = layout.windows.find((w) => w.active) ?? layout.windows[0];
	if (activeWindow) {
		const activePanes = layout.panes.filter((p) => p.windowIndex === activeWindow.index);
		process.stdout.write(`\nwindow ${activeWindow.index} "${activeWindow.name}" — layout:\n`);
		for (const line of renderPaneMap(activePanes)) {
			process.stdout.write(`  ${line}\n`);
		}
		process.stdout.write("\npanes (active window):\n");
		for (const p of activePanes) {
			const marker = p.active ? "*" : " ";
			process.stdout.write(
				`  ${marker} ${p.paneId.padEnd(5)} ${`${p.width}x${p.height}`.padEnd(8)} ${p.command}\n`,
			);
		}
	}

	if (layout.windows.length > 1) {
		process.stdout.write("\nwindows:\n");
		for (const w of layout.windows) {
			process.stdout.write(`  ${w.active ? "*" : " "} ${String(w.index).padEnd(3)} ${w.name} (${w.panes} pane(s))\n`);
		}
	}
}

/**
 * `dev3 ui state` — report what the app is currently showing (focused task /
 * project, foreground) plus the worktree's tmux layout (windows, panes, an ASCII
 * map) so an agent can decide whether a ping is even needed. `--json` for machines.
 */
export async function handleUi(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	if (subcommand !== "state") {
		exitUsage(`Unknown subcommand: ui ${subcommand || "(none)"}\nAvailable: ui state`);
	}
	rejectUnknownFlags(args, ["task", "task-id", "project", "json"]);

	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	const params: Record<string, unknown> = {};
	if (rawTaskId) params.taskId = expandShortId(rawTaskId, context);

	const resp = await sendRequest(socketPath, "ui.state", params);
	if (!resp.ok) exitError(resp.error || "Failed to read UI state");

	const d = resp.data as UiStateResponse;

	if ("json" in args.flags) {
		process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
		return;
	}

	printDetail([
		["app", d.appRunning ? "running" : "not running"],
		["foreground", d.foreground ? "yes" : "no"],
		["userActivity", formatIdle(d.userIdleSeconds)],
		["activeProject", d.activeProjectId ? d.activeProjectId.slice(0, 8) : "(none)"],
		["activeTask", d.activeTaskId ? d.activeTaskId.slice(0, 8) : "(none)"],
	]);

	if (context?.taskId && d.activeTaskId === context.taskId) {
		process.stdout.write(
			`\nThis task is currently focused${d.foreground ? " and the app is in the foreground." : " (app in background)."}\n`,
		);
	}

	// Nudge the agent toward the right channel when the user is away.
	if (d.userIdleSeconds != null && d.userIdleSeconds >= 300) {
		process.stdout.write(
			`\nUser has been idle ${formatIdle(d.userIdleSeconds).replace(/^idle /, "")} — they may not see an in-app toast; prefer --desktop or hold.\n`,
		);
	}

	if (d.tmux) printTmuxSection(d.tmux);
}
