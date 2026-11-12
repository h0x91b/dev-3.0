import type { ApprovalReason } from "../../shared/approval-reason";
import { useT } from "../i18n";

/**
 * Why an agent asks for an approval-gated action (`--reason`). The text is
 * agent-supplied, so it renders as a plain text node — never HTML or markdown.
 */
function ApprovalReasonNote({ reason, tone = "accent" }: { reason: ApprovalReason; tone?: "accent" | "danger" }) {
	const t = useT();
	const label = reason.from
		? t("approvalReason.fromTask", { seq: String(reason.from.seq), title: reason.from.title })
		: t("approvalReason.label");
	return (
		<figure
			data-testid="approval-reason"
			className={`m-0 rounded-lg bg-elevated/70 border-l-2 px-3 py-2 space-y-1 ${tone === "danger" ? "border-danger/60" : "border-accent/60"}`}
		>
			<figcaption className="text-fg-3 text-xs font-medium truncate">{label}</figcaption>
			<blockquote className="m-0 text-fg text-sm leading-relaxed whitespace-pre-line break-words max-h-32 overflow-y-auto">
				{reason.text}
			</blockquote>
		</figure>
	);
}

export default ApprovalReasonNote;
