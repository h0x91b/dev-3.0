import { isAbsolute, resolve } from "node:path";
import type { CliContext } from "../context";
import { sendRequest } from "../socket-client";
import type { FileLeaseConflict } from "../../shared/file-leases";

/** The file a Claude edit tool is about to write, from its `PreToolUse` payload. */
export function claimedFilePath(rawInput: string): { path: string; sessionId?: string } | null {
	try {
		const parsed = JSON.parse(rawInput) as Record<string, unknown>;
		if (parsed.hook_event_name !== "PreToolUse") return null;
		const input = (parsed.tool_input ?? {}) as Record<string, unknown>;
		const raw = typeof input.file_path === "string" ? input.file_path : input.notebook_path;
		if (typeof raw !== "string" || !raw.trim()) return null;
		const cwd = typeof parsed.cwd === "string" ? parsed.cwd : process.cwd();
		return {
			path: isAbsolute(raw) ? raw : resolve(cwd, raw),
			...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}),
		};
	} catch {
		return null;
	}
}

/** The reason Claude shows its agent. It names the holder and the way to reach it. */
export function claimDenialReason(conflict: FileLeaseConflict): string {
	const who = `task #${conflict.holderSeq}${conflict.holderTitle ? ` "${conflict.holderTitle}"` : ""}`;
	return (
		`${conflict.path} is being edited right now by ${who}, which works in this same folder. ` +
		"Edit a different file, or coordinate first: " +
		`dev3 message --task seq:${conflict.holderSeq} --subject "Need ${conflict.fileName}" "<what you need to change and why>". ` +
		`The claim lapses ${conflict.minutesLeft} min after that task's last edit to the file.`
	);
}

/**
 * Internal adapter for Claude Code's `PreToolUse` hook on its edit tools, in a
 * folder other tasks share. Asks the app for a lease on the file and, when a live
 * task holds it, denies the edit with a reason the agent acts on. Every other
 * outcome - app offline, no task, a parse failure - allows the edit: a lease is
 * advisory and must never stop an agent on its own.
 */
export async function handleClaudeClaim(
	rawInput: string,
	socketPath: string | null,
	context: CliContext | null,
): Promise<void> {
	const claim = claimedFilePath(rawInput);
	if (!claim || !socketPath || !context?.taskId) return;
	try {
		const response = await sendRequest(socketPath, "task.claimFile", {
			taskId: context.taskId,
			projectId: context.projectId,
			path: claim.path,
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		const conflict = response.ok ? (response.data as { conflict?: FileLeaseConflict } | null)?.conflict : undefined;
		if (!conflict) return;
		process.stdout.write(JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: claimDenialReason(conflict),
			},
		}));
	} catch {
		// Offline or slow: the edit goes ahead, as it would without dev3.
	}
}
