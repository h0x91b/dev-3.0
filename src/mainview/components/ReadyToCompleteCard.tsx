import type { ResourceUsage } from "../../shared/types";
import { useT } from "../i18n";
import type { Route } from "../state";
import { useEffect } from "react";
import { registerWaitingOffersList, useCompletionOffers } from "../completion-offers";
import { formatBytesCompact } from "../utils/formatBytes";
import { waitingRss } from "./ReadyToCompleteScreen";

/**
 * The dashboard's way into the Ready to complete screen: how many tasks wait for a
 * completion answer and the memory they hold. Shown only while one waits, so the
 * dashboard stays the project list however many asks pile up.
 */
export default function ReadyToCompleteCard({ usage, navigate }: { usage: Map<string, ResourceUsage>; navigate: (route: Route) => void }) {
	const t = useT();
	const offers = useCompletionOffers();
	// The card already counts every ask, so a toast about one would only repeat it.
	useEffect(() => registerWaitingOffersList(), []);
	const count = new Set(offers.map((o) => o.taskId)).size;
	if (count === 0) return null;
	const held = waitingRss(offers, usage);
	return (
		<button
			type="button"
			onClick={() => navigate({ screen: "completions" })}
			data-testid="dashboard-ready-to-complete"
			className="group w-full flex items-center gap-4 rounded-2xl border border-success/30 bg-raised hover:bg-raised-hover hover:border-success/50 px-3 md:px-5 py-3.5 transition-[background-color,border-color] text-left"
		>
			<span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-success/15 text-success">✓</span>
			<span className="flex-1 min-w-0">
				<span className="block text-fg font-semibold">{t.plural("completions.cardTitle", count)}</span>
				<span className="block text-fg-3 text-xs mt-0.5 truncate">
					{held > 0 ? t("completions.cardHeld", { size: formatBytesCompact(held) }) : t("completions.cardHint")}
				</span>
			</span>
			<svg aria-hidden="true" focusable="false" className="w-4 h-4 text-fg-muted group-hover:text-success transition-colors shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
			</svg>
		</button>
	);
}
