import { dirname, join } from "node:path";
import type { CliContext } from "../context";
import { exitError } from "../output";
import { writeClaudeHooks } from "../../shared/agent-hooks";

const WORKTREES_DIR = `${process.env.HOME || "/tmp"}/.dev3.0/worktrees`;

/**
 * Walk up from cwd to find the worktree root
 * (path matching ~/.dev3.0/worktrees/{slug}/{id}/worktree).
 */
function detectWorktreePath(cwd: string): string | null {
	let dir = cwd;
	for (let i = 0; i < 30; i++) {
		if (dir.startsWith(WORKTREES_DIR + "/")) {
			const relative = dir.slice(WORKTREES_DIR.length + 1);
			const parts = relative.split("/");
			if (parts.length >= 3 && parts[2] === "worktree") {
				return join(WORKTREES_DIR, parts[0], parts[1], "worktree");
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export async function handleInstallHooks(context: CliContext | null): Promise<void> {
	const worktreePath = detectWorktreePath(process.cwd());
	if (!worktreePath) {
		exitError("Cannot detect worktree path", "Run this command from inside a dev-3.0 worktree.");
	}
	if (!context?.taskId) {
		exitError("Cannot detect task ID", "Run this command from inside a dev-3.0 worktree.");
	}

	const taskId = context.taskId;
	const settingsPath = join(worktreePath, ".claude", "settings.local.json");

	writeClaudeHooks(worktreePath, taskId);

	process.stdout.write(`Installed Claude Code hooks → ${settingsPath}\n`);
	process.stdout.write(`  UserPromptSubmit → in-progress\n`);
	process.stdout.write(`  PreToolUse → in-progress\n`);
	process.stdout.write(`  PermissionRequest → user-questions\n`);
	process.stdout.write(`  Stop → review-by-user\n`);
}
