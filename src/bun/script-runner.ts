/**
 * Stateless helper that opens a package.json script in a new tmux pane or window
 * inside the task's session. Intentionally no registry / no exit tracking — the
 * user owns the pane lifecycle from there (close it manually in tmux, or just
 * run the script again to open another pane).
 */
import type { ScriptPlacement, ScriptRunner } from "../shared/types";
import * as pty from "./pty-server";
import { spawn } from "./spawn";
import { resolveRunnerCommand } from "./package-scripts";
import { createLogger } from "./logger";

const log = createLogger("script-runner");

const taskSessionName = (taskId: string): string => `dev3-${taskId.slice(0, 8)}`;

function placementToTmuxArgs(placement: ScriptPlacement): { kind: "split" | "window"; args: string[] } {
	switch (placement) {
		case "left":
			return { kind: "split", args: ["split-window", "-h", "-b"] };
		case "right":
			return { kind: "split", args: ["split-window", "-h"] };
		case "top":
			return { kind: "split", args: ["split-window", "-v", "-b"] };
		case "bottom":
			return { kind: "split", args: ["split-window", "-v"] };
		case "window":
			return { kind: "window", args: ["new-window"] };
	}
}

interface RunScriptOptions {
	taskId: string;
	worktreePath: string;
	scriptName: string;
	runner: ScriptRunner;
	placement: ScriptPlacement;
	socket?: string;
}

export async function runScript(opts: RunScriptOptions): Promise<void> {
	const { taskId, worktreePath, scriptName, runner, placement } = opts;
	const socket = opts.socket ?? pty.DEFAULT_TMUX_SOCKET;
	const session = taskSessionName(taskId);
	const command = resolveRunnerCommand(runner, scriptName);
	const { kind, args } = placementToTmuxArgs(placement);

	const tmuxArgs = kind === "split"
		? pty.tmuxArgs(
			socket,
			...args,
			"-t",
			`${session}:`,
			"-c",
			worktreePath,
			"-P",
			"-F",
			"#{pane_id}",
			command,
		)
		: pty.tmuxArgs(
			socket,
			...args,
			"-t",
			`${session}:`,
			"-c",
			worktreePath,
			"-n",
			`script:${scriptName}`.slice(0, 20),
			"-P",
			"-F",
			"#{pane_id}",
			command,
		);

	const proc = spawn(tmuxArgs, { stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) {
		log.error("runScript tmux failed", {
			taskId: taskId.slice(0, 8),
			scriptName,
			placement,
			stderr: stderr.trim(),
		});
		throw new Error(`tmux ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`);
	}
	const paneId = stdout.trim();
	if (paneId) {
		spawn(pty.tmuxArgs(socket, "select-pane", "-t", paneId, "-T", `script:${scriptName}`), {
			stdout: "pipe",
			stderr: "pipe",
		}).exited.catch(() => {});
	}
}

export { resolveRunnerCommand };
