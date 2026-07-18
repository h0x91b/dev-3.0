/**
 * Stateless helper that opens a package.json script or Makefile target in a new
 * tmux pane or window inside the task's session. Intentionally no registry / no
 * exit tracking — the user owns the pane lifecycle from there (close it manually
 * in tmux, or just run it again to open another pane).
 */
import type { ScriptPlacement, ScriptRunner, ScriptSource } from "../shared/types";
import { tmux, DEFAULT_TMUX_SOCKET, TmuxError, taskSessionName, type SplitOrientation } from "./tmux";
import { resolveRunnerCommand } from "./package-scripts";
import { resolveMakeCommand } from "./makefile";
import { createLogger } from "./logger";

const log = createLogger("script-runner");

type ScriptPlacementSpec =
	| { kind: "split"; orientation: SplitOrientation; before: boolean }
	| { kind: "window" };

function placementSpec(placement: ScriptPlacement): ScriptPlacementSpec {
	switch (placement) {
		case "left":
			return { kind: "split", orientation: "horizontal", before: true };
		case "right":
			return { kind: "split", orientation: "horizontal", before: false };
		case "top":
			return { kind: "split", orientation: "vertical", before: true };
		case "bottom":
			return { kind: "split", orientation: "vertical", before: false };
		case "window":
			return { kind: "window" };
	}
}

interface RunScriptOptions {
	taskId: string;
	worktreePath: string;
	scriptName: string;
	source: ScriptSource;
	runner: ScriptRunner;
	placement: ScriptPlacement;
	socket?: string;
}

export async function runScript(opts: RunScriptOptions): Promise<void> {
	const { taskId, worktreePath, scriptName, source, runner, placement } = opts;
	const socket = opts.socket ?? DEFAULT_TMUX_SOCKET;
	const session = taskSessionName(taskId);
	const command = source === "make"
		? resolveMakeCommand(scriptName)
		: resolveRunnerCommand(runner, scriptName);
	const label = source === "make" ? `make:${scriptName}` : `script:${scriptName}`;
	// Keep the pane alive after the script exits so the user can read the tail
	// of the output. They press Enter (or any key) to close the pane.
	// Single quotes around the inner script protect against the outer shell —
	// `command` is built from a safe-name validator so it cannot contain quotes.
	const wrapped = `bash -c '${command}; __EC=$?; printf "\\n\\033[2m[exited %s — press Enter to close]\\033[0m " "$__EC"; read'`;
	const spec = placementSpec(placement);

	let paneId: string | null;
	try {
		if (spec.kind === "split") {
			({ paneId } = await tmux.splitWindow({
				target: `${session}:`,
				orientation: spec.orientation,
				before: spec.before,
				cwd: worktreePath,
				printPaneId: true,
				command: wrapped,
				socket,
			}));
		} else {
			({ paneId } = await tmux.newWindow({
				target: `${session}:`,
				cwd: worktreePath,
				name: label.slice(0, 20),
				printPaneId: true,
				command: wrapped,
				socket,
			}));
		}
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		log.error("runScript tmux failed", {
			taskId: taskId.slice(0, 8),
			scriptName,
			placement,
			stderr: err.stderr,
		});
		const subcommand = spec.kind === "split" ? "split-window" : "new-window";
		throw new Error(`tmux ${subcommand} failed: ${err.stderr || `exit ${err.exitCode}`}`);
	}
	if (paneId) {
		tmux.selectPane(paneId, { socket, title: label }).catch(() => {});
	}
}

export { resolveRunnerCommand };
