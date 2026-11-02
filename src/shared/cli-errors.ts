import { EVENT_CURSOR_UNRESOLVED_PREFIX } from "./board-events";
import {
	CLI_EXIT_CODE_COMMAND_FAILED,
	CLI_EXIT_CODE_EVENT_CURSOR_INVALID,
	CLI_EXIT_CODE_EXTERNAL_SENDER_UNKNOWN,
	CLI_EXIT_CODE_SENDER_INBOX_BUSY,
	CLI_EXIT_CODE_TASK_IS_DRAFT,
	CLI_EXIT_CODE_TASK_REF_UNRESOLVED,
} from "./cli-exit-codes";
import { SENDER_INBOX_BUSY_ERROR, UNKNOWN_EXTERNAL_SENDER_ERROR } from "./external-senders";
import { DRAFT_TASK_ACTIVATION_ERROR, TASK_REF_UNRESOLVED_PREFIX } from "./types";

/** A failed app request, as the CLI reports it: a stable code, an exit code, and the stderr text. */
export interface ClassifiedAppError {
	code: string;
	exitCode: number;
	/** What the CLI prints after `error: ` — a marker prefix, when the app sent one, is cut off. */
	message: string;
}

const PREFIX_MARKERS = [
	{ code: "TASK_REF_UNRESOLVED", exitCode: CLI_EXIT_CODE_TASK_REF_UNRESOLVED, marker: TASK_REF_UNRESOLVED_PREFIX },
	{ code: "EVENT_CURSOR_INVALID", exitCode: CLI_EXIT_CODE_EVENT_CURSOR_INVALID, marker: EVENT_CURSOR_UNRESOLVED_PREFIX },
] as const;

/**
 * The one map from an app error string to its exit code, shared by the CLI and
 * the MCP listener so the two can never disagree on what a failure means.
 */
export function classifyAppError(error: string | undefined, fallback = "Request failed"): ClassifiedAppError {
	const text = error || fallback;
	for (const { code, exitCode, marker } of PREFIX_MARKERS) {
		const at = text.indexOf(marker);
		if (at !== -1) return { code, exitCode, message: text.slice(at + marker.length) };
	}
	if (text.startsWith(UNKNOWN_EXTERNAL_SENDER_ERROR)) return { code: "EXTERNAL_SENDER_UNKNOWN", exitCode: CLI_EXIT_CODE_EXTERNAL_SENDER_UNKNOWN, message: text };
	if (text.startsWith(SENDER_INBOX_BUSY_ERROR)) return { code: "SENDER_INBOX_BUSY", exitCode: CLI_EXIT_CODE_SENDER_INBOX_BUSY, message: text };
	if (text.includes(DRAFT_TASK_ACTIVATION_ERROR)) return { code: "TASK_IS_DRAFT", exitCode: CLI_EXIT_CODE_TASK_IS_DRAFT, message: text };
	return { code: "COMMAND_FAILED", exitCode: CLI_EXIT_CODE_COMMAND_FAILED, message: text };
}
