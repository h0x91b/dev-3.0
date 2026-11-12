import type { Task } from "../../shared/types";
import { pickCompletionOffer, useCompletionOffers } from "../completion-offers";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";
import { MergeIcon } from "./task-info-panel/GitIcons";

/**
 * Passive card marker: a completion offer waits in this task's view. A tinted badge,
 * so it never reads as part of the agent label beside it, and never a ✓, which is
 * the quick-complete action. With both kinds waiting it shows the agent's and names both.
 */
export default function CompletionOfferMark({ task, testId }: { task: Pick<Task, "id">; testId?: string }) {
	const t = useT();
	const offers = useCompletionOffers();
	const offer = pickCompletionOffer(offers, task.id);
	if (!offer) return null;
	const kinds = new Set(offers.filter((o) => o.taskId === task.id).map((o) => o.kind));
	const label = [
		kinds.has("agent") && t("completionStrip.agentTitle"),
		kinds.has("merge") && t("completionStrip.mergedTitle"),
	].filter(Boolean).join(" · ");
	const isAgent = offer.kind === "agent";
	return (
		<Tooltip content={label}>
			<span
				role="img"
				aria-label={label}
				data-testid={testId}
				data-kinds={[...kinds].sort().join(" ")}
				className={`flex-shrink-0 inline-grid h-4 w-4 place-items-center rounded-full ${isAgent ? "bg-accent/15 text-accent" : "bg-success/15 text-success"}`}
			>
				{isAgent ? (
					<span aria-hidden className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F06A9}"}</span>
				) : (
					<MergeIcon className="w-3 h-3" />
				)}
			</span>
		</Tooltip>
	);
}
