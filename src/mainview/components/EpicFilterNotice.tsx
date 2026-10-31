import type { Epic, EpicMember, Project } from "../../shared/types";
import { useT } from "../i18n";
import { useProjectPrivacy } from "../sensitive-projects";
import { parseTaskQuery } from "../utils/taskSearch";
import { epicForFilterValue } from "../utils/taskEpic";

interface EpicFilterNoticeProps {
	searchQuery: string;
	epics: readonly Epic[];
	members: readonly EpicMember[];
	allProjects: readonly Project[];
	/** Projects on this board — their tasks are already on screen. */
	boardProjectIds: ReadonlySet<string>;
	/** Open `projectId`'s board filtered to the same epic. */
	onOpenProject: (projectId: string, epic: Epic) => void;
}

const LINK = "font-medium text-accent hover:text-accent-emphasis hover:underline focus-visible:ring-1 focus-visible:ring-accent rounded";

/**
 * The one line under the filter bar while an `epic:` token is active: the
 * epic's tasks this board cannot show because they live in other projects.
 * Same shape as the `children:` notice. Renders nothing otherwise.
 */
function EpicFilterNotice({ searchQuery, epics, members, allProjects, boardProjectIds, onOpenProject }: EpicFilterNoticeProps) {
	const t = useT();
	const { maskClass } = useProjectPrivacy();
	const value = parseTaskQuery(searchQuery).facets.epic[0];
	if (!value) return null;
	const epic = epicForFilterValue(value, epics);
	if (!epic) return null;

	const elsewhere = new Map<string, number>();
	for (const member of members) {
		if (member.epicId !== epic.id || boardProjectIds.has(member.projectId)) continue;
		elsewhere.set(member.projectId, (elsewhere.get(member.projectId) ?? 0) + 1);
	}
	if (elsewhere.size === 0) return null;
	const total = [...elsewhere.values()].reduce((sum, n) => sum + n, 0);
	const nameOf = (projectId: string) =>
		allProjects.find((p) => p.id === projectId)?.name ?? members.find((m) => m.projectId === projectId)?.projectName ?? projectId.slice(0, 8);

	return (
		<div data-testid="epic-filter-notice" role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 pb-1 text-xs text-fg-3">
			<span>{t.plural("kanban.epic.otherProjects", total)}</span>
			{[...elsewhere.entries()].map(([projectId, count]) => (
				<button key={projectId} type="button" className={LINK} onClick={() => onOpenProject(projectId, epic)}>
					<span className={maskClass(projectId)}>{nameOf(projectId)}</span>
					<span className="ml-1 font-mono text-fg-3">{count}</span>
				</button>
			))}
		</div>
	);
}

export default EpicFilterNotice;
