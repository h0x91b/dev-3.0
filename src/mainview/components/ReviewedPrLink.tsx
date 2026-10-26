import type { ReviewedPullRequest } from "../../shared/types";
import { useT } from "../i18n";
import Tooltip from "./Tooltip";

interface ReviewedPrLinkProps {
	pr: ReviewedPullRequest;
	/** The git bar has room to say what the number is; cards show the number alone. */
	labelled?: boolean;
	testId?: string;
}

/**
 * Opens the pull request a review task reviews. Neutral ink on purpose: the
 * state colours belong to the task's OWN PR badge, and this one is somebody
 * else's PR that nothing polls. Swallows the click so a card never selects,
 * opens or starts dragging underneath it.
 */
export default function ReviewedPrLink({ pr, labelled = false, testId }: ReviewedPrLinkProps) {
	const t = useT();
	const name = t("task.reviewedPr.open", { number: String(pr.number) });
	return (
		<Tooltip content={name} detail={t("ttip.task.reviewedPr")}>
			<a
				href={pr.url}
				target="_blank"
				rel="noreferrer"
				draggable={false}
				data-testid={testId}
				onClick={(e) => {
					// The same route every PR badge takes: desktop forwards it to the OS
					// browser, remote mode opens a tab.
					e.preventDefault();
					e.stopPropagation();
					window.open(pr.url, "_blank");
				}}
				onMouseDown={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
				onDragStart={(e) => {
					e.preventDefault();
					e.stopPropagation();
				}}
				className="inline-flex h-5 max-w-full flex-shrink-0 items-center gap-1 rounded bg-fg-3/10 px-1.5 py-0.5 font-mono text-dense font-semibold leading-none text-fg-2 no-underline transition-colors hover:bg-fg-3/20 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
				aria-label={name}
			>
				<span className="text-micro leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }} aria-hidden="true">{"\u{F0401}"}</span>
				<span className="truncate leading-none">
					{labelled ? t("task.reviewedPr.label", { number: String(pr.number) }) : t("task.prNumber", { number: String(pr.number) })}
				</span>
			</a>
		</Tooltip>
	);
}
