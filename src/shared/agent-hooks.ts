/**
 * Pure hook-building logic shared between the backend (bun/) and CLI.
 * No filesystem or process dependencies — only data transformations.
 */

export const DEV3_CLI = "~/.dev3.0/bin/dev3";

export interface HookEntry {
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
