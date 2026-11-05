import { useT } from "../i18n";
import type { CardLineage } from "../utils/taskLineage";
import { ChildTasksIcon, ParentTaskIcon } from "./LineageIcons";
import Tooltip from "./Tooltip";

const LINK =
	"inline-flex min-w-0 items-center gap-1 rounded text-fg-3 transition-colors duration-150 ease-out " +
	"hover:text-accent-emphasis focus-visible:ring-1 focus-visible:ring-accent";

/**
 * The card's lineage line, a muted row under the title: where the task came from
 * and how many tasks it created. Each half filters the board to the batch it
 * names. It lives in the body because the identity row has no width to spare.
 */
function LineageCluster({ lineage, testId = "task-card-lineage" }: { lineage: CardLineage; testId?: string }) {
	const t = useT();
	const { parentLabel, parentTitle, childCount, onFilterByParent, onFilterByChildren } = lineage;
	if (parentLabel === null && childCount === 0) return null;

	return (
		<div className="mt-1 flex min-w-0 items-center gap-1.5 text-dense" data-testid={testId}>
			{parentLabel === "deleted" && (
				<Tooltip content={t("task.lineage.parentDeleted")}>
					<span data-testid={`${testId}-parent`} className="inline-flex items-center gap-1 text-fg-muted" aria-label={t("task.lineage.parentDeleted")}>
						<ParentTaskIcon className="h-3 w-3 flex-shrink-0" />
						{t("task.lineage.fromDeleted")}
					</span>
				</Tooltip>
			)}
			{parentLabel !== null && parentLabel !== "deleted" && (
				<Tooltip
					content={t("task.lineage.parent", { seq: parentLabel })}
					detail={parentTitle ? `${parentTitle} — ${t("task.lineage.filterHint")}` : t("task.lineage.filterHint")}
				>
					<button
						type="button"
						data-testid={`${testId}-parent`}
						aria-label={t("task.lineage.parent", { seq: parentLabel })}
						disabled={!onFilterByParent}
						onClick={(event) => {
							event.stopPropagation();
							onFilterByParent?.();
						}}
						className={LINK}
					>
						<ParentTaskIcon className="h-3 w-3 flex-shrink-0" />
						{t("task.lineage.from")}
						<span className="font-mono">{parentLabel}</span>
					</button>
				</Tooltip>
			)}
			{parentLabel !== null && childCount > 0 && <span aria-hidden className="text-fg-muted">·</span>}
			{childCount > 0 && (
				<Tooltip content={t.plural("task.lineage.children", childCount)} detail={t("task.lineage.filterHint")}>
					<button
						type="button"
						data-testid={`${testId}-children`}
						aria-label={t.plural("task.lineage.children", childCount)}
						disabled={!onFilterByChildren}
						onClick={(event) => {
							event.stopPropagation();
							onFilterByChildren?.();
						}}
						className={LINK}
					>
						<ChildTasksIcon className="h-3 w-3 flex-shrink-0" />
						{t.plural("task.lineage.created", childCount)}
					</button>
				</Tooltip>
			)}
		</div>
	);
}

export default LineageCluster;
