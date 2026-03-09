/**
 * Agent hook injection for dev-3.0 worktrees.
 *
 * Sets up agent-native hooks (e.g., Claude Code hooks in .claude/settings.local.json)
 * so that task status transitions happen automatically via the agent's built-in
 * event system, rather than relying solely on SKILL.md instructions.
 *
 * Currently supports Claude Code.  Extensible for Gemini, Cursor, etc.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger";
import { isClaudeCommand } from "./agents";
import { spawnSync } from "./spawn";

const log = createLogger("agent-hooks");

const DEV3_CLI = "~/.dev3.0/bin/dev3";

// ---- Claude Code hooks ----

interface HookEntry {
	type: string;
	command: string;
}

/**
 * Build the Claude Code hooks object for a given task.
 *
 * - PermissionRequest: agent is blocked waiting for user approval → user-questions
 * - Stop: agent finished its turn → review-by-user (only if still in-progress)
 */
export function buildClaudeHooks(
	taskId: string,
): Record<string, HookEntry[]> {
	return {
		PermissionRequest: [
			{
				type: "command",
				command: `${DEV3_CLI} task move ${taskId} --status user-questions`,
			},
		],
		Stop: [
			{
				type: "command",
				command: `${DEV3_CLI} task move ${taskId} --status review-by-user --if-status in-progress`,
			},
		],
	};
}

/**
 * Merge dev3 hooks into an existing settings.local.json object.
 * Preserves any existing hooks for other events, and any non-dev3 hooks
 * on the same events.  Idempotent: replaces previous dev3 hooks.
 */
export function mergeClaudeHooks(
	existing: Record<string, unknown>,
	taskId: string,
): Record<string, unknown> {
	const newHooks = buildClaudeHooks(taskId);
	const existingHooks = (existing.hooks ?? {}) as Record<string, HookEntry[]>;
	const merged: Record<string, HookEntry[]> = { ...existingHooks };

	for (const [event, commands] of Object.entries(newHooks)) {
		const current = merged[event] ?? [];
		// Remove any previous dev3 hooks (idempotency)
		const filtered = current.filter(
			(h) => !h.command?.includes(DEV3_CLI),
		);
		merged[event] = [...filtered, ...commands];
	}

	return { ...existing, hooks: merged };
}

/**
 * Write .claude/settings.local.json in the worktree with dev3 hooks.
 */
export function setupClaudeHooks(
	worktreePath: string,
	taskId: string,
): void {
	const claudeDir = join(worktreePath, ".claude");
	const settingsPath = join(claudeDir, "settings.local.json");

	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(settingsPath)) {
			existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
		}
	} catch {
		// Corrupted file — overwrite
	}

	const updated = mergeClaudeHooks(existing, taskId);

	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(
		settingsPath,
		JSON.stringify(updated, null, 2) + "\n",
		"utf-8",
	);
	log.info("Claude hooks installed", {
		worktreePath,
		taskId: taskId.slice(0, 8),
	});

	ensureGitExclude(worktreePath, ".claude/settings.local.json");
}

// ---- Git exclude helper ----

/**
 * Ensure a pattern is in the worktree-local git exclude file
 * (<git-dir>/info/exclude).  This is invisible, never committed,
 * and scoped to the individual worktree.
 */
export function ensureGitExclude(
	worktreePath: string,
	pattern: string,
): void {
	try {
		const result = spawnSync(["git", "rev-parse", "--git-dir"], {
			cwd: worktreePath,
		});
		const gitDir = result.stdout.toString().trim();
		if (!gitDir) return;

		const excludePath = join(gitDir, "info", "exclude");
		let content = "";
		try {
			content = readFileSync(excludePath, "utf-8");
		} catch {
			// File doesn't exist yet
		}

		if (content.includes(pattern)) return;

		mkdirSync(join(gitDir, "info"), { recursive: true });
		const separator =
			content.length > 0 && !content.endsWith("\n") ? "\n" : "";
		writeFileSync(
			excludePath,
			content + separator + pattern + "\n",
			"utf-8",
		);
		log.info("Git exclude added", { pattern, worktreePath });
	} catch (err) {
		log.warn("Failed to add git exclude (non-fatal)", {
			pattern,
			error: String(err),
		});
	}
}

// ---- Dispatcher ----

/**
 * Set up agent-native hooks in the worktree.
 * Routes to the appropriate setup function based on agent type.
 */
export function setupAgentHooks(
	worktreePath: string,
	taskId: string,
	baseCommand: string,
): void {
	if (isClaudeCommand(baseCommand)) {
		setupClaudeHooks(worktreePath, taskId);
		return;
	}
	// Future: isGeminiCommand, isCursorCommand, etc.
}
