import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CliContext } from "../context";
import { exitError } from "../output";
import { mergeClaudeHooks } from "../../shared/agent-hooks";

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

	// Claude Code hooks → .claude/settings.local.json
	const claudeDir = join(worktreePath, ".claude");
	const settingsPath = join(claudeDir, "settings.local.json");

	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(settingsPath)) {
			existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
		}
	} catch {
		// Corrupted — overwrite
	}

	const updated = mergeClaudeHooks(existing, taskId);

	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");

	process.stdout.write(`Installed Claude Code hooks → ${settingsPath}\n`);
	process.stdout.write(`  PermissionRequest → user-questions\n`);
	process.stdout.write(`  Stop → review-by-user\n`);
}
