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
	timeout?: number;
	timeoutSec?: number;
	statusMessage?: string;
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
	matcher?: string;
	hooks: HookEntry[];
}

type HookMap = Record<string, MatcherGroup[]>;

function buildStopGroups(stopTarget: TaskStatus): MatcherGroup[] {
	const move = (status: string, extra?: string) =>
		`${DEV3_CLI} task move --status ${status}${extra ? ` ${extra}` : ""}`;

	const stopGroups: MatcherGroup[] = [
		{
			hooks: [{ type: "command", command: move(stopTarget, "--if-status in-progress") }],
		},
	];

	if (stopTarget !== "review-by-user") {
		stopGroups.push({
			hooks: [{ type: "command", command: move("review-by-user", "--if-status review-by-ai") }],
		});
	}

	return stopGroups;
}

function mergeHookMaps(
	existing: Record<string, unknown>,
	newHooks: HookMap,
): Record<string, unknown> {
	const existingHooks = (existing.hooks ?? {}) as HookMap;
	const merged: HookMap = { ...existingHooks };

	for (const [event, groups] of Object.entries(newHooks)) {
		const current = merged[event] ?? [];
		const filtered = current.filter((g) => !isDev3Entry(g));
		merged[event] = [...filtered, ...groups];
	}

	return { ...existing, hooks: merged };
}

export function buildClaudeHooks(
	options?: { stopTarget?: TaskStatus },
): HookMap {
	const stopTarget: TaskStatus = options?.stopTarget ?? "review-by-user";
	const move = (status: string, extra?: string) =>
		`${DEV3_CLI} task move --status ${status}${extra ? ` ${extra}` : ""}`;

	// Working hook: move to in-progress, but NOT when in review-by-ai
	// (the review agent shares the same hooks file and must not flip status).
	// review-by-user is intentionally allowed: when the user leaves feedback
	// and the primary agent resumes, UserPromptSubmit should move the task back.
	const workingCmd = move("in-progress", "--if-status-not review-by-ai");

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
		Stop: buildStopGroups(stopTarget),
	};
}

/**
 * Build the Codex hooks object for a given task.
 *
 * Codex currently lacks a PermissionRequest event, so we mirror the Claude
 * behavior as closely as possible with:
 *
 * - SessionStart/UserPromptSubmit/PreToolUse(Bash): → in-progress
 * - Stop: primary agent → stopTarget; review agent → review-by-user
 */
export function buildCodexHooks(
	options?: { stopTarget?: TaskStatus },
): HookMap {
	const stopTarget: TaskStatus = options?.stopTarget ?? "review-by-user";
	const workingCmd = `${DEV3_CLI} task move --status in-progress --if-status-not review-by-ai`;

	return {
		SessionStart: [
			{
				matcher: "startup|resume",
				hooks: [{ type: "command", command: workingCmd }],
			},
		],
		UserPromptSubmit: [
			{ hooks: [{ type: "command", command: workingCmd }] },
		],
		PreToolUse: [
			{
				matcher: "Bash",
				hooks: [{ type: "command", command: workingCmd }],
			},
		],
		Stop: buildStopGroups(stopTarget),
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
	return mergeHookMaps(existing, buildClaudeHooks(options));
}

export function mergeCodexHooks(
	existing: Record<string, unknown>,
	options?: { stopTarget?: TaskStatus },
): Record<string, unknown> {
	return mergeHookMaps(existing, buildCodexHooks(options));
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

/**
 * Read .codex/hooks.json, merge dev3 hooks, and write it back.
 * Creates the .codex/ directory if it doesn't exist.
 */
export function writeCodexHooks(worktreePath: string, options?: { stopTarget?: TaskStatus }): void {
	const codexDir = join(worktreePath, ".codex");
	mkdirSync(codexDir, { recursive: true });

	const hooksPath = join(codexDir, "hooks.json");

	let settings: Record<string, unknown> = {};
	try {
		if (existsSync(hooksPath)) {
			settings = JSON.parse(readFileSync(hooksPath, "utf-8"));
		}
	} catch {
		// Corrupted file — overwrite
	}

	const updated = mergeCodexHooks(settings, options);
	writeFileSync(hooksPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}
