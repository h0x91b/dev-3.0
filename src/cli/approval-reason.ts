import { APPROVAL_REASON_MAX_LENGTH, normalizeApprovalReason } from "../shared/approval-reason";
import type { ParsedArgs } from "./args";
import { exitUsage } from "./output";

/**
 * `--reason "<text>"`: why the agent asks, shown in the approval dialog.
 * Refused rather than trimmed when too long, so the agent learns its text was cut.
 */
export function readReasonFlag(args: ParsedArgs): { reason?: string } {
	const raw = args.flags.reason;
	if (raw === undefined) return {};
	if (raw === "true") exitUsage("--reason needs the text as its value: --reason \"why you ask\".");
	const length = [...raw.trim()].length;
	if (length > APPROVAL_REASON_MAX_LENGTH) {
		exitUsage(`--reason is ${length} characters; the limit is ${APPROVAL_REASON_MAX_LENGTH}. Say why in a sentence or two.`);
	}
	const reason = normalizeApprovalReason(raw);
	if (!reason) exitUsage("--reason must not be empty.");
	return { reason };
}
