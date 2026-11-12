/**
 * Why an agent asks for an approval-gated action (`--reason`), shown in the
 * approval dialog. Agent-supplied text: the renderer prints it as plain text,
 * never as HTML or markdown.
 */
export interface ApprovalReason {
	text: string;
	/**
	 * The task whose agent gave the reason, when it is not the target task's own
	 * agent. Absent on launch dialogs, which already name who asked.
	 */
	from?: { seq: number; title: string };
}

export const APPROVAL_REASON_MAX_LENGTH = 500;

const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Plain, bounded text or null when nothing usable is left. Control and
 * bidi-override characters go, blank lines collapse to one, and anything past
 * the cap is cut — the CLI refuses an over-long reason, this only guards the
 * app against other callers of the socket.
 */
export function normalizeApprovalReason(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const text = raw
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, " ")
		.replace(CONTROL_CHARS, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!text) return null;
	const chars = [...text];
	return chars.length > APPROVAL_REASON_MAX_LENGTH ? `${chars.slice(0, APPROVAL_REASON_MAX_LENGTH - 1).join("").trimEnd()}…` : text;
}

/** The `reason` socket param as a dialog field, or nothing when none was given. */
export function approvalReasonFromParams(params: Record<string, unknown>, from?: ApprovalReason["from"] | null): { reason?: ApprovalReason } {
	const text = normalizeApprovalReason(params.reason);
	if (!text) return {};
	return { reason: from ? { text, from } : { text } };
}
