import type { Project } from "../../shared/types";
import { useT } from "../i18n";
import { useProjectPrivacy } from "../sensitive-projects";
import { parseTaskQuery } from "../utils/taskSearch";
import { groupKey, resolveChildrenValue, type TaskLineage } from "../utils/taskLineage";

interface LineageFilterNoticeProps {
	searchQuery: string;
	lineage: TaskLineage;
	allProjects: readonly Project[];
	/** Projects on this board — children there are already on screen. */
	boardProjectIds: ReadonlySet<string>;
	currentProjectId: string | null;
	/** Open `projectId`'s board filtered to the same parent. */
	onOpenProject: (projectId: string, parent: { projectId: string; seq: number }) => void;
	/** Replace the ambiguous token with one naming `projectId`. */
	onPickProject: (parent: { projectId: string; seq: number }) => void;
}

const LINK = "font-medium text-accent hover:text-accent-emphasis hover:underline focus-visible:ring-1 focus-visible:ring-accent rounded";

/**
 * The one line under the filter bar while a `children:` token is active: the
 * children this board cannot show because they live in other projects, or the
 * projects an ambiguous name could mean. Renders nothing otherwise.
 */
function LineageFilterNotice({ searchQuery, lineage, allProjects, boardProjectIds, currentProjectId, onOpenProject, onPickProject }: LineageFilterNoticeProps) {
	const t = useT();
	const { maskClass } = useProjectPrivacy();
	const value = parseTaskQuery(searchQuery).facets.children[0];
	if (!value) return null;
	const resolved = resolveChildrenValue(value, allProjects, currentProjectId);

	if (resolved.kind === "ambiguous") {
		return (
			<div data-testid="lineage-filter-notice" role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 px-6 pb-1 text-xs text-fg-3">
				<span>{t("kanban.lineage.ambiguous", { name: resolved.name })}</span>
				{resolved.projectIds.map((projectId) => (
					<button key={projectId} type="button" className={`${LINK} font-mono`} onClick={() => onPickProject({ projectId, seq: resolved.seq })}>
						{`children:${projectId.slice(0, 8)}/${resolved.seq}`}
					</button>
				))}
			</div>
		);
	}
	if (resolved.kind !== "group") return null;

	const parent = { projectId: resolved.projectId, seq: resolved.seq };
	const elsewhere = new Map<string, number>();
	for (const child of lineage.childrenByGroup.get(groupKey(parent)) ?? []) {
		if (boardProjectIds.has(child.projectId)) continue;
		elsewhere.set(child.projectId, (elsewhere.get(child.projectId) ?? 0) + 1);
	}
	if (elsewhere.size === 0) return null;
	const total = [...elsewhere.values()].reduce((sum, n) => sum + n, 0);
	const nameOf = (projectId: string) => allProjects.find((p) => p.id === projectId)?.name ?? projectId.slice(0, 8);

	return (
		<div data-testid="lineage-filter-notice" role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 pb-1 text-xs text-fg-3">
			<span>{t.plural("kanban.lineage.otherProjects", total)}</span>
			{[...elsewhere.entries()].map(([projectId, count]) => (
				<button key={projectId} type="button" className={LINK} onClick={() => onOpenProject(projectId, parent)}>
					<span className={maskClass(projectId)}>{nameOf(projectId)}</span>
					<span className="ml-1 font-mono text-fg-3">{count}</span>
				</button>
			))}
		</div>
	);
}

export default LineageFilterNotice;
