/**
 * Hook-building logic shared between the backend (bun/) and CLI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskStatus } from "./types";

export const DEV3_CLI = "~/.dev3.0/bin/dev3";

export interface HookEntry {
	type: string;
	command: string;
}

/**
 * Build the Claude Code hooks object for a given task.
 *
 * Unified hooks that work for both the primary agent and the review agent
 * running in the same worktree (they share .claude/settings.local.json).
 *
 * - PreToolUse/UserPromptSubmit: → in-progress (skipped when in review-by-ai)
 * - PermissionRequest: → user-questions
 * - Stop: primary agent → stopTarget; review agent → review-by-user
 */
export interface MatcherGroup {
	hooks: HookEntry[];
}

export function buildClaudeHooks(
	taskId: string,
	options?: { stopTarget?: TaskStatus },
): Record<string, MatcherGroup[]> {
	const stopTarget: TaskStatus = options?.stopTarget ?? "review-by-user";
	const move = (status: string, extra?: string) =>
		`${DEV3_CLI} task move ${taskId} --status ${status}${extra ? ` ${extra}` : ""}`;

	// Working hook: move to in-progress, but NOT when in review-by-ai
	// (the review agent shares the same hooks file and must not flip status).
	// review-by-user is intentionally allowed: when the user leaves feedback
	// and the primary agent resumes, UserPromptSubmit should move the task back.
	const workingCmd = move("in-progress", "--if-status-not review-by-ai");

	// Primary Stop hook: only fires when task is in-progress (primary agent working).
	// This prevents it from firing after the review agent has already moved the task.
	const stopGroups: MatcherGroup[] = [
		{
			hooks: [{ type: "command", command: move(stopTarget, "--if-status in-progress") }],
		},
	];
	// When AI review is enabled (stopTarget != review-by-user), add a second
	// Stop hook for the review agent: move to review-by-user only if currently
	// in review-by-ai.
	if (stopTarget !== "review-by-user") {
		stopGroups.push({
			hooks: [{ type: "command", command: move("review-by-user", "--if-status review-by-ai") }],
		});
	}

	return {
		UserPromptSubmit: [
			{ hooks: [{ type: "command", command: workingCmd }] },
		],
		PreToolUse: [
			{ hooks: [{ type: "command", command: workingCmd }] },
		],
		PermissionRequest: [
			{ hooks: [{ type: "command", command: move("user-questions") }] },
		],
		Stop: stopGroups,
	};
}

/**
 * Merge dev3 hooks into an existing settings.local.json object.
 * Preserves any existing hooks for other events, and any non-dev3 hooks
 * on the same events.  Idempotent: replaces previous dev3 hooks.
 */
/** Check if a matcher group (or legacy flat entry) contains a dev3 hook. */
function isDev3Entry(group: MatcherGroup | HookEntry): boolean {
	// New format: matcher group with nested hooks array
	if ("hooks" in group && Array.isArray(group.hooks)) {
		return group.hooks.some((h) => h.command?.includes(DEV3_CLI));
	}
	// Legacy flat format: { type, command } at top level
	if ("command" in group) {
		return (group as HookEntry).command?.includes(DEV3_CLI) ?? false;
	}
	return false;
}

export function mergeClaudeHooks(
	existing: Record<string, unknown>,
	taskId: string,
	options?: { stopTarget?: TaskStatus },
): Record<string, unknown> {
	const newHooks = buildClaudeHooks(taskId, options);
	const existingHooks = (existing.hooks ?? {}) as Record<string, MatcherGroup[]>;
	const merged: Record<string, MatcherGroup[]> = { ...existingHooks };

	for (const [event, groups] of Object.entries(newHooks)) {
		const current = merged[event] ?? [];
		// Remove any previous dev3 matcher groups (idempotency)
		const filtered = current.filter((g) => !isDev3Entry(g));
		merged[event] = [...filtered, ...groups];
	}

	return { ...existing, hooks: merged };
}

/**
 * Read .claude/settings.local.json, merge dev3 hooks, write back.
 * Creates the .claude/ directory if it doesn't exist.
 */
export function writeClaudeHooks(worktreePath: string, taskId: string, options?: { stopTarget?: TaskStatus }): void {
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

	const updated = mergeClaudeHooks(existing, taskId, options);

	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}
