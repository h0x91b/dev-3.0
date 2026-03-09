/**
 * Hook-building logic shared between the backend (bun/) and CLI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEV3_CLI = "~/.dev3.0/bin/dev3";

export interface HookEntry {
	type: string;
	command: string;
}

/**
 * Build the Claude Code hooks object for a given task.
 *
 * - PreToolUse: agent is about to call a tool → in-progress (idempotent)
 * - PermissionRequest: agent is blocked waiting for user approval → user-questions
 * - Stop: agent finished its turn → review-by-user
 */
export interface MatcherGroup {
	hooks: HookEntry[];
}

export function buildClaudeHooks(
	taskId: string,
): Record<string, MatcherGroup[]> {
	const inProgressCmd = `${DEV3_CLI} task move ${taskId} --status in-progress`;
	return {
		UserPromptSubmit: [
			{
				hooks: [
					{
						type: "command",
						command: inProgressCmd,
					},
				],
			},
		],
		PreToolUse: [
			{
				hooks: [
					{
						type: "command",
						command: inProgressCmd,
					},
				],
			},
		],
		PermissionRequest: [
			{
				hooks: [
					{
						type: "command",
						command: `${DEV3_CLI} task move ${taskId} --status user-questions`,
					},
				],
			},
		],
		Stop: [
			{
				hooks: [
					{
						type: "command",
						command: `${DEV3_CLI} task move ${taskId} --status review-by-user`,
					},
				],
			},
		],
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
): Record<string, unknown> {
	const newHooks = buildClaudeHooks(taskId);
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
export function writeClaudeHooks(worktreePath: string, taskId: string): void {
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
	writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}
