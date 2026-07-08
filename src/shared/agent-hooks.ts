/**
 * Hook-building logic shared between the backend (bun/) and CLI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode, TaskStatus } from "./types";
import { CLI_EXIT_CODE_APP_NOT_RUNNING } from "./cli-exit-codes";

export const DEV3_CLI = "~/.dev3.0/bin/dev3";
export const CODEX_STOP_HOOK_FLAG = "--codex-stop-hook";
export const CODEX_STOP_HOOK_SUCCESS_JSON = "{}";
export const CODEX_DEV3_HOOK_COMMAND = `${DEV3_CLI} hook codex`;
export const CODEX_STATUS_HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"Stop",
] as const;
export type CodexStatusHookEvent = typeof CODEX_STATUS_HOOK_EVENTS[number];

export function getCodexHookTargetStatus(
	event: CodexStatusHookEvent,
	currentStatus: TaskStatus,
	autoReviewEnabled: boolean,
	resumeStatus?: "in-progress" | "review-by-ai",
): TaskStatus | null {
	if (currentStatus === "completed" || currentStatus === "cancelled") return null;

	switch (event) {
		case "SessionStart":
		case "UserPromptSubmit":
		case "PreToolUse":
		case "PostToolUse":
			if (currentStatus === "user-questions" && resumeStatus) return resumeStatus;
			return currentStatus === "review-by-ai" ? null : "in-progress";
		case "PermissionRequest":
			return "user-questions";
		case "Stop":
			if (currentStatus === "in-progress") {
				return autoReviewEnabled ? "review-by-ai" : "review-by-user";
			}
			if (currentStatus === "review-by-ai") return "review-by-user";
			return null;
	}
}

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

function buildMoveCommand(
	status: string,
	extra?: string,
	options?: { codexStopHook?: boolean },
): string {
	const parts = [`${DEV3_CLI} task move --status ${status}`];
	if (extra) parts.push(extra);
	if (options?.codexStopHook) parts.push(CODEX_STOP_HOOK_FLAG);
	return parts.join(" ");
}

// Status-move hooks must not hard-fail when the desktop app is down. The CLI
// exits `CLI_EXIT_CODE_APP_NOT_RUNNING` (2) in that case — but exit code 2 is
// ALSO how both Claude Code and Codex signal a *blocking* hook error (Claude:
// blocks the tool call / erases the prompt / blocks Stop; Codex: blocks prompt
// and tool execution). So a closed app would otherwise wedge the agent on every
// PreToolUse/UserPromptSubmit/Stop. This guard collapses ONLY the app-offline
// exit code into success; any other failure still propagates. It is deliberately
// selective rather than `|| true`, which would mask real regressions (see
// decisions 032 and 089). The CLI still prints its "app not running" notice to
// stderr, so the warning survives — we just don't let it block the agent.
function wrapAppOfflineFallback(command: string): string {
	return `${command} || [ $? -eq ${CLI_EXIT_CODE_APP_NOT_RUNNING} ]`;
}

function buildStopGroups(
	stopTarget: TaskStatus,
): MatcherGroup[] {
	const move = (status: string, extra?: string) => {
		const command = buildMoveCommand(status, extra);
		return wrapAppOfflineFallback(command);
	};

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
		wrapAppOfflineFallback(buildMoveCommand(status, extra));

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
 * All entries call one stable user-level handler. Keeping the hook definition
 * independent of the worktree and task lets the user trust it once through
 * Codex's hash-based hook review instead of once per generated worktree path.
 * The handler receives the event JSON on stdin and asks dev3 to perform the
 * status transition atomically.
 */
export function buildCodexHooks(): HookMap {
	const handler: HookEntry = {
		type: "command",
		command: CODEX_DEV3_HOOK_COMMAND,
		timeout: 5,
	};
	const toolMatcher = "Bash|Edit|Write|^apply_patch$|^mcp__.*";

	return {
		SessionStart: [
			{
				matcher: "startup|resume",
				hooks: [handler],
			},
		],
		UserPromptSubmit: [
			{ hooks: [handler] },
		],
		PreToolUse: [
			{
				matcher: toolMatcher,
				hooks: [handler],
			},
		],
		PermissionRequest: [
			{
				matcher: toolMatcher,
				hooks: [handler],
			},
		],
		PostToolUse: [
			{
				matcher: toolMatcher,
				hooks: [handler],
			},
		],
		Stop: [{ hooks: [handler] }],
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

/**
 * Write `permissions.defaultMode` into a settings object. Idempotent.
 *
 * The `--permission-mode` CLI flag only governs the *lead* Claude session.
 * Teammates spawned via the experimental agent-teams feature
 * (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 + the TeamCreate tool) take their
 * starting mode from the worktree's settings files, NOT from the lead's CLI
 * flag — so without a settings-file baseline they fall back to "default" and
 * prompt "Waiting for tool approval" on every tool call. Writing defaultMode
 * into .claude/settings.local.json gives the lead AND every teammate the same
 * auto-approve baseline. dev3's PermissionMode values map 1:1 to the modes
 * Claude Code accepts here, so we write them through verbatim. See
 * decision 085.
 */
export function ensureDefaultMode(
	settings: Record<string, unknown>,
	mode: PermissionMode,
): Record<string, unknown> {
	const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
	return { ...settings, permissions: { ...permissions, defaultMode: mode } };
}

export function mergeClaudeHooks(
	existing: Record<string, unknown>,
	options?: { stopTarget?: TaskStatus },
): Record<string, unknown> {
	return mergeHookMaps(existing, buildClaudeHooks(options));
}

export function mergeCodexHooks(
	existing: Record<string, unknown>,
): Record<string, unknown> {
	return mergeHookMaps(existing, buildCodexHooks());
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
export function writeClaudeHooks(
	worktreePath: string,
	options?: { stopTarget?: TaskStatus; permissionMode?: PermissionMode },
): void {
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

	// defaultMode always lives in settings.local.json (local scope, gitignored)
	// so it never leaks into a committed settings.json. "default" is Claude's
	// baseline — writing it would be a no-op, so we skip it.
	if (options?.permissionMode && options.permissionMode !== "default") {
		updatedHooks = ensureDefaultMode(updatedHooks, options.permissionMode);
	}

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
 * Read the user-level ~/.codex/hooks.json, merge dev3 hooks, and write it back.
 * The caller supplies the Codex config directory so tests never touch HOME.
 */
export function writeCodexHooks(codexDir: string): void {
	mkdirSync(codexDir, { recursive: true });

	const hooksPath = join(codexDir, "hooks.json");

	let settings: Record<string, unknown> = {};
	try {
		if (existsSync(hooksPath)) {
			settings = JSON.parse(readFileSync(hooksPath, "utf-8"));
		}
	} catch (error) {
		throw new Error(
			`Cannot install Codex hooks because ${hooksPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const updated = mergeCodexHooks(settings);
	if (JSON.stringify(updated) === JSON.stringify(settings)) return;
	writeFileSync(hooksPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

/**
 * Remove legacy dev3 entries from a worktree-local hooks file while preserving
 * every project-owned hook and top-level setting. We intentionally keep the
 * file even when the resulting hooks map is empty: files inside managed
 * worktrees are user-visible state, and migration must not delete them.
 */
export function removeCodexWorktreeHooks(worktreePath: string): void {
	const hooksPath = join(worktreePath, ".codex", "hooks.json");
	if (!existsSync(hooksPath)) return;

	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(hooksPath, "utf-8"));
	} catch {
		return;
	}

	const existingHooks = (settings.hooks ?? {}) as HookMap;
	const hooks: HookMap = {};
	for (const [event, groups] of Object.entries(existingHooks)) {
		const preserved = groups.filter((group) => !isDev3Entry(group));
		if (preserved.length > 0) hooks[event] = preserved;
	}

	const updated = { ...settings, hooks };
	if (JSON.stringify(updated) === JSON.stringify(settings)) return;
	writeFileSync(hooksPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}
