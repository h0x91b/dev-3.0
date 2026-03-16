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
	options?: { stopTarget?: TaskStatus },
): Record<string, MatcherGroup[]> {
	const stopTarget: TaskStatus = options?.stopTarget ?? "review-by-user";
	const move = (status: string, extra?: string) =>
		`${DEV3_CLI} task move --status ${status}${extra ? ` ${extra}` : ""}`;

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

export const DEV3_BASH_PERMISSION = "Bash(dev3:*)";

export function mergeClaudeHooks(
	existing: Record<string, unknown>,
	options?: { stopTarget?: TaskStatus },
): Record<string, unknown> {
	const newHooks = buildClaudeHooks(options);
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
 * Add Bash(dev3:*) to permissions.allow in a settings object. Idempotent.
 */
export function ensureDevPermission(settings: Record<string, unknown>): Record<string, unknown> {
	const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
	const allow = Array.isArray(permissions.allow) ? [...permissions.allow as string[]] : [];
	if (!allow.includes(DEV3_BASH_PERMISSION)) {
		allow.push(DEV3_BASH_PERMISSION);
	}
	return { ...settings, permissions: { ...permissions, allow } };
}

/**
 * Resolve which .claude/settings file to write the dev3 permission to:
 * 1. settings.local.json exists → use it
 * 2. settings.json exists → use it
 * 3. neither → create settings.local.json
 */
function resolvePermissionSettingsPath(claudeDir: string): string {
	const localPath = join(claudeDir, "settings.local.json");
	const sharedPath = join(claudeDir, "settings.json");

	if (existsSync(localPath)) return localPath;
	if (existsSync(sharedPath)) return sharedPath;
	return localPath;
}

/**
 * Read .claude/settings.local.json, merge dev3 hooks, write back.
 * Also ensures Bash(dev3:*) permission in the appropriate settings file.
 * Creates the .claude/ directory if it doesn't exist.
 */
export function writeClaudeHooks(worktreePath: string, options?: { stopTarget?: TaskStatus }): void {
	const claudeDir = join(worktreePath, ".claude");
	mkdirSync(claudeDir, { recursive: true });

	const hooksPath = join(claudeDir, "settings.local.json");
	const permPath = resolvePermissionSettingsPath(claudeDir);
	const sameFile = permPath === hooksPath;

	// Read the hooks target (always settings.local.json)
	let hooksSettings: Record<string, unknown> = {};
	try {
		if (existsSync(hooksPath)) {
			hooksSettings = JSON.parse(readFileSync(hooksPath, "utf-8"));
		}
	} catch {
		// Corrupted file — overwrite
	}

	let updatedHooks = mergeClaudeHooks(hooksSettings, options);

	if (sameFile) {
		// Permission goes into the same file — apply on top of merged hooks
		updatedHooks = ensureDevPermission(updatedHooks);
		writeFileSync(hooksPath, JSON.stringify(updatedHooks, null, 2) + "\n", "utf-8");
	} else {
		// Hooks and permission go to different files
		writeFileSync(hooksPath, JSON.stringify(updatedHooks, null, 2) + "\n", "utf-8");

		let permSettings: Record<string, unknown> = {};
		try {
			if (existsSync(permPath)) {
				permSettings = JSON.parse(readFileSync(permPath, "utf-8"));
			}
		} catch {
			// Corrupted — overwrite
		}
		const updatedPerm = ensureDevPermission(permSettings);
		if (JSON.stringify(updatedPerm) !== JSON.stringify(permSettings)) {
			writeFileSync(permPath, JSON.stringify(updatedPerm, null, 2) + "\n", "utf-8");
		}
	}
}
