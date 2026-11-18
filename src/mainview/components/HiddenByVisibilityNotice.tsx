import { useMemo } from "react";
import { TERMINAL_STATUSES, type Task } from "../../shared/types";
import type { TaskVisibility } from "../../shared/board-filter-state";
import { useT } from "../i18n";
import { statusFilterValues } from "../utils/taskSearch";

interface HiddenByVisibilityNoticeProps {
	visibility: TaskVisibility;
	searchQuery: string;
	/** Every task of the board, before the Active | All switch and the query. */
	tasks: readonly Task[];
	/** How many tasks the view shows now. */
	shownCount: number;
	matches: (task: Task, query: string) => boolean;
	onShowAll: () => void;
}

const LINK = "font-medium text-accent hover:text-accent-emphasis hover:underline focus-visible:ring-1 focus-visible:ring-accent rounded";

/**
 * One line under the filter bar while Active hides finished tasks the user is likely
 * looking for: a search that matches only them, or a board that holds only them.
 */
function HiddenByVisibilityNotice({ visibility, searchQuery, tasks, shownCount, matches, onShowAll }: HiddenByVisibilityNoticeProps) {
	const t = useT();
	const overridden = statusFilterValues(searchQuery).length > 0;
	const active = visibility === "active" && !overridden;
	const hiddenCount = useMemo(
		() => (active ? tasks.filter((task) => TERMINAL_STATUSES.includes(task.status) && matches(task, searchQuery)).length : 0),
		[active, tasks, matches, searchQuery],
	);
	if (!active || hiddenCount === 0) return null;
	if (searchQuery.trim() === "" && shownCount > 0) return null;

	return (
		<div data-testid="hidden-by-visibility-notice" role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 px-6 pb-1 text-xs text-fg-3">
			<span>{t.plural("board.visibility.hidden", hiddenCount)}</span>
			<span aria-hidden="true">·</span>
			<button type="button" className={LINK} onClick={onShowAll}>{t("board.visibility.showAll")}</button>
		</div>
	);
}

export default HiddenByVisibilityNotice;
