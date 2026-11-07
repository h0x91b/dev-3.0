import type { Task } from "../../shared/types";
import { useCompletionOffer } from "../completion-offers";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";
import { MergeIcon } from "./task-info-panel/GitIcons";

/** Passive card marker: a completion offer waits in this task's view. Never a ✓, which is the quick-complete action. */
export default function CompletionOfferMark({ task, testId }: { task: Pick<Task, "id">; testId?: string }) {
	const t = useT();
	const offer = useCompletionOffer(task.id, true);
	if (!offer) return null;
	const label = t(offer.kind === "agent" ? "completionStrip.agentTitle" : "completionStrip.mergedTitle");
	return (
		<Tooltip content={label}>
			<span
				role="img"
				aria-label={label}
				data-testid={testId}
				className={`flex-shrink-0 inline-flex h-3.5 w-3.5 items-center justify-center ${offer.kind === "agent" ? "text-accent" : "text-success"}`}
			>
				{offer.kind === "agent" ? (
					<span aria-hidden className="text-xs leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{"\u{F06A9}"}</span>
				) : (
					<MergeIcon className="w-3.5 h-3.5" />
				)}
			</span>
		</Tooltip>
	);
}
